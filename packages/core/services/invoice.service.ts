import type { DueDateBasis, InvoiceStatus, Prisma } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { can } from '../rbac/can.ts';
import { invoiceAccessSelect, invoiceResource, scopeInvoices } from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import { todayInIST, type Page } from '../schemas/common.ts';
import type { DocumentState } from '../schemas/document-state.ts';
import {
  createInvoiceSchema,
  dueDateHint,
  listInvoicesSchema,
  markInvoicePaidSchema,
  markInvoiceUnpaidSchema,
  updateInvoiceSchema,
  type CreateInvoiceInput,
  type InvoiceDraft,
  type ListInvoicesInput,
  type MarkInvoicePaidInput,
  type MarkInvoiceUnpaidInput,
  type UpdateInvoiceInput,
} from '../schemas/invoice.ts';
import { parseAmount } from '../schemas/money.ts';
import { UNASSIGNED } from '../schemas/project.ts';
import { documentStateOf } from '../status/document.ts';
import {
  assertInvoiceTransition,
  daysOverdue,
  defaultDueDate,
  invoiceStatusForDueDate,
  type InvoiceActor,
  type InvoiceMove,
} from '../status/invoice.ts';
import {
  dueWindowWhere,
  INVOICE_DOCUMENT_WHERE,
  overInvoicedWarning,
  poBilling,
  type PoBilling,
} from './invoice-queries.ts';
import { lockPurchaseOrder } from './purchase-order-lock.ts';
import { recomputePurchaseOrderStatus } from './purchase-order-status.ts';
import { SETTINGS_ID } from './settings.service.ts';
import { guardUnique } from './unique.ts';

export type { PoBilling } from './invoice-queries.ts';

/*
 * Invoices (M10): what we bill the client against one of their POs. Permissions come from
 * the PO's project (its PM) and quotation (the pipeline owner), read through relations
 * (Decision 1). Every write locks the PO first and recomputes its derived status in the same
 * transaction (Decision 12, M9 "For M10"). The status changes only through the machine in
 * status/invoice.ts: moveInvoiceStatus is the one writer after create.
 */

export const CONCURRENT_INVOICE_CHANGE = 'Someone else changed this invoice. Reload and try again.';

