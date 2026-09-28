import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import { withTx, type Ctx } from '../context.ts';
import { listFollowUps, logFollowUp } from '../services/follow-up.service.ts';
import { listFollowUpTargets } from '../services/follow-up.service.ts';
import { recomputePurchaseOrderStatus } from '../services/purchase-order-status.ts';
import {
  restorePurchaseOrder,
  softDeletePurchaseOrder,
} from '../services/purchase-order.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { ensureSystemCtx } from './helpers.ts';
import { newPurchaseOrder, poWorld, type PoWorld } from './purchase-order-fixtures.ts';

// AC8: follow-ups on POs, and PO events on the client timeline.
describe('AC8: purchase order follow-ups and timeline (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await poWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  const timeline = async (ctx: Ctx, record?: string) =>
    (
      await getClientTimeline(ctx, {
        clientId: w.acme,
        limit: 100,
        ...(record && { entityType: 'PURCHASE_ORDER' as const, entityId: record }),
      })
    ).items;

  it('shows the PM’s follow-up on a PO to the PM, the Sales owner and admins only', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    const followUp = await logFollowUp(w.pm, {
      entityType: 'PURCHASE_ORDER',
      entityId: purchaseOrder.id,
      date: '2026-04-05',
      channel: 'EMAIL',
      notes: 'Asked the client for the signed PO copy',
    });
    for (const ctx of [w.pm, w.sales, w.admin]) {
      const event = (await timeline(ctx)).find((e) => e.id === followUp.id);
      expect(event?.entity).toMatchObject({
        type: 'PURCHASE_ORDER',
        id: purchaseOrder.id,
        label: `PO ${purchaseOrder.poNumber}`,
        deleted: false,
      });
      expect((await listFollowUps(ctx, { clientId: w.acme })).items.map((f) => f.id)).toContain(
        followUp.id,
      );
    }
    for (const ctx of [w.pm2, w.sales2]) {
      expect((await timeline(ctx)).some((e) => e.id === followUp.id)).toBe(false);
    }
    // The PO is offered in the follow-up record picker to those who can read it.
    const targets = async (ctx: Ctx) =>
      (await listFollowUpTargets(ctx, w.acme)).map((t) => `${t.entityType}:${t.entityId}`);
    expect(await targets(w.pm)).toContain(`PURCHASE_ORDER:${purchaseOrder.id}`);
    expect(await targets(w.pm2)).not.toContain(`PURCHASE_ORDER:${purchaseOrder.id}`);
  });

  it('shows creation, deletion, restore and status changes among project events', async () => {
    const { project, purchaseOrder } = await newPurchaseOrder(w, { amount: '1,00,000' });
    await softDeletePurchaseOrder(w.pm, purchaseOrder.id);
    await restorePurchaseOrder(w.pm, purchaseOrder.id);
    // As M10's nightly job would: a status change recorded by the system.
    await withTx(system, (tx) =>
      recomputePurchaseOrderStatus(tx, purchaseOrder.id, async () => [
        { status: 'PAID', amountMinor: 1_00_000_00n },
      ]),
    );

    for (const ctx of [w.pm, w.sales, w.admin]) {
      const items = (await timeline(ctx)).filter(
        (e) => e.entity.id === purchaseOrder.id || e.entity.id === project.id,
      );
      const kinds = items.map((e) => `${e.entity.type}:${e.kind}`).reverse(); // oldest first
      expect(kinds).toEqual([
        'PROJECT:CREATED',
        'PURCHASE_ORDER:CREATED',
        'PURCHASE_ORDER:DELETED',
        'PURCHASE_ORDER:RESTORED',
        'PURCHASE_ORDER:STATUS_CHANGE',
      ]);
      const change = items.find((e) => e.kind === 'STATUS_CHANGE');
      expect(change?.change).toEqual({ from: 'PENDING', to: 'PAID' });
      expect(change?.actor.id).toBe(system.user.id);
      // Amounts never reach the timeline.
      expect(JSON.stringify(items)).not.toContain('10000000');
    }
    expect((await timeline(w.pm2)).some((e) => e.entity.id === purchaseOrder.id)).toBe(false);

    // The record filter narrows to the PO.
    const only = await timeline(w.sales, purchaseOrder.id);
    expect(only.length).toBe(4);
    expect(only.every((e) => e.entity.id === purchaseOrder.id)).toBe(true);
  });
});
