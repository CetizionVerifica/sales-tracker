import type { Db } from '../clients.ts';
import { DomainError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import {
  enquiryResource,
  quotationResource,
  scopeEnquiries,
  scopeQuotations,
} from '../rbac/scope.ts';
import type { Actor, Resource } from '../rbac/types.ts';
import type { FollowUpEntityTypeValue } from '../schemas/follow-up.ts';
import { isActiveQuotation } from '../status/quotation.ts';

/**
 * The records a follow-up can be linked to (M5 Decision 3). `entityId` has no foreign key,
 * so everything the follow-up and timeline services need to know about a linked record
 * comes from here. M6–M10 each add one entry; nothing else changes.
 */
export interface FollowUpTarget {
  /** AuditLog `entityType` whose CREATE / status / delete rows appear on the timeline. */
  auditModel?: string;
  /** Includes soft-deleted records; null when the id does not exist. */
  load(db: Db, id: string): Promise<LinkedRecord | null>;
  /** Ids of this type the user may read, including soft-deleted ones (timeline history). */
  visibleIds(db: Db, user: Actor, clientId?: string): Promise<string[]>;
  /** Display labels, including soft-deleted records. */
  labels(db: Db, ids: string[]): Promise<Map<string, { label: string; deleted: boolean }>>;
  /** Live records on a client the user may read, for the "log follow-up" record picker. */
  pickable(db: Db, user: Actor, clientId: string): Promise<{ id: string; label: string }[]>;
  /**
   * Runs in the same transaction after a follow-up on this record is logged, edited, deleted
   * or restored. M6 uses it to keep the quotation's next follow-up date and highlights in
   * step with the latest follow-up (M5 Decision 6, M6 Decision 5).
   */
  afterChange?(db: Db, followUp: { id: string; entityId: string }): Promise<void>;
  /** Whether a follow-up on this record must carry a next follow-up date (open quotations). */
  requiresNextFollowUp?(db: Db, entityId: string): Promise<boolean>;
}

export interface LinkedRecord {
  clientId: string;
  label: string;
  /** The record, or its client, is soft deleted. */
  deleted: boolean;
  /** The can() resource for reading the record. */
  resource: Resource;
}

const clientTarget: FollowUpTarget = {
  async load(db, id) {
    const client = await db.client.findFirst({
      where: { id, deletedAt: undefined },
      select: { id: true, name: true, deletedAt: true },
    });
    return client
      ? { clientId: client.id, label: client.name, deleted: !!client.deletedAt, resource: 'client' }
      : null;
  },
  // Everyone reads clients (M3 Decision 11); client-level notes are scoped by type instead.
  async visibleIds(_db, _user, clientId) {
    return clientId ? [clientId] : [];
  },
  async labels(db, ids) {
    const rows = await db.client.findMany({
      where: { id: { in: ids }, deletedAt: undefined },
      select: { id: true, name: true, deletedAt: true },
    });
    return new Map(rows.map((r) => [r.id, { label: r.name, deleted: !!r.deletedAt }]));
  },
  async pickable() {
    return []; // the client itself is always offered by listFollowUpTargets
  },
};

const enquiryTarget: FollowUpTarget = {
  auditModel: 'Enquiry',
  async load(db, id) {
    const row = await db.enquiry.findFirst({
      where: { id, deletedAt: undefined },
      select: {
        number: true,
        ownerId: true,
        clientId: true,
        deletedAt: true,
        client: { select: { deletedAt: true } },
      },
    });
    if (!row) return null;
    return {
      clientId: row.clientId,
      label: row.number,
      deleted: !!row.deletedAt || !!row.client.deletedAt,
      resource: enquiryResource(row),
    };
  },
  async visibleIds(db, user, clientId) {
    const rows = await db.enquiry.findMany({
      where: { deletedAt: undefined, ...(clientId && { clientId }), AND: [scopeEnquiries(user)] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },
  async labels(db, ids) {
    const rows = await db.enquiry.findMany({
      where: { id: { in: ids }, deletedAt: undefined },
      select: { id: true, number: true, deletedAt: true },
    });
    return new Map(rows.map((r) => [r.id, { label: r.number, deleted: !!r.deletedAt }]));
  },
  async pickable(db, user, clientId) {
    const rows = await db.enquiry.findMany({
      where: { clientId, AND: [scopeEnquiries(user)] },
      select: { id: true, number: true },
      orderBy: { number: 'desc' },
    });
    return rows.map((r) => ({ id: r.id, label: r.number }));
  },
};

/** Highlights keep the first 1000 characters of the follow-up's notes (M6 schema limit). */
export const HIGHLIGHTS_MAX = 1000;

/**
 * Copies the latest live follow-up on a quotation onto it (M6 Decision 5): notes into
 * `lastFollowUpHighlights`, its id into `lastFollowUpId`, and, while the quotation is open,
 * its next date into `nextFollowUpDate`. Runs only when the latest follow-up is a different
 * one than last synced, or is the one that just changed, so a hand edit survives changes to
 * older follow-ups. With no live follow-up left, nothing changes (the required date is never
 * cleared). Writes only fields whose value differs, so the audit log shows real changes.
 * Not exported: it takes no ctx, so it must only run from the registry hook, inside a
 * follow-up service's permission-checked, audited transaction.
 */
async function syncQuotationFromFollowUps(
  db: Db,
  quotationId: string,
  changedFollowUpId: string,
): Promise<void> {
  const quotation = await db.quotation.findFirst({
    where: { id: quotationId },
    select: {
      status: true,
      nextFollowUpDate: true,
      lastFollowUpHighlights: true,
      lastFollowUpId: true,
    },
  });
  if (!quotation) return;
  const latest = await db.followUp.findFirst({
    where: { entityType: 'QUOTATION', entityId: quotationId },
    select: { id: true, notes: true, nextFollowUpDate: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  if (!latest) return;
  if (latest.id === quotation.lastFollowUpId && latest.id !== changedFollowUpId) return;

  const data: {
    lastFollowUpHighlights?: string;
    lastFollowUpId?: string;
    nextFollowUpDate?: Date;
  } = {};
  const highlights = latest.notes.slice(0, HIGHLIGHTS_MAX);
  if (highlights !== quotation.lastFollowUpHighlights) data.lastFollowUpHighlights = highlights;
  if (latest.id !== quotation.lastFollowUpId) data.lastFollowUpId = latest.id;
  if (
    isActiveQuotation(quotation.status) &&
    latest.nextFollowUpDate &&
    latest.nextFollowUpDate.getTime() !== quotation.nextFollowUpDate?.getTime()
  ) {
    data.nextFollowUpDate = latest.nextFollowUpDate;
  }
  if (Object.keys(data).length > 0) {
    await db.quotation.update({ where: { id: quotationId }, data });
  }
}

const quotationTarget: FollowUpTarget = {
  auditModel: 'Quotation',
  async load(db, id) {
    const row = await db.quotation.findFirst({
      where: { id, deletedAt: undefined },
      select: {
        number: true,
        ownerId: true,
        clientId: true,
        deletedAt: true,
        client: { select: { deletedAt: true } },
      },
    });
    if (!row) return null;
    return {
      clientId: row.clientId,
      label: row.number,
      deleted: !!row.deletedAt || !!row.client.deletedAt,
      resource: quotationResource(row),
    };
  },
  async visibleIds(db, user, clientId) {
    const rows = await db.quotation.findMany({
      where: { deletedAt: undefined, ...(clientId && { clientId }), AND: [scopeQuotations(user)] },
      select: { id: true },
    });
    return rows.map((r) => r.id);
  },
  async labels(db, ids) {
    const rows = await db.quotation.findMany({
      where: { id: { in: ids }, deletedAt: undefined },
      select: { id: true, number: true, deletedAt: true },
    });
    return new Map(rows.map((r) => [r.id, { label: r.number, deleted: !!r.deletedAt }]));
  },
  async pickable(db, user, clientId) {
    const rows = await db.quotation.findMany({
      where: { clientId, AND: [scopeQuotations(user)] },
      select: { id: true, number: true },
      orderBy: { number: 'desc' },
    });
    return rows.map((r) => ({ id: r.id, label: r.number }));
  },
  async afterChange(db, followUp) {
    await syncQuotationFromFollowUps(db, followUp.entityId, followUp.id);
  },
  async requiresNextFollowUp(db, entityId) {
    const row = await db.quotation.findFirst({
      where: { id: entityId, deletedAt: undefined },
      select: { status: true },
    });
    return !!row && isActiveQuotation(row.status);
  },
};

export const FOLLOW_UP_TARGETS: Partial<Record<FollowUpEntityTypeValue, FollowUpTarget>> = {
  CLIENT: clientTarget,
  ENQUIRY: enquiryTarget,
  QUOTATION: quotationTarget,
};

/** The registry entry, or a field error for a type whose module has not shipped. */
export function targetFor(entityType: FollowUpEntityTypeValue): FollowUpTarget {
  const target = FOLLOW_UP_TARGETS[entityType];
  if (!target) {
    throw new DomainError('Follow-ups cannot be logged on this kind of record yet', {
      field: 'entityType',
    });
  }
  return target;
}

/** Supported types, in registry order. */
export function supportedTargets(): [FollowUpEntityTypeValue, FollowUpTarget][] {
  return Object.entries(FOLLOW_UP_TARGETS) as [FollowUpEntityTypeValue, FollowUpTarget][];
}

export function canReadRecord(user: Actor, record: LinkedRecord): boolean {
  return can(user, 'read', record.resource);
}

/** Readable ids per type, for scopeFollowUps. Admins are unscoped, so nothing is resolved. */
export async function visibleRecordIds(
  db: Db,
  user: Actor,
  clientId?: string,
): Promise<{ ENQUIRY: string[]; QUOTATION: string[] }> {
  if (user.role === 'ADMIN') return { ENQUIRY: [], QUOTATION: [] };
  return {
    ENQUIRY: await enquiryTarget.visibleIds(db, user, clientId),
    QUOTATION: await quotationTarget.visibleIds(db, user, clientId),
  };
}

/** Labels for a mixed list of (type, id) pairs, one query per type. */
export async function labelsFor(
  db: Db,
  refs: { entityType: FollowUpEntityTypeValue; entityId: string }[],
): Promise<(type: FollowUpEntityTypeValue, id: string) => { label: string; deleted: boolean }> {
  const byType = new Map<FollowUpEntityTypeValue, Set<string>>();
  for (const { entityType, entityId } of refs) {
    byType.set(entityType, (byType.get(entityType) ?? new Set()).add(entityId));
  }
  const labels = new Map<string, { label: string; deleted: boolean }>();
  for (const [type, ids] of byType) {
    const found = await targetFor(type).labels(db, [...ids]);
    for (const [id, value] of found) labels.set(`${type}:${id}`, value);
  }
  return (type, id) => labels.get(`${type}:${id}`) ?? { label: 'Unknown record', deleted: true };
}
