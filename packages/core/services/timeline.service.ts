import type { AuditAction, Prisma } from '@sales-tracker/db';
import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { scopeFollowUps } from '../rbac/scope.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import {
  clientTimelineSchema,
  encodeTimelineCursor,
  type ClientTimelineInput,
  type FollowUpChannelValue,
  type FollowUpEntityTypeValue,
  type TimelineCursor,
  type TimelineKind,
} from '../schemas/follow-up.ts';
import { kindSpec } from '../extraction/kinds.ts';
import type { DocumentKindValue } from '../schemas/document.ts';
import { labelsFor, supportedTargets, targetFor } from './follow-up-targets.ts';

export interface TimelineEvent {
  /** The follow-up id, or the audit row id. */
  id: string;
  kind: TimelineKind;
  /** When it was recorded. */
  at: Date;
  /** The calendar day it belongs to (YYYY-MM-DD, Asia/Kolkata): a follow-up's own date. */
  day: string;
  actor: { id: string; name: string };
  entity: { type: FollowUpEntityTypeValue; id: string; label: string; deleted: boolean };
  summary: string;
  change?: {
    from: string;
    to: string;
    lostReason?: string;
    poReceivedDate?: string;
    /** Project moves (M8). */
    holdReason?: string;
    completedDate?: string;
    cancelReason?: string;
  };
  /** DOCUMENT events: which file and what happened (never its values). */
  document?: {
    id: string;
    filename: string;
    action: 'UPLOADED' | 'CONFIRMED' | 'DELETED' | 'REPLACED' | 'RESTORED';
    appliedFields?: string[];
  };
  followUp?: {
    date: Date;
    channel: FollowUpChannelValue;
    notes: string;
    contact: { id: string; name: string } | null;
    nextFollowUpDate: Date | null;
    userId: string;
  };
}

// Sort key: day desc, at desc, then source rank and id asc. Ranks separate the sources, so
// two events can only tie on (day, at, rank) within one source, where the database order
// (id asc, in its collation) is kept as is.
const RANK = { followUp: 0, audit: 1 } as const;

const AUDIT_KIND: Partial<Record<AuditAction, TimelineKind>> = {
  CREATE: 'CREATED',
  UPDATE: 'STATUS_CHANGE',
  SOFT_DELETE: 'DELETED',
  RESTORE: 'RESTORED',
};

/** Document audit rows shown on the timeline (M7), by audit action. */
/** Document audit rows shown on the timeline (M7), by audit action; same verbs as the UI. */
const DOCUMENT_ACTION = {
  CREATE: 'UPLOADED',
  UPDATE: 'CONFIRMED',
  SOFT_DELETE: 'DELETED',
  RESTORE: 'RESTORED',
} as const satisfies Partial<Record<AuditAction, NonNullable<TimelineEvent['document']>['action']>>;

const DOCUMENT_VERB: Record<NonNullable<TimelineEvent['document']>['action'], string> = {
  UPLOADED: 'Uploaded',
  CONFIRMED: 'Confirmed',
  DELETED: 'Deleted',
  REPLACED: 'Replaced',
  RESTORED: 'Restored',
};

const AUDIT_SUMMARY: Partial<Record<TimelineKind, string>> = {
  CREATED: 'Created',
  DELETED: 'Deleted',
  RESTORED: 'Restored',
};

const CHANNEL_LABEL: Record<FollowUpChannelValue, string> = {
  CALL: 'Call',
  EMAIL: 'Email',
  MEETING: 'Meeting',
  SITE_VISIT: 'Site visit',
  WHATSAPP: 'WhatsApp',
  OTHER: 'Follow-up',
};

const istDay = (at: Date) => toCalendarDateString(todayInIST(at));
/** The instant an IST calendar day starts. */
const istDayStart = (day: string) => new Date(`${day}T00:00:00+05:30`);
const nextDay = (day: string) =>
  toCalendarDateString(new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000));