// Relations loaded with `include` are not soft-delete filtered, so a retired service or a
// deactivated manager still shows its name on existing invoices (as in M3 AC12).
const invoiceInclude = {
  client: { select: { id: true, name: true, gstin: true } },
  service: { select: { id: true, name: true } },
  purchaseOrder: {
    select: {
      id: true,
      poNumber: true,
      amountMinor: true,
      currency: true,
      status: true,
      paymentTerms: true,
      paymentTermsDays: true,
      deletedAt: true,
      project: {
        select: {
          id: true,
          number: true,
          name: true,
          status: true,
          managerId: true,
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
    },
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
} satisfies Prisma.InvoiceInclude;

type InvoiceRow = Prisma.InvoiceGetPayload<{ include: typeof invoiceInclude }>;

/** An invoice with its client, service, PO, project and document state, for display. */
export type InvoiceDetail = InvoiceRow & {
  documentState: DocumentState;
  /** Days past the due date for an unpaid invoice (negative before it); null once paid. */
  daysOverdue: number | null;
};

/** What the actor may do on the invoice page. */
export interface InvoicePermissions {
  canUpdate: boolean;
  canMarkPaid: boolean;
  canMarkUnpaid: boolean;
  canDelete: boolean;
  /** Why the invoice cannot be deleted although the actor may delete invoices. */
  deleteBlockedReason: string | null;
}

export type InvoiceView = InvoiceDetail & {
  /** The PO's live invoices against its amount. */
  billing: PoBilling;
  permissions: InvoicePermissions;
};

function toDetail(row: InvoiceRow, today = todayInIST()): InvoiceDetail {
  return {
    ...row,
    documentState: documentStateOf(row.document),
    daysOverdue: row.status === 'PAID' ? null : daysOverdue(row.dueDate, today),
  };
}

/** Includes a soft-deleted invoice (detail page with Restore). */
async function loadInvoice(db: Db, id: string): Promise<InvoiceDetail> {
  const row = await db.invoice.findFirst({
    where: { id, deletedAt: undefined },
    include: invoiceInclude,
  });
  if (!row) throw new NotFoundError('invoice');
  return toDetail(row);
}

const accessSelect = {
  id: true,
  purchaseOrderId: true,
  invoiceNumber: true,
  invoiceDate: true,
  dueDate: true,
  dueDateBasis: true,
  status: true,
  paidAt: true,
  currency: true,
  serviceId: true,
  documentId: true,
  purchaseOrder: {
    select: {
      ...invoiceAccessSelect.purchaseOrder.select,
      id: true,
      poNumber: true,
      paymentTermsDays: true,
      services: { select: { serviceId: true } },
    },
  },
} satisfies Prisma.InvoiceSelect;

type AccessRow = Prisma.InvoiceGetPayload<{ select: typeof accessSelect }>;

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/**
 * Loads the ownership fields and checks `action`. An invoice the user cannot read is
 * reported as not found, so other people's ids don't leak (M4 Decision 7).
 */
async function findAccessible(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
): Promise<AccessRow> {
  const row = await db.invoice.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    select: accessSelect,
  });
  if (!row || !can(ctx.user, 'read', invoiceResource(row))) throw new NotFoundError('invoice');
  assertCan(ctx, action, invoiceResource(row));
  return row;
}

/**
 * Checks access, takes the PO lock, then reads the invoice again, so the checks and the
 * status recompute see what no other invoice write on the PO can change until commit.
 */
async function lockAccessible(
  tx: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
): Promise<AccessRow> {
  const { purchaseOrderId } = await findAccessible(tx, ctx, id, action, rows);
  await lockPurchaseOrder(tx, purchaseOrderId);
  return findAccessible(tx, ctx, id, action, rows);
}

/** The PO an invoice is raised on, if it is live and the user can read it (else not found). */
async function findPurchaseOrderFor(db: Db, ctx: Ctx, purchaseOrderId: string) {
  const po = await db.purchaseOrder.findFirst({
    where: { id: purchaseOrderId },
    select: {
      id: true,
      poNumber: true,
      clientId: true,
      currency: true,
      amountMinor: true,
      paymentTermsDays: true,
      client: { select: { name: true, deletedAt: true } },
      services: {
        select: { serviceId: true, service: { select: { id: true, name: true } } },
        orderBy: { service: { name: 'asc' } },
      },
      project: {
        select: {
          id: true,
          number: true,
          name: true,
          managerId: true,
          quotation: { select: { id: true, ownerId: true, enquiryId: true } },
        },
      },
    },
  });
  if (
    !po ||
    po.client.deletedAt ||
    !can(ctx.user, 'read', invoiceResource({ purchaseOrder: po }))
  ) {
    throw new NotFoundError('purchase order');
  }
  return po;
}

// ─── Checks ─────────────────────────────────────────────────────────────────────────

/** Only admins delete a paid invoice (Decision 10). */
export const PAID_DELETE_ADMIN_ONLY = 'Only admins can delete a paid invoice';

/** `admin` for admins, `user` for everyone else; the nightly job passes `system` itself. */
const actorOf = (ctx: Ctx): InvoiceActor => (ctx.user.role === 'ADMIN' ? 'admin' : 'user');

/**
 * The invoice number must not match a live invoice anywhere, ignoring case (Decision 2).
 * The partial unique index backs this for requests racing each other.
 */
async function assertNumberFree(db: Db, invoiceNumber: string, exceptId?: string) {
  const clash = await db.invoice.findFirst({
    where: {
      invoiceNumber: { equals: invoiceNumber, mode: 'insensitive' },
      ...(exceptId && { id: { not: exceptId } }),
    },
    select: { invoiceNumber: true, purchaseOrder: { select: { poNumber: true } } },
  });
  if (clash) {
    throw new DomainError(
      `Invoice ${clash.invoiceNumber} already exists (on PO ${clash.purchaseOrder.poNumber})`,
      { field: 'invoiceNumber' },
    );
  }
}

const numberTaken = (invoiceNumber: string | undefined) =>
  invoiceNumber ? `Invoice ${invoiceNumber} already exists` : 'That invoice number already exists';

/** An invoice's service is one of its PO's (Decision 4). */
function assertServiceOnPo(poServiceIds: readonly { serviceId: string }[], serviceId: string) {
  if (!poServiceIds.some((link) => link.serviceId === serviceId)) {
    throw new DomainError('Choose one of the purchase order’s services', { field: 'serviceId' });
  }
}

/** The typed amount in the PO's currency, as minor units (Decision 3). */
function toMinor(amount: string, currency: string): bigint {
  const parsed = parseAmount(amount, currency);
  if (!parsed.ok) throw new DomainError(parsed.message, { field: 'amount' });
  if (parsed.value <= 0n) {
    throw new DomainError('The amount must be more than zero', { field: 'amount' });
  }
  return parsed.value;
}

async function companyDefaultDays(db: Db): Promise<number> {
  const settings = await db.companySettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { defaultInvoiceDueDays: true },
  });
  if (!settings) throw new Error('Company settings are missing; run `pnpm db:seed`');
  return settings.defaultInvoiceDueDays;
}

