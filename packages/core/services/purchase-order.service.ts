import type { Prisma } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import {
  projectResource,
  purchaseOrderAccessSelect,
  purchaseOrderResource,
  scopePurchaseOrders,
} from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import { todayInIST, type Page } from '../schemas/common.ts';
import type { DocumentState } from '../schemas/document-state.ts';
import { formatMoney } from '../schemas/money.ts';
import { UNASSIGNED } from '../schemas/project.ts';
import {
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
  updatePurchaseOrderSchema,
  type CreatePurchaseOrderInput,
  type ListPurchaseOrdersInput,
  type PurchaseOrderDraft,
  type UpdatePurchaseOrderInput,
} from '../schemas/purchase-order.ts';
import { documentStateOf } from '../status/document.ts';
import {
  invoiceStage,
  overInvoicedWarning,
  poBilling,
  type InvoiceStage,
  type PoBilling,
} from './invoice-queries.ts';
import { lockProject } from './project-lock.ts';
import { lockPurchaseOrder } from './purchase-order-lock.ts';
import { PO_DOCUMENT_WHERE, poTotals, type PoTotals } from './purchase-order-queries.ts';
import {
  CONCURRENT_PURCHASE_ORDER_CHANGE,
  recomputePurchaseOrderStatus,
} from './purchase-order-status.ts';
import { SETTINGS_ID } from './settings.service.ts';
import { guardUnique } from './unique.ts';

export type { PoTotals } from './purchase-order-queries.ts';
export { CONCURRENT_PURCHASE_ORDER_CHANGE } from './purchase-order-status.ts';

/*
 * Purchase orders (M9): the client's order authorising billing on a project. A project has
 * many; permissions come from the project (its PM) and its quotation (the pipeline owner),
 * read through relations (M1 policy, M8 Decision 4). The status is derived from invoices
 * and written only by recomputePurchaseOrderStatus (Decision 4).
 */

// Relations loaded with `include` are not soft-delete filtered, so a retired service or a
// deactivated manager still shows its name on existing POs (as in M3 AC12).
const purchaseOrderInclude = {
  client: { select: { id: true, name: true } },
  project: {
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      revenueMinor: true,
      currency: true,
      managerId: true,
      deletedAt: true,
      manager: { select: { id: true, name: true } },
      quotation: {
        select: {
          id: true,
          number: true,
          ownerId: true,
          owner: { select: { id: true, name: true } },
          enquiry: { select: { id: true, number: true } },
        },
      },
    },
  },
  services: {
    select: { service: { select: { id: true, name: true } } },
    orderBy: { service: { name: 'asc' } },
  },
  // The current document (M7 Decision 2); a replaced or deleted one is no longer linked.
  document: {
    select: {
      id: true,
      originalFilename: true,
      extractionStatus: true,
      reviewStatus: true,
      createdAt: true,
      uploadedBy: { select: { id: true, name: true } },
    },
  },
} satisfies Prisma.PurchaseOrderInclude;

type PurchaseOrderRow = Prisma.PurchaseOrderGetPayload<{ include: typeof purchaseOrderInclude }>;

/** A PO with its client, project, services and document state, flattened for display. */
export type PurchaseOrderDetail = Omit<PurchaseOrderRow, 'services'> & {
  services: { id: string; name: string }[];
  documentState: DocumentState;
};

/** What the actor may do on the PO page. */
export interface PurchaseOrderPermissions {
  canUpdate: boolean;
  canDelete: boolean;
  /** Why the PO cannot be deleted although the actor may delete POs (M10: its invoices). */
  deleteBlockedReason: string | null;
}

export const PURCHASE_ORDER_HAS_INVOICES = 'Has invoices';

export type PurchaseOrderView = PurchaseOrderDetail & {
  /** The live POs on its project, against the project's revenue. */
  projectTotals: PoTotals;
  /** Its live invoices against its amount (M10). */
  billing: PoBilling;
  /** The pipeline strip's Invoice stage (M10). */
  invoiceStage: InvoiceStage;
  permissions: PurchaseOrderPermissions;
};

function toDetail({ services, ...row }: PurchaseOrderRow): PurchaseOrderDetail {
  return {
    ...row,
    services: services.map((link) => link.service),
    documentState: documentStateOf(row.document),
  };
}

/** Includes a soft-deleted PO (detail page with Restore). */
async function loadPurchaseOrder(db: Db, id: string): Promise<PurchaseOrderDetail> {
  const row = await db.purchaseOrder.findFirst({
    where: { id, deletedAt: undefined },
    include: purchaseOrderInclude,
  });
  if (!row) throw new NotFoundError('purchase order');
  return toDetail(row);
}

