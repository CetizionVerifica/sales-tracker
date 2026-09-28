import { getDb, type Db } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import {
  invoiceAccessSelect,
  invoiceResource,
  scopeEnquiries,
  scopeInvoices,
  scopeProjects,
  scopePurchaseOrders,
  scopeQuotations,
} from '../rbac/scope.ts';
import type { Actor } from '../rbac/types.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { FollowUpEntityTypeValue } from '../schemas/follow-up.ts';
import {
  MY_TODAY_HORIZON_DAYS,
  MY_TODAY_KIND_GROUPS,
  myTodaySchema,
  type MyToday,
  type MyTodayAction,
  type MyTodayInput,
  type MyTodayRow,
} from '../schemas/my-today.ts';
import { UNPAID_INVOICE_STATUSES } from '../status/invoice.ts';
import { ACTIVE_PROJECT_STATUSES } from '../status/project.ts';
import { ACTIVE_QUOTATION_STATUSES } from '../status/quotation.ts';
import { findDocumentsPendingReview } from './document-queries.ts';
import { findStaleEnquiries } from './enquiry-queries.ts';
import { invoiceLabel, projectLabel, purchaseOrderLabel, targetFor } from './follow-up-targets.ts';
import { dueWindowWhere } from './invoice-queries.ts';
import {
  addDays,
  istDayOf,
  mergeCandidates,
  splitSections,
  type MergedRow,
  type MyTodayCandidate,
} from './my-today-merge.ts';
import { SETTINGS_ID } from './settings.service.ts';

/*
 * My Today (M11): each user's rows, computed on read from the pipeline tables (Decision 8).
 * Read-only: no writes, no transaction, no audit rows.
 *
 * Every source ANDs the viewed user's own scope with their responsibility filter
 * (Decision 1), so a row never names a record that user cannot read, and an admin viewing
 * someone's list (Decision 6) sees exactly what that user sees.
 */

const DAY_MS = 86_400_000;
const liveClient = { client: { deletedAt: null } };
const clientSelect = { client: { select: { id: true, name: true } } } as const;

type InvoiceAccess = Parameters<typeof invoiceResource>[0];

interface Collected {
  rows: MergedRow[];
  /** Invoices named by rows, for the viewer's Mark paid permission. */
  invoiceAccess: Map<string, InvoiceAccess>;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);
const truncate = (text: string, max = 160) =>
  text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;

// ─── Sources ────────────────────────────────────────────────────────────────────────

/** Overdue invoices, and pending ones due today to +7, for the PM and pipeline owner. */
async function invoiceRows(db: Db, subject: Actor, today: Date, out: Collected) {
  const invoices = await db.invoice.findMany({
    where: {
      AND: [
        scopeInvoices(subject),
        liveClient,
        {
          purchaseOrder: {
            deletedAt: null,
            project: {
              deletedAt: null,
              // Decision 12: both the project's PM and the pipeline owner.
              OR: [{ managerId: subject.id }, { quotation: { ownerId: subject.id } }],
            },
          },
        },
        { OR: [dueWindowWhere('overdue', today), dueWindowWhere('next7', today)] },
      ],
    },
    select: {
      id: true,
      invoiceNumber: true,
      invoiceDate: true,
      dueDate: true,
      status: true,
      amountMinor: true,
      currency: true,
      ...clientSelect,
      ...invoiceAccessSelect,
    },
  });
  return invoices.map((inv): MyTodayCandidate => {
    out.invoiceAccess.set(inv.id, inv);
    const days = daysBetween(inv.dueDate, today);
    const overdue = inv.status === 'OVERDUE';
    return {
      key: `INVOICE:${inv.id}`,
      kind: overdue ? 'INVOICE_OVERDUE' : 'INVOICE_DUE',
      dueDate: inv.dueDate,
      record: { type: 'INVOICE', id: inv.id, label: invoiceLabel(inv) },
      client: inv.client,
      title: overdue
        ? `Chase payment — ${plural(days, 'day')} overdue`
        : days === 0
          ? 'Payment due today'
          : 'Payment due',
      detail: null,
      amount: { amountMinor: inv.amountMinor, currency: inv.currency },
      invoiceDate: inv.invoiceDate,
      followUpTarget: { entityType: 'INVOICE', entityId: inv.id },
    };
  });
}