/**
 * The due date and its basis (Decision 6): a typed date is MANUAL unless it equals the
 * default; no typed date means the default from the PO's current terms and settings.
 */
async function resolveDueDate(
  db: Db,
  input: { invoiceDate: Date; typed: Date | null | undefined; poPaymentTermsDays: number | null },
): Promise<{ dueDate: Date; basis: DueDateBasis }> {
  const fallback = defaultDueDate({
    invoiceDate: input.invoiceDate,
    poPaymentTermsDays: input.poPaymentTermsDays,
    companyDefaultDays: await companyDefaultDays(db),
  });
  if (!input.typed || input.typed.getTime() === fallback.dueDate.getTime()) return fallback;
  return { dueDate: input.typed, basis: 'MANUAL' };
}

function assertDueNotBeforeInvoice(dueDate: Date, invoiceDate: Date) {
  if (dueDate < invoiceDate) {
    throw new DomainError('The due date cannot be before the invoice date', { field: 'dueDate' });
  }
}

/**
 * Writes only if the row still looks the way the caller read it (the M4 race fix). An empty
 * `data` still checks the row.
 */
async function guardedUpdate(
  tx: Db,
  id: string,
  expected: Prisma.InvoiceWhereInput,
  data: Prisma.InvoiceUpdateManyMutationInput,
) {
  const where = { ...expected, id };
  const count =
    Object.keys(data).length > 0
      ? (await tx.invoice.updateMany({ where, data })).count
      : await tx.invoice.count({ where });
  if (count === 0) throw new DomainError(CONCURRENT_INVOICE_CHANGE);
}

/**
 * The one writer of an existing invoice's status (CLAUDE.md rule 8): checks the move with
 * the machine, then writes it guarded on the status that was read. `data` carries the
 * fields that travel with the move (the paid date and reference, or the unpaid reason).
 */
