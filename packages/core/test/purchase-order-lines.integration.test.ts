import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import {
  createExchangeRate,
  recalculateExchangeRate,
  updateExchangeRate,
} from '../services/exchange-rate.service.ts';
import { createPurchaseOrder, updatePurchaseOrder } from '../services/purchase-order.service.ts';
import { auditOf, newProject } from './project-fixtures.ts';
import { poInput, poWorld, uniquePoNumber, type PoWorld } from './purchase-order-fixtures.ts';

/*
 * M12b schema change 1: one PurchaseOrderLine per service, always summing to the PO amount.
 * Reached only through purchase-order.service.ts (no can() of its own — findings from
 * /review), so these tests go through createPurchaseOrder/updatePurchaseOrder like any other
 * caller, and assert on the purchase_order_line rows and their audit trail directly.
 */

describe('purchase order lines (integration)', () => {
  let w: PoWorld;
  let admin: Ctx;

  beforeAll(async () => {
    w = await poWorld();
    admin = w.admin;
  });
  afterAll(disconnectAll);

  const linesOf = (purchaseOrderId: string) =>
    getDb().purchaseOrderLine.findMany({
      where: { purchaseOrderId },
      orderBy: { createdAt: 'asc' },
    });

  it('a single-service PO gets one line for the full amount, not estimated', async () => {
    const { project } = await newProject(w);
    const { purchaseOrder } = await createPurchaseOrder(
      admin,
      poInput(w, project.id, { serviceIds: [w.inspection], amount: '1,00,000' }),
    );
    const lines = await linesOf(purchaseOrder.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      serviceId: w.inspection,
      amountMinor: 1_00_000_00n,
      currency: 'INR',
      allocationEstimated: false,
    });
  });

  it('a multi-service PO with an explicit split writes exactly those lines', async () => {
    const { project } = await newProject(w);
    const { purchaseOrder } = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, { amount: '1,00,000', serviceIds: [w.inspection, w.audit] }),
      lines: [
        { serviceId: w.inspection, amount: '60,000' },
        { serviceId: w.audit, amount: '40,000' },
      ],
    });
    const lines = await linesOf(purchaseOrder.id);
    const byService = new Map(lines.map((l) => [l.serviceId, l]));
    expect(byService.get(w.inspection)).toMatchObject({
      amountMinor: 60_000_00n,
      allocationEstimated: false,
    });
    expect(byService.get(w.audit)).toMatchObject({
      amountMinor: 40_000_00n,
      allocationEstimated: false,
    });
  });

  it('a multi-service PO without an explicit split falls back to an estimated equal split', async () => {
    const { project } = await newProject(w);
    const { purchaseOrder } = await createPurchaseOrder(
      admin,
      poInput(w, project.id, { amount: '1,00,000', serviceIds: [w.inspection, w.audit] }),
    );
    const lines = await linesOf(purchaseOrder.id);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.allocationEstimated)).toBe(true);
    expect(lines.reduce((n, l) => n + l.amountMinor, 0n)).toBe(1_00_000_00n);
    // An even split of an even amount: exactly 50/50, largest-remainder has nothing to give.
    expect(new Set(lines.map((l) => l.amountMinor))).toEqual(new Set([50_000_00n]));
  });

  it('rejects a split that does not sum to the PO amount, and writes nothing', async () => {
    const { project } = await newProject(w);
    const poNumber = uniquePoNumber();
    const error = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, {
        poNumber,
        amount: '1,00,000',
        serviceIds: [w.inspection, w.audit],
      }),
      lines: [
        { serviceId: w.inspection, amount: '60,000' },
        { serviceId: w.audit, amount: '30,000' }, // 90,000 total, short by 10,000
      ],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).field).toBe('lines');
    expect((error as DomainError).message).toMatch(/short by/);
    // The whole create rolled back: no PO, so no lines either.
    const po = await getDb().purchaseOrder.findFirst({ where: { poNumber } });
    expect(po).toBeNull();
  });

  it('rejects a split whose services do not match the PO’s services', async () => {
    const { project } = await newProject(w);
    const error = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, { amount: '1,00,000', serviceIds: [w.inspection, w.audit] }),
      lines: [
        { serviceId: w.inspection, amount: '50,000' },
        { serviceId: w.certification, amount: '50,000' }, // not one of the PO's services
      ],
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).field).toBe('lines');
  });

  it('editing services adds and removes lines; an unchanged service keeps its line id', async () => {
    const { project } = await newProject(w, {
      serviceIds: [w.inspection, w.audit, w.certification],
    });
    const { purchaseOrder } = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, { amount: '1,00,000', serviceIds: [w.inspection, w.audit] }),
      lines: [
        { serviceId: w.inspection, amount: '60,000' },
        { serviceId: w.audit, amount: '40,000' },
      ],
    });
    const before = await linesOf(purchaseOrder.id);
    const inspectionLineId = before.find((l) => l.serviceId === w.inspection)!.id;
    const auditLineId = before.find((l) => l.serviceId === w.audit)!.id;

    // Add certification, keeping the same total, with an explicit 3-way split.
    await updatePurchaseOrder(admin, purchaseOrder.id, {
      serviceIds: [w.inspection, w.audit, w.certification],
      lines: [
        { serviceId: w.inspection, amount: '50,000' },
        { serviceId: w.audit, amount: '30,000' },
        { serviceId: w.certification, amount: '20,000' },
      ],
    });
    const afterAdd = await linesOf(purchaseOrder.id);
    expect(afterAdd).toHaveLength(3);
    // The two surviving services kept their row (and its id), even though their amount changed.
    expect(afterAdd.find((l) => l.serviceId === w.inspection)!.id).toBe(inspectionLineId);
    expect(afterAdd.find((l) => l.serviceId === w.audit)!.id).toBe(auditLineId);
    expect(afterAdd.find((l) => l.serviceId === w.inspection)!.amountMinor).toBe(50_000_00n);
    const certificationLineId = afterAdd.find((l) => l.serviceId === w.certification)!.id;

    // Drop certification again.
    await updatePurchaseOrder(admin, purchaseOrder.id, {
      serviceIds: [w.inspection, w.audit],
      lines: [
        { serviceId: w.inspection, amount: '60,000' },
        { serviceId: w.audit, amount: '40,000' },
      ],
    });
    const afterRemove = await linesOf(purchaseOrder.id);
    expect(afterRemove.map((l) => l.serviceId).sort()).toEqual([w.audit, w.inspection].sort());

    const certAudit = await auditOf('PurchaseOrderLine', certificationLineId);
    expect(certAudit.map((r) => r.action)).toEqual(['CREATE', 'DELETE']);
  });

  it('changing the amount without resubmitting lines re-splits evenly and marks it estimated', async () => {
    const { project } = await newProject(w);
    const { purchaseOrder } = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, { amount: '1,00,000', serviceIds: [w.inspection, w.audit] }),
      lines: [
        { serviceId: w.inspection, amount: '70,000' },
        { serviceId: w.audit, amount: '30,000' },
      ],
    });
    await updatePurchaseOrder(admin, purchaseOrder.id, { amount: '2,00,000', currency: 'INR' });
    const lines = await linesOf(purchaseOrder.id);
    expect(lines.reduce((n, l) => n + l.amountMinor, 0n)).toBe(2_00_000_00n);
    expect(lines.every((l) => l.allocationEstimated)).toBe(true);
    expect(new Set(lines.map((l) => l.amountMinor))).toEqual(new Set([1_00_000_00n]));
  });

  it('writes to purchase_order_line are audited with the request’s source', async () => {
    const { project } = await newProject(w);
    const { purchaseOrder } = await createPurchaseOrder(
      admin,
      poInput(w, project.id, { serviceIds: [w.inspection], amount: '1,00,000' }),
    );
    const [line] = await linesOf(purchaseOrder.id);
    const rows = await auditOf('PurchaseOrderLine', line!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'CREATE', source: 'web' });
    expect(rows[0]!.actorId).toBe(admin.user.id);

    await updatePurchaseOrder(admin, purchaseOrder.id, { amount: '1,50,000', currency: 'INR' });
    const afterUpdate = await auditOf('PurchaseOrderLine', line!.id);
    expect(afterUpdate.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(afterUpdate[1]).toMatchObject({ source: 'web' });
  });

  it('fills lines’ INR value when an exchange rate is added, summing to the PO’s own', async () => {
    const { project } = await newProject(w);
    const poNumber = uniquePoNumber();
    const { purchaseOrder } = await createPurchaseOrder(admin, {
      ...poInput(w, project.id, {
        poNumber,
        amount: '1,000',
        currency: 'USD',
        receivedDate: '2026-04-02',
        serviceIds: [w.inspection, w.audit],
      }),
      lines: [
        { serviceId: w.inspection, amount: '700' },
        { serviceId: w.audit, amount: '300' },
      ],
    });
    expect(purchaseOrder.amountInrMinor).toBeNull();
    const before = await linesOf(purchaseOrder.id);
    expect(before.every((l) => l.amountInrMinor === null)).toBe(true);

    const { rate } = await createExchangeRate(admin, {
      currency: 'USD',
      month: '2026-04',
      rate: '83',
    });

    const po = await getDb().purchaseOrder.findUniqueOrThrow({ where: { id: purchaseOrder.id } });
    expect(po.amountInrMinor).toBe(83_000_00n); // $1,000 × 83
    const after = await linesOf(purchaseOrder.id);
    const total = after.reduce((n, l) => n + (l.amountInrMinor ?? 0n), 0n);
    expect(total).toBe(po.amountInrMinor);
    // Proportional to each line's own amount (70/30 split of the USD amount).
    const inspectionInr = after.find((l) => l.serviceId === w.inspection)!.amountInrMinor!;
    expect(inspectionInr).toBe((83_000_00n * 7n) / 10n);

    // Recalculating at a new rate re-splits the lines again to match.
    await updateExchangeRate(admin, rate.id, { rate: '85' });
    await recalculateExchangeRate(admin, rate.id);
    const poAfterRecalc = await getDb().purchaseOrder.findUniqueOrThrow({
      where: { id: purchaseOrder.id },
    });
    expect(poAfterRecalc.amountInrMinor).toBe(85_000_00n);
    const linesAfterRecalc = await linesOf(purchaseOrder.id);
    expect(linesAfterRecalc.reduce((n, l) => n + (l.amountInrMinor ?? 0n), 0n)).toBe(
      poAfterRecalc.amountInrMinor,
    );
  });
});