/** Open quotations whose next follow-up is due within the horizon, for their owner. */
async function quotationRows(db: Db, subject: Actor, horizon: Date) {
  const quotations = await db.quotation.findMany({
    where: {
      AND: [
        scopeQuotations(subject),
        liveClient,
        {
          ownerId: subject.id,
          status: { in: [...ACTIVE_QUOTATION_STATUSES] },
          nextFollowUpDate: { lte: horizon },
        },
      ],
    },
    select: {
      id: true,
      number: true,
      nextFollowUpDate: true,
      lastFollowUpHighlights: true,
      ...clientSelect,
    },
  });
  return quotations.flatMap((q): MyTodayCandidate[] =>
    q.nextFollowUpDate
      ? [
          {
            key: `QUOTATION:${q.id}`,
            kind: 'QUOTATION_AWAITING_REPLY',
            dueDate: q.nextFollowUpDate,
            record: { type: 'QUOTATION', id: q.id, label: q.number },
            client: q.client,
            title: 'Follow up on the quotation',
            detail: q.lastFollowUpHighlights ? truncate(q.lastFollowUpHighlights) : null,
            amount: null,
            invoiceDate: null,
            followUpTarget: { entityType: 'QUOTATION', entityId: q.id },
          },
        ]
      : [],
  );
}

interface LatestFollowUp {
  entityType: Exclude<FollowUpEntityTypeValue, 'QUOTATION'>;
  entityId: string;
  userId: string;
  notes: string;
  next: string;
}

/**
 * The latest live follow-up per record (M5 Decision 1; getLatestFollowUp's order), when its
 * next date is within the horizon. Quotations are left out: their row comes from the
 * quotation, which M6 keeps in step with its latest follow-up. The inner filter only narrows
 * which records are considered (the latest must itself be due), so "latest" is unchanged.
 */
async function latestDueFollowUps(db: Db, subject: Actor, horizon: Date) {
  const until = toCalendarDateString(horizon);
  return db.$queryRaw<LatestFollowUp[]>`
    SELECT l."entityType", l."entityId", l."userId", l.notes,
           to_char(l."nextFollowUpDate", 'YYYY-MM-DD') AS next
    FROM (
      SELECT DISTINCT ON (f."entityType", f."entityId")
             f."entityType"::text AS "entityType", f."entityId", f."userId", f.notes,
             f."nextFollowUpDate"
      FROM follow_up f
      WHERE f."deletedAt" IS NULL AND f."entityType" <> 'QUOTATION'
        AND (f."entityType", f."entityId") IN (
          SELECT c."entityType", c."entityId" FROM follow_up c
          WHERE c."deletedAt" IS NULL AND c."entityType" <> 'QUOTATION'
            AND c."nextFollowUpDate" <= ${until}::date
            AND (c."userId" = ${subject.id}
                 OR (c."entityType" = 'ENQUIRY' AND c."entityId" IN (
                   SELECT e.id FROM enquiry e WHERE e."ownerId" = ${subject.id}))))
      ORDER BY f."entityType", f."entityId", f."date" DESC, f."createdAt" DESC, f.id DESC
    ) l
    WHERE l."nextFollowUpDate" IS NOT NULL AND l."nextFollowUpDate" <= ${until}::date`;
}

/** The row's "what to do"; the record's number is on the line below, so not repeated. */
const FOLLOW_UP_TITLES: Record<LatestFollowUp['entityType'], string> = {
  CLIENT: 'Follow up with the client',
  ENQUIRY: 'Follow up on the enquiry',
  PROJECT: 'Follow up on the project',
  PURCHASE_ORDER: 'Follow up on the PO',
  INVOICE: 'Follow up on the invoice',
};

interface OpenRecord {
  label: string;
  client: { id: string; name: string };
  invoice?: { amountMinor: bigint; currency: string; invoiceDate: Date } & InvoiceAccess;
}

/**
 * Which of the follow-ups' records are still open (M11 "record still open"), readable by the
 * user, and theirs (Decision 2): enquiries by their owner, everything else by the author.
 * One query per record type.
 */
