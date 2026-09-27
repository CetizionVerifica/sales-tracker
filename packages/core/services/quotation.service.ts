import type { Prisma, QuotationStatus } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import {
  enquiryManagersSelect,
  enquiryResource,
  quotationResource,
  scopeQuotations,
} from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import { todayInIST, type Page } from '../schemas/common.ts';
import {
  changeQuotationStatusSchema,
  createQuotationSchema,
  listQuotationsSchema,
  NEXT_BEFORE_QUOTATION_DATE,
  QUOTATION_BEFORE_ENQUIRY,
  updateQuotationSchema,
  type ChangeQuotationStatusInput,
  type CreateQuotationInput,
  type ListQuotationsInput,
  type ProjectDraft,
  type UpdateQuotationInput,
} from '../schemas/quotation.ts';
import {
  ACTIVE_QUOTATION_STATUSES,
  assertQuotationTransition,
  CLOSED_QUOTATION_EDITABLE,
  isActiveQuotation,
} from '../status/quotation.ts';
import { nextNumber } from './number-sequence.ts';
import { SETTINGS_ID } from './settings.service.ts';

// Relations loaded with `include` are not soft-delete filtered, so a retired sector or
// service still shows its name on existing quotations (as in M3 AC12).
const quotationInclude = {
  client: { select: { id: true, name: true } },
  sector: { select: { id: true, name: true } },
  owner: { select: { id: true, name: true } },
  enquiry: { select: { id: true, number: true } },
  services: {
    select: { service: { select: { id: true, name: true } } },
    orderBy: { service: { name: 'asc' } },
  },
  // The live project (at most one, M8 Decision 2): its link, and quotationResource's PMs.
  projects: {
    where: { deletedAt: null },
    select: { id: true, number: true, status: true, managerId: true },
  },
} satisfies Prisma.QuotationInclude;

type QuotationRow = Prisma.QuotationGetPayload<{ include: typeof quotationInclude }>;

/** A quotation with its client, sector, owner, enquiry and services flattened for display. */
export type QuotationDetail = Omit<QuotationRow, 'services'> & {
  services: { id: string; name: string }[];
};

function toDetail({ services, ...row }: QuotationRow): QuotationDetail {
  return { ...row, services: services.map((link) => link.service) };
}

/** Includes a soft-deleted quotation (detail page with Restore). */
async function loadQuotation(db: Db, id: string): Promise<QuotationDetail> {
  const row = await db.quotation.findFirst({
    where: { id, deletedAt: undefined },
    include: quotationInclude,
  });
  if (!row) throw new NotFoundError('quotation');
  return toDetail(row);
}

const accessSelect = {
  id: true,
  number: true,
  enquiryId: true,
  ownerId: true,
  clientId: true,
  sectorId: true,
  status: true,
  quotationDate: true,
  amountMinor: true,
  currency: true,
  nextFollowUpDate: true,
  poReceivedDate: true,
  enquiry: { select: { receivedDate: true } },
  services: { select: { id: true, serviceId: true } },
  // The live project (M8): quotationResource's PMs, and getProjectDraft's one-project check.
  projects: { where: { deletedAt: null }, select: { id: true, number: true, managerId: true } },
} satisfies Prisma.QuotationSelect;

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/**
 * Loads the ownership fields and checks `action`. A quotation the user cannot read is
 * reported as not found, so other reps' ids don't leak (M4 Decision 7).
 */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
) {
  const row = await db.quotation.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    select: accessSelect,
  });
  if (!row || !can(ctx.user, 'read', quotationResource(row))) {
    throw new NotFoundError('quotation');
  }
  assertCan(ctx, action, quotationResource(row));
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