const accessSelect = {
  id: true,
  projectId: true,
  clientId: true,
  poNumber: true,
  currency: true,
  documentId: true,
  services: { select: { id: true, serviceId: true } },
  project: {
    select: {
      ...purchaseOrderAccessSelect.project.select,
      currency: true,
      services: { select: { serviceId: true } },
    },
  },
} satisfies Prisma.PurchaseOrderSelect;

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/**
 * Loads the ownership fields and checks `action`. A PO the user cannot read is reported as
 * not found, so other people's ids don't leak (M4 Decision 7).
 */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
) {
  const row = await db.purchaseOrder.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    select: accessSelect,
  });
  if (!row || !can(ctx.user, 'read', purchaseOrderResource(row))) {
    throw new NotFoundError('purchase order');
  }
  assertCan(ctx, action, purchaseOrderResource(row));
  return row;
}

/**
 * The project a PO is created on, if the user can read it (otherwise not found). Its client
 * must be live too. The project's owners feed purchaseOrderResource for the create check.
 */
async function findProjectFor(db: Db, ctx: Ctx, projectId: string) {
  const project = await db.project.findFirst({
    where: { id: projectId },
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      clientId: true,
      currency: true,
      revenueMinor: true,
      ...purchaseOrderAccessSelect.project.select,
      client: { select: { name: true, deletedAt: true } },
      services: {
        select: { serviceId: true, service: { select: { id: true, name: true } } },
        orderBy: { service: { name: 'asc' } },
      },
      quotation: {
        select: { id: true, ownerId: true, number: true, poReceivedDate: true, enquiryId: true },
      },
    },
  });
  if (!project || project.client.deletedAt || !can(ctx.user, 'read', projectResource(project))) {
    throw new NotFoundError('project');
  }
  return project;
}

// ─── Checks ─────────────────────────────────────────────────────────────────────────

export const CANCELLED_PROJECT = 'A cancelled project takes no new purchase orders';

/**
 * The PO number must not match a live PO of the same client, ignoring case (Decision 2).
 * The partial unique index backs this for requests racing each other.
 */
async function assertNumberFree(db: Db, clientId: string, poNumber: string, exceptId?: string) {
  const clash = await db.purchaseOrder.findFirst({
    where: {
      clientId,
      poNumber: { equals: poNumber, mode: 'insensitive' },
      ...(exceptId && { id: { not: exceptId } }),
    },
    select: { poNumber: true, project: { select: { number: true } } },
  });
  if (clash) {
    throw new DomainError(
      `This client already has PO ${clash.poNumber} (on ${clash.project.number})`,
      { field: 'poNumber' },
    );
  }
}

const numberTaken = (poNumber: string | undefined) =>
  poNumber ? `This client already has PO ${poNumber}` : 'This client already has that PO number';

/** A PO's services come from its project's (Decision 8). */
function assertServicesOnProject(projectServiceIds: readonly string[], serviceIds: string[]) {
  const allowed = new Set(projectServiceIds);
  if (serviceIds.some((id) => !allowed.has(id))) {
    throw new DomainError('Choose from the project’s services', { field: 'serviceIds' });
  }
}

/** A currency other than the project's must be enabled in CompanySettings. */
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

