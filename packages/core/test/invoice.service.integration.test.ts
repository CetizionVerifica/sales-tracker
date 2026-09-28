import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { toCalendarDateString } from '../schemas/common.ts';
import {
  createInvoice,
  getInvoice,
  getInvoiceDraft,
  listInvoices,
  listInvoicesForClient,
  listInvoicesForProject,
  listInvoicesForPurchaseOrder,
  markInvoicePaid,
  markInvoiceUnpaid,
  restoreInvoice,
  softDeleteInvoice,
  updateInvoice,
} from '../services/invoice.service.ts';
import { getEnquiry } from '../services/enquiry.service.ts';
import { updateProject } from '../services/project.service.ts';
import { softDeletePurchaseOrder } from '../services/purchase-order.service.ts';
import { updateQuotation } from '../services/quotation.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { invoiceStatusCounts } from '../services/summary.service.ts';
import {
  daysFromToday,
  invoiceInput,
  invoiceWorld,
  newInvoice,
  uniqueInvoiceNumber,
} from './invoice-fixtures.ts';
import { auditOf, fieldOf, rejection } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

const SETTINGS = {
  companyName: 'Test Co',
  defaultInvoiceDueDays: 30,
  enabledCurrencies: ['INR', 'USD'],
};
const ymd = (date: Date | null) => (date ? toCalendarDateString(date) : null);