/** The currency must be enabled in CompanySettings when it is chosen or changed. */
async function assertCurrencyEnabled(db: Db, currency: string) {
  const settings = await db.companySettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { enabledCurrencies: true },
  });
  if (!settings) throw new Error('Company settings are missing; run `pnpm db:seed`');
  if (!settings.enabledCurrencies.includes(currency)) {
    throw new DomainError(`${currency} is not enabled in company settings`, {
      field: 'currency',
    });
  }
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  quotationDate: (dir) => ({ quotationDate: dir }),
  number: (dir) => ({ number: dir }),
  // Minor units across currencies are not comparable; the list notes this (M12 converts).
  amount: (dir) => ({ amountMinor: dir }),
  status: (dir) => ({ status: dir }),
  nextFollowUpDate: (dir) => ({ nextFollowUpDate: { sort: dir, nulls: 'last' } }),
  client: (dir) => ({ client: { name: dir } }),
  owner: (dir) => ({ owner: { name: dir } }),
  updatedAt: (dir) => ({ updatedAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.QuotationOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

export async function listQuotations(
  ctx: Ctx,
  input: ListQuotationsInput,
): Promise<Page<QuotationDetail>> {
  const p = listQuotationsSchema.parse(input);
  assertCan(ctx, 'list', 'quotation');

  const contains = p.q ? { contains: p.q, mode: 'insensitive' as const } : undefined;
  const filters: Prisma.QuotationWhereInput[] = [
    {
      ...(p.status && { status: { in: p.status } }),
      ...(p.currency && { currency: { in: p.currency } }),
      ...(p.ownerId && { ownerId: p.ownerId }),
      ...(p.clientId && { clientId: p.clientId }),
      ...(p.enquiryId && { enquiryId: p.enquiryId }),
      ...(p.sectorId && { sectorId: p.sectorId }),
      ...(p.serviceId && { services: { some: { serviceId: p.serviceId } } }),
      ...(between(p.quotationFrom, p.quotationTo) && {
        quotationDate: between(p.quotationFrom, p.quotationTo),
      }),
      ...(between(p.nextFollowUpFrom, p.nextFollowUpTo) && {
        nextFollowUpDate: between(p.nextFollowUpFrom, p.nextFollowUpTo),
      }),
      ...(contains && {
        OR: [
          { number: contains },
          { enquiry: { number: contains } },
          { client: { name: contains } },
          { description: contains },
          { lostReason: contains },
        ],
      }),
    },
  ];
  if (p.hasProject !== undefined) {
    // A live project, if any (M8 Decision 2); relation filters skip the soft-delete extension.
    const live = { some: { deletedAt: null } };
    filters.push(
      p.hasProject ? { projects: live } : { status: 'PO_RECEIVED', NOT: { projects: live } },
    );
  }
  if (p.followUpDue) {
    filters.push({
      status: { in: [...ACTIVE_QUOTATION_STATUSES] },
      nextFollowUpDate: { lte: todayInIST() },
    });
  }
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  const where: Prisma.QuotationWhereInput = {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopeQuotations(ctx.user), ...filters],
  };
  const dir = p.dir ?? (p.sort ? 'asc' : 'desc');
  const db = getDb();

  const [rows, total] = await Promise.all([
    db.quotation.findMany({
      where,
      include: quotationInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'quotationDate'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    db.quotation.count({ where }),
  ]);
  return { items: rows.map(toDetail), total, page: p.page, pageSize: p.pageSize };
}

/** Includes a soft-deleted quotation the user can see (restore view). */
export async function getQuotation(ctx: Ctx, id: string): Promise<QuotationDetail> {
  await findAccessible(getDb(), ctx, id, 'read', 'any');
  return loadQuotation(getDb(), id);
}

/** Live quotations on an enquiry the user can read, newest number first (enquiry page). */
export async function listQuotationsForEnquiry(
  ctx: Ctx,
  enquiryId: string,
): Promise<QuotationDetail[]> {
  assertCan(ctx, 'list', 'quotation');
  const db = getDb();
  const enquiry = await db.enquiry.findFirst({
    where: { id: enquiryId, deletedAt: undefined },
    select: { ownerId: true, ...enquiryManagersSelect },
  });
  if (!enquiry || !can(ctx.user, 'read', enquiryResource(enquiry))) {
    throw new NotFoundError('enquiry');
  }
  const rows = await db.quotation.findMany({
    where: { enquiryId, AND: [scopeQuotations(ctx.user)] },
    include: quotationInclude,
    orderBy: { number: 'desc' },
  });
  return rows.map(toDetail);
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

/**
 * Starts SENT from a converted enquiry the user can read (M6 Decision 1). The client is the
 * enquiry's (Decision 6); the owner defaults to the enquiry's owner.
 */
export async function createQuotation(
  ctx: Ctx,
  input: CreateQuotationInput,
): Promise<QuotationDetail> {
  const {
    enquiryId,
    serviceIds,
    ownerId: requestedOwner,
    ...fields
  } = createQuotationSchema.parse(input);
  assertCan(ctx, 'create', 'quotation');
  return withTx(ctx, async (tx) => {
    const enquiry = await tx.enquiry.findFirst({
      where: { id: enquiryId },
      select: {
        id: true,
        ownerId: true,
        clientId: true,
        status: true,
        receivedDate: true,
        client: { select: { deletedAt: true } },
        ...enquiryManagersSelect,
      },
    });
    if (!enquiry || enquiry.client.deletedAt || !can(ctx.user, 'read', enquiryResource(enquiry))) {
      throw new NotFoundError('enquiry');
    }
    if (enquiry.status !== 'CONVERTED') {
      throw new DomainError('Only a converted enquiry can start a quotation', {
        field: 'enquiryId',
      });
    }
    if (fields.quotationDate < enquiry.receivedDate) {
      throw new DomainError(QUOTATION_BEFORE_ENQUIRY, { field: 'quotationDate' });
    }

    const ownerId = requestedOwner ?? enquiry.ownerId;
    await assertOwnerAllowed(tx, ctx, ownerId);
    assertCan(ctx, 'create', quotationResource({ ownerId, projects: [] }));
    await assertCurrencyEnabled(tx, fields.currency);
    await assertSectorUsable(tx, fields.sectorId);
    await assertServicesUsable(tx, serviceIds);

    const number = await nextNumber(tx, 'QUO', fields.quotationDate.getUTCFullYear());
    const { id } = await tx.quotation.create({
      data: {
        ...fields,
        enquiryId,
        clientId: enquiry.clientId,
        ownerId,
        number,
        status: 'SENT',
        statusChangedAt: new Date(),
      },
      select: { id: true },
    });
    // One row per service: M2 rejects nested writes, and each link is audited.
    for (const serviceId of serviceIds) {
      await tx.quotationService.create({ data: { quotationId: id, serviceId } });
    }
    return loadQuotation(tx, id);
  });
}

/**
 * Edited in place; the audit log is the history (M6 Decision 2). Referenced records and the
 * currency are re-checked only when they change, so a retired sector or a since-disabled
 * currency keeps working on existing quotations.
 */
export async function updateQuotation(
  ctx: Ctx,
  id: string,
  input: UpdateQuotationInput,
): Promise<QuotationDetail> {
  const { serviceIds, ...fields } = updateQuotationSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'update');

    if (!isActiveQuotation(current.status)) {
      const locked = [...Object.keys(fields), ...(serviceIds ? ['serviceIds'] : [])].filter(
        (key) => !CLOSED_QUOTATION_EDITABLE.includes(key),
      );
      if (locked.length > 0) {
        // The amount (with its currency) is the field people try to change; point at it.
        const field = locked.includes('amountMinor') ? 'amount' : locked[0];
        throw new DomainError(
          'A closed quotation only takes description, highlights and owner changes',
          {
            field,
          },
        );
      }
    }

    if (fields.ownerId !== undefined && fields.ownerId !== current.ownerId) {
      await assertOwnerAllowed(tx, ctx, fields.ownerId);
    }
    if (fields.sectorId !== undefined && fields.sectorId !== current.sectorId) {
      await assertSectorUsable(tx, fields.sectorId);
    }
    if (fields.currency !== undefined && fields.currency !== current.currency) {
      await assertCurrencyEnabled(tx, fields.currency);
    }

    const quotationDate = fields.quotationDate ?? current.quotationDate;
    const next =
      fields.nextFollowUpDate !== undefined ? fields.nextFollowUpDate : current.nextFollowUpDate;
    if (fields.quotationDate && quotationDate < current.enquiry.receivedDate) {
      throw new DomainError(QUOTATION_BEFORE_ENQUIRY, { field: 'quotationDate' });
    }
    if (isActiveQuotation(current.status) && !next) {
      throw new DomainError('An open quotation needs a next follow-up date', {
        field: 'nextFollowUpDate',
      });
    }
    if (next && next < quotationDate) {
      throw new DomainError(NEXT_BEFORE_QUOTATION_DATE, { field: 'nextFollowUpDate' });
    }

    if (serviceIds) {
      const wanted = new Set(serviceIds);
      const have = new Set(current.services.map((link) => link.serviceId));
      const added = serviceIds.filter((serviceId) => !have.has(serviceId));
      const removed = current.services.filter((link) => !wanted.has(link.serviceId));
      await assertServicesUsable(tx, added);
      if (removed.length > 0) {
        await tx.quotationService.deleteMany({
          where: { id: { in: removed.map((link) => link.id) } },
        });
      }
      for (const serviceId of added) {
        await tx.quotationService.create({ data: { quotationId: id, serviceId } });
      }
    }

    if (Object.keys(fields).length > 0) {
      // Guarded: a status change committed since the read must still lock the fields.
      await guardedUpdate(tx, id, { status: current.status, deletedAt: null }, fields);
    }
    return loadQuotation(tx, id);
  });
}

export const CONCURRENT_QUOTATION_CHANGE =
  'Someone else changed this quotation. Reload and try again.';

/**
 * Writes only if the row still looks the way the caller read it (the M4 code-review fix):
 * under READ COMMITTED two requests could both pass the read, e.g. PO received and lost at
 * once. The conditional UPDATE re-checks `expected` under the row lock, so the second
 * request updates nothing and fails; its transaction, with any audit row, rolls back.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  expected: Prisma.QuotationWhereInput,
  data: Prisma.QuotationUpdateManyMutationInput,
) {
  const { count } = await tx.quotation.updateMany({ where: { ...expected, id }, data });
  if (count === 0) throw new DomainError(CONCURRENT_QUOTATION_CHANGE);
}

/** The values M8's project form starts from (the M4 → M6 hand-off pattern). */
function draftFrom(row: {
  id: string;
  number: string;
  clientId: string;
  ownerId: string;
  amountMinor: bigint;
  currency: string;
  poReceivedDate: Date | null;
  serviceIds: string[];
}): ProjectDraft {
  return {
    quotationId: row.id,
    quotationNumber: row.number,
    clientId: row.clientId,
    serviceIds: [...row.serviceIds].sort(),
    ownerId: row.ownerId,
    revenueMinor: row.amountMinor,
    currency: row.currency,
    poReceivedDate: row.poReceivedDate!, // PO_RECEIVED guarantees it (status machine + CHECK)
  };
}

/**
 * Moves a quotation through its status machine and stores the values the move needs. A move
 * to PO_RECEIVED returns the project draft (the PLAN.md "done when"); no project is created.
 */
export async function changeQuotationStatus(
  ctx: Ctx,
  input: ChangeQuotationStatusInput,
): Promise<{ quotation: QuotationDetail; projectDraft?: ProjectDraft }> {
  const p = changeQuotationStatusSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, p.id, 'update');
    assertQuotationTransition(current, p.to, { ...p, today: todayInIST() });

    const data: Prisma.QuotationUpdateManyMutationInput = {
      status: p.to as QuotationStatus,
      statusChangedAt: new Date(),
    };
    if (p.to === 'PO_RECEIVED') data.poReceivedDate = p.poReceivedDate;
    else if (p.to === 'LOST') data.lostReason = p.lostReason;
    else if (p.nextFollowUpDate) data.nextFollowUpDate = p.nextFollowUpDate;
    await guardedUpdate(tx, p.id, { status: current.status, deletedAt: null }, data);

    const quotation = await loadQuotation(tx, p.id);
    if (p.to !== 'PO_RECEIVED') return { quotation };
    return {
      quotation,
      projectDraft: draftFrom({ ...quotation, serviceIds: quotation.services.map((s) => s.id) }),
    };
  });
}

