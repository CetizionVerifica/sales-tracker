import type { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import { scopeInvoices } from '../rbac/scope.ts';
import type { Actor } from '../rbac/types.ts';
import type { DocumentState } from '../schemas/document-state.ts';
import { todayInIST } from '../schemas/common.ts';
import { formatMoney } from '../schemas/money.ts';
import { UNPAID_INVOICE_STATUSES } from '../status/invoice.ts';

/*
 * Queries shared by the invoice, PO, project and summary services (M10). Not exported from
 * the package: they take a Db, not a ctx, so callers check permissions first.
 */

/** A PO's live invoices against its amount, all in the PO's currency (Decision 3). */
export interface PoBilling {
  currency: string;
  poAmountMinor: bigint;
  invoicedMinor: bigint;
  paidMinor: bigint;
  /** Invoiced but not yet paid (pending and overdue). */
  outstandingMinor: bigint;
  overdueMinor: bigint;
  invoiceCount: number;
  paidCount: number;
  overdueCount: number;
  /** Live invoices exceed the PO amount: a warning, not an error (Decision 9). */
  overInvoiced: boolean;
}

type PoAmount = { id: string; amountMinor: bigint; currency: string };

function emptyBilling(po: PoAmount): PoBilling {
  return {
    currency: po.currency,
    poAmountMinor: po.amountMinor,
    invoicedMinor: 0n,
    paidMinor: 0n,
    outstandingMinor: 0n,
    overdueMinor: 0n,
    invoiceCount: 0,
    paidCount: 0,
    overdueCount: 0,
    overInvoiced: false,
  };
}

/** Billing totals for several POs in one query, keyed by PO id (every id is present). */
export async function billingFor(
  db: Db,
  pos: readonly PoAmount[],
): Promise<Map<string, PoBilling>> {
  const result = new Map(pos.map((po) => [po.id, emptyBilling(po)]));
  if (pos.length === 0) return result;
  const rows = await db.invoice.groupBy({
    by: ['purchaseOrderId', 'status'],
    where: { purchaseOrderId: { in: pos.map((po) => po.id) } },
    _sum: { amountMinor: true },
    _count: { _all: true },
  });
  for (const row of rows) {
    const billing = result.get(row.purchaseOrderId);
    if (!billing) continue;
    const sum = row._sum.amountMinor ?? 0n;
    billing.invoicedMinor += sum;
    billing.invoiceCount += row._count._all;
    if (row.status === 'PAID') {
      billing.paidMinor += sum;
      billing.paidCount += row._count._all;
    } else {
      billing.outstandingMinor += sum;
    }
    if (row.status === 'OVERDUE') {
      billing.overdueMinor += sum;
      billing.overdueCount += row._count._all;
    }
  }
  for (const billing of result.values()) {
    billing.overInvoiced = billing.invoicedMinor > billing.poAmountMinor;
  }
  return result;
}

export async function poBilling(db: Db, po: PoAmount): Promise<PoBilling> {
  return (await billingFor(db, [po])).get(po.id)!;
}

/** "Invoices on PO … now total ₹X, above its amount of ₹Y." when over; otherwise null. */
export function overInvoicedWarning(billing: PoBilling, poNumber: string): string | null {
  return billing.overInvoiced
    ? `Invoices on PO ${poNumber} now total ${formatMoney(billing.invoicedMinor, billing.currency)}, above its amount of ${formatMoney(billing.poAmountMinor, billing.currency)}.`
    : null;
}

/** The invoice filter for each document state; the list and the summary chips share it. */
export const INVOICE_DOCUMENT_WHERE: Record<DocumentState, Prisma.InvoiceWhereInput> = {
  none: { documentId: null },
  reading: {
    document: { is: { reviewStatus: 'PENDING', extractionStatus: { in: ['QUEUED', 'RUNNING'] } } },
  },
  toReview: { document: { is: { reviewStatus: 'PENDING', extractionStatus: 'SUCCEEDED' } } },
  reviewed: { document: { is: { reviewStatus: 'CONFIRMED' } } },
  failed: {
    document: { is: { reviewStatus: 'PENDING', extractionStatus: { in: ['FAILED', 'SKIPPED'] } } },
  },
};

/** The pipeline strip's Invoice stage: whether a live invoice exists, and which one if one. */
export interface InvoiceStage {
  count: number;
  /** Set when there is exactly one, so the stage links straight to it. */
  invoiceId: string | null;
}

/**
 * Only invoices `user` may read are counted: a record's readers are not always its invoices'
 * readers (an enquiry's owner after its quotation is reassigned, or one PM among several on
 * an enquiry), and a count or id must not reveal records they cannot open (M4 Decision 7).
 */
export async function invoiceStage(
  db: Db,
  user: Actor,
  scope: Prisma.InvoiceWhereInput,
): Promise<InvoiceStage> {
  const where: Prisma.InvoiceWhereInput = { AND: [scopeInvoices(user), scope] };
  const rows = await db.invoice.findMany({ where, select: { id: true }, take: 2 });
  const count = rows.length < 2 ? rows.length : await db.invoice.count({ where });
  return { count, invoiceId: rows.length === 1 ? rows[0]!.id : null };
}

const DAY_MS = 86_400_000;

/** Unpaid invoices by due window: overdue, or due from today to +7 / +30 days. */
export function dueWindowWhere(
  window: 'overdue' | 'next7' | 'next30',
  today = todayInIST(),
): Prisma.InvoiceWhereInput {
  if (window === 'overdue') return { status: 'OVERDUE' };
  const days = window === 'next7' ? 7 : 30;
  return {
    status: { in: [...UNPAID_INVOICE_STATUSES] },
    dueDate: { gte: today, lte: new Date(today.getTime() + days * DAY_MS) },
  };
}