async function openRecords(
  db: Db,
  subject: Actor,
  byType: Map<LatestFollowUp['entityType'], string[]>,
): Promise<Map<string, OpenRecord>> {
  const open = new Map<string, OpenRecord>();
  const ids = (type: LatestFollowUp['entityType']) => byType.get(type) ?? [];
  const put = (type: string, id: string, record: OpenRecord) => open.set(`${type}:${id}`, record);

  const [clients, enquiries, projects, pos, invoices] = await Promise.all([
    ids('CLIENT').length
      ? db.client.findMany({
          where: { id: { in: ids('CLIENT') } },
          select: { id: true, name: true },
        })
      : [],
    ids('ENQUIRY').length
      ? db.enquiry.findMany({
          where: {
            AND: [
              scopeEnquiries(subject),
              liveClient,
              { id: { in: ids('ENQUIRY') }, ownerId: subject.id, status: 'IN_PROGRESS' },
            ],
          },
          select: { id: true, number: true, ...clientSelect },
        })
      : [],
    ids('PROJECT').length
      ? db.project.findMany({
          where: {
            AND: [
              scopeProjects(subject),
              liveClient,
              { id: { in: ids('PROJECT') }, status: { in: [...ACTIVE_PROJECT_STATUSES] } },
            ],
          },
          select: { id: true, number: true, name: true, ...clientSelect },
        })
      : [],
    ids('PURCHASE_ORDER').length
      ? db.purchaseOrder.findMany({
          where: {
            AND: [
              scopePurchaseOrders(subject),
              liveClient,
              {
                id: { in: ids('PURCHASE_ORDER') },
                status: { not: 'PAID' },
                project: { deletedAt: null },
              },
            ],
          },
          select: { id: true, poNumber: true, ...clientSelect },
        })
      : [],
    ids('INVOICE').length
      ? db.invoice.findMany({
          where: {
            AND: [
              scopeInvoices(subject),
              liveClient,
              {
                id: { in: ids('INVOICE') },
                status: { in: [...UNPAID_INVOICE_STATUSES] },
                purchaseOrder: { deletedAt: null },
              },
            ],
          },
          select: {
            id: true,
            invoiceNumber: true,
            invoiceDate: true,
            amountMinor: true,
            currency: true,
            ...clientSelect,
            ...invoiceAccessSelect,
          },
        })
      : [],
  ]);
  for (const c of clients) put('CLIENT', c.id, { label: c.name, client: c });
  for (const e of enquiries) put('ENQUIRY', e.id, { label: e.number, client: e.client });
  for (const p of projects) put('PROJECT', p.id, { label: projectLabel(p), client: p.client });
  for (const po of pos) {
    put('PURCHASE_ORDER', po.id, { label: purchaseOrderLabel(po), client: po.client });
  }
  for (const inv of invoices) {
    put('INVOICE', inv.id, { label: invoiceLabel(inv), client: inv.client, invoice: inv });
  }
  return open;
}

async function followUpRows(
  db: Db,
  subject: Actor,
  horizon: Date,
  out: Collected,
): Promise<MyTodayCandidate[]> {
  const latest = (await latestDueFollowUps(db, subject, horizon)).filter(
    // Decision 2: an enquiry's follow-ups are its owner's (checked in openRecords);
    // everything else is the author's.
    (f) => f.entityType === 'ENQUIRY' || f.userId === subject.id,
  );
  const byType = new Map<LatestFollowUp['entityType'], string[]>();
  for (const f of latest)
    byType.set(f.entityType, [...(byType.get(f.entityType) ?? []), f.entityId]);
  const open = await openRecords(db, subject, byType);

  return latest.flatMap((f): MyTodayCandidate[] => {
    const record = open.get(`${f.entityType}:${f.entityId}`);
    if (!record) return [];
    if (record.invoice) out.invoiceAccess.set(f.entityId, record.invoice);
    return [
      {
        key: `${f.entityType}:${f.entityId}`,
        kind: 'FOLLOW_UP_DUE',
        dueDate: new Date(`${f.next}T00:00:00.000Z`),
        record: { type: f.entityType, id: f.entityId, label: record.label },
        client: record.client,
        title: FOLLOW_UP_TITLES[f.entityType],
        detail: truncate(f.notes),
        amount: record.invoice
          ? { amountMinor: record.invoice.amountMinor, currency: record.invoice.currency }
          : null,
        invoiceDate: record.invoice?.invoiceDate ?? null,
        followUpTarget: { entityType: f.entityType, entityId: f.entityId },
      },
    ];
  });
}

