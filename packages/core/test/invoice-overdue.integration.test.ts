import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { ForbiddenError } from '../errors.ts';
import { todayInIST } from '../schemas/common.ts';
import {
  createInvoice,
  getInvoice,
  markInvoicePaid,
  markOverdueInvoices,
  softDeleteInvoice,
} from '../services/invoice.service.ts';
import { getPurchaseOrder } from '../services/purchase-order.service.ts';
import { ensureSystemCtx } from './helpers.ts';
import { daysFromToday, invoiceInput, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import { auditOf } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

/** `n` days after today (IST), as the job's `today`. */
const plus = (n: number) => new Date(todayInIST().getTime() + n * 86_400_000);

const statusRows = async (entityType: string, id: string) =>
  (await auditOf(entityType, id)).filter(
    (r) => r.action === 'UPDATE' && r.changedFields.includes('status'),
  );

// AC5, the PLAN.md "done when": past-due unpaid invoices become OVERDUE.
describe('AC5: markOverdueInvoices (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await invoiceWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  it('marks only live PENDING invoices due before today, as system, with their PO', async () => {
    // Due in 30 days (company default). The job runs "31 days from now".
    const due = await newInvoice(w);
    // Due exactly on the job's day: not yet overdue.
    const dueToday = await newInvoice(w, { dueDate: daysFromToday(31) });
    const paid = await newInvoice(w, { invoiceDate: daysFromToday(-1), paidAt: daysFromToday(0) });
    const deleted = await newInvoice(w);
    await softDeleteInvoice(w.sales, deleted.invoice.id);
    const already = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
    expect(already.invoice.status).toBe('OVERDUE');
    const alreadyRows = (await auditOf('Invoice', already.invoice.id)).length;

    const run = await markOverdueInvoices(system, { today: plus(31) });
    expect(run.failed).toBe(0);
    expect(run.markedOverdue).toBeGreaterThanOrEqual(1);

    expect((await getInvoice(w.admin, due.invoice.id)).status).toBe('OVERDUE');
    expect((await getInvoice(w.admin, dueToday.invoice.id)).status).toBe('PENDING');
    expect((await getInvoice(w.admin, paid.invoice.id)).status).toBe('PAID');
    expect((await getInvoice(w.admin, deleted.invoice.id)).status).toBe('PENDING');
    expect((await auditOf('Invoice', already.invoice.id)).length).toBe(alreadyRows);

    const [invoiceRow] = await statusRows('Invoice', due.invoice.id);
    expect(invoiceRow).toMatchObject({ source: 'system', actorId: system.user.id });
    expect((invoiceRow!.after as { status: string }).status).toBe('OVERDUE');

    // The PO went OVERDUE in the same transaction, also as system.
    expect((await getPurchaseOrder(w.admin, due.purchaseOrder.id)).status).toBe('OVERDUE');
    const [poRow] = await statusRows('PurchaseOrder', due.purchaseOrder.id);
    expect(poRow).toMatchObject({ source: 'system', requestId: invoiceRow!.requestId });
  });

  it('is idempotent: a second run the same day writes nothing', async () => {
    await newInvoice(w);
    await markOverdueInvoices(system, { today: plus(31) });
    const before = await getDb().auditLog.count();
    const again = await markOverdueInvoices(system, { today: plus(31) });
    expect(again).toEqual({ markedOverdue: 0, posRecomputed: 0, failed: 0 });
    expect(await getDb().auditLog.count()).toBe(before);
  });

  it('goes on after one invoice fails, and counts it', async () => {
    const bad = await newInvoice(w, { dueDate: daysFromToday(1) });
    const good = await newInvoice(w, { dueDate: daysFromToday(1) });
    // Test-only: a trigger that refuses this one invoice's status change.
    const db = getDb();
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_refuse_invoice() RETURNS trigger AS $$
      BEGIN
        IF NEW.id = '${bad.invoice.id}' THEN RAISE EXCEPTION 'forced failure'; END IF;
        RETURN NEW;
      END $$ LANGUAGE plpgsql`);
    await db.$executeRawUnsafe(
      `CREATE TRIGGER test_refuse_invoice BEFORE UPDATE ON "invoice"
       FOR EACH ROW EXECUTE FUNCTION test_refuse_invoice()`,
    );
    try {
      const run = await markOverdueInvoices(system, { today: plus(2) });
      expect(run.failed).toBe(1);
      expect((await getInvoice(w.admin, bad.invoice.id)).status).toBe('PENDING');
      expect((await getInvoice(w.admin, good.invoice.id)).status).toBe('OVERDUE');
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER test_refuse_invoice ON "invoice"`);
      await db.$executeRawUnsafe(`DROP FUNCTION test_refuse_invoice()`);
    }
  });

  it('corrects a PO whose status drifted (safety net)', async () => {
    const { purchaseOrder } = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
    expect((await getPurchaseOrder(w.admin, purchaseOrder.id)).status).toBe('OVERDUE');
    // Test-only: simulates drift (a write that skipped the recompute).
    await getDb().$executeRawUnsafe(
      `UPDATE "purchase_order" SET status = 'PAID'::"PurchaseOrderStatus" WHERE id = $1`,
      purchaseOrder.id,
    );
    const run = await markOverdueInvoices(system);
    expect(run.posRecomputed).toBeGreaterThanOrEqual(1);
    expect((await getPurchaseOrder(w.admin, purchaseOrder.id)).status).toBe('OVERDUE');
    const last = (await statusRows('PurchaseOrder', purchaseOrder.id)).at(-1);
    expect(last).toMatchObject({ source: 'system' });
  });

  it('never marks an invoice paid meanwhile', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    const { invoice } = await createInvoice(
      w.sales,
      invoiceInput(purchaseOrder.id, w.inspection, { dueDate: daysFromToday(1) }),
    );
    await markInvoicePaid(w.sales, { id: invoice.id, paidAt: daysFromToday(0) });
    await markOverdueInvoices(system, { today: plus(5) });
    expect((await getInvoice(w.admin, invoice.id)).status).toBe('PAID');
  });

  it('runs only as the system', async () => {
    await expect(markOverdueInvoices(w.admin)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
