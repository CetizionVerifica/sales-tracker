import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import { todayInIST } from '../schemas/common.ts';
import {
  createInvoice,
  getInvoice,
  markInvoicePaid,
  markInvoiceUnpaid,
  markOverdueInvoices,
  restoreInvoice,
  softDeleteInvoice,
  updateInvoice,
} from '../services/invoice.service.ts';
import { changeProjectStatus, getProject } from '../services/project.service.ts';
import {
  getPurchaseOrder,
  softDeletePurchaseOrder,
  updatePurchaseOrder,
} from '../services/purchase-order.service.ts';
import { getEnquiry } from '../services/enquiry.service.ts';
import { getQuotation } from '../services/quotation.service.ts';
import { ensureSystemCtx } from './helpers.ts';
import { daysFromToday, invoiceInput, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import { rejection } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

describe('invoices and their PO (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await invoiceWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  // AC6: M9's "done when", end to end: the PO status after every kind of invoice write.
  it('AC6: the PO status follows each invoice write', async () => {
    const { sales, admin } = w;
    const { purchaseOrder: po } = await newPurchaseOrder(w, {
      amount: '10,00,000',
      serviceIds: [w.inspection],
    });
    const status = async () => (await getPurchaseOrder(admin, po.id)).status;
    const raise = async (amount: string, extra = {}) =>
      (await createInvoice(sales, invoiceInput(po.id, w.inspection, { amount, ...extra }))).invoice;

    expect(await status()).toBe('PENDING'); // no invoices
    const first = await raise('5,00,000');
    expect(await status()).toBe('PENDING');
    await markInvoicePaid(sales, { id: first.id, paidAt: daysFromToday(0) });
    expect(await status()).toBe('PENDING'); // paid, but only half invoiced
    const second = await raise('5,00,000');
    expect(await status()).toBe('PENDING');

    // The job, 31 days on: the second invoice goes overdue.
    await markOverdueInvoices(system, {
      today: new Date(todayInIST().getTime() + 31 * 86_400_000),
    });
    expect((await getInvoice(admin, second.id)).status).toBe('OVERDUE');
    expect(await status()).toBe('OVERDUE');

    await markInvoicePaid(sales, { id: second.id, paidAt: daysFromToday(0) });
    expect(await status()).toBe('PAID');

    await updateInvoice(sales, second.id, { amount: '4,00,000' });
    expect(await status()).toBe('PENDING'); // ₹9L of ₹10L
    await updateInvoice(sales, second.id, { amount: '5,00,000' });
    expect(await status()).toBe('PAID');

    const third = await raise('1,00,000', { paidAt: daysFromToday(0) });
    expect(await status()).toBe('PAID');
    await softDeleteInvoice(admin, third.id);
    expect(await status()).toBe('PAID'); // the rest still cover it
    await softDeleteInvoice(admin, second.id);
    expect(await status()).toBe('PENDING'); // the rest no longer cover it
    await restoreInvoice(admin, second.id);
    expect(await status()).toBe('PAID');

    const unpaid = await markInvoiceUnpaid(admin, { id: second.id, reason: 'Reversed by bank' });
    expect(unpaid.status).toBe('PENDING');
    expect(await status()).toBe('PENDING');

    await updateInvoice(sales, second.id, {
      invoiceDate: daysFromToday(-5),
      dueDate: daysFromToday(-1),
    });
    expect((await getInvoice(admin, second.id)).status).toBe('OVERDUE');
    expect(await status()).toBe('OVERDUE');
    await updateInvoice(sales, second.id, { dueDate: daysFromToday(3) });
    expect((await getInvoice(admin, second.id)).status).toBe('PENDING');
    expect(await status()).toBe('PENDING');
  });

  describe('AC8: PO interplay', () => {
    it('refuses deleting a PO with live invoices, and allows it once they are deleted', async () => {
      const { purchaseOrder, invoice } = await newInvoice(w);
      const error = await rejection(softDeletePurchaseOrder(w.sales, purchaseOrder.id));
      expect(error).toBeInstanceOf(DomainError);
      expect((error as Error).message).toBe("Delete this PO's invoices first (1)");
      expect((await getPurchaseOrder(w.sales, purchaseOrder.id)).permissions).toMatchObject({
        canDelete: false,
        deleteBlockedReason: 'Has invoices',
      });
      await softDeleteInvoice(w.sales, invoice.id);
      await softDeletePurchaseOrder(w.sales, purchaseOrder.id);
    });

    it('refuses restoring an invoice while its PO is deleted', async () => {
      const { purchaseOrder, invoice } = await newInvoice(w);
      await softDeleteInvoice(w.sales, invoice.id);
      await softDeletePurchaseOrder(w.sales, purchaseOrder.id);
      const error = await rejection(restoreInvoice(w.sales, invoice.id));
      expect((error as Error).message).toBe('Restore the purchase order before its invoices');
    });

    it('refuses a PO currency change while it has invoices', async () => {
      const { purchaseOrder } = await newInvoice(w);
      const error = await rejection(
        updatePurchaseOrder(w.sales, purchaseOrder.id, { amount: '1,000', currency: 'USD' }),
      );
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).field).toBe('currency');
      expect((error as Error).message).toBe('Invoices on this PO are in INR');
    });

    it('lets a PO amount drop below the invoiced total, with a warning', async () => {
      const { purchaseOrder } = await newInvoice(w, { amount: '80,000' });
      const updated = await updatePurchaseOrder(w.sales, purchaseOrder.id, {
        amount: '50,000',
        currency: 'INR',
      });
      expect(updated.amountMinor).toBe(50_000_00n);
      expect(updated.warning).toMatch(/₹80,000\.00.*₹50,000\.00/);
      const fine = await updatePurchaseOrder(w.sales, purchaseOrder.id, { description: 'x' });
      expect(fine.warning).toBeNull();
    });

    it('allows invoices on a cancelled project’s PO', async () => {
      const { project, purchaseOrder } = await newPurchaseOrder(w);
      await changeProjectStatus(w.admin, {
        id: project.id,
        to: 'CANCELLED',
        cancelReason: 'Client withdrew',
      });
      const { invoice } = await createInvoice(w.pm, invoiceInput(purchaseOrder.id, w.inspection));
      expect(invoice.status).toBe('PENDING');
    });

    it('returns billing totals on the PO and the project, and the pipeline stage', async () => {
      const { project, quotation, enquiry, purchaseOrder, invoice } = await newInvoice(
        w,
        { amount: '60,000', invoiceDate: daysFromToday(-40) }, // overdue
        { po: { amount: '1,00,000' } },
      );
      await createInvoice(
        w.sales,
        invoiceInput(purchaseOrder.id, w.inspection, {
          amount: '30,000',
          invoiceDate: daysFromToday(-1),
          paidAt: daysFromToday(0),
        }),
      );
      const expected = {
        currency: 'INR',
        poAmountMinor: 1_00_000_00n,
        invoicedMinor: 90_000_00n,
        paidMinor: 30_000_00n,
        outstandingMinor: 60_000_00n,
        overdueMinor: 60_000_00n,
        invoiceCount: 2,
        paidCount: 1,
        overdueCount: 1,
        overInvoiced: false,
      };
      expect((await getPurchaseOrder(w.pm, purchaseOrder.id)).billing).toEqual(expected);
      const view = await getProject(w.pm, project.id);
      expect(view.purchaseOrders[0]!.billing).toEqual(expected);
      expect(view.invoiceStage).toEqual({ count: 2, invoiceId: null });

      // One invoice below: the stage links straight to it.
      const single = await newInvoice(w);
      expect((await getQuotation(w.sales, single.quotation.id)).invoiceStage).toEqual({
        count: 1,
        invoiceId: single.invoice.id,
      });
      expect((await getEnquiry(w.sales, single.enquiry.id)).invoiceStage).toEqual({
        count: 1,
        invoiceId: single.invoice.id,
      });
      expect((await getPurchaseOrder(w.sales, single.purchaseOrder.id)).invoiceStage).toEqual({
        count: 1,
        invoiceId: single.invoice.id,
      });
      expect((await getQuotation(w.sales, quotation.id)).invoiceStage.count).toBe(2);
      expect((await getEnquiry(w.sales, enquiry.id)).invoiceStage.count).toBe(2);
      expect(invoice.status).toBe('OVERDUE');
    });
  });
});