describe('invoices (integration)', () => {
  let w: PoWorld;
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let pm2: Ctx;

  beforeAll(async () => {
    w = await invoiceWorld();
    ({ admin, sales, sales2, pm, pm2 } = w);
  });
  afterAll(disconnectAll);

  const ids = async (ctx: Ctx, input: Parameters<typeof listInvoices>[1] = {}) =>
    (await listInvoices(ctx, { pageSize: 100, ...input })).items.map((i) => i.id);

  describe('AC1: create and defaults', () => {
    it('defaults the due date from the PO net days (PO_TERMS)', async () => {
      const { invoice } = await newInvoice(
        w,
        { invoiceDate: daysFromToday(-10) },
        { po: { paymentTermsDays: 45 } },
      );
      expect(ymd(invoice.dueDate)).toBe(daysFromToday(35));
      expect(invoice.dueDateBasis).toBe('PO_TERMS');
      expect(invoice.status).toBe('PENDING');
    });

    it('falls back to the company default when the PO has no net days', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-1) });
      expect(ymd(invoice.dueDate)).toBe(daysFromToday(29));
      expect(invoice.dueDateBasis).toBe('COMPANY_DEFAULT');
    });

    it('makes net 0 due on the invoice date', async () => {
      const { invoice } = await newInvoice(w, {}, { po: { paymentTermsDays: 0 } });
      expect(ymd(invoice.dueDate)).toBe(daysFromToday(0));
      expect(invoice.dueDateBasis).toBe('PO_TERMS');
      expect(invoice.status).toBe('PENDING'); // due today is not overdue
    });

    it('keeps a typed due date as MANUAL, and one equal to the default as the default', async () => {
      const { invoice: manual } = await newInvoice(w, { dueDate: daysFromToday(10) });
      expect(manual.dueDateBasis).toBe('MANUAL');
      expect(ymd(manual.dueDate)).toBe(daysFromToday(10));
      const { invoice: same } = await newInvoice(w, { dueDate: daysFromToday(30) });
      expect(same.dueDateBasis).toBe('COMPANY_DEFAULT');
    });

    it('copies the client and currency from the PO and writes one audited CREATE', async () => {
      const { purchaseOrder, invoice } = await newInvoice(
        w,
        { amount: '5,90,000.50', description: 'Milestone 1' },
        { po: { amount: '10,00,000' } },
      );
      expect(invoice).toMatchObject({
        clientId: purchaseOrder.clientId,
        currency: 'INR',
        amountMinor: 5_90_000_50n,
        serviceId: w.inspection,
        status: 'PENDING',
        paidAt: null,
        description: 'Milestone 1',
        documentId: null,
        client: { id: w.acme, name: 'Acme Pharma' },
        service: { id: w.inspection, name: 'Inspection' },
        purchaseOrder: { id: purchaseOrder.id, poNumber: purchaseOrder.poNumber },
      });
      expect(invoice.statusChangedAt).toBeInstanceOf(Date);
      const rows = await auditOf('Invoice', invoice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      expect(rows[0]!.requestId).toBeTruthy();
    });

    it('converts the amount in the PO currency (USD cents)', async () => {
      const { invoice } = await newInvoice(w, { amount: '1,234.56' }, { po: { currency: 'USD' } });
      expect(invoice).toMatchObject({ currency: 'USD', amountMinor: 123_456n });
    });

    it('creates a back-dated invoice OVERDUE at once', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-40),
      }); // due −10 days
      expect(invoice.status).toBe('OVERDUE');
      expect(ymd(invoice.dueDate)).toBe(daysFromToday(-10));
    });

    it('creates an already-paid invoice PAID', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-40),
        paidAt: daysFromToday(-5),
        paymentReference: 'UTR 99',
      });
      expect(invoice).toMatchObject({ status: 'PAID', paymentReference: 'UTR 99' });
      expect(ymd(invoice.paidAt)).toBe(daysFromToday(-5));
    });

    it('getInvoiceDraft returns the remaining PO amount, then blank once fully invoiced', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w, {
        amount: '1,00,000',
        serviceIds: [w.inspection],
        paymentTermsDays: 45,
      });
      const draft = await getInvoiceDraft(pm, purchaseOrder.id);
      expect(draft).toMatchObject({
        purchaseOrderId: purchaseOrder.id,
        poNumber: purchaseOrder.poNumber,
        clientId: w.acme,
        currency: 'INR',
        serviceId: w.inspection,
        amountMinor: 1_00_000_00n,
        invoicedMinor: 0n,
        dueDateBasis: 'PO_TERMS',
        dueDateHint: `Net 45 from PO ${purchaseOrder.poNumber}`,
      });
      expect(ymd(draft.invoiceDate)).toBe(daysFromToday(0));
      expect(ymd(draft.dueDate)).toBe(daysFromToday(45));

      await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { amount: '60,000' }),
      );
      expect((await getInvoiceDraft(pm, purchaseOrder.id)).amountMinor).toBe(40_000_00n);
      await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { amount: '40,000' }),
      );
      expect((await getInvoiceDraft(pm, purchaseOrder.id)).amountMinor).toBeNull();
    });

    it('getInvoiceDraft leaves the service open when the PO has several, and hints the company default', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      const draft = await getInvoiceDraft(sales, purchaseOrder.id);
      expect(draft.serviceId).toBeNull();
      expect(draft.services).toHaveLength(2);
      expect(draft.dueDateHint).toBe('Company default, 30 days');
    });

    it('returns a warning, without blocking, when invoices exceed the PO amount', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w, { amount: '1,00,000' });
      const first = await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { amount: '1,00,000' }),
      );
      expect(first.billing.warning).toBeNull();
      const { billing } = await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { amount: '18,000' }),
      );
      expect(billing).toMatchObject({
        invoicedMinor: 1_18_000_00n,
        poAmountMinor: 1_00_000_00n,
        overInvoiced: true,
      });
      expect(billing.warning).toMatch(/₹1,18,000\.00.*₹1,00,000\.00/);
    });
  });

  describe('AC2: validation against the database', () => {
    it('rejects a duplicate number company-wide, ignoring case, even for another client', async () => {
      const number = uniqueInvoiceNumber();
      await newInvoice(w, { invoiceNumber: number });
      const other = await newPurchaseOrder(w, {}, { clientId: w.globex });
      for (const clash of [number, number.toLowerCase(), `  ${number.toUpperCase()} `]) {
        const error = await rejection(
          createInvoice(
            sales,
            invoiceInput(other.purchaseOrder.id, w.inspection, { invoiceNumber: clash }),
          ),
        );
        expect(error).toBeInstanceOf(DomainError);
        expect(fieldOf(error)).toBe('invoiceNumber');
      }
    });

    it('allows a number again once the invoice holding it is deleted', async () => {
      const number = uniqueInvoiceNumber();
      const { invoice, purchaseOrder } = await newInvoice(w, { invoiceNumber: number });
      await softDeleteInvoice(sales, invoice.id);
      const { invoice: again } = await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { invoiceNumber: number }),
      );
      expect(again.invoiceNumber).toBe(number);
    });

    it('rejects a service that is not on the PO', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w, { serviceIds: [w.inspection] });
      const error = await rejection(createInvoice(sales, invoiceInput(purchaseOrder.id, w.audit)));
      expect(fieldOf(error)).toBe('serviceId');
    });

    it('rejects an amount with more decimals than the currency has', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      const error = await rejection(
        createInvoice(sales, invoiceInput(purchaseOrder.id, w.inspection, { amount: '10.505' })),
      );
      expect(fieldOf(error)).toBe('amount');
    });

    it('rejects a typed due date before the invoice date, and a paid date before it', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      await expect(
        createInvoice(
          sales,
          invoiceInput(purchaseOrder.id, w.inspection, {
            invoiceDate: daysFromToday(-5),
            dueDate: daysFromToday(-6),
          }),
        ),
      ).rejects.toBeInstanceOf(ZodError);
    });

    it('treats a soft-deleted or unreadable PO as not found', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      await expect(
        createInvoice(sales2, invoiceInput(purchaseOrder.id, w.inspection)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(
        createInvoice(pm2, invoiceInput(purchaseOrder.id, w.inspection)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await softDeletePurchaseOrder(sales, purchaseOrder.id);
      await expect(
        createInvoice(sales, invoiceInput(purchaseOrder.id, w.inspection)),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it('rejects derived and fixed fields as unknown keys', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      for (const key of ['clientId', 'currency', 'status', 'dueDateBasis', 'documentId']) {
        await expect(
          createInvoice(sales, {
            ...invoiceInput(purchaseOrder.id, w.inspection),
            [key]: 'x',
          } as never),
        ).rejects.toBeInstanceOf(ZodError);
      }
      const { invoice } = await newInvoice(w);
      for (const key of ['purchaseOrderId', 'paidAt']) {
        await expect(
          updateInvoice(sales, invoice.id, { [key]: 'x' } as never),
        ).rejects.toBeInstanceOf(ZodError);
      }
    });
  });

  describe('updates', () => {
    it('moves a default due date with the invoice date, and keeps a manual one', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-10) });
      const moved = await updateInvoice(sales, invoice.id, { invoiceDate: daysFromToday(-5) });
      expect(ymd(moved.dueDate)).toBe(daysFromToday(25));
      expect(moved.dueDateBasis).toBe('COMPANY_DEFAULT');

      const { invoice: manual } = await newInvoice(w, {
        invoiceDate: daysFromToday(-10),
        dueDate: daysFromToday(3),
      });
      const kept = await updateInvoice(sales, manual.id, { invoiceDate: daysFromToday(-5) });
      expect(ymd(kept.dueDate)).toBe(daysFromToday(3));
      expect(kept.dueDateBasis).toBe('MANUAL');

      // A manual due date is checked against the stored invoice date.
      const tooEarly = await rejection(
        updateInvoice(sales, manual.id, { dueDate: daysFromToday(-6) }),
      );
      expect(tooEarly).toBeInstanceOf(DomainError);
      expect(fieldOf(tooEarly)).toBe('dueDate');
      // A new invoice date up to the manual due date is fine; past it is not.
      await updateInvoice(sales, manual.id, { invoiceDate: daysFromToday(0) });
      const { invoice: late } = await newInvoice(w, {
        invoiceDate: daysFromToday(-10),
        dueDate: daysFromToday(-8),
      });
      const pastDue = await rejection(
        updateInvoice(sales, late.id, { invoiceDate: daysFromToday(-7) }),
      );
      expect(fieldOf(pastDue)).toBe('dueDate');
    });

    it('recomputes a default due date from the current PO terms, never on settings changes', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-2) });
      await updateSettings(admin, { ...SETTINGS, defaultInvoiceDueDays: 60 });
      try {
        const unchanged = await getInvoice(sales, invoice.id);
        expect(ymd(unchanged.dueDate)).toBe(daysFromToday(28));
        const moved = await updateInvoice(sales, invoice.id, { invoiceDate: daysFromToday(-1) });
        expect(ymd(moved.dueDate)).toBe(daysFromToday(59));
      } finally {
        await updateSettings(admin, SETTINGS);
      }
    });

    it('puts the due date back on its default when cleared', async () => {
      const { invoice } = await newInvoice(w, { dueDate: daysFromToday(5) });
      const reset = await updateInvoice(sales, invoice.id, { dueDate: '' });
      expect(reset.dueDateBasis).toBe('COMPANY_DEFAULT');
      expect(ymd(reset.dueDate)).toBe(daysFromToday(30));
    });

    it('moves OVERDUE ⇄ PENDING when the due date is corrected', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
      expect(invoice.status).toBe('OVERDUE');
      const pending = await updateInvoice(sales, invoice.id, { dueDate: daysFromToday(0) });
      expect(pending.status).toBe('PENDING');
      const overdue = await updateInvoice(sales, invoice.id, { dueDate: daysFromToday(-1) });
      expect(overdue.status).toBe('OVERDUE');
    });

    it('keeps a paid invoice editable, but not dated after its payment', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-20),
        paidAt: daysFromToday(-10),
      });
      const edited = await updateInvoice(sales, invoice.id, { paymentReference: 'NEFT 1' });
      expect(edited).toMatchObject({ status: 'PAID', paymentReference: 'NEFT 1' });
      const error = await rejection(
        updateInvoice(sales, invoice.id, { invoiceDate: daysFromToday(-9) }),
      );
      expect(fieldOf(error)).toBe('invoiceDate');
    });
  });

  describe('Mark paid and Mark unpaid', () => {
    it('marks paid with a date and reference, and refuses a second time', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-3) });
      const paid = await markInvoicePaid(pm, {
        id: invoice.id,
        paidAt: daysFromToday(0),
        paymentReference: 'UTR 1',
      });
      expect(paid).toMatchObject({ status: 'PAID', paymentReference: 'UTR 1' });
      expect(ymd(paid.paidAt)).toBe(daysFromToday(0));
      const audit = (await auditOf('Invoice', invoice.id)).at(-1);
      expect(audit).toMatchObject({ action: 'UPDATE', actorId: pm.user.id, source: 'web' });
      const again = await rejection(
        markInvoicePaid(pm, { id: invoice.id, paidAt: daysFromToday(0) }),
      );
      expect((again as Error).message).toBe('This invoice is already marked paid');
    });

    it('refuses a paid date before the invoice date', async () => {
      const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-3) });
      const error = await rejection(
        markInvoicePaid(sales, { id: invoice.id, paidAt: daysFromToday(-4) }),
      );
      expect(fieldOf(error)).toBe('paidAt');
    });

    it('lets only admins mark unpaid, recording the reason', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-40),
        paidAt: daysFromToday(-1),
        paymentReference: 'CHQ 7',
      });
      for (const ctx of [sales, pm]) {
        await expect(
          markInvoiceUnpaid(ctx, { id: invoice.id, reason: 'Cheque bounced' }),
        ).rejects.toBeInstanceOf(ForbiddenError);
      }
      const unpaid = await markInvoiceUnpaid(admin, { id: invoice.id, reason: 'Cheque bounced' });
      expect(unpaid).toMatchObject({
        status: 'OVERDUE', // due −10 days
        paidAt: null,
        paymentReference: null,
        unmarkedPaidReason: 'Cheque bounced',
      });
      const audit = (await auditOf('Invoice', invoice.id)).at(-1)!;
      expect(audit.actorId).toBe(admin.user.id);
      expect(audit.after).toMatchObject({ unmarkedPaidReason: 'Cheque bounced' });

      const repaid = await markInvoicePaid(sales, { id: invoice.id, paidAt: daysFromToday(0) });
      expect(repaid.unmarkedPaidReason).toBeNull();
    });

    it('refuses to mark an unpaid invoice unpaid', async () => {
      const { invoice } = await newInvoice(w);
      const error = await rejection(markInvoiceUnpaid(admin, { id: invoice.id, reason: 'x' }));
      expect(error).toBeInstanceOf(DomainError);
    });
  });

  describe('AC3: RBAC', () => {
    it('scopes lists: PMs to their projects, Sales to their quotations, admins all', async () => {
      const mine = await newInvoice(w);
      const theirs = await newInvoice(
        w,
        {},
        { owner: sales2, projectOverrides: { managerId: pm2.user.id } },
      );
      expect(await ids(pm)).toContain(mine.invoice.id);
      expect(await ids(pm)).not.toContain(theirs.invoice.id);
      expect(await ids(sales)).toContain(mine.invoice.id);
      expect(await ids(sales)).not.toContain(theirs.invoice.id);
      expect(await ids(pm2)).toContain(theirs.invoice.id);
      expect(await ids(admin)).toEqual(
        expect.arrayContaining([mine.invoice.id, theirs.invoice.id]),
      );

      for (const ctx of [sales2, pm2]) {
        await expect(getInvoice(ctx, mine.invoice.id)).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          updateInvoice(ctx, mine.invoice.id, { description: 'x' }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(
          markInvoicePaid(ctx, { id: mine.invoice.id, paidAt: daysFromToday(0) }),
        ).rejects.toBeInstanceOf(NotFoundError);
        await expect(softDeleteInvoice(ctx, mine.invoice.id)).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it('lets the PM, the pipeline owner and admins do everything on an unpaid invoice', async () => {
      for (const ctx of [sales, pm, admin]) {
        const { purchaseOrder } = await newPurchaseOrder(w);
        const { invoice } = await createInvoice(ctx, invoiceInput(purchaseOrder.id, w.inspection));
        await updateInvoice(ctx, invoice.id, { description: 'edited' });
        await softDeleteInvoice(ctx, invoice.id);
        await restoreInvoice(ctx, invoice.id);
        await markInvoicePaid(ctx, { id: invoice.id, paidAt: daysFromToday(0) });
        const actions = (await auditOf('Invoice', invoice.id)).map((r) => [r.action, r.actorId]);
        expect(actions).toEqual([
          ['CREATE', ctx.user.id],
          ['UPDATE', ctx.user.id],
          ['SOFT_DELETE', ctx.user.id],
          ['RESTORE', ctx.user.id],
          ['UPDATE', ctx.user.id],
        ]);
      }
    });

    it('on an unassigned project, only the owner and admins can create', async () => {
      const { purchaseOrder } = await newPurchaseOrder(
        w,
        {},
        { projectOverrides: { managerId: '' } },
      );
      await expect(
        createInvoice(pm, invoiceInput(purchaseOrder.id, w.inspection)),
      ).rejects.toBeInstanceOf(NotFoundError);
      await createInvoice(sales, invoiceInput(purchaseOrder.id, w.inspection));
      await createInvoice(admin, invoiceInput(purchaseOrder.id, w.inspection));
    });

    it('lets only admins delete a PAID invoice', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-2),
        paidAt: daysFromToday(0),
      });
      for (const ctx of [sales, pm]) {
        const error = await rejection(softDeleteInvoice(ctx, invoice.id));
        expect(error).toBeInstanceOf(ForbiddenError);
      }
      const deleted = await softDeleteInvoice(admin, invoice.id);
      expect(deleted.deletedAt).toBeInstanceOf(Date);
      const view = await getInvoice(admin, invoice.id);
      expect(view.permissions.canDelete).toBe(false); // already deleted: restore instead
    });

    it('reports permissions and why deleting is blocked', async () => {
      const { invoice } = await newInvoice(w, {
        invoiceDate: daysFromToday(-2),
        paidAt: daysFromToday(0),
      });
      expect((await getInvoice(sales, invoice.id)).permissions).toMatchObject({
        canUpdate: true,
        canMarkPaid: false,
        canMarkUnpaid: false,
        canDelete: false,
        deleteBlockedReason: 'Only admins can delete a paid invoice',
      });
      expect((await getInvoice(admin, invoice.id)).permissions).toMatchObject({
        canMarkUnpaid: true,
        canDelete: true,
      });
      const { invoice: open } = await newInvoice(w);
      expect((await getInvoice(pm, open.id)).permissions).toMatchObject({
        canUpdate: true,
        canMarkPaid: true,
        canMarkUnpaid: false,
        canDelete: true,
      });
    });

    it('moves invoices between lists when the project’s PM or the quotation’s owner changes', async () => {
      const { project, quotation, invoice } = await newInvoice(w);
      await updateProject(admin, project.id, { managerId: pm2.user.id });
      expect(await ids(pm2)).toContain(invoice.id);
      expect(await ids(pm)).not.toContain(invoice.id);
      await updateQuotation(admin, quotation.id, { ownerId: sales2.user.id });
      expect(await ids(sales2)).toContain(invoice.id);
      expect(await ids(sales)).not.toContain(invoice.id);
    });

    it('treats a PO another PM or rep cannot read as not found for the draft', async () => {
      const { purchaseOrder } = await newPurchaseOrder(w);
      for (const ctx of [sales2, pm2]) {
        await expect(getInvoiceDraft(ctx, purchaseOrder.id)).rejects.toBeInstanceOf(NotFoundError);
      }
    });

    it('treats a deleted invoice another PM or rep cannot read as not found for restore', async () => {
      const { invoice } = await newInvoice(w);
      await softDeleteInvoice(sales, invoice.id);
      for (const ctx of [sales2, pm2]) {
        await expect(restoreInvoice(ctx, invoice.id)).rejects.toBeInstanceOf(NotFoundError);
      }
      expect((await getInvoice(admin, invoice.id)).deletedAt).toBeInstanceOf(Date);
    });

    it('refuses an inactive user the list and the summary counts', async () => {
      const inactive: Ctx = { ...sales, user: { ...sales.user, active: false } };
      await expect(listInvoices(inactive, {})).rejects.toBeInstanceOf(ForbiddenError);
      await expect(invoiceStatusCounts(inactive)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('counts only readable invoices in the enquiry’s pipeline strip (no id leaks)', async () => {
      const { enquiry, quotation, invoice } = await newInvoice(w);
      expect((await getEnquiry(sales, enquiry.id)).invoiceStage).toEqual({
        count: 1,
        invoiceId: invoice.id,
      });
      // The enquiry stays the rep's, but the quotation, and its invoices, move to sales2.
      await updateQuotation(admin, quotation.id, { ownerId: sales2.user.id });
      expect((await getEnquiry(sales, enquiry.id)).invoiceStage).toEqual({
        count: 0,
        invoiceId: null,
      });
      expect((await getEnquiry(admin, enquiry.id)).invoiceStage.count).toBe(1);
    });

    it('scopes the PO, project and client helper lists', async () => {
      const { project, purchaseOrder, invoice } = await newInvoice(w);
      expect((await listInvoicesForPurchaseOrder(pm, purchaseOrder.id)).map((i) => i.id)).toEqual([
        invoice.id,
      ]);
      expect((await listInvoicesForProject(sales, project.id)).map((i) => i.id)).toEqual([
        invoice.id,
      ]);
      expect((await listInvoicesForClient(admin, w.acme)).map((i) => i.id)).toContain(invoice.id);
      expect(await listInvoicesForPurchaseOrder(pm2, purchaseOrder.id)).toEqual([]);
      expect(await listInvoicesForProject(pm2, project.id)).toEqual([]);
      expect(await listInvoicesForProject(sales2, project.id)).toEqual([]);
      expect((await listInvoicesForClient(sales2, w.acme)).map((i) => i.id)).not.toContain(
        invoice.id,
      );
    });
  });

  describe('soft delete and restore', () => {
    it('drops a deleted invoice from lists except under "deleted"; restore needs a free number', async () => {
      const number = uniqueInvoiceNumber();
      const { purchaseOrder, invoice } = await newInvoice(w, { invoiceNumber: number });
      await softDeleteInvoice(sales, invoice.id);
      expect(await ids(sales, { purchaseOrderId: purchaseOrder.id })).toEqual([]);
      expect(
        await ids(sales, { purchaseOrderId: purchaseOrder.id, recordStatus: 'deleted' }),
      ).toEqual([invoice.id]);
      await createInvoice(
        sales,
        invoiceInput(purchaseOrder.id, w.inspection, { invoiceNumber: number.toLowerCase() }),
      );
      const error = await rejection(restoreInvoice(sales, invoice.id));
      expect(fieldOf(error)).toBe('invoiceNumber');
    });

    it('keeps the audit trail readable: deleted invoices stay in the database', async () => {
      const { invoice } = await newInvoice(w);
      await softDeleteInvoice(pm, invoice.id);
      const row = await getDb().invoice.findFirst({
        where: { id: invoice.id, deletedAt: { not: null } },
      });
      expect(row).not.toBeNull();
    });
  });
});