/** Active projects past their planned end, for their PM (M8's behind-schedule rule). */
async function projectRows(db: Db, subject: Actor, today: Date) {
  const projects = await db.project.findMany({
    where: {
      AND: [
        scopeProjects(subject),
        liveClient,
        {
          managerId: subject.id,
          status: { in: [...ACTIVE_PROJECT_STATUSES] },
          endDate: { lt: today },
        },
      ],
    },
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      completionPct: true,
      holdReason: true,
      endDate: true,
      ...clientSelect,
    },
  });
  return projects.flatMap((p): MyTodayCandidate[] =>
    p.endDate
      ? [
          {
            key: `PROJECT:${p.id}`,
            kind: 'PROJECT_BEHIND_SCHEDULE',
            dueDate: p.endDate,
            record: { type: 'PROJECT', id: p.id, label: projectLabel(p) },
            client: p.client,
            title: `Past planned end — ${p.completionPct}% complete`,
            detail: p.status === 'ON_HOLD' && p.holdReason ? `On hold: ${p.holdReason}` : null,
            amount: null,
            invoiceDate: null,
            followUpTarget: { entityType: 'PROJECT', entityId: p.id },
          },
        ]
      : [],
  );
}

/** In-progress enquiries with no planned next step, untouched for `staleEnquiryDays`. */
async function staleEnquiryRows(db: Db, subject: Actor, today: Date) {
  const { staleEnquiryDays: days } = await db.companySettings.findUniqueOrThrow({
    where: { id: SETTINGS_ID },
    select: { staleEnquiryDays: true },
  });
  const stale = await findStaleEnquiries(db, { today, days, ownerId: subject.id });
  if (stale.length === 0) return [];
  const lastTouch = new Map(stale.map((s) => [s.id, s.lastTouch]));
  const enquiries = await db.enquiry.findMany({
    where: {
      AND: [scopeEnquiries(subject), liveClient, { id: { in: stale.map((s) => s.id) } }],
    },
    select: { id: true, number: true, ...clientSelect },
  });
  return enquiries.map((e): MyTodayCandidate => {
    const touched = lastTouch.get(e.id)!;
    return {
      key: `ENQUIRY:${e.id}`,
      kind: 'STALE_ENQUIRY',
      dueDate: addDays(touched, days),
      record: { type: 'ENQUIRY', id: e.id, label: e.number },
      client: e.client,
      title: `No activity for ${plural(daysBetween(touched, today), 'day')}`,
      detail: null,
      amount: null,
      invoiceDate: null,
      followUpTarget: { entityType: 'ENQUIRY', entityId: e.id },
    };
  });
}

/** M7's "documents to review", for the viewed user. Keyed by the document (Decision 4). */
async function documentRows(db: Db, subject: Actor) {
  const docs = await findDocumentsPendingReview(db, subject);
  const labels = new Map<string, string>();
  for (const kind of new Set(docs.map((d) => d.kind))) {
    const ids = docs.filter((d) => d.kind === kind).map((d) => d.entityId);
    for (const [id, { label }] of await targetFor(kind).labels(db, ids)) labels.set(id, label);
  }
  return docs.map((d): MyTodayCandidate => ({
    key: `DOCUMENT:${d.id}`,
    kind: 'DOCUMENT_TO_REVIEW',
    dueDate: istDayOf(d.extractedAt ?? d.updatedAt),
    record: { type: 'DOCUMENT', id: d.id, label: labels.get(d.entityId) ?? d.originalFilename },
    client: { id: d.clientId, name: d.client.name },
    title: 'Review extracted fields',
    detail: d.originalFilename,
    amount: null,
    invoiceDate: null,
    followUpTarget: { entityType: d.kind, entityId: d.entityId },
  }));
}

// ─── Assembly ───────────────────────────────────────────────────────────────────────

