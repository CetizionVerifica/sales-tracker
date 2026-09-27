import type { EnquiryStatus, Prisma } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import { enquiryResource, scopeEnquiries } from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import type { Page } from '../schemas/common.ts';
import {
  convertEnquirySchema,
  createEnquirySchema,
  enquiryRuleIssues,
  listEnquiriesSchema,
  markEnquiryLostSchema,
  PROPOSAL_BEFORE_RECEIVED,
  updateEnquirySchema,
  type ConvertEnquiryInput,
  type CreateEnquiryInput,
  type ListEnquiriesInput,
  type MarkEnquiryLostInput,
  type QuotationDraft,
  type UpdateEnquiryInput,
} from '../schemas/enquiry.ts';
import { assertEnquiryTransition } from '../status/enquiry.ts';
import { nextNumber } from './number-sequence.ts';

// Relations loaded with `include` are not soft-delete filtered, so a deleted client or a
// retired sector or service still shows its name on existing enquiries (as in M3 AC12).
const enquiryInclude = {
  client: { select: { id: true, name: true } },
  sector: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  services: {
    select: { service: { select: { id: true, name: true } } },
    orderBy: { service: { name: 'asc' } },
  },
} satisfies Prisma.EnquiryInclude;

type EnquiryRow = Prisma.EnquiryGetPayload<{ include: typeof enquiryInclude }>;

/** An enquiry with its client, sector, owner and services flattened for display. */
export type EnquiryDetail = Omit<EnquiryRow, 'services'> & {
  services: { id: string; name: string }[];
};

function toDetail({ services, ...row }: EnquiryRow): EnquiryDetail {
  return { ...row, services: services.map((link) => link.service) };
}

/** Includes a soft-deleted enquiry (detail page with Restore). */
async function loadEnquiry(db: Db, id: string): Promise<EnquiryDetail> {
  const row = await db.enquiry.findFirst({
    where: { id, deletedAt: undefined },
    include: enquiryInclude,
  });
  if (!row) throw new NotFoundError('enquiry');
  return toDetail(row);
}

const accessSelect = {
  id: true,
  number: true,
  ownerId: true,
  clientId: true,
  sectorId: true,
  status: true,
  receivedDate: true,
  proposalSentDate: true,
  source: true,
  sourceDetail: true,
  services: { select: { id: true, serviceId: true } },
} satisfies Prisma.EnquirySelect;

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/**
 * Loads the ownership fields and checks `action`. An enquiry the user cannot read is
 * reported as not found, so other reps' ids don't leak (M4 Decision 7).
 */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
) {
  const row = await db.enquiry.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    select: accessSelect,
  });
  if (!row || !can(ctx.user, 'read', enquiryResource(row))) throw new NotFoundError('enquiry');
  assertCan(ctx, action, enquiryResource(row));
  return row;
}

// ─── Checks on referenced records ───────────────────────────────────────────────────

/** The owner must be an active Sales or Admin user; only admins choose someone else. */
async function assertOwnerAllowed(db: Db, ctx: Ctx, ownerId: string) {
  if (ownerId !== ctx.user.id && ctx.user.role !== 'ADMIN') {
    throw new DomainError('Only admins can choose the owner', { field: 'ownerId' });
  }
  const owner = await db.user.findFirst({
    where: { id: ownerId, active: true, isSystem: false, role: { in: ['SALES', 'ADMIN'] } },
    select: { id: true },
  });
  if (!owner) {
    throw new DomainError('Choose an active sales or admin user', { field: 'ownerId' });
  }
}

async function assertClientUsable(db: Db, clientId: string) {
  const client = await db.client.findFirst({ where: { id: clientId }, select: { id: true } });
  if (!client) throw new DomainError('Choose a client', { field: 'clientId' });
}

async function assertSectorUsable(db: Db, sectorId: string) {
  const sector = await db.sector.findFirst({ where: { id: sectorId, active: true } });
  if (!sector) throw new DomainError('Choose an active sector', { field: 'sectorId' });
}

async function assertServicesUsable(db: Db, serviceIds: string[]) {
  if (serviceIds.length === 0) return;
  const found = await db.service.count({ where: { id: { in: serviceIds }, active: true } });
  if (found !== serviceIds.length) {
    throw new DomainError('Choose active services', { field: 'serviceIds' });
  }
}