/**
 * Writes only if the row still looks the way the caller read it (the M4 race fix): the
 * conditional UPDATE re-checks `expected`, so the second of two racing requests updates
 * nothing and fails, and its transaction, with any audit row, rolls back. An empty `data`
 * still checks the row, so a services-only edit is guarded too.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  expected: Prisma.PurchaseOrderWhereInput,
  data: Prisma.PurchaseOrderUpdateManyMutationInput,
) {
  const where = { ...expected, id };
  const count =
    Object.keys(data).length > 0
      ? (await tx.purchaseOrder.updateMany({ where, data })).count
      : await tx.purchaseOrder.count({ where });
  if (count === 0) throw new DomainError(CONCURRENT_PURCHASE_ORDER_CHANGE);
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  receivedDate: (dir) => ({ receivedDate: dir }),
  poNumber: (dir) => ({ poNumber: dir }),
  client: (dir) => ({ client: { name: dir } }),
  project: (dir) => ({ project: { number: dir } }),
  // Minor units across currencies are not comparable; the list notes this (M12 converts).
  amount: (dir) => ({ amountMinor: dir }),
  status: (dir) => ({ status: dir }),
  createdAt: (dir) => ({ createdAt: dir }),
  updatedAt: (dir) => ({ updatedAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.PurchaseOrderOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

export async function listPurchaseOrders(
  ctx: Ctx,
  input: ListPurchaseOrdersInput,
): Promise<Page<PurchaseOrderDetail>> {
  const p = listPurchaseOrdersSchema.parse(input);
  assertCan(ctx, 'list', 'purchaseOrder');
  if (p.ownerId && ctx.user.role !== 'ADMIN') {
    throw new DomainError('Only admins can filter by owner', { field: 'ownerId' });
  }

  const contains = p.q ? { contains: p.q, mode: 'insensitive' as const } : undefined;
  const project: Prisma.ProjectWhereInput = {
    ...(p.managerId && { managerId: p.managerId === UNASSIGNED ? null : p.managerId }),
    ...(p.ownerId && { quotation: { ownerId: p.ownerId } }),
  };
  const filters: Prisma.PurchaseOrderWhereInput[] = [
    {
      ...(p.status && { status: { in: p.status } }),
      ...(p.currency && { currency: { in: p.currency } }),
      ...(p.projectId && { projectId: p.projectId }),
      ...(p.clientId && { clientId: p.clientId }),
      ...(p.serviceId && { services: { some: { serviceId: p.serviceId } } }),
      ...(between(p.receivedFrom, p.receivedTo) && {
        receivedDate: between(p.receivedFrom, p.receivedTo),
      }),
      ...(Object.keys(project).length > 0 && { project }),
      ...(contains && {
        OR: [
          { poNumber: contains },
          { project: { number: contains } },
          { project: { name: contains } },
          { client: { name: contains } },
          { paymentTerms: contains },
        ],
      }),
    },
  ];
  if (p.document) filters.push(PO_DOCUMENT_WHERE[p.document]);
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  const where: Prisma.PurchaseOrderWhereInput = {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopePurchaseOrders(ctx.user), ...filters],
  };
  const dir = p.dir ?? (p.sort ? 'asc' : 'desc');
  const db = getDb();

  const [rows, total] = await Promise.all([
    db.purchaseOrder.findMany({
      where,
      include: purchaseOrderInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'receivedDate'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    db.purchaseOrder.count({ where }),
  ]);
  return { items: rows.map(toDetail), total, page: p.page, pageSize: p.pageSize };
}

function permissionsFor(
  ctx: Ctx,
  row: Parameters<typeof purchaseOrderResource>[0],
  liveInvoices: number,
): PurchaseOrderPermissions {
  const resource = purchaseOrderResource(row);
  const mayDelete = can(ctx.user, 'delete', resource);
  return {
    canUpdate: can(ctx.user, 'update', resource),
    canDelete: mayDelete && liveInvoices === 0,
    deleteBlockedReason: mayDelete && liveInvoices > 0 ? PURCHASE_ORDER_HAS_INVOICES : null,
  };
}

/** Includes a soft-deleted PO the user can see (restore view). */
export async function getPurchaseOrder(ctx: Ctx, id: string): Promise<PurchaseOrderView> {
  const db = getDb();
  const access = await findAccessible(db, ctx, id, 'read', 'any');
  const purchaseOrder = await loadPurchaseOrder(db, id);
  const [projectTotals, billing, stage] = await Promise.all([
    poTotals(db, purchaseOrder.project),
    poBilling(db, purchaseOrder),
    invoiceStage(db, { purchaseOrderId: id }),
  ]);
  return {
    ...purchaseOrder,
    projectTotals,
    billing,
    invoiceStage: stage,
    permissions: permissionsFor(ctx, access, billing.invoiceCount),
  };
}