async function collectRows(db: Db, subject: Actor, today: Date): Promise<Collected> {
  const horizon = addDays(today, MY_TODAY_HORIZON_DAYS);
  const out: Collected = { rows: [], invoiceAccess: new Map() };
  const sources = await Promise.all([
    invoiceRows(db, subject, today, out),
    quotationRows(db, subject, horizon),
    followUpRows(db, subject, horizon, out),
    projectRows(db, subject, today),
    staleEnquiryRows(db, subject, today),
    documentRows(db, subject),
  ]);
  out.rows = mergeCandidates(sources.flat());
  return out;
}

/** What the viewer may do from a row (Decision 6: Open only on someone else's list). */
function actionsFor(
  viewer: Actor,
  viewingOther: boolean,
  row: MergedRow,
  invoiceAccess: Map<string, InvoiceAccess>,
): MyTodayAction[] {
  if (viewingOther) return ['OPEN'];
  if (row.record.type === 'DOCUMENT') return ['REVIEW', 'OPEN'];
  // Every row's record is readable by its user, and logging needs read (M5 Decision 10).
  const actions: MyTodayAction[] = ['LOG_FOLLOW_UP'];
  const access = row.record.type === 'INVOICE' ? invoiceAccess.get(row.record.id) : undefined;
  if (access && can(viewer, 'update', invoiceResource(access))) actions.push('MARK_PAID');
  actions.push('OPEN');
  return actions;
}

interface Subject {
  actor: Actor;
  name: string;
  viewingOther: boolean;
}

/** The user whose list is shown: the actor, or (admins) an active, non-system user. */
async function resolveSubject(db: Db, ctx: Ctx, userId: string | undefined): Promise<Subject> {
  const id = userId ?? ctx.user.id;
  // Another user's list is not found for non-admins, like any record they cannot read.
  if (!can(ctx.user, 'read', { type: 'myToday', userId: id })) throw new NotFoundError('user');
  const user = await db.user.findFirst({
    where: { id, active: true, isSystem: false },
    select: { id: true, name: true, role: true, active: true },
  });
  if (!user) throw new NotFoundError('user');
  return {
    actor: { id: user.id, role: user.role, active: user.active },
    name: user.name,
    viewingOther: id !== ctx.user.id,
  };
}

/**
 * The user's My Today: rows due within the next seven days, one per record, in three
 * sections by due date (Decisions 3, 4, 7). `today` is the IST day unless pinned (tests).
 */
export async function getMyToday(
  ctx: Ctx,
  input: MyTodayInput = {},
  options: { today?: Date } = {},
): Promise<MyToday> {
  const { userId, kind } = myTodaySchema.parse(input);
  const db = getDb();
  const today = options.today ?? todayInIST();
  const subject = await resolveSubject(db, ctx, userId);
  const { rows, invoiceAccess } = await collectRows(db, subject.actor, today);
  // Chip counts and the badge describe the whole list; sections follow the chip, filtered
  // before the 100-row cap so their counts stay exact (Decision 7).
  const all = splitSections(rows, today);
  const kinds = kind ? new Set<string>(MY_TODAY_KIND_GROUPS[kind]) : null;
  const { sections, counts } = kinds
    ? splitSections(
        rows.filter((row) => kinds.has(row.kind)),
        today,
      )
    : all;
  const withActions = (list: (MergedRow & { daysFromToday: number })[]): MyTodayRow[] =>
    list.map((row) => ({
      ...row,
      actions: actionsFor(ctx.user, subject.viewingOther, row, invoiceAccess),
    }));
  return {
    today,
    user: { id: subject.actor.id, name: subject.name },
    viewingOther: subject.viewingOther,
    kind: kind ?? null,
    sections: {
      overdue: withActions(sections.overdue),
      dueToday: withActions(sections.dueToday),
      comingUp: withActions(sections.comingUp),
    },
    counts: {
      overdue: counts.overdue,
      dueToday: counts.dueToday,
      comingUp: counts.comingUp,
      byKind: all.counts.byKind,
      badge: all.counts.overdue + all.counts.dueToday,
    },
  };
}

/** The nav badge: the actor's overdue and due-today rows, on the same code path. */
export async function myTodayBadgeCount(ctx: Ctx, options: { today?: Date } = {}): Promise<number> {
  return (await getMyToday(ctx, {}, options)).counts.badge;
}
