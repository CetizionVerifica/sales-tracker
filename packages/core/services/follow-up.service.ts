import type { Prisma } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import { followUpResource, scopeFollowUps } from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import type { Page } from '../schemas/common.ts';
import {
  createFollowUpSchema,
  listFollowUpsSchema,
  NEXT_BEFORE_DATE,
  updateFollowUpSchema,
  type CreateFollowUpInput,
  type FollowUpEntityTypeValue,
  type ListFollowUpsInput,
  type UpdateFollowUpInput,
} from '../schemas/follow-up.ts';
import {
  canReadRecord,
  labelsFor,
  supportedTargets,
  targetFor,
  visibleRecordIds,
} from './follow-up-targets.ts';

// `include` relations are not soft-delete filtered, so a removed contact still shows.
const followUpInclude = {
  user: { select: { id: true, name: true } },
  contact: { select: { id: true, name: true } },
} satisfies Prisma.FollowUpInclude;

type FollowUpRow = Prisma.FollowUpGetPayload<{ include: typeof followUpInclude }>;

/** A follow-up with its author, contact and the linked record's label. */
export type FollowUpDetail = FollowUpRow & { entityLabel: string; entityDeleted: boolean };

async function withLabels(db: Db, rows: FollowUpRow[]): Promise<FollowUpDetail[]> {
  const label = await labelsFor(db, rows);
  return rows.map((row) => {
    const { label: entityLabel, deleted: entityDeleted } = label(row.entityType, row.entityId);
    return { ...row, entityLabel, entityDeleted };
  });
}

async function loadDetail(db: Db, id: string): Promise<FollowUpDetail> {
  const row = await db.followUp.findFirst({
    where: { id, deletedAt: undefined },
    include: followUpInclude,
  });
  if (!row) throw new NotFoundError('followUp');
  const [detail] = await withLabels(db, [row]);
  return detail!;
}

/** Whether the user may read the record a follow-up is on (the policy's canReadLinked). */
async function canReadLinked(
  db: Db,
  ctx: Ctx,
  row: { entityType: FollowUpEntityTypeValue; entityId: string },
): Promise<boolean> {
  if (ctx.user.role === 'ADMIN') return true;
  const record = await targetFor(row.entityType).load(db, row.entityId);
  return !!record && canReadRecord(ctx.user, record);
}

const ROWS = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/** Loads a follow-up and checks `action`. Unreadable → not found (M4 Decision 7). */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROWS = 'live',
) {
  const row = await db.followUp.findFirst({
    where: { id, ...ROWS[rows] },
    select: {
      id: true,
      userId: true,
      entityType: true,
      entityId: true,
      clientId: true,
      date: true,
      nextFollowUpDate: true,
      contactId: true,
    },
  });
  if (!row) throw new NotFoundError('followUp');
  const resource = followUpResource(row, await canReadLinked(db, ctx, row));
  if (!can(ctx.user, 'read', resource)) throw new NotFoundError('followUp');
  assertCan(ctx, action, resource);
  return row;
}

async function assertContactUsable(db: Db, contactId: string, clientId: string) {
  const contact = await db.clientContact.findFirst({
    where: { id: contactId, clientId },
    select: { id: true },
  });
  if (!contact) throw new DomainError('Choose a contact at this client', { field: 'contactId' });
}

/** Open quotations always need a next follow-up date, so each follow-up on one carries it. */
async function assertNextNotRequired(
  db: Db,
  entityType: FollowUpEntityTypeValue,
  entityId: string,
) {
  if (await targetFor(entityType).requiresNextFollowUp?.(db, entityId)) {
    throw new DomainError('An open quotation needs a next follow-up date', {
      field: 'nextFollowUpDate',
    });
  }
}

/** Lets the linked record react in the same transaction (M6: quotation sync). */
async function afterChange(
  db: Db,
  row: { id: string; entityType: FollowUpEntityTypeValue; entityId: string },
) {
  await targetFor(row.entityType).afterChange?.(db, { id: row.id, entityId: row.entityId });
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

export const CONCURRENT_FOLLOW_UP_CHANGE =
  'Someone else changed this follow-up. Reload and try again.';

/**
 * Writes only if the row is still live (or still deleted, for restore) as it was read. Under
 * READ COMMITTED two requests can both pass the read, e.g. an edit and a delete at once;
 * the conditional UPDATE re-checks under the row lock, so the second updates nothing and
 * fails, and its transaction (with any audit row) rolls back. Same fix as M4's enquiries.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  deleted: boolean,
  data: Prisma.FollowUpUpdateManyMutationInput,
) {
  const { count } = await tx.followUp.updateMany({
    where: { id, deletedAt: deleted ? { not: null } : null },
    data,
  });
  if (count === 0) throw new DomainError(CONCURRENT_FOLLOW_UP_CHANGE);
}

/**
 * Logs a touchpoint on a client or one of its records. The client and author are derived,
 * never taken from input. Needs read access to a live record (M5 Decision 10).
 */
export async function logFollowUp(ctx: Ctx, input: CreateFollowUpInput): Promise<FollowUpDetail> {
  const { entityType, entityId, ...fields } = createFollowUpSchema.parse(input);
  assertCan(ctx, 'create', 'followUp');
  const target = targetFor(entityType);
  return withTx(ctx, async (tx) => {
    const record = await target.load(tx, entityId);
    if (!record || record.deleted || !canReadRecord(ctx.user, record)) {
      throw new NotFoundError(entityType.toLowerCase());
    }
    assertCan(ctx, 'create', followUpResource({ userId: ctx.user.id }, true));
    if (fields.contactId) await assertContactUsable(tx, fields.contactId, record.clientId);
    if (!fields.nextFollowUpDate) await assertNextNotRequired(tx, entityType, entityId);

    const { id } = await tx.followUp.create({
      data: { ...fields, entityType, entityId, clientId: record.clientId, userId: ctx.user.id },
      select: { id: true },
    });
    await target.afterChange?.(tx, { id, entityId });
    return loadDetail(tx, id);
  });
}

/** Author or admin. The link never changes; the next-date rule is checked on merged values. */
export async function updateFollowUp(
  ctx: Ctx,
  id: string,
  input: UpdateFollowUpInput,
): Promise<FollowUpDetail> {
  const fields = updateFollowUpSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');
    const date = fields.date ?? current.date;
    const next =
      fields.nextFollowUpDate !== undefined ? fields.nextFollowUpDate : current.nextFollowUpDate;
    if (next && next < date) throw new DomainError(NEXT_BEFORE_DATE, { field: 'nextFollowUpDate' });
    if (!next) await assertNextNotRequired(tx, current.entityType, current.entityId);
    if (fields.contactId && fields.contactId !== current.contactId) {
      await assertContactUsable(tx, fields.contactId, current.clientId);
    }
    // The date rule on merged values is also a DB CHECK, which catches a concurrent edit.
    if (Object.keys(fields).length > 0) {
      await guardedUpdate(tx, id, false, fields);
      await afterChange(tx, current);
    }
    return loadDetail(tx, id);
  });
}

