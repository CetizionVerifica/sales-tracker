import type { Db } from '../clients.ts';
import { DomainError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import { enquiryResource, scopeEnquiries } from '../rbac/scope.ts';
import type { Actor, Resource } from '../rbac/types.ts';
import type { FollowUpEntityTypeValue } from '../schemas/follow-up.ts';

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
   * Runs in the logging transaction after the follow-up is created. M6 uses it to update
   * the quotation's next follow-up date and highlights (M5 Decision 6).
   */
  afterLog?(db: Db, followUp: { id: string; entityId: string }): Promise<void>;
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

export const FOLLOW_UP_TARGETS: Partial<Record<FollowUpEntityTypeValue, FollowUpTarget>> = {
  CLIENT: clientTarget,
  ENQUIRY: enquiryTarget,
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
): Promise<{ ENQUIRY: string[] }> {
  if (user.role === 'ADMIN') return { ENQUIRY: [] };
  return { ENQUIRY: await enquiryTarget.visibleIds(db, user, clientId) };
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
