import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { withTx, type Ctx } from '../context.ts';
import {
  liveInvoicesFor,
  recomputePurchaseOrderStatus,
} from '../services/purchase-order-status.ts';
import { getPurchaseOrder, updatePurchaseOrder } from '../services/purchase-order.service.ts';
import type { InvoiceForStatus } from '../status/purchase-order.ts';
import { ensureSystemCtx } from './helpers.ts';
import { auditOf } from './project-fixtures.ts';
import { newPurchaseOrder, poWorld, type PoWorld } from './purchase-order-fixtures.ts';

/** A loader standing in for M10's invoice query. */
const invoices =
  (...rows: InvoiceForStatus[]) =>
  async () =>
    rows;

const statusUpdates = async (id: string) =>
  (await auditOf('PurchaseOrder', id)).filter(
    (r) => r.action === 'UPDATE' && r.changedFields.includes('status'),
  );

const forceStatus = (id: string, status: 'PAID' | 'OVERDUE') =>
  // Test-only: simulates drift (a write that skipped the recompute).
  getDb().$executeRawUnsafe(
    `UPDATE "purchase_order" SET status = $1::"PurchaseOrderStatus" WHERE id = $2`,
    status,
    id,
  );

// AC5: the stored status follows the derivation, written only through the recompute.
describe('AC5: recomputePurchaseOrderStatus (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await poWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  it('writes one audited change with the caller’s source and request, then nothing', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w, { amount: '1,00,000' });
    const paid = invoices({ status: 'PAID', amountMinor: 1_00_000_00n });

    const result = await withTx(w.sales, async (tx) => {
      await updatePurchaseOrder(w.sales, purchaseOrder.id, { description: 'Invoiced in full' });
      return recomputePurchaseOrderStatus(tx, purchaseOrder.id, paid);
    });
    expect(result).toEqual({ status: 'PAID', changed: true });

    const [row] = await statusUpdates(purchaseOrder.id);
    expect(row).toMatchObject({ source: 'web', actorId: w.sales.user.id });
    expect(row!.changedFields.sort()).toEqual(['status', 'statusChangedAt']);
    expect((row!.before as { status: string }).status).toBe('PENDING');
    expect((row!.after as { status: string }).status).toBe('PAID');
    const description = (await auditOf('PurchaseOrder', purchaseOrder.id)).find((r) =>
      r.changedFields.includes('description'),
    );
    expect(description!.requestId).toBe(row!.requestId);

    const again = await withTx(w.sales, (tx) =>
      recomputePurchaseOrderStatus(tx, purchaseOrder.id, paid),
    );
    expect(again).toEqual({ status: 'PAID', changed: false });
    expect(await statusUpdates(purchaseOrder.id)).toHaveLength(1);
    expect((await getPurchaseOrder(w.sales, purchaseOrder.id)).status).toBe('PAID');
  });

  it('records `system` when the nightly job recomputes', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    await withTx(system, (tx) =>
      recomputePurchaseOrderStatus(
        tx,
        purchaseOrder.id,
        invoices({ status: 'OVERDUE', amountMinor: 1n }),
      ),
    );
    const [row] = await statusUpdates(purchaseOrder.id);
    expect(row).toMatchObject({ source: 'system', actorId: system.user.id });
    expect((row!.after as { status: string }).status).toBe('OVERDUE');
  });

  it('corrects a status forced by raw SQL on the next recompute', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    await forceStatus(purchaseOrder.id, 'PAID');
    // M9's loader finds no invoices, so the PO is PENDING again.
    expect(await liveInvoicesFor(getDb(), purchaseOrder.id)).toEqual([]);
    const result = await withTx(system, (tx) => recomputePurchaseOrderStatus(tx, purchaseOrder.id));
    expect(result).toEqual({ status: 'PENDING', changed: true });
    expect((await getPurchaseOrder(w.sales, purchaseOrder.id)).status).toBe('PENDING');
  });

  it('changing a PO’s amount recomputes in the same transaction', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    await forceStatus(purchaseOrder.id, 'OVERDUE');
    await updatePurchaseOrder(w.pm, purchaseOrder.id, { amount: '2,00,000', currency: 'INR' });
    expect((await getPurchaseOrder(w.pm, purchaseOrder.id)).status).toBe('PENDING');
    const rows = await auditOf('PurchaseOrder', purchaseOrder.id);
    const amount = rows.find((r) => r.changedFields.includes('amountMinor'))!;
    const status = rows.find((r) => r.changedFields.includes('status'))!;
    expect(status.requestId).toBe(amount.requestId);
    expect(status).toMatchObject({ source: 'web', actorId: w.pm.user.id });
  });

  it('a description-only edit does not recompute', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    await forceStatus(purchaseOrder.id, 'PAID');
    await updatePurchaseOrder(w.pm, purchaseOrder.id, { description: 'Notes' });
    expect((await getPurchaseOrder(w.pm, purchaseOrder.id)).status).toBe('PAID');
  });
});
