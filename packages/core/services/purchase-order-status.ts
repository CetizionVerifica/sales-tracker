import type { PurchaseOrderStatus } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { derivePurchaseOrderStatus, type InvoiceForStatus } from '../status/purchase-order.ts';

/*
 * The one writer of PurchaseOrder.status (M9 Decision 4). Not exported from the package:
 * only core services call it, inside their own permission-checked, audited transaction, so
 * its audit row carries the caller's source and requestId. A test pins that nothing else
 * writes the status.
 */

export const CONCURRENT_PURCHASE_ORDER_CHANGE =
  'Someone else changed this purchase order. Reload and try again.';

export type InvoiceLoader = (tx: Db, purchaseOrderId: string) => Promise<InvoiceForStatus[]>;

/** The PO's live invoices (M10), as the derivation sees them. */
export async function liveInvoicesFor(
  tx: Db,
  purchaseOrderId: string,
): Promise<InvoiceForStatus[]> {
  return tx.invoice.findMany({
    where: { purchaseOrderId },
    select: { status: true, amountMinor: true },
  });
}

/**
 * Derives the PO's status from its live invoices and stores it with `statusChangedAt`, only
 * when it changed. Runs in the caller's transaction (M10: every invoice create, amount or
 * status change, soft delete and restore, and the nightly overdue job as `system`).
 * `loadInvoices` is a parameter for tests only; production callers use the default.
 */
export async function recomputePurchaseOrderStatus(
  tx: Db,
  purchaseOrderId: string,
  loadInvoices: InvoiceLoader = liveInvoicesFor,
): Promise<{ status: PurchaseOrderStatus; changed: boolean }> {
  const po = await tx.purchaseOrder.findFirst({
    where: { id: purchaseOrderId, deletedAt: undefined },
    select: { status: true, amountMinor: true, currency: true },
  });
  if (!po) throw new NotFoundError('purchase order');
  const status = derivePurchaseOrderStatus(po, await loadInvoices(tx, purchaseOrderId));
  if (status === po.status) return { status, changed: false };
  // Guarded on the status read, so two recomputes racing write one change, not two.
  const { count } = await tx.purchaseOrder.updateMany({
    where: { id: purchaseOrderId, status: po.status },
    data: { status, statusChangedAt: new Date() },
  });
  if (count === 0) throw new DomainError(CONCURRENT_PURCHASE_ORDER_CHANGE);
  return { status, changed: true };
}