/** Follow-ups after the cursor in (date desc, createdAt desc, id asc) order. */
function followUpsAfter(c: TimelineCursor): Prisma.FollowUpWhereInput {
  const day = new Date(`${c.day}T00:00:00Z`);
  const at = new Date(c.at);
  return {
    OR: [
      { date: { lt: day } },
      { date: day, createdAt: { lt: at } },
      ...(c.rank === RANK.followUp ? [{ date: day, createdAt: at, id: { gt: c.id } }] : []),
    ],
  };
}

/**
 * Audit rows after the cursor. Their day is derived from createdAt, so "earlier day" is a
 * time bound; within the cursor's day, rows before its `at` follow it. A back-dated
 * follow-up's `at` can lie outside its day, which is why the day bound comes first.
 */
function auditAfter(c: TimelineCursor): Prisma.AuditLogWhereInput {
  const start = istDayStart(c.day);
  const end = istDayStart(nextDay(c.day));
  const at = new Date(c.at);
  const sameDay = { gte: start, lt: end };
  return {
    OR: [
      { createdAt: { lt: start } },
      { AND: [{ createdAt: sameDay }, { createdAt: { lt: at } }] },
      ...(c.rank === RANK.followUp
        ? [{ AND: [{ createdAt: sameDay }, { createdAt: at }] }]
        : c.rank === RANK.audit
          ? [{ AND: [{ createdAt: sameDay }, { createdAt: at }], id: { gt: c.id } }]
          : []),
    ],
  };
}

interface Keyed {
  day: string;
  at: Date;
  rank: number;
}

/** Descending by (day, at), then ascending rank. */
function before(a: Keyed, b: Keyed): boolean {
  if (a.day !== b.day) return a.day > b.day;
  if (a.at.getTime() !== b.at.getTime()) return a.at > b.at;
  return a.rank < b.rank;
}

/** Merges two lists already in timeline order, keeping each list's own order on ties. */
function merge<T extends Keyed>(a: T[], b: T[]): T[] {
  const out: T[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && !before(b[j]!, a[i]!))) out.push(a[i++]!);
    else out.push(b[j++]!);
  }
  return out;
}

/**
 * One client's history, newest first: follow-ups, and creation, status changes and deletes
 * of its records from the M2 audit log. Audit rows are filtered by **record visibility**,
 * not scopeAuditLog (M5 Decision 5): a rep sees an admin converting their enquiry, and
 * nothing about records they cannot read. Only whitelisted fields leave this function.
 */