/** A PO_RECEIVED quotation cannot be deleted: M8 projects point to it (as M4 Decision 6). */
export async function softDeleteQuotation(ctx: Ctx, id: string): Promise<QuotationDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete');
    if (current.status === 'PO_RECEIVED') {
      throw new DomainError('A quotation with a PO received cannot be deleted');
    }
    // Guarded: a PO received committed since the read must still block the delete.
    await guardedUpdate(
      tx,
      id,
      { status: current.status, deletedAt: null },
      { deletedAt: new Date() },
    );
    return loadQuotation(tx, id);
  });
}

export async function restoreQuotation(ctx: Ctx, id: string): Promise<QuotationDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete', 'deleted');
    const enquiry = await tx.enquiry.findFirst({
      where: { id: current.enquiryId },
      select: { id: true },
    });
    if (!enquiry) throw new DomainError('Restore the enquiry before its quotation');
    await guardedUpdate(tx, id, { deletedAt: { not: null } }, { deletedAt: null });
    return loadQuotation(tx, id);
  });
}

/** getProjectDraft on a quotation that already has a live project (M8 Decision 2). */
export class ProjectExistsError extends DomainError {
  constructor(
    readonly projectId: string,
    projectNumber: string,
  ) {
    super(`This quotation already has a project (${projectNumber})`, { field: 'quotationId' });
  }
}

/** The project draft for a PO_RECEIVED quotation without a live project (the M8 form). */
export async function getProjectDraft(ctx: Ctx, quotationId: string): Promise<ProjectDraft> {
  const row = await findAccessible(getDb(), ctx, quotationId, 'read');
  if (row.status !== 'PO_RECEIVED') {
    throw new DomainError('Only a quotation with a PO received can start a project');
  }
  const [project] = row.projects;
  if (project) {
    // M8 Decision 2: one live project per quotation. The id lets the form page redirect.
    throw new ProjectExistsError(project.id, project.number);
  }
  return draftFrom({ ...row, serviceIds: row.services.map((link) => link.serviceId) });
}
