import type { Db } from '../clients.ts';

/**
 * A transaction-scoped advisory lock on one PO (M10 Decision 12): every invoice write, the
 * nightly overdue job and the PO's delete take it, so invoice changes on one PO run one at a
 * time and each recomputePurchaseOrderStatus sees the committed set of invoices. It is a
 * lock, not a write (no audit row), released when the transaction ends. Lock order: the
 * project first (lockProject), then the PO. Call it only inside withTx.
 */
export async function lockPurchaseOrder(tx: Db, purchaseOrderId: string): Promise<void> {
  // SELECT … FROM keeps the result deserialisable (pg_advisory_xact_lock returns void).
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`purchase-order:${purchaseOrderId}`}, 0))`;
}
