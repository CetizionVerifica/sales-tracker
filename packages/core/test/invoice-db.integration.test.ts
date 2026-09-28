import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import { todayInIST } from '../schemas/common.ts';
import {
  createInvoice,
  getInvoice,
  markInvoicePaid,
  markOverdueInvoices,
  updateInvoice,
} from '../services/invoice.service.ts';
import { liveInvoicesFor } from '../services/purchase-order-status.ts';
import { getPurchaseOrder, softDeletePurchaseOrder } from '../services/purchase-order.service.ts';
import { derivePurchaseOrderStatus } from '../status/purchase-order.ts';
import { ensureSystemCtx } from './helpers.ts';
import {
  daysFromToday,
  invoiceInput,
  invoiceWorld,
  newInvoice,
  uniqueInvoiceNumber,
} from './invoice-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

const ROUNDS = 10;

const settled = (results: PromiseSettledResult<unknown>[]) => ({
  ok: results.filter((r) => r.status === 'fulfilled').length,
  errors: results
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => r.reason as unknown),
});

describe('invoice database rules and races (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await invoiceWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  // AC15: the rules hold even for a write that skips the services.
  it('the database rejects rows that break the invoice rules, even via raw SQL', async () => {
    const { invoice } = await newInvoice(w);
    const raw = (sql: string) => getDb().$executeRawUnsafe(sql, invoice.id);
    await expect(raw(`UPDATE "invoice" SET "amountMinor" = 0 WHERE id = $1`)).rejects.toThrow(
      /invoice_amount_positive/,
    );
    await expect(raw(`UPDATE "invoice" SET currency = 'inr' WHERE id = $1`)).rejects.toThrow(
      /invoice_currency_iso/,
    );
    await expect(raw(`UPDATE "invoice" SET "invoiceNumber" = '  ' WHERE id = $1`)).rejects.toThrow(
      /invoice_number_length/,
    );
    await expect(
      raw(`UPDATE "invoice" SET "dueDate" = "invoiceDate" - 1 WHERE id = $1`),
    ).rejects.toThrow(/invoice_due_after_invoice_date/);
    await expect(
      raw(`UPDATE "invoice" SET status = 'PAID'::"InvoiceStatus" WHERE id = $1`),
    ).rejects.toThrow(/invoice_paid_has_date/);
    await expect(
      raw(`UPDATE "invoice" SET "paidAt" = "invoiceDate" WHERE id = $1`),
    ).rejects.toThrow(/invoice_paid_has_date/);
    await expect(
      raw(
        `UPDATE "invoice" SET status = 'PAID'::"InvoiceStatus", "paidAt" = "invoiceDate" - 1 WHERE id = $1`,
      ),
    ).rejects.toThrow(/invoice_paid_after_invoice_date/);
  });

  it('has the partial unique index on live invoice numbers', async () => {
    const rows = await getDb().$queryRawUnsafe<{ indexdef: string }[]>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'invoice_live_number_key'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(
      /UNIQUE INDEX.*lower\("invoiceNumber"\).*"deletedAt" IS NULL/,
    );
  });

  it('liveInvoicesFor returns the PO’s live invoices only', async () => {
    const { purchaseOrder, invoice } = await newInvoice(w, { amount: '12,000' });
    expect(await liveInvoicesFor(getDb(), purchaseOrder.id)).toEqual([
      { status: invoice.status, amountMinor: 12_000_00n },
    ]);
  });

  // AC11: races, 10 rounds each.
  it('two creates with the same number: exactly one succeeds', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { purchaseOrder } = await newPurchaseOrder(w);
      const number = uniqueInvoiceNumber();
      const results = settled(
        await Promise.allSettled([
          createInvoice(
            w.sales,
            invoiceInput(purchaseOrder.id, w.inspection, { invoiceNumber: number }),
          ),
          createInvoice(
            w.pm,
            invoiceInput(purchaseOrder.id, w.inspection, { invoiceNumber: number }),
          ),
        ]),
      );
      expect(results.ok).toBe(1);
      expect(results.errors[0]).toBeInstanceOf(DomainError);
      expect((results.errors[0] as DomainError).field).toBe('invoiceNumber');
    }
  });

  it('an invoice create racing the PO delete never leaves a live invoice on a deleted PO', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { purchaseOrder } = await newPurchaseOrder(w);
      await Promise.allSettled([
        createInvoice(w.sales, invoiceInput(purchaseOrder.id, w.inspection)),
        softDeletePurchaseOrder(w.pm, purchaseOrder.id),
      ]);
      const po = await getDb().purchaseOrder.findFirst({
        where: { id: purchaseOrder.id, deletedAt: undefined },
        select: { deletedAt: true },
      });
      const live = await getDb().invoice.count({ where: { purchaseOrderId: purchaseOrder.id } });
      expect(po!.deletedAt !== null && live > 0).toBe(false);
    }
  });

  it('concurrent invoice writes on one PO leave its status matching its invoices', async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const { purchaseOrder } = await newPurchaseOrder(w, { amount: '1,00,000' });
      const { invoice } = await createInvoice(
        w.sales,
        invoiceInput(purchaseOrder.id, w.inspection, { amount: '50,000' }),
      );
      await Promise.allSettled([
        markInvoicePaid(w.sales, { id: invoice.id, paidAt: daysFromToday(0) }),
        createInvoice(
          w.pm,
          invoiceInput(purchaseOrder.id, w.inspection, {
            amount: '50,000',
            paidAt: daysFromToday(0),
          }),
        ),
        updateInvoice(w.admin, invoice.id, { description: `round ${round}` }),
      ]);
      const po = await getPurchaseOrder(w.admin, purchaseOrder.id);
      const invoices = await liveInvoicesFor(getDb(), purchaseOrder.id);
      expect(po.status).toBe(derivePurchaseOrderStatus(po, invoices));
    }
  });

  it('the overdue job racing Mark paid ends PAID with the PO consistent', async () => {
    const later = new Date(todayInIST().getTime() + 5 * 86_400_000);
    for (let round = 0; round < ROUNDS; round++) {
      const { purchaseOrder } = await newPurchaseOrder(w, { amount: '50,000' });
      const { invoice } = await createInvoice(
        w.sales,
        invoiceInput(purchaseOrder.id, w.inspection, {
          amount: '50,000',
          dueDate: daysFromToday(1),
        }),
      );
      // Both take the PO lock before reading the invoice, so whichever runs second sees the
      // other's result: Mark paid never fails, and the job skips a paid invoice.
      const [job, paid] = await Promise.allSettled([
        markOverdueInvoices(system, { today: later }),
        markInvoicePaid(w.sales, { id: invoice.id, paidAt: daysFromToday(0) }),
      ]);
      expect(job.status).toBe('fulfilled');
      expect(paid.status).toBe('fulfilled');
      expect((await getInvoice(w.admin, invoice.id)).status).toBe('PAID');
      const po = await getPurchaseOrder(w.admin, purchaseOrder.id);
      expect(po.status).toBe(
        derivePurchaseOrderStatus(po, await liveInvoicesFor(getDb(), purchaseOrder.id)),
      );
    }
  });
});
