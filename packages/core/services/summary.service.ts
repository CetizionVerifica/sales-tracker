import type {
  EnquiryStatus,
  InvoiceStatus,
  ProjectStatus,
  PurchaseOrderStatus,
  QuotationStatus,
} from '@sales-tracker/db';
import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import {
  scopeEnquiries,
  scopeInvoices,
  scopeProjects,
  scopePurchaseOrders,
  scopeQuotations,
} from '../rbac/scope.ts';
import { todayInIST } from '../schemas/common.ts';
import { ACTIVE_PROJECT_STATUSES } from '../status/project.ts';
import { ACTIVE_QUOTATION_STATUSES } from '../status/quotation.ts';
import { dueWindowWhere, INVOICE_DOCUMENT_WHERE } from './invoice-queries.ts';
import { PO_DOCUMENT_WHERE } from './purchase-order-queries.ts';

/*
 * Counts for the list pages' summary strips (UI guide §4.1). Scoped exactly like the
 * lists, live records only, so each chip's number matches the filtered list it opens.
 */

export async function enquiryStatusCounts(ctx: Ctx): Promise<Record<EnquiryStatus, number>> {
  assertCan(ctx, 'list', 'enquiry');
  const rows = await getDb().enquiry.groupBy({
    by: ['status'],
    where: { AND: [scopeEnquiries(ctx.user)] },
    _count: { _all: true },
  });
  const counts: Record<EnquiryStatus, number> = { IN_PROGRESS: 0, CONVERTED: 0, LOST: 0 };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

export async function quotationStatusCounts(
  ctx: Ctx,
): Promise<Record<QuotationStatus, number> & { followUpDue: number }> {
  assertCan(ctx, 'list', 'quotation');
  const db = getDb();
  const scope = scopeQuotations(ctx.user);
  const [rows, followUpDue] = await Promise.all([
    db.quotation.groupBy({ by: ['status'], where: { AND: [scope] }, _count: { _all: true } }),
    db.quotation.count({
      where: {
        AND: [scope],
        status: { in: [...ACTIVE_QUOTATION_STATUSES] },
        nextFollowUpDate: { lte: todayInIST() },
      },
    }),
  ]);
  const counts = { SENT: 0, UNDER_NEGOTIATION: 0, PO_RECEIVED: 0, LOST: 0, followUpDue };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

export async function projectStatusCounts(
  ctx: Ctx,
): Promise<Record<ProjectStatus, number> & { behindSchedule: number }> {
  assertCan(ctx, 'list', 'project');
  const db = getDb();
  const scope = scopeProjects(ctx.user);
  const [rows, behindSchedule] = await Promise.all([
    db.project.groupBy({ by: ['status'], where: { AND: [scope] }, _count: { _all: true } }),
    db.project.count({
      where: {
        AND: [scope],
        status: { in: [...ACTIVE_PROJECT_STATUSES] },
        endDate: { lt: todayInIST() },
      },
    }),
  ]);
  const counts = {
    NOT_STARTED: 0,
    IN_PROGRESS: 0,
    ON_HOLD: 0,
    COMPLETED: 0,
    CANCELLED: 0,
    behindSchedule,
  };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/** M9: PO status chips, plus current PO documents waiting for review (the list's filter). */
export async function purchaseOrderStatusCounts(
  ctx: Ctx,
): Promise<Record<PurchaseOrderStatus, number> & { toReview: number }> {
  assertCan(ctx, 'list', 'purchaseOrder');
  const db = getDb();
  const scope = scopePurchaseOrders(ctx.user);
  const [rows, toReview] = await Promise.all([
    db.purchaseOrder.groupBy({ by: ['status'], where: { AND: [scope] }, _count: { _all: true } }),
    db.purchaseOrder.count({ where: { AND: [scope, PO_DOCUMENT_WHERE.toReview] } }),
  ]);
  const counts = { PENDING: 0, PAID: 0, OVERDUE: 0, toReview };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}

/**
 * M10: invoice status chips, unpaid invoices due in the next seven days, and current invoice
 * documents waiting for review, each scoped like the list and matching its filter.
 */
export async function invoiceStatusCounts(
  ctx: Ctx,
): Promise<Record<InvoiceStatus, number> & { dueNext7: number; toReview: number }> {
  assertCan(ctx, 'list', 'invoice');
  const db = getDb();
  const scope = scopeInvoices(ctx.user);
  const [rows, dueNext7, toReview] = await Promise.all([
    db.invoice.groupBy({ by: ['status'], where: { AND: [scope] }, _count: { _all: true } }),
    db.invoice.count({ where: { AND: [scope, dueWindowWhere('next7')] } }),
    db.invoice.count({ where: { AND: [scope, INVOICE_DOCUMENT_WHERE.toReview] } }),
  ]);
  const counts = { PENDING: 0, PAID: 0, OVERDUE: 0, dueNext7, toReview };
  for (const row of rows) counts[row.status] = row._count._all;
  return counts;
}