function assertRules(record: Parameters<typeof enquiryRuleIssues>[0]) {
  const [issue] = enquiryRuleIssues(record);
  if (issue) throw new DomainError(issue.message, { field: issue.field });
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  receivedDate: (dir) => ({ receivedDate: dir }),
  number: (dir) => ({ number: dir }),
  proposalSentDate: (dir) => ({ proposalSentDate: { sort: dir, nulls: 'last' } }),
  status: (dir) => ({ status: dir }),
  source: (dir) => ({ source: dir }),
  client: (dir) => ({ client: { name: dir } }),
  owner: (dir) => ({ owner: { name: dir } }),
  updatedAt: (dir) => ({ updatedAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.EnquiryOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

export async function listEnquiries(
  ctx: Ctx,
  input: ListEnquiriesInput,
): Promise<Page<EnquiryDetail>> {
  const p = listEnquiriesSchema.parse(input);
  assertCan(ctx, 'list', 'enquiry');

  const contains = p.q ? { contains: p.q, mode: 'insensitive' as const } : undefined;
  const filters: Prisma.EnquiryWhereInput = {
    ...(p.status && { status: { in: p.status } }),
    ...(p.source && { source: { in: p.source } }),
    ...(p.ownerId && { ownerId: p.ownerId }),
    ...(p.clientId && { clientId: p.clientId }),
    ...(p.sectorId && { sectorId: p.sectorId }),
    ...(p.serviceId && { services: { some: { serviceId: p.serviceId } } }),
    ...(between(p.receivedFrom, p.receivedTo) && {
      receivedDate: between(p.receivedFrom, p.receivedTo),
    }),
    ...(between(p.proposalSentFrom, p.proposalSentTo) && {
      proposalSentDate: between(p.proposalSentFrom, p.proposalSentTo),
    }),
    ...(contains && {
      OR: [
        { number: contains },
        { client: { name: contains } },
        { description: contains },
        { sourceDetail: contains },
      ],
    }),
  };
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  const where: Prisma.EnquiryWhereInput = {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopeEnquiries(ctx.user), filters],
  };
  const dir = p.dir ?? (p.sort ? 'asc' : 'desc');

  const [rows, total] = await Promise.all([
    getDb().enquiry.findMany({
      where,
      include: enquiryInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'receivedDate'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    getDb().enquiry.count({ where }),
  ]);
  return { items: rows.map(toDetail), total, page: p.page, pageSize: p.pageSize };
}

/** Includes a soft-deleted enquiry the user can see (restore view). */
export async function getEnquiry(ctx: Ctx, id: string): Promise<EnquiryDetail> {
  await findAccessible(getDb(), ctx, id, 'read', 'any');
  return loadEnquiry(getDb(), id);
}

/** Owner picker for admins: active Sales and Admin users. */
export async function listEnquiryOwnerOptions(
  ctx: Ctx,
): Promise<{ id: string; name: string; role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER' }[]> {
  assertCan(ctx, 'list', 'user');
  return getDb().user.findMany({
    where: { active: true, isSystem: false, role: { in: ['SALES', 'ADMIN'] } },
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  });
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

export async function createEnquiry(ctx: Ctx, input: CreateEnquiryInput): Promise<EnquiryDetail> {
  const { serviceIds, ownerId: requestedOwner, ...fields } = createEnquirySchema.parse(input);
  assertCan(ctx, 'create', 'enquiry');
  return withTx(ctx, async (tx) => {
    const ownerId = requestedOwner ?? ctx.user.id;
    await assertOwnerAllowed(tx, ctx, ownerId);
    await assertClientUsable(tx, fields.clientId);
    await assertSectorUsable(tx, fields.sectorId);
    await assertServicesUsable(tx, serviceIds);

    const number = await nextNumber(tx, 'ENQ', fields.receivedDate.getUTCFullYear());
    const { id } = await tx.enquiry.create({
      data: { ...fields, ownerId, number },
      select: { id: true },
    });
    // One row per service: M2 rejects nested writes, and each link is audited.
    for (const serviceId of serviceIds) {
      await tx.enquiryService.create({ data: { enquiryId: id, serviceId } });
    }
    return loadEnquiry(tx, id);
  });
}

/**
 * Corrections are allowed in any status. Referenced records are re-checked only when they
 * change (a retired sector keeps working on existing enquiries). Status and number never
 * change here (the schema drops them).
 */
export async function updateEnquiry(
  ctx: Ctx,
  id: string,
  input: UpdateEnquiryInput,
): Promise<EnquiryDetail> {
  const { serviceIds, ...fields } = updateEnquirySchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');

    if (fields.ownerId !== undefined && fields.ownerId !== current.ownerId) {
      await assertOwnerAllowed(tx, ctx, fields.ownerId);
    }
    if (fields.clientId !== undefined && fields.clientId !== current.clientId) {
      await assertClientUsable(tx, fields.clientId);
    }
    if (fields.sectorId !== undefined && fields.sectorId !== current.sectorId) {
      await assertSectorUsable(tx, fields.sectorId);
    }

    const merged = {
      receivedDate: fields.receivedDate ?? current.receivedDate,
      proposalSentDate:
        fields.proposalSentDate !== undefined ? fields.proposalSentDate : current.proposalSentDate,
      source: fields.source ?? current.source,
      sourceDetail: fields.sourceDetail !== undefined ? fields.sourceDetail : current.sourceDetail,
    };
    assertRules(merged);
    if (current.status === 'CONVERTED' && !merged.proposalSentDate) {
      throw new DomainError('A converted enquiry needs its proposal sent date', {
        field: 'proposalSentDate',
      });
    }

    if (serviceIds) {
      const wanted = new Set(serviceIds);
      const have = new Set(current.services.map((link) => link.serviceId));
      const added = serviceIds.filter((serviceId) => !have.has(serviceId));
      const removed = current.services.filter((link) => !wanted.has(link.serviceId));
      await assertServicesUsable(tx, added);
      if (removed.length > 0) {
        await tx.enquiryService.deleteMany({
          where: { id: { in: removed.map((link) => link.id) } },
        });
      }
      for (const serviceId of added) {
        await tx.enquiryService.create({ data: { enquiryId: id, serviceId } });
      }
    }

    if (Object.keys(fields).length > 0) {
      await tx.enquiry.update({ where: { id }, data: fields });
    }
    return loadEnquiry(tx, id);
  });
}

/** The values M6's quotation form starts from (M4 Decision 8). */
function draftFrom(row: {
  id: string;
  number: string;
  clientId: string;
  sectorId: string;
  ownerId: string;
  proposalSentDate: Date | null;
  services: { serviceId: string }[];
}): QuotationDraft {
  return {
    enquiryId: row.id,
    enquiryNumber: row.number,
    clientId: row.clientId,
    sectorId: row.sectorId,
    serviceIds: row.services.map((link) => link.serviceId).sort(),
    ownerId: row.ownerId,
    quotationDate: row.proposalSentDate!, // CONVERTED guarantees it (status machine + CHECK)
  };
}

export const CONCURRENT_CHANGE = 'Someone else changed this enquiry. Reload and try again.';

/**
 * Writes only if the row still looks the way the caller read it. The services read the
 * status and then write it, and under READ COMMITTED two requests could both pass the
 * read (e.g. convert and mark lost at once). The conditional UPDATE re-checks `expected`
 * under the row lock, so the second request updates nothing and fails; its transaction,
 * including any audit row, rolls back.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  expected: Prisma.EnquiryWhereInput,
  data: Prisma.EnquiryUpdateManyMutationInput,
) {
  const { count } = await tx.enquiry.updateMany({ where: { ...expected, id }, data });
  if (count === 0) throw new DomainError(CONCURRENT_CHANGE);
}

/** Applies a status change the status machine has already allowed. */
async function transition(
  tx: Db,
  current: { id: string; status: EnquiryStatus },
  status: EnquiryStatus,
  data: Prisma.EnquiryUpdateManyMutationInput,
) {
  await guardedUpdate(
    tx,
    current.id,
    { status: current.status, deletedAt: null },
    { ...data, status, statusChangedAt: new Date() },
  );
}

/**
 * IN_PROGRESS → CONVERTED. A proposal sent date supplied here is stored in the same
 * update. Returns the quotation draft; no quotation is created (the user confirms in M6).
 */
export async function convertEnquiry(
  ctx: Ctx,
  input: ConvertEnquiryInput,
): Promise<{ enquiry: EnquiryDetail; quotationDraft: QuotationDraft }> {
  const { id, proposalSentDate } = convertEnquirySchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');
    assertEnquiryTransition(current, 'CONVERTED', { proposalSentDate });
    if (proposalSentDate && proposalSentDate < current.receivedDate) {
      throw new DomainError(PROPOSAL_BEFORE_RECEIVED, { field: 'proposalSentDate' });
    }
    await transition(tx, current, 'CONVERTED', proposalSentDate ? { proposalSentDate } : {});
    const enquiry = await loadEnquiry(tx, id);
    return {
      enquiry,
      quotationDraft: draftFrom({
        ...enquiry,
        services: enquiry.services.map((s) => ({ serviceId: s.id })),
      }),
    };
  });
}

/** IN_PROGRESS → LOST, with a required reason (M4 Decision 4). */
export async function markEnquiryLost(
  ctx: Ctx,
  input: MarkEnquiryLostInput,
): Promise<EnquiryDetail> {
  const { id, lostReason } = markEnquiryLostSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');
    assertEnquiryTransition(current, 'LOST', { lostReason });
    await transition(tx, current, 'LOST', { lostReason });
    return loadEnquiry(tx, id);
  });
}

