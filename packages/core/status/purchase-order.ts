import type { PurchaseOrderStatus } from '@sales-tracker/db';

/**
 * A PO's status is derived from its invoices, never chosen (M9 Decision 4), so there is no
 * transition table or assert here: nobody moves a PO, and recomputePurchaseOrderStatus is
 * the only writer.
 */

/** An invoice as the derivation sees it. M10's Invoice model supplies these. */
export interface InvoiceForStatus {
  status: 'PENDING' | 'PAID' | 'OVERDUE';
  amountMinor: bigint;
}

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

/**
 * The PO's status from its **live** invoices, which are in the PO's currency (M10 enforces
 * that, since amounts are summed):
 *
 * 1. any invoice OVERDUE → OVERDUE, even if others are paid;
 * 2. at least one invoice, all PAID, and together at least the PO amount → PAID (Decision 5:
 *    a paid advance on a partly invoiced PO is not "paid");
 * 3. otherwise, including no invoices at all → PENDING.
 */
export function derivePurchaseOrderStatus(
  po: { amountMinor: bigint; currency: string },
  invoices: readonly InvoiceForStatus[],
): PurchaseOrderStatus {
  if (invoices.some((invoice) => invoice.status === 'OVERDUE')) return 'OVERDUE';
  if (invoices.length === 0 || invoices.some((invoice) => invoice.status !== 'PAID')) {
    return 'PENDING';
  }
  const invoiced = invoices.reduce((sum, invoice) => sum + invoice.amountMinor, 0n);
  return invoiced >= po.amountMinor ? 'PAID' : 'PENDING';
}
