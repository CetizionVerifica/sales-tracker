import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import type { ListInvoicesInput } from '../schemas/invoice.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { runExtraction, uploadDocument } from '../services/document.service.ts';
import { createInvoice, listInvoices, softDeleteInvoice } from '../services/invoice.service.ts';
import { invoiceStatusCounts } from '../services/summary.service.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';
import { daysFromToday, invoiceInput, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import { rejection } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

type Made = Awaited<ReturnType<typeof newInvoice>>;

// AC10: filters, search, sort, pagination and the summary chips.
describe('AC10: invoice list (integration)', () => {
  let w: PoWorld;
  let system: Ctx;
  const mock = createMockExtractor();
  let pending: Made; // due in 30 days, service Inspection, owner sales, PM pm
  let dueSoon: Made; // due in 3 days
  let overdue: Made; // due 10 days ago
  let paid: Made;
  let usd: Made;
  let unassigned: Made; // project without a PM
  let theirs: Made; // sales2 / pm2
  let withDoc: Made; // has an extracted document waiting for review
  let deleted: Made;

  beforeAll(async () => {
    w = await invoiceWorld();
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();

    pending = await newInvoice(w, {
      invoiceNumber: 'LIST/PENDING/1',
      paymentReference: 'UTR-FIND',
    });
    dueSoon = await newInvoice(w, { dueDate: daysFromToday(3) });
    overdue = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
    paid = await newInvoice(w, { invoiceDate: daysFromToday(-5), paidAt: daysFromToday(-1) });
    usd = await newInvoice(w, { amount: '900' }, { po: { currency: 'USD' } });
    unassigned = await newInvoice(w, {}, { projectOverrides: { managerId: '' } });
    theirs = await newInvoice(
      w,
      {},
      { owner: w.sales2, projectOverrides: { managerId: w.pm2.user.id } },
    );
    withDoc = await newInvoice(w);
    const bytes = samplePdf('list invoice');
    mock.register(await sha256Hex(bytes), {
      type: 'result',
      wire: {
        invoiceNumber: { value: 'X', confidence: 'high', page: 1, sourceText: 'X' },
      },
    });
    const doc = await uploadDocument(
      w.sales,
      { kind: 'INVOICE', entityId: withDoc.invoice.id },
      { bytes, mimeType: 'application/pdf', filename: 'inv.pdf' },
    );
    await runExtraction(system, doc.id);
    deleted = await newInvoice(w);
    await softDeleteInvoice(w.sales, deleted.invoice.id);
    // A second service on one PO, for the service filter.
    const po = await newPurchaseOrder(w);
    await createInvoice(w.sales, invoiceInput(po.purchaseOrder.id, w.audit));
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  const ids = async (ctx: Ctx, input: ListInvoicesInput = {}) =>
    (await listInvoices(ctx, { pageSize: 100, ...input })).items.map((i) => i.id);

  it('filters by status, due window, currency and document state', async () => {
    expect(await ids(w.admin, { status: ['OVERDUE'] })).toEqual([overdue.invoice.id]);
    expect(await ids(w.admin, { status: ['PAID'] })).toEqual([paid.invoice.id]);
    expect(await ids(w.admin, { due: 'overdue' })).toEqual([overdue.invoice.id]);
    expect(await ids(w.admin, { due: 'next7' })).toEqual([dueSoon.invoice.id]);
    expect(await ids(w.admin, { due: 'next30' })).toEqual(
      expect.arrayContaining([dueSoon.invoice.id, pending.invoice.id]),
    );
    expect(await ids(w.admin, { due: 'next30' })).not.toContain(paid.invoice.id);
    expect(await ids(w.admin, { currency: ['USD'] })).toEqual([usd.invoice.id]);
    expect(await ids(w.admin, { document: 'toReview' })).toEqual([withDoc.invoice.id]);
    expect(await ids(w.admin, { document: 'none' })).not.toContain(withDoc.invoice.id);
  });

  it('filters by PO, project, client, service, manager and owner', async () => {
    expect(await ids(w.admin, { purchaseOrderId: pending.purchaseOrder.id })).toEqual([
      pending.invoice.id,
    ]);
    expect(await ids(w.admin, { projectId: pending.project.id })).toEqual([pending.invoice.id]);
    expect(await ids(w.admin, { clientId: w.globex })).toEqual([]);
    const audit = await ids(w.admin, { serviceId: w.audit });
    expect(audit).toHaveLength(1);
    expect(await ids(w.admin, { managerId: 'none' })).toEqual([unassigned.invoice.id]);
    expect(await ids(w.admin, { managerId: w.pm2.user.id })).toEqual([theirs.invoice.id]);
    expect(await ids(w.admin, { ownerId: w.sales2.user.id })).toEqual([theirs.invoice.id]);
    const error = await rejection(listInvoices(w.sales, { ownerId: w.sales2.user.id }));
    expect(error).toBeInstanceOf(DomainError);
  });

  it('filters by invoice and due date ranges', async () => {
    expect(
      await ids(w.admin, { invoiceFrom: daysFromToday(-41), invoiceTo: daysFromToday(-39) }),
    ).toEqual([overdue.invoice.id]);
    expect(await ids(w.admin, { dueFrom: daysFromToday(2), dueTo: daysFromToday(4) })).toEqual([
      dueSoon.invoice.id,
    ]);
  });

  it('searches number, PO, project, client and payment reference', async () => {
    expect(await ids(w.admin, { q: 'list/pending' })).toEqual([pending.invoice.id]);
    expect(await ids(w.admin, { q: 'utr-find' })).toEqual([pending.invoice.id]);
    expect(await ids(w.admin, { q: pending.purchaseOrder.poNumber })).toEqual([pending.invoice.id]);
    expect(await ids(w.admin, { q: pending.project.number })).toEqual([pending.invoice.id]);
    expect((await ids(w.admin, { q: 'acme' })).length).toBeGreaterThan(5);
  });

  it('ANDs filters with the RBAC scope', async () => {
    expect(await ids(w.pm, { managerId: w.pm2.user.id })).toEqual([]);
    expect(await ids(w.sales2)).toEqual([theirs.invoice.id]);
    expect(await ids(w.pm)).not.toContain(unassigned.invoice.id);
    expect(await ids(w.sales)).toContain(unassigned.invoice.id);
  });

  it('shows deleted invoices only under "deleted"', async () => {
    expect(await ids(w.admin)).not.toContain(deleted.invoice.id);
    expect(await ids(w.admin, { recordStatus: 'deleted' })).toEqual([deleted.invoice.id]);
  });

  it('sorts and paginates', async () => {
    const byDue = await ids(w.admin, { sort: 'dueDate' });
    expect(byDue[0]).toBe(overdue.invoice.id);
    const byDueDesc = await ids(w.admin, { sort: 'dueDate', dir: 'desc' });
    expect(byDueDesc.at(-1)).toBe(overdue.invoice.id);
    const all = await ids(w.admin, { sort: 'invoiceNumber' });
    const page1 = await listInvoices(w.admin, { sort: 'invoiceNumber', pageSize: 3, page: 1 });
    const page2 = await listInvoices(w.admin, { sort: 'invoiceNumber', pageSize: 3, page: 2 });
    expect(page1.total).toBe(all.length);
    expect([...page1.items, ...page2.items].map((i) => i.id)).toEqual(all.slice(0, 6));
    for (const sort of [
      'invoiceDate',
      'client',
      'amount',
      'status',
      'paidAt',
      'createdAt',
      'updatedAt',
    ] as const) {
      expect(await ids(w.admin, { sort })).toHaveLength(all.length);
    }
  });

  it('reports days overdue on unpaid rows', async () => {
    const [row] = (await listInvoices(w.admin, { status: ['OVERDUE'] })).items;
    expect(row!.daysOverdue).toBe(10);
    const [paidRow] = (await listInvoices(w.admin, { status: ['PAID'] })).items;
    expect(paidRow!.daysOverdue).toBeNull();
  });

  it('counts each chip as the filtered list does', async () => {
    for (const ctx of [w.admin, w.sales, w.pm, w.sales2]) {
      const counts = await invoiceStatusCounts(ctx);
      for (const status of ['PENDING', 'PAID', 'OVERDUE'] as const) {
        expect(counts[status]).toBe((await ids(ctx, { status: [status] })).length);
      }
      expect(counts.dueNext7).toBe((await ids(ctx, { due: 'next7' })).length);
      expect(counts.toReview).toBe((await ids(ctx, { document: 'toReview' })).length);
    }
  });
});