/** Converted enquiries cannot be deleted: M6 quotations point to them (M4 Decision 6). */
export async function softDeleteEnquiry(ctx: Ctx, id: string): Promise<EnquiryDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete');
    if (current.status === 'CONVERTED') {
      throw new DomainError('A converted enquiry cannot be deleted');
    }
    // Guarded: a convert committed since the read must still block the delete.
    await guardedUpdate(
      tx,
      id,
      { status: current.status, deletedAt: null },
      {
        deletedAt: new Date(),
      },
    );
    return loadEnquiry(tx, id);
  });
}

export async function restoreEnquiry(ctx: Ctx, id: string): Promise<EnquiryDetail> {
  return withTx(ctx, async (tx) => {
    await findAccessible(tx, ctx, id, 'delete', 'deleted');
    await guardedUpdate(tx, id, { deletedAt: { not: null } }, { deletedAt: null });
    return loadEnquiry(tx, id);
  });
}

/** The quotation draft for a converted enquiry (the M6 form reads this). */
export async function getQuotationDraft(ctx: Ctx, enquiryId: string): Promise<QuotationDraft> {
  const row = await findAccessible(getDb(), ctx, enquiryId, 'read');
  if (row.status !== 'CONVERTED') {
    throw new DomainError('Only a converted enquiry can start a quotation');
  }
  return draftFrom(row);
}