export async function softDeleteFollowUp(ctx: Ctx, id: string): Promise<FollowUpDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete');
    await guardedUpdate(tx, id, false, { deletedAt: new Date() });
    await afterChange(tx, current);
    return loadDetail(tx, id);
  });
}

export async function restoreFollowUp(ctx: Ctx, id: string): Promise<FollowUpDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete', 'deleted');
    await guardedUpdate(tx, id, true, { deletedAt: null });
    await afterChange(tx, current);
    return loadDetail(tx, id);
  });
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  date: (dir) => ({ date: dir }),
  nextFollowUpDate: (dir) => ({ nextFollowUpDate: { sort: dir, nulls: 'last' } }),
  createdAt: (dir) => ({ createdAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.FollowUpOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

export async function listFollowUps(
  ctx: Ctx,
  input: ListFollowUpsInput,
): Promise<Page<FollowUpDetail>> {
  const p = listFollowUpsSchema.parse(input);
  assertCan(ctx, 'list', 'followUp');
  const db = getDb();

  const filters: Prisma.FollowUpWhereInput = {
    ...(p.clientId && { clientId: p.clientId }),
    ...(p.entityType && { entityType: p.entityType }),
    ...(p.entityId && { entityId: p.entityId }),
    ...(p.userId && { userId: p.userId }),
    ...(p.channel && { channel: { in: p.channel } }),
    ...(between(p.dateFrom, p.dateTo) && { date: between(p.dateFrom, p.dateTo) }),
    ...(between(p.nextFrom, p.nextTo) && { nextFollowUpDate: between(p.nextFrom, p.nextTo) }),
    ...(p.q && { notes: { contains: p.q, mode: 'insensitive' } }),
  };
  const visible = await visibleRecordIds(db, ctx.user, p.clientId);
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  const where: Prisma.FollowUpWhereInput = {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopeFollowUps(ctx.user, visible), filters],
  };
  const dir = p.dir ?? (p.sort && p.sort !== 'date' ? 'asc' : 'desc');

  const [rows, total] = await Promise.all([
    db.followUp.findMany({
      where,
      include: followUpInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'date'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    db.followUp.count({ where }),
  ]);
  return { items: await withLabels(db, rows), total, page: p.page, pageSize: p.pageSize };
}

/** Includes a soft-deleted follow-up the user can see (restore). */
export async function getFollowUp(ctx: Ctx, id: string): Promise<FollowUpDetail> {
  await findAccessible(getDb(), ctx, id, 'read', 'any');
  return loadDetail(getDb(), id);
}

/**
 * The newest live follow-up on one record, by date then entry time: M6's source for the
 * quotation's highlights and next follow-up date (M5 Decision 6).
 */
export async function getLatestFollowUp(
  ctx: Ctx,
  entityType: FollowUpEntityTypeValue,
  entityId: string,
): Promise<FollowUpDetail | null> {
  assertCan(ctx, 'list', 'followUp');
  const db = getDb();
  const record = await targetFor(entityType).load(db, entityId);
  if (!record || !canReadRecord(ctx.user, record)) {
    throw new NotFoundError(entityType.toLowerCase());
  }
  const row = await db.followUp.findFirst({
    where: { entityType, entityId },
    include: followUpInclude,
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  return row ? ((await withLabels(db, [row]))[0] ?? null) : null;
}

/** The records on a live client the user may log a follow-up on: the client, then others. */
export async function listFollowUpTargets(
  ctx: Ctx,
  clientId: string,
): Promise<{ entityType: FollowUpEntityTypeValue; entityId: string; label: string }[]> {
  assertCan(ctx, 'create', 'followUp');
  assertCan(ctx, 'read', 'client');
  const db = getDb();
  const client = await db.client.findFirst({ where: { id: clientId }, select: { name: true } });
  if (!client) throw new NotFoundError('client');

  const targets: { entityType: FollowUpEntityTypeValue; entityId: string; label: string }[] = [
    { entityType: 'CLIENT', entityId: clientId, label: client.name },
  ];
  for (const [entityType, target] of supportedTargets()) {
    for (const { id, label } of await target.pickable(db, ctx.user, clientId)) {
      targets.push({ entityType, entityId: id, label });
    }
  }
  return targets;
}