async function moveInvoiceStatus(
  tx: Db,
  invoice: { id: string; status: InvoiceStatus; invoiceDate: Date },
  to: InvoiceStatus,
  move: InvoiceMove & { paidAt?: Date | null; today: Date },
  data: Prisma.InvoiceUpdateManyMutationInput = {},
) {
  assertInvoiceTransition(invoice, to, move);
  const { count } = await tx.invoice.updateMany({
    where: { id: invoice.id, status: invoice.status, deletedAt: null },
    data: { ...data, status: to, statusChangedAt: new Date() },
  });
  if (count === 0) throw new DomainError(CONCURRENT_INVOICE_CHANGE);
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

const SORT_COLUMNS = {
  invoiceDate: (dir) => ({ invoiceDate: dir }),
  dueDate: (dir) => ({ dueDate: dir }),
  invoiceNumber: (dir) => ({ invoiceNumber: dir }),
  client: (dir) => ({ client: { name: dir } }),
  // Minor units across currencies are not comparable; the list notes this (M12 converts).
  amount: (dir) => ({ amountMinor: dir }),
  status: (dir) => ({ status: dir }),
  paidAt: (dir) => ({ paidAt: { sort: dir, nulls: 'last' } }),
  createdAt: (dir) => ({ createdAt: dir }),
  updatedAt: (dir) => ({ updatedAt: dir }),
} satisfies Record<string, (dir: Prisma.SortOrder) => Prisma.InvoiceOrderByWithRelationInput>;

const between = (from: Date | undefined, to: Date | undefined) =>
  from || to ? { ...(from && { gte: from }), ...(to && { lte: to }) } : undefined;

/** The list's where clause. */
function invoiceListWhere(ctx: Ctx, input: ListInvoicesInput): Prisma.InvoiceWhereInput {
  const p = listInvoicesSchema.parse(input);
  if (p.ownerId && ctx.user.role !== 'ADMIN') {
    throw new DomainError('Only admins can filter by owner', { field: 'ownerId' });
  }
  const contains = p.q ? { contains: p.q, mode: 'insensitive' as const } : undefined;
  const project: Prisma.ProjectWhereInput = {
    ...(p.projectId && { id: p.projectId }),
    ...(p.managerId && { managerId: p.managerId === UNASSIGNED ? null : p.managerId }),
    ...(p.ownerId && { quotation: { ownerId: p.ownerId } }),
  };
  const filters: Prisma.InvoiceWhereInput[] = [
    {
      ...(p.status && { status: { in: p.status } }),
      ...(p.currency && { currency: { in: p.currency } }),
      ...(p.purchaseOrderId && { purchaseOrderId: p.purchaseOrderId }),
      ...(p.clientId && { clientId: p.clientId }),
      ...(p.serviceId && { serviceId: p.serviceId }),
      ...(between(p.invoiceFrom, p.invoiceTo) && {
        invoiceDate: between(p.invoiceFrom, p.invoiceTo),
      }),
      ...(Object.keys(project).length > 0 && { purchaseOrder: { project } }),
      ...(contains && {
        OR: [
          { invoiceNumber: contains },
          { paymentReference: contains },
          { client: { name: contains } },
          { purchaseOrder: { poNumber: contains } },
          { purchaseOrder: { project: { number: contains } } },
          { purchaseOrder: { project: { name: contains } } },
        ],
      }),
    },
  ];
  // The due range and window both constrain dueDate, so they go in separate AND terms.
  if (between(p.dueFrom, p.dueTo)) filters.push({ dueDate: between(p.dueFrom, p.dueTo) });
  if (p.due) filters.push(dueWindowWhere(p.due));
  if (p.document) filters.push(INVOICE_DOCUMENT_WHERE[p.document]);
  // `deletedAt` stays top-level: that is the soft-delete extension's opt-in (M3).
  return {
    ...(p.recordStatus === 'deleted' && { deletedAt: { not: null } }),
    AND: [scopeInvoices(ctx.user), ...filters],
  };
}

export async function listInvoices(
  ctx: Ctx,
  input: ListInvoicesInput,
): Promise<Page<InvoiceDetail>> {
  const p = listInvoicesSchema.parse(input);
  assertCan(ctx, 'list', 'invoice');
  const where = invoiceListWhere(ctx, input);
  const dir = p.dir ?? (p.sort ? 'asc' : 'desc');
  const db = getDb();
  const today = todayInIST();

  const [rows, total] = await Promise.all([
    db.invoice.findMany({
      where,
      include: invoiceInclude,
      orderBy: [SORT_COLUMNS[p.sort ?? 'invoiceDate'](dir), { createdAt: 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
    db.invoice.count({ where }),
  ]);
  return {
    items: rows.map((row) => toDetail(row, today)),
    total,
    page: p.page,
    pageSize: p.pageSize,
  };
}

function permissionsFor(
  ctx: Ctx,
  row: AccessRow & { deletedAt?: Date | null },
): InvoicePermissions {
  const resource = invoiceResource(row);
  const canUpdate = can(ctx.user, 'update', resource);
  const mayDelete = can(ctx.user, 'delete', resource);
  const paidBlock = row.status === 'PAID' && ctx.user.role !== 'ADMIN';
  const live = !row.deletedAt;
  return {
    canUpdate: canUpdate && live,
    canMarkPaid: canUpdate && live && row.status !== 'PAID',
    canMarkUnpaid: live && row.status === 'PAID' && ctx.user.role === 'ADMIN',
    canDelete: live && mayDelete && !paidBlock,
    deleteBlockedReason: live && mayDelete && paidBlock ? PAID_DELETE_ADMIN_ONLY : null,
  };
}

/** Includes a soft-deleted invoice the user can see (restore view). */
export async function getInvoice(ctx: Ctx, id: string): Promise<InvoiceView> {
  const db = getDb();
  const access = await findAccessible(db, ctx, id, 'read', 'any');
  const invoice = await loadInvoice(db, id);
  return {
    ...invoice,
    billing: await poBilling(db, invoice.purchaseOrder),
    permissions: permissionsFor(ctx, { ...access, deletedAt: invoice.deletedAt }),
  };
}

/** Live invoices on a PO the user can see, oldest first (PO page). */
export async function listInvoicesForPurchaseOrder(
  ctx: Ctx,
  purchaseOrderId: string,
): Promise<InvoiceDetail[]> {
  assertCan(ctx, 'list', 'invoice');
  const rows = await getDb().invoice.findMany({
    where: { purchaseOrderId, AND: [scopeInvoices(ctx.user)] },
    include: invoiceInclude,
    orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toDetail(row));
}

/** Live invoices on a project's POs the user can see, oldest first (project page). */
export async function listInvoicesForProject(
  ctx: Ctx,
  projectId: string,
): Promise<InvoiceDetail[]> {
  assertCan(ctx, 'list', 'invoice');
  const rows = await getDb().invoice.findMany({
    where: { purchaseOrder: { projectId }, AND: [scopeInvoices(ctx.user)] },
    include: invoiceInclude,
    orderBy: [{ invoiceDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => toDetail(row));
}

/** Up to ten live invoices on a client the user can see, overdue first (client page). */
export async function listInvoicesForClient(ctx: Ctx, clientId: string): Promise<InvoiceDetail[]> {
  assertCan(ctx, 'list', 'invoice');
  const db = getDb();
  const where = { clientId, AND: [scopeInvoices(ctx.user)] };
  const overdue = await db.invoice.findMany({
    where: { ...where, status: 'OVERDUE' },
    include: invoiceInclude,
    orderBy: [{ dueDate: 'asc' }, { id: 'asc' }],
    take: 10,
  });
  const rest = await db.invoice.findMany({
    where: { ...where, status: { not: 'OVERDUE' } },
    include: invoiceInclude,
    orderBy: [{ invoiceDate: 'desc' }, { createdAt: 'desc' }, { id: 'asc' }],
    take: 10 - overdue.length,
  });
  return [...overdue, ...rest].map((row) => toDetail(row));
}

/**
 * What the create form starts from: the PO's client, currency and services, the part of its
 * amount not yet invoiced (blank when nothing is left), today's date and the default due
 * date with its hint (Decision 6).
 */
export async function getInvoiceDraft(ctx: Ctx, purchaseOrderId: string): Promise<InvoiceDraft> {
  assertCan(ctx, 'create', 'invoice');
  const db = getDb();
  const po = await findPurchaseOrderFor(db, ctx, purchaseOrderId);
  assertCan(ctx, 'create', invoiceResource({ purchaseOrder: po }));
  const billing = await poBilling(db, po);
  const remaining = po.amountMinor - billing.invoicedMinor;
  const days = await companyDefaultDays(db);
  const invoiceDate = todayInIST();
  const due = defaultDueDate({
    invoiceDate,
    poPaymentTermsDays: po.paymentTermsDays,
    companyDefaultDays: days,
  });
  return {
    purchaseOrderId: po.id,
    poNumber: po.poNumber,
    projectId: po.project.id,
    projectNumber: po.project.number,
    projectName: po.project.name,
    clientId: po.clientId,
    clientName: po.client.name,
    quotationId: po.project.quotation.id,
    enquiryId: po.project.quotation.enquiryId,
    currency: po.currency,
    services: po.services.map((link) => link.service),
    serviceId: po.services.length === 1 ? po.services[0]!.serviceId : null,
    amountMinor: remaining > 0n ? remaining : null,
    poAmountMinor: po.amountMinor,
    invoicedMinor: billing.invoicedMinor,
    invoiceDate,
    dueDate: due.dueDate,
    dueDateBasis: due.basis,
    poPaymentTermsDays: po.paymentTermsDays,
    companyDefaultDays: days,
    dueDateHint: dueDateHint(due.basis, {
      poNumber: po.poNumber,
      poPaymentTermsDays: po.paymentTermsDays,
      companyDefaultDays: days,
    }),
  };
}

// ─── Writes ─────────────────────────────────────────────────────────────────────────

/** The PO's billing after a write, with a non-blocking warning when over-invoiced. */
export type InvoiceBilling = PoBilling & { warning: string | null };

async function billingAfter(tx: Db, po: { id: string; poNumber: string }): Promise<InvoiceBilling> {
  const amounts = await tx.purchaseOrder.findFirst({
    where: { id: po.id },
    select: { id: true, amountMinor: true, currency: true },
  });
  if (!amounts) throw new NotFoundError('purchase order');
  const billing = await poBilling(tx, amounts);
  return { ...billing, warning: overInvoicedWarning(billing, po.poNumber) };
}

/**
 * Records an invoice on a live PO the user can read, by its pipeline owner, its project's PM
 * or an admin; a cancelled project's POs are allowed (Decision 5). The client and currency
 * are the PO's. The status is PAID when a paid date is given, otherwise PENDING or, for a
 * back-dated invoice already past due, OVERDUE (Decision 7). Recomputes the PO's status.
 */
export async function createInvoice(
  ctx: Ctx,
  input: CreateInvoiceInput,
): Promise<{ invoice: InvoiceDetail; billing: InvoiceBilling }> {
  const { purchaseOrderId, amount, dueDate, paidAt, ...fields } = createInvoiceSchema.parse(input);
  assertCan(ctx, 'create', 'invoice');
  return guardUnique('invoiceNumber', numberTaken(fields.invoiceNumber), () =>
    withTx(ctx, async (tx) => {
      await lockPurchaseOrder(tx, purchaseOrderId);
      const po = await findPurchaseOrderFor(tx, ctx, purchaseOrderId);
      assertCan(ctx, 'create', invoiceResource({ purchaseOrder: po }));
      await assertNumberFree(tx, fields.invoiceNumber);
      assertServiceOnPo(po.services, fields.serviceId);
      const amountMinor = toMinor(amount, po.currency);
      const due = await resolveDueDate(tx, {
        invoiceDate: fields.invoiceDate,
        typed: dueDate,
        poPaymentTermsDays: po.paymentTermsDays,
      });
      assertDueNotBeforeInvoice(due.dueDate, fields.invoiceDate);

      const today = todayInIST();
      let status = invoiceStatusForDueDate('PENDING', due.dueDate, today);
      if (paidAt) {
        // Recorded as paid from the start: the same checks as Mark paid.
        assertInvoiceTransition({ status, invoiceDate: fields.invoiceDate }, 'PAID', {
          by: actorOf(ctx),
          paidAt,
          today,
        });
        status = 'PAID';
      }

      const { id } = await tx.invoice.create({
        data: {
          ...fields,
          purchaseOrderId,
          clientId: po.clientId,
          currency: po.currency,
          amountMinor,
          dueDate: due.dueDate,
          dueDateBasis: due.basis,
          status,
          statusChangedAt: new Date(),
          paidAt: paidAt ?? null,
        },
        select: { id: true },
      });
      await recomputePurchaseOrderStatus(tx, purchaseOrderId);
      return { invoice: await loadInvoice(tx, id), billing: await billingAfter(tx, po) };
    }),
  );
}

const sameDay = (a: Date | null, b: Date | null) =>
  (a?.getTime() ?? null) === (b?.getTime() ?? null);

/**
 * Edited in place; the audit log and the replaced document are the history. A new invoice
 * date moves a PO_TERMS or COMPANY_DEFAULT due date with it, from the PO's current terms and
 * settings; a MANUAL one stays (Decision 6). An unpaid invoice's status follows its due date
 * (Decision 7). A new amount or status recomputes the PO.
 */
export async function updateInvoice(
  ctx: Ctx,
  id: string,
  input: UpdateInvoiceInput,
): Promise<InvoiceDetail> {
  const { amount, dueDate, ...fields } = updateInvoiceSchema.parse(input);
  return guardUnique('invoiceNumber', numberTaken(fields.invoiceNumber), () =>
    withTx(ctx, async (tx) => {
      const current = await lockAccessible(tx, ctx, id, 'update');

      if (fields.invoiceNumber !== undefined && fields.invoiceNumber !== current.invoiceNumber) {
        await assertNumberFree(tx, fields.invoiceNumber, id);
      }
      if (fields.serviceId !== undefined && fields.serviceId !== current.serviceId) {
        assertServiceOnPo(current.purchaseOrder.services, fields.serviceId);
      }
      const amountMinor = amount === undefined ? undefined : toMinor(amount, current.currency);

      const invoiceDate = fields.invoiceDate ?? current.invoiceDate;
      const dateMoved = !sameDay(invoiceDate, current.invoiceDate);
      let due = { dueDate: current.dueDate, basis: current.dueDateBasis };
      if (dueDate !== undefined || (dateMoved && current.dueDateBasis !== 'MANUAL')) {
        due = await resolveDueDate(tx, {
          invoiceDate,
          typed: dueDate,
          poPaymentTermsDays: current.purchaseOrder.paymentTermsDays,
        });
      }
      assertDueNotBeforeInvoice(due.dueDate, invoiceDate);
      if (current.paidAt && invoiceDate > current.paidAt) {
        throw new DomainError('The invoice date cannot be after the paid date', {
          field: 'invoiceDate',
        });
      }

      const data: Prisma.InvoiceUpdateManyMutationInput = { ...fields };
      if (!dateMoved) delete data.invoiceDate;
      if (amountMinor !== undefined) data.amountMinor = amountMinor;
      if (!sameDay(due.dueDate, current.dueDate)) data.dueDate = due.dueDate;
      if (due.basis !== current.dueDateBasis) data.dueDateBasis = due.basis;
      await guardedUpdate(tx, id, { deletedAt: null, status: current.status }, data);

      const today = todayInIST();
      const next = invoiceStatusForDueDate(current.status, due.dueDate, today);
      if (next !== current.status) {
        await moveInvoiceStatus(tx, { ...current, invoiceDate }, next, {
          by: actorOf(ctx),
          dueDateChange: true,
          today,
        });
      }
      if (amountMinor !== undefined || next !== current.status) {
        await recomputePurchaseOrderStatus(tx, current.purchaseOrderId);
      }
      return loadInvoice(tx, id);
    }),
  );
}

/**
 * Mark paid (Decision 14): anyone who may update the invoice. The paid date is checked by
 * the machine; a reason left by an earlier Mark unpaid is cleared.
 */
export async function markInvoicePaid(
  ctx: Ctx,
  input: MarkInvoicePaidInput,
): Promise<InvoiceDetail> {
  const { id, paidAt, paymentReference } = markInvoicePaidSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await lockAccessible(tx, ctx, id, 'update');
    if (current.status === 'PAID') throw new DomainError('This invoice is already marked paid');
    await moveInvoiceStatus(
      tx,
      current,
      'PAID',
      { by: actorOf(ctx), paidAt, today: todayInIST() },
      {
        paidAt,
        ...(paymentReference !== undefined && { paymentReference }),
        unmarkedPaidReason: null,
      },
    );
    await recomputePurchaseOrderStatus(tx, current.purchaseOrderId);
    return loadInvoice(tx, id);
  });
}

/**
 * Mark unpaid (Decision 8): admins only, with a reason kept on the invoice (so its audit row
 * carries it). The status goes back to what the due date says.
 */
export async function markInvoiceUnpaid(
  ctx: Ctx,
  input: MarkInvoiceUnpaidInput,
): Promise<InvoiceDetail> {
  const { id, reason } = markInvoiceUnpaidSchema.parse(input);
  return withTx(ctx, async (tx) => {
    const current = await lockAccessible(tx, ctx, id, 'update');
    if (ctx.user.role !== 'ADMIN') throw new ForbiddenError('mark unpaid', 'invoice');
    if (current.status !== 'PAID') throw new DomainError('This invoice is not marked paid');
    const today = todayInIST();
    await moveInvoiceStatus(
      tx,
      current,
      invoiceStatusForDueDate('PENDING', current.dueDate, today),
      { by: 'admin', today },
      { paidAt: null, paymentReference: null, unmarkedPaidReason: reason },
    );
    await recomputePurchaseOrderStatus(tx, current.purchaseOrderId);
    return loadInvoice(tx, id);
  });
}

/**
 * The pipeline owner, the project's PM or an admin; a paid invoice only by an admin
 * (Decision 10). The document stays attached, so a restore brings it back.
 */
export async function softDeleteInvoice(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  return withTx(ctx, async (tx) => {
    const current = await lockAccessible(tx, ctx, id, 'delete');
    if (current.status === 'PAID' && ctx.user.role !== 'ADMIN') {
      throw new ForbiddenError('delete', 'paid invoice');
    }
    await guardedUpdate(
      tx,
      id,
      { deletedAt: null, documentId: current.documentId },
      { deletedAt: new Date() },
    );
    await recomputePurchaseOrderStatus(tx, current.purchaseOrderId);
    return loadInvoice(tx, id);
  });
}

/** Restores only onto a live PO, and while no live invoice has its number. */
export async function restoreInvoice(ctx: Ctx, id: string): Promise<InvoiceDetail> {
  return withTx(ctx, async (tx) => {
    const current = await lockAccessible(tx, ctx, id, 'delete', 'deleted');
    return guardUnique('invoiceNumber', numberTaken(current.invoiceNumber), async () => {
      const po = await tx.purchaseOrder.findFirst({
        where: { id: current.purchaseOrderId },
        select: { id: true },
      });
      if (!po) throw new DomainError('Restore the purchase order before its invoices');
      await assertNumberFree(tx, current.invoiceNumber, id);
      await guardedUpdate(tx, id, { deletedAt: { not: null } }, { deletedAt: null });
      await recomputePurchaseOrderStatus(tx, current.purchaseOrderId);
      return loadInvoice(tx, id);
    });
  });
}

// ─── Nightly overdue job ────────────────────────────────────────────────────────────

export interface OverdueRun {
  /** Invoices moved PENDING → OVERDUE. */
  markedOverdue: number;
  /** POs whose status changed (after an invoice went overdue, or by the safety net). */
  posRecomputed: number;
  /** Invoices or POs that failed; each was logged and the run went on. */
  failed: number;
}

const OVERDUE_BATCH = 100;

/**
 * The nightly job (PLAN.md "done when"): every live PENDING invoice due before `today` (IST)
 * becomes OVERDUE, each in its own transaction with its PO locked and recomputed, so one
 * failure does not stop the rest. Then a safety net recomputes any live PO with an overdue
 * invoice that is not OVERDUE itself (M9 risk "stored status can drift"). Idempotent: a
 * second run the same day writes nothing. For the worker only (`source: 'system'`).
 */
export async function markOverdueInvoices(
  ctx: Ctx,
  { today = todayInIST() }: { today?: Date } = {},
): Promise<OverdueRun> {
  if (ctx.source !== 'system') throw new ForbiddenError('run', 'overdue check');
  // The system user is an admin; checked like any other actor (CLAUDE.md rule 2).
  assertCan(ctx, 'update', 'invoice');
  const db = getDb();
  const run: OverdueRun = { markedOverdue: 0, posRecomputed: 0, failed: 0 };

  let after: string | undefined;
  for (;;) {
    const batch = await db.invoice.findMany({
      where: { status: 'PENDING', dueDate: { lt: today }, ...(after && { id: { gt: after } }) },
      select: { id: true, purchaseOrderId: true },
      orderBy: { id: 'asc' },
      take: OVERDUE_BATCH,
    });
    if (batch.length === 0) break;
    after = batch.at(-1)!.id;
    for (const { id, purchaseOrderId } of batch) {
      try {
        const changed = await withTx(ctx, async (tx) => {
          await lockPurchaseOrder(tx, purchaseOrderId);
          // Re-read under the lock: it may have been paid or moved meanwhile.
          const invoice = await tx.invoice.findFirst({
            where: { id, status: 'PENDING', dueDate: { lt: today } },
            select: { id: true, status: true, invoiceDate: true },
          });
          if (!invoice) return null;
          await moveInvoiceStatus(tx, invoice, 'OVERDUE', { by: 'system', today });
          return recomputePurchaseOrderStatus(tx, purchaseOrderId);
        });
        if (changed) {
          run.markedOverdue++;
          if (changed.changed) run.posRecomputed++;
        }
      } catch (error) {
        run.failed++;
        console.error(`overdue check: invoice ${id} failed`, error);
      }
    }
  }

  const drifted = await db.purchaseOrder.findMany({
    where: {
      status: { not: 'OVERDUE' },
      invoices: { some: { status: 'OVERDUE', deletedAt: null } },
    },
    select: { id: true },
  });
  for (const { id } of drifted) {
    try {
      const result = await withTx(ctx, async (tx) => {
        await lockPurchaseOrder(tx, id);
        return recomputePurchaseOrderStatus(tx, id);
      });
      if (result.changed) run.posRecomputed++;
    } catch (error) {
      run.failed++;
      console.error(`overdue check: purchase order ${id} failed`, error);
    }
  }
  return run;
}