/** Live POs on a project the user can see, oldest first (project page). */
export async function listPurchaseOrdersForProject(
  ctx: Ctx,
  projectId: string,
): Promise<PurchaseOrderDetail[]> {
  assertCan(ctx, 'list', 'purchaseOrder');
  const rows = await getDb().purchaseOrder.findMany({
    where: { projectId, AND: [scopePurchaseOrders(ctx.user)] },
    include: purchaseOrderInclude,
    orderBy: [{ receivedDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(toDetail);
}

/** The ten latest live POs on a client the user can see (client page). */
export async function listPurchaseOrdersForClient(
  ctx: Ctx,
  clientId: string,
): Promise<PurchaseOrderDetail[]> {
  assertCan(ctx, 'list', 'purchaseOrder');
  const rows = await getDb().purchaseOrder.findMany({
    where: { clientId, AND: [scopePurchaseOrders(ctx.user)] },
    include: purchaseOrderInclude,
    orderBy: [{ receivedDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: 10,
  });
  return rows.map(toDetail);
}

/**
 * What the create form starts from: the project's client and services, and the part of its
 * revenue no live PO covers yet (blank when nothing is left, or when POs in another currency
 * make the remainder unknowable). The first PO is dated from the quotation's PO received
 * date, later ones today (Decision 12).
 */
export async function getPurchaseOrderDraft(
  ctx: Ctx,
  projectId: string,
): Promise<PurchaseOrderDraft> {
  assertCan(ctx, 'create', 'purchaseOrder');
  const db = getDb();
  const project = await findProjectFor(db, ctx, projectId);
  assertCan(ctx, 'create', purchaseOrderResource({ project }));
  if (project.status === 'CANCELLED') {
    throw new DomainError(CANCELLED_PROJECT, { field: 'projectId' });
  }
  const totals = await poTotals(db, project);
  const otherCurrencies = totals.byCurrency.some((t) => t.currency !== project.currency);
  const remaining = project.revenueMinor - totals.coveredMinor;
  const first = totals.byCurrency.length === 0 && project.quotation.poReceivedDate !== null;
  return {
    projectId: project.id,
    projectNumber: project.number,
    projectName: project.name,
    clientId: project.clientId,
    clientName: project.client.name,
    quotationId: project.quotation.id,
    quotationNumber: project.quotation.number,
    enquiryId: project.quotation.enquiryId,
    services: project.services.map((link) => link.service),
    serviceIds: project.services.map((link) => link.serviceId),
    currency: project.currency,
    amountMinor: otherCurrencies || remaining <= 0n ? null : remaining,
    revenueMinor: project.revenueMinor,
    coveredMinor: totals.coveredMinor,
    otherCurrencies,
    receivedDate: first ? project.quotation.poReceivedDate! : todayInIST(),
    receivedDateFrom: first ? 'quotation' : 'today',
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

/** The PO totals after a create, with a non-blocking warning when over revenue. */
export type PoCoverage = PoTotals & { warning: string | null };

function coverageOf(totals: PoTotals, projectNumber: string): PoCoverage {
  return {
    ...totals,
    warning: totals.overCovered
      ? `POs on ${projectNumber} now total ${formatMoney(totals.coveredMinor, totals.currency)}, above its revenue of ${formatMoney(totals.revenueMinor, totals.currency)}.`
      : null,
  };
}

/**
 * Records a PO on a live, non-cancelled project the user can read, by its pipeline owner,
 * its PM or an admin. Starts PENDING (the column default; only the recompute writes the
 * status). The client is the project's (Decision 1). Takes the project lock first, so it
 * cannot race the project's delete or cancel (AC12).
 */
export async function createPurchaseOrder(
  ctx: Ctx,
  input: CreatePurchaseOrderInput,
): Promise<{ purchaseOrder: PurchaseOrderDetail; coverage: PoCoverage }> {
  const { projectId, serviceIds, ...fields } = createPurchaseOrderSchema.parse(input);
  assertCan(ctx, 'create', 'purchaseOrder');
  return guardUnique('poNumber', numberTaken(fields.poNumber), () =>
    withTx(ctx, async (tx) => {
      await lockProject(tx, projectId);
      const project = await findProjectFor(tx, ctx, projectId);
      assertCan(ctx, 'create', purchaseOrderResource({ project }));
      if (project.status === 'CANCELLED') {
        throw new DomainError(CANCELLED_PROJECT, { field: 'projectId' });
      }
      await assertNumberFree(tx, project.clientId, fields.poNumber);
      assertServicesOnProject(
        project.services.map((link) => link.serviceId),
        serviceIds,
      );
      if (fields.currency !== project.currency) await assertCurrencyEnabled(tx, fields.currency);

      const { id } = await tx.purchaseOrder.create({
        data: { ...fields, projectId, clientId: project.clientId, statusChangedAt: new Date() },
        select: { id: true },
      });
      // One row per service: M2 rejects nested writes, and each link is audited.
      for (const serviceId of serviceIds) {
        await tx.purchaseOrderService.create({ data: { purchaseOrderId: id, serviceId } });
      }
      return {
        purchaseOrder: await loadPurchaseOrder(tx, id),
        coverage: coverageOf(await poTotals(tx, project), project.number),
      };
    }),
  );
}

/**
 * Edited in place; the audit log and the replaced document are the history (Decision 9).
 * The number, services and currency are re-checked only when they change. A new amount or
 * currency recomputes the status in the same transaction.
 */
export async function updatePurchaseOrder(
  ctx: Ctx,
  id: string,
  input: UpdatePurchaseOrderInput,
): Promise<PurchaseOrderDetail & { warning: string | null }> {
  const { serviceIds, ...fields } = updatePurchaseOrderSchema.parse(input);
  return guardUnique('poNumber', numberTaken(fields.poNumber), () =>
    withTx(ctx, async (tx) => {
      await findAccessible(tx, ctx, id, 'update');
      // Invoices on this PO recompute its status under this lock (M10 Decision 12).
      await lockPurchaseOrder(tx, id);
      const current = await findAccessible(tx, ctx, id, 'update');
      const invoices = await tx.invoice.count({ where: { purchaseOrderId: id } });
      // Invoices are in the PO's currency (M10 Decision 3), so it is fixed once they exist.
      if (invoices > 0 && fields.currency !== undefined && fields.currency !== current.currency) {
        throw new DomainError(`Invoices on this PO are in ${current.currency}`, {
          field: 'currency',
        });
      }

      if (fields.poNumber !== undefined && fields.poNumber !== current.poNumber) {
        await assertNumberFree(tx, current.clientId, fields.poNumber, id);
      }
      if (
        fields.currency !== undefined &&
        fields.currency !== current.currency &&
        fields.currency !== current.project.currency
      ) {
        await assertCurrencyEnabled(tx, fields.currency);
      }

      if (serviceIds) {
        const wanted = new Set(serviceIds);
        const have = new Set(current.services.map((link) => link.serviceId));
        const added = serviceIds.filter((serviceId) => !have.has(serviceId));
        const removed = current.services.filter((link) => !wanted.has(link.serviceId));
        assertServicesOnProject(
          current.project.services.map((link) => link.serviceId),
          added,
        );
        if (removed.length > 0) {
          await tx.purchaseOrderService.deleteMany({
            where: { id: { in: removed.map((link) => link.id) } },
          });
        }
        for (const serviceId of added) {
          await tx.purchaseOrderService.create({ data: { purchaseOrderId: id, serviceId } });
        }
      }

      await guardedUpdate(tx, id, { deletedAt: null }, fields);
      if (fields.amountMinor !== undefined || fields.currency !== undefined) {
        await recomputePurchaseOrderStatus(tx, id);
      }
      const purchaseOrder = await loadPurchaseOrder(tx, id);
      // Below the invoiced total is allowed, with a warning (M10 Decision 9).
      const warning =
        fields.amountMinor !== undefined && invoices > 0
          ? overInvoicedWarning(await poBilling(tx, purchaseOrder), purchaseOrder.poNumber)
          : null;
      return { ...purchaseOrder, warning };
    }),
  );
}

/**
 * The pipeline owner, the project's PM or an admin (Decision 10), and not while it has live
 * invoices (M10). The project lock, then the PO lock (M9 lock order), stop an invoice being
 * created meanwhile. The document stays attached, so a restore brings it back.
 */
export async function softDeletePurchaseOrder(ctx: Ctx, id: string): Promise<PurchaseOrderDetail> {
  return withTx(ctx, async (tx) => {
    const { projectId } = await findAccessible(tx, ctx, id, 'delete');
    await lockProject(tx, projectId);
    await lockPurchaseOrder(tx, id);
    const current = await findAccessible(tx, ctx, id, 'delete');
    const invoices = await tx.invoice.count({ where: { purchaseOrderId: id } });
    if (invoices > 0) {
      throw new DomainError(`Delete this PO's invoices first (${invoices})`);
    }
    await guardedUpdate(
      tx,
      id,
      { deletedAt: null, documentId: current.documentId },
      { deletedAt: new Date() },
    );
    return loadPurchaseOrder(tx, id);
  });
}

/** Restores only onto a live project, and while the client has no live PO with its number. */
export async function restorePurchaseOrder(ctx: Ctx, id: string): Promise<PurchaseOrderDetail> {
  return withTx(ctx, async (tx) => {
    const current = await findAccessible(tx, ctx, id, 'delete', 'deleted');
    return guardUnique('poNumber', numberTaken(current.poNumber), async () => {
      // The project lock stops a restore racing the project's delete.
      await lockProject(tx, current.projectId);
      const project = await tx.project.findFirst({
        where: { id: current.projectId },
        select: { id: true },
      });
      if (!project) throw new DomainError('Restore the project before its purchase orders');
      await assertNumberFree(tx, current.clientId, current.poNumber, id);
      await guardedUpdate(tx, id, { deletedAt: { not: null } }, { deletedAt: null });
      return loadPurchaseOrder(tx, id);
    });
  });
}