export async function getClientTimeline(
  ctx: Ctx,
  input: ClientTimelineInput,
): Promise<{ items: TimelineEvent[]; nextCursor: string | null }> {
  const p = clientTimelineSchema.parse(input);
  assertCan(ctx, 'read', 'client');
  assertCan(ctx, 'list', 'followUp');
  const db = getDb();

  const client = await db.client.findFirst({
    where: { id: p.clientId, deletedAt: undefined },
    select: { id: true, deletedAt: true },
  });
  if (!client || (client.deletedAt && ctx.user.role !== 'ADMIN')) {
    throw new NotFoundError('client');
  }
  if (p.entityType) {
    targetFor(p.entityType);
    if (p.entityType === 'CLIENT' && p.entityId !== p.clientId) {
      throw new DomainError('That record is not on this client', { field: 'entityId' });
    }
  }

  // Readable records of each audited type on this client (including deleted ones).
  const records: { entityType: FollowUpEntityTypeValue; model: string; ids: string[] }[] = [];
  for (const [entityType, target] of supportedTargets()) {
    if (!target.auditModel) continue;
    if (p.entityType && p.entityType !== entityType) continue;
    let ids = await target.visibleIds(db, ctx.user, p.clientId);
    if (p.entityId) ids = ids.filter((id) => id === p.entityId);
    records.push({ entityType, model: target.auditModel, ids });
  }
  const modelType = new Map(records.map((r) => [r.model, r.entityType]));
  const wants = (kind: TimelineKind) => !p.kinds || p.kinds.includes(kind);

  // M7: documents on those records (a document kind shares its record type's name).
  const documents = wants('DOCUMENT')
    ? await db.document.findMany({
        where: {
          deletedAt: undefined,
          OR: records
            .filter((r) => kindSpec(r.entityType as DocumentKindValue) && r.ids.length > 0)
            .map((r) => ({ kind: r.entityType as DocumentKindValue, entityId: { in: r.ids } })),
        },
        select: { id: true, kind: true, entityId: true },
      })
    : [];
  const documentOf = new Map(documents.map((d) => [d.id, d]));

  const take = p.limit + 1;

  const followUps = wants('FOLLOW_UP')
    ? await db.followUp.findMany({
        where: {
          clientId: p.clientId,
          ...(p.entityType && { entityType: p.entityType, entityId: p.entityId }),
          AND: [
            scopeFollowUps(
              ctx.user,
              Object.fromEntries(
                records.filter((r) => r.entityType !== 'CLIENT').map((r) => [r.entityType, r.ids]),
              ),
            ),
            ...(p.cursor ? [followUpsAfter(p.cursor)] : []),
          ],
        },
        include: {
          user: { select: { id: true, name: true } },
          contact: { select: { id: true, name: true } },
        },
        orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
        take,
      })
    : [];

  const actions: Prisma.AuditLogWhereInput[] = [
    ...(wants('CREATED') ? [{ action: 'CREATE' as const }] : []),
    ...(wants('STATUS_CHANGE')
      ? [{ action: 'UPDATE' as const, changedFields: { has: 'status' } }]
      : []),
    ...(wants('DELETED') ? [{ action: 'SOFT_DELETE' as const }] : []),
    ...(wants('RESTORED') ? [{ action: 'RESTORE' as const }] : []),
  ];
  const withRecords = records.filter((r) => r.ids.length > 0);
  const sources: Prisma.AuditLogWhereInput[] = [
    ...(actions.length > 0 && withRecords.length > 0
      ? [
          {
            AND: [
              { OR: withRecords.map((r) => ({ entityType: r.model, entityId: { in: r.ids } })) },
              { OR: actions },
            ],
          },
        ]
      : []),
    ...(documents.length > 0
      ? [
          {
            entityType: 'Document',
            entityId: { in: [...documentOf.keys()] },
            OR: [
              { action: { in: ['CREATE', 'SOFT_DELETE', 'RESTORE'] as AuditAction[] } },
              { action: 'UPDATE' as const, changedFields: { has: 'reviewStatus' } },
            ],
          },
        ]
      : []),
  ];
  const audits =
    sources.length > 0
      ? await db.auditLog.findMany({
          where: {
            AND: [{ OR: sources }, ...(p.cursor ? [auditAfter(p.cursor)] : [])],
          },
          select: {
            id: true,
            action: true,
            entityType: true,
            entityId: true,
            before: true,
            after: true,
            createdAt: true,
            requestId: true,
            actor: { select: { id: true, name: true } },
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          take,
        })
      : [];

  // A document deleted in the same request as an upload was replaced by it (M7 Decision 2).
  const deletedDocs = audits.filter(
    (a) => a.entityType === 'Document' && a.action === 'SOFT_DELETE',
  );
  const replacing = new Set(
    deletedDocs.length > 0
      ? (
          await db.auditLog.findMany({
            where: {
              entityType: 'Document',
              action: 'CREATE',
              requestId: { in: deletedDocs.map((a) => a.requestId) },
            },
            select: { requestId: true },
          })
        ).map((r) => r.requestId)
      : [],
  );

  /** The record an audit row belongs to (a document's is its quotation, PO or invoice). */
  const recordOf = (a: { entityType: string; entityId: string }) => {
    const doc = a.entityType === 'Document' ? documentOf.get(a.entityId) : undefined;
    return doc
      ? { entityType: doc.kind as FollowUpEntityTypeValue, entityId: doc.entityId }
      : { entityType: modelType.get(a.entityType)!, entityId: a.entityId };
  };

  const label = await labelsFor(db, [...followUps, ...audits.map(recordOf)]);

  const followUpEvents = followUps.map((f): TimelineEvent & Keyed => {
    const entity = { type: f.entityType, id: f.entityId, ...label(f.entityType, f.entityId) };
    return {
      id: f.id,
      kind: 'FOLLOW_UP',
      at: f.createdAt,
      day: toCalendarDateString(f.date),
      rank: RANK.followUp,
      actor: f.user,
      entity,
      summary: CHANNEL_LABEL[f.channel],
      followUp: {
        date: f.date,
        channel: f.channel,
        notes: f.notes,
        contact: f.contact,
        nextFollowUpDate: f.nextFollowUpDate,
        userId: f.userId,
      },
    };
  });

  const auditEvents = audits.map((a): TimelineEvent & Keyed => {
    const record = recordOf(a);
    const entity = {
      type: record.entityType,
      id: record.entityId,
      ...label(record.entityType, record.entityId),
    };
    if (a.entityType === 'Document') {
      const mapped = DOCUMENT_ACTION[a.action as keyof typeof DOCUMENT_ACTION];
      const action = mapped === 'DELETED' && replacing.has(a.requestId) ? 'REPLACED' : mapped;
      // Whitelisted fields only: the filename and applied field names, never values.
      const row = (a.after ?? a.before ?? {}) as {
        originalFilename?: unknown;
        appliedFields?: unknown;
      };
      const filename = typeof row.originalFilename === 'string' ? row.originalFilename : 'document';
      const applied = Array.isArray(row.appliedFields)
        ? row.appliedFields.filter((f): f is string => typeof f === 'string')
        : [];
      const detail =
        action === 'CONFIRMED' && applied.length > 0 ? ` · applied ${applied.join(', ')}` : '';
      return {
        id: a.id,
        kind: 'DOCUMENT',
        at: a.createdAt,
        day: istDay(a.createdAt),
        rank: RANK.audit,
        actor: a.actor,
        entity,
        summary: `${DOCUMENT_VERB[action]} ${filename}${detail}`,
        document: {
          id: a.entityId,
          filename,
          action,
          ...(action === 'CONFIRMED' && { appliedFields: applied }),
        },
      };
    }
    const kind = AUDIT_KIND[a.action]!;
    const event: TimelineEvent & Keyed = {
      id: a.id,
      kind,
      at: a.createdAt,
      day: istDay(a.createdAt),
      rank: RANK.audit,
      actor: a.actor,
      entity,
      summary: AUDIT_SUMMARY[kind] ?? '',
    };
    if (kind === 'STATUS_CHANGE') {
      const from = String((a.before as { status?: unknown } | null)?.status ?? '');
      const after = (a.after ?? {}) as {
        status?: unknown;
        lostReason?: unknown;
        poReceivedDate?: unknown;
        holdReason?: unknown;
        completedDate?: unknown;
        cancelReason?: unknown;
      };
      const to = String(after.status ?? '');
      // Whitelisted fields only; amounts and revenue never reach the timeline (M6, M8).
      event.change = {
        from,
        to,
        ...(to === 'LOST' && typeof after.lostReason === 'string'
          ? { lostReason: after.lostReason }
          : {}),
        ...(to === 'PO_RECEIVED' && typeof after.poReceivedDate === 'string'
          ? { poReceivedDate: after.poReceivedDate.slice(0, 10) }
          : {}),
        ...(to === 'ON_HOLD' && typeof after.holdReason === 'string'
          ? { holdReason: after.holdReason }
          : {}),
        ...(to === 'COMPLETED' && typeof after.completedDate === 'string'
          ? { completedDate: after.completedDate.slice(0, 10) }
          : {}),
        ...(to === 'CANCELLED' && typeof after.cancelReason === 'string'
          ? { cancelReason: after.cancelReason }
          : {}),
      };
      event.summary = `${from} → ${to}`;
    }
    return event;
  });

  const merged = merge(followUpEvents, auditEvents);
  const page = merged.slice(0, p.limit);
  const last = page.at(-1);
  const nextCursor =
    merged.length > p.limit && last
      ? encodeTimelineCursor({
          day: last.day,
          at: last.at.toISOString(),
          rank: last.rank,
          id: last.id,
        })
      : null;
  return { items: page.map(({ rank: _rank, ...event }) => event), nextCursor };
}
