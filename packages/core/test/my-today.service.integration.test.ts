import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import { todayInIST } from '../schemas/common.ts';
import type { WireExtraction } from '../schemas/extraction.ts';
import type { MyToday, MyTodayRow } from '../schemas/my-today.ts';
import { createClient, softDeleteClient } from '../services/client.service.ts';
import {
  confirmExtraction,
  getDocument,
  listDocumentsPendingReview,
  runExtraction,
  uploadDocument,
} from '../services/document.service.ts';
import {
  convertEnquiry,
  createEnquiry,
  getEnquiry,
  listEnquiries,
  markEnquiryLost,
  softDeleteEnquiry,
  updateEnquiry,
} from '../services/enquiry.service.ts';
import {
  logFollowUp,
  restoreFollowUp,
  softDeleteFollowUp,
} from '../services/follow-up.service.ts';
import {
  getInvoice,
  markInvoicePaid,
  softDeleteInvoice,
} from '../services/invoice.service.ts';
import { getMyToday, myTodayBadgeCount } from '../services/my-today.service.ts';
import { changeProjectStatus, getProject, updateProject } from '../services/project.service.ts';
import {
  getPurchaseOrder,
  softDeletePurchaseOrder,
} from '../services/purchase-order.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getQuotation,
  updateQuotation,
} from '../services/quotation.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { deactivateUser } from '../services/user.service.ts';
import { invoiceStatusCounts } from '../services/summary.service.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from './helpers.ts';
import { daysFromToday, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import { newProject, rejection } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

type Section = 'overdue' | 'dueToday' | 'comingUp';
type Located = MyTodayRow & { section: Section };

const flatten = (t: MyToday): Located[] =>
  (['overdue', 'dueToday', 'comingUp'] as const).flatMap((section) =>
    t.sections[section].map((row) => ({ ...row, section })),
  );

let w: PoWorld;
let system: Ctx;
const today = () => todayInIST();

async function rows(ctx: Ctx, userId?: string): Promise<Located[]> {
  return flatten(await getMyToday(ctx, userId ? { userId } : {}, { today: today() }));
}

async function rowFor(ctx: Ctx, recordId: string): Promise<Located | undefined> {
  return (await rows(ctx)).find((r) => r.record.id === recordId);
}

const call = (date: number, next?: number) => ({
  date: daysFromToday(date),
  channel: 'CALL' as const,
  notes: `Call on day ${date}`,
  ...(next !== undefined && { nextFollowUpDate: daysFromToday(next) }),
});

/** An IN_PROGRESS enquiry owned by `ctx`, received `receivedDaysAgo` days ago. */
async function enquiry(ctx: Ctx, receivedDaysAgo: number, clientId = w.acme) {
  return createEnquiry(ctx, {
    clientId,
    sectorId: w.pharma,
    serviceIds: [w.inspection],
    receivedDate: daysFromToday(-receivedDaysAgo),
    proposalSentDate: daysFromToday(-receivedDaysAgo),
    source: 'EMAIL',
  });
}

/** A SENT quotation owned by `ctx` with the given next follow-up day. */
async function openQuotation(ctx: Ctx, next: number) {
  const enq = await enquiry(ctx, 10);
  await convertEnquiry(ctx, { id: enq.id });
  return createQuotation(ctx, {
    enquiryId: enq.id,
    quotationDate: daysFromToday(-10),
    amount: '2,00,000',
    currency: 'INR',
    sectorId: w.pharma,
    serviceIds: [w.inspection],
    nextFollowUpDate: daysFromToday(next),
  });
}

const mock = createMockExtractor();
const field = (value: string | null) => ({ value, confidence: 'high' as const, page: 1, sourceText: value });
const invoiceWire = (): WireExtraction => ({
  invoiceNumber: field('INV/26-27/0042'),
  invoiceDate: field(daysFromToday(-2)),
  dueDate: field(null),
  clientName: field('Acme Pharma'),
  clientGstin: field(null),
  poNumber: field(null),
  amount: field('50,000'),
  currency: field('INR'),
});

beforeAll(async () => {
  w = await invoiceWorld();
  system = await ensureSystemCtx();
  setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
  await getDocumentsQueue().obliterate({ force: true });
});
afterAll(async () => {
  await closeDocumentsQueue();
  await disconnectAll();
});

describe('AC2: follow-ups due', () => {
  it('a missed follow-up on an in-progress enquiry is overdue for its owner', async () => {
    const enq = await enquiry(w.sales, 20);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(-5, -2) });
    const row = await rowFor(w.sales, enq.id);
    expect(row).toMatchObject({
      kind: 'FOLLOW_UP_DUE',
      section: 'overdue',
      daysFromToday: -2,
      record: { type: 'ENQUIRY', label: enq.number },
      client: { id: w.acme, name: 'Acme Pharma' },
    });
    expect(row!.detail).toContain('Call on day -5');
    expect(await rowFor(w.sales2, enq.id)).toBeUndefined();
  });

  it('only the latest follow-up counts; deleting it brings the older one back', async () => {
    const enq = await enquiry(w.sales, 20);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(-5, -2) });

    const later = await logFollowUp(w.sales, {
      entityType: 'ENQUIRY',
      entityId: enq.id,
      ...call(-1, 3),
    });
    expect(await rowFor(w.sales, enq.id)).toMatchObject({ section: 'comingUp', daysFromToday: 3 });

    const beyond = await logFollowUp(w.sales, {
      entityType: 'ENQUIRY',
      entityId: enq.id,
      ...call(0, 8),
    });
    expect(await rowFor(w.sales, enq.id)).toBeUndefined();

    await softDeleteFollowUp(w.sales, beyond.id);
    await softDeleteFollowUp(w.sales, later.id);
    expect(await rowFor(w.sales, enq.id)).toMatchObject({ section: 'overdue', daysFromToday: -2 });

    await restoreFollowUp(w.sales, later.id);
    expect(await rowFor(w.sales, enq.id)).toMatchObject({ daysFromToday: 3 });
  });

  it('a newer follow-up without a next date closes the row', async () => {
    const enq = await enquiry(w.sales, 5);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(-4, -1) });
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(0) });
    expect(await rowFor(w.sales, enq.id)).toBeUndefined();
  });

  it('closed or deleted enquiries drop out', async () => {
    const converted = await enquiry(w.sales, 5);
    const lost = await enquiry(w.sales, 5);
    const deleted = await enquiry(w.sales, 5);
    for (const e of [converted, lost, deleted]) {
      await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: e.id, ...call(-3, -1) });
      expect(await rowFor(w.sales, e.id)).toBeDefined();
    }
    await convertEnquiry(w.sales, { id: converted.id });
    await markEnquiryLost(w.sales, { id: lost.id, lostReason: 'Went with a competitor' });
    await softDeleteEnquiry(w.sales, deleted.id);
    for (const e of [converted, lost, deleted]) {
      expect(await rowFor(w.sales, e.id)).toBeUndefined();
    }
  });

  it('project, PO and invoice follow-ups go to their author while the record is open', async () => {
    const { project, purchaseOrder } = await newPurchaseOrder(w);
    const onProject = await logFollowUp(w.pm, {
      entityType: 'PROJECT',
      entityId: project.id,
      ...call(-2, 0),
    });
    await logFollowUp(w.sales, {
      entityType: 'PURCHASE_ORDER',
      entityId: purchaseOrder.id,
      ...call(-2, 1),
    });
    expect(await rowFor(w.pm, project.id)).toMatchObject({
      kind: 'FOLLOW_UP_DUE',
      section: 'dueToday',
    });
    // The author, not everyone on the record (Decision 2).
    expect(await rowFor(w.sales, project.id)).toBeUndefined();
    expect(await rowFor(w.sales, purchaseOrder.id)).toMatchObject({ kind: 'FOLLOW_UP_DUE' });
    expect(await rowFor(w.pm, purchaseOrder.id)).toBeUndefined();

    await softDeletePurchaseOrder(w.sales, purchaseOrder.id);
    expect(await rowFor(w.sales, purchaseOrder.id)).toBeUndefined();

    await changeProjectStatus(w.pm, {
      id: project.id,
      to: 'IN_PROGRESS',
      startDate: daysFromToday(-5),
    });
    await changeProjectStatus(w.pm, {
      id: project.id,
      to: 'COMPLETED',
      completedDate: daysFromToday(0),
    });
    expect(await rowFor(w.pm, project.id)).toBeUndefined();
    expect(onProject.id).toBeDefined();
  });

  it('a follow-up on a PO drops out once the PO is paid', async () => {
    const { purchaseOrder, invoice } = await newInvoice(w, { amount: '1,00,000' });
    await logFollowUp(w.sales, {
      entityType: 'PURCHASE_ORDER',
      entityId: purchaseOrder.id,
      ...call(-1, 2),
    });
    expect(await rowFor(w.sales, purchaseOrder.id)).toMatchObject({ kind: 'FOLLOW_UP_DUE' });
    await markInvoicePaid(w.sales, { id: invoice.id, paidAt: daysFromToday(0) });
    expect((await getPurchaseOrder(w.sales, purchaseOrder.id)).status).toBe('PAID');
    expect(await rowFor(w.sales, purchaseOrder.id)).toBeUndefined();
  });

  it('a follow-up on a paid invoice drops out', async () => {
    const { invoice } = await newInvoice(w);
    await logFollowUp(w.pm, { entityType: 'INVOICE', entityId: invoice.id, ...call(-1, 2) });
    expect(await rowFor(w.pm, invoice.id)).toMatchObject({ kind: 'FOLLOW_UP_DUE' });
    await markInvoicePaid(w.pm, { id: invoice.id, paidAt: daysFromToday(0) });
    expect(await rowFor(w.pm, invoice.id)).toBeUndefined();
  });

  it('client-level follow-ups stay with their author; a deleted client drops out', async () => {
    const initech = (await createClient(w.admin, { name: 'Initech', sectorId: w.pharma })).id;
    await logFollowUp(w.sales, { entityType: 'CLIENT', entityId: initech, ...call(-3, -1) });
    expect(await rowFor(w.sales, initech)).toMatchObject({
      kind: 'FOLLOW_UP_DUE',
      record: { type: 'CLIENT', label: 'Initech' },
    });
    expect(await rowFor(w.sales2, initech)).toBeUndefined();
    await softDeleteClient(w.admin, initech);
    expect(await rowFor(w.sales, initech)).toBeUndefined();
  });

  it('a record on a deleted client drops out', async () => {
    const umbrella = (await createClient(w.admin, { name: 'Umbrella', sectorId: w.pharma })).id;
    const enq = await enquiry(w.sales, 5, umbrella);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(-3, -1) });
    expect(await rowFor(w.sales, enq.id)).toBeDefined();
    await softDeleteClient(w.admin, umbrella);
    expect(await rowFor(w.sales, enq.id)).toBeUndefined();
  });

  it('quotation follow-ups never show as FOLLOW_UP_DUE (the quotation row covers them)', async () => {
    const q = await openQuotation(w.sales, 5);
    await logFollowUp(w.sales, { entityType: 'QUOTATION', entityId: q.id, ...call(-3, -1) });
    const all = (await rows(w.sales)).filter((r) => r.record.id === q.id);
    expect(all.map((r) => r.kind)).toEqual(['QUOTATION_AWAITING_REPLY']);
    expect(all[0]!.alsoReasons).toEqual([]);
  });

  it('reassigning an enquiry moves its follow-up row to the new owner', async () => {
    const enq = await enquiry(w.sales, 5);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: enq.id, ...call(-3, -1) });
    await updateEnquiry(w.admin, enq.id, { ownerId: w.sales2.user.id });
    expect(await rowFor(w.sales, enq.id)).toBeUndefined();
    expect(await rowFor(w.sales2, enq.id)).toMatchObject({ kind: 'FOLLOW_UP_DUE' });
  });

  it('a PM who loses a project loses its follow-up rows', async () => {
    const { project } = await newProject(w);
    await logFollowUp(w.pm, { entityType: 'PROJECT', entityId: project.id, ...call(-3, -1) });
    expect(await rowFor(w.pm, project.id)).toBeDefined();
    await updateProject(w.admin, project.id, { managerId: w.pm2.user.id });
    expect(await rowFor(w.pm, project.id)).toBeUndefined();
    expect(await rowFor(w.pm2, project.id)).toBeUndefined();
  });
});

describe('AC3: quotations awaiting reply', () => {
  it('open quotations due within 7 days show for their owner, by section', async () => {
    const missed = await openQuotation(w.sales, -2);
    const todayQ = await openQuotation(w.sales, 0);
    const week = await openQuotation(w.sales, 7);
    const later = await openQuotation(w.sales, 8);
    expect(await rowFor(w.sales, missed.id)).toMatchObject({
      kind: 'QUOTATION_AWAITING_REPLY',
      section: 'overdue',
      record: { type: 'QUOTATION', label: missed.number },
    });
    expect(await rowFor(w.sales, todayQ.id)).toMatchObject({ section: 'dueToday' });
    expect(await rowFor(w.sales, week.id)).toMatchObject({ section: 'comingUp' });
    expect(await rowFor(w.sales, later.id)).toBeUndefined();
    expect(await rowFor(w.sales2, missed.id)).toBeUndefined();
  });

  it('under negotiation counts; PO received and lost never do', async () => {
    const negotiating = await openQuotation(w.sales, -1);
    const won = await openQuotation(w.sales, -1);
    const lost = await openQuotation(w.sales, -1);
    await changeQuotationStatus(w.sales, {
      id: negotiating.id,
      to: 'UNDER_NEGOTIATION',
      nextFollowUpDate: daysFromToday(-1),
    });
    await changeQuotationStatus(w.sales, {
      id: won.id,
      to: 'PO_RECEIVED',
      poReceivedDate: daysFromToday(0),
    });
    await changeQuotationStatus(w.sales, { id: lost.id, to: 'LOST', lostReason: 'Price' });
    expect(await rowFor(w.sales, negotiating.id)).toMatchObject({ section: 'overdue' });
    expect(await rowFor(w.sales, won.id)).toBeUndefined();
    expect(await rowFor(w.sales, lost.id)).toBeUndefined();
  });

  it('reassigning the owner moves the row', async () => {
    const q = await openQuotation(w.sales, 1);
    await updateQuotation(w.admin, q.id, { ownerId: w.sales2.user.id });
    expect(await rowFor(w.sales, q.id)).toBeUndefined();
    expect(await rowFor(w.sales2, q.id)).toMatchObject({ kind: 'QUOTATION_AWAITING_REPLY' });
  });
});

describe('AC4: invoices due and overdue', () => {
  it('overdue and due invoices show for both the PM and the pipeline owner (Decision 12)', async () => {
    const overdue = (await newInvoice(w, { invoiceDate: daysFromToday(-40) })).invoice;
    const due = (await newInvoice(w, { invoiceDate: daysFromToday(-27) })).invoice;
    const later = (await newInvoice(w, { invoiceDate: daysFromToday(-22) })).invoice;
    expect(overdue.status).toBe('OVERDUE');
    for (const ctx of [w.pm, w.sales]) {
      expect(await rowFor(ctx, overdue.id)).toMatchObject({
        kind: 'INVOICE_OVERDUE',
        section: 'overdue',
        daysFromToday: -10,
        amount: { amountMinor: 5_000_000n, currency: 'INR' },
      });
      expect(await rowFor(ctx, due.id)).toMatchObject({
        kind: 'INVOICE_DUE',
        section: 'comingUp',
        daysFromToday: 3,
      });
      expect(await rowFor(ctx, later.id)).toBeUndefined();
    }
    expect(await rowFor(w.pm2, overdue.id)).toBeUndefined();
    expect(await rowFor(w.sales2, overdue.id)).toBeUndefined();
  });

  it('paid and deleted invoices drop out', async () => {
    const paid = (await newInvoice(w, { invoiceDate: daysFromToday(-40) })).invoice;
    const deleted = (await newInvoice(w, { invoiceDate: daysFromToday(-40) })).invoice;
    await markInvoicePaid(w.pm, { id: paid.id, paidAt: daysFromToday(0) });
    await softDeleteInvoice(w.pm, deleted.id);
    expect(await rowFor(w.pm, paid.id)).toBeUndefined();
    expect(await rowFor(w.pm, deleted.id)).toBeUndefined();
  });

  it('an unassigned project’s invoices show for the owner only', async () => {
    const { invoice } = await newInvoice(
      w,
      { invoiceDate: daysFromToday(-40) },
      { projectOverrides: { managerId: '' } },
    );
    expect(await rowFor(w.sales, invoice.id)).toMatchObject({ kind: 'INVOICE_OVERDUE' });
    expect(await rowFor(w.pm, invoice.id)).toBeUndefined();
  });

  it('matches the invoice list’s overdue and due-in-7-days counts for the owner', async () => {
    const mine = await getMyToday(w.sales, {}, { today: today() });
    const counts = await invoiceStatusCounts(w.sales);
    expect(mine.counts.byKind.INVOICE_OVERDUE).toBe(counts.OVERDUE);
    expect(mine.counts.byKind.INVOICE_DUE).toBe(counts.dueNext7);
  });
});

describe('AC5: stale enquiries', () => {
  it('uses staleEnquiryDays from the last touch; a planned next step is never stale', async () => {
    const at30 = await enquiry(w.sales, 30);
    const at29 = await enquiry(w.sales, 29);
    const planned = await enquiry(w.sales, 60);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: planned.id, ...call(-40, 10) });
    const touched = await enquiry(w.sales, 60);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: touched.id, ...call(-35) });
    const missed = await enquiry(w.sales, 60);
    await logFollowUp(w.sales, { entityType: 'ENQUIRY', entityId: missed.id, ...call(-40, -3) });

    expect(await rowFor(w.sales, at30.id)).toMatchObject({
      kind: 'STALE_ENQUIRY',
      section: 'dueToday',
      record: { type: 'ENQUIRY', label: at30.number },
    });
    expect(await rowFor(w.sales, at29.id)).toBeUndefined();
    expect(await rowFor(w.sales, planned.id)).toBeUndefined();
    expect(await rowFor(w.sales, touched.id)).toMatchObject({
      kind: 'STALE_ENQUIRY',
      section: 'overdue',
      daysFromToday: -5,
    });
    // A missed next date is a follow-up row, not a stale one (Decision 5).
    const missedRow = await rowFor(w.sales, missed.id);
    expect(missedRow).toMatchObject({ kind: 'FOLLOW_UP_DUE', daysFromToday: -3 });
    expect(missedRow!.alsoReasons).toEqual([]);

    const stale = await listEnquiries(w.sales, { stale: true, pageSize: 100 });
    const ids = stale.items.map((e) => e.id);
    expect(ids).toContain(at30.id);
    expect(ids).toContain(touched.id);
    expect(ids).not.toContain(at29.id);
    expect(ids).not.toContain(planned.id);
    expect(ids).not.toContain(missed.id);

    // The filter stays inside the list's scope: another rep never sees these.
    const theirs = await listEnquiries(w.sales2, { stale: true, pageSize: 100 });
    expect(theirs.items.map((e) => e.id)).not.toContain(at30.id);
    expect(theirs.items.every((e) => e.ownerId === w.sales2.user.id)).toBe(true);

    await updateSettings(w.admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR', 'USD'],
      staleEnquiryDays: 60,
    });
    try {
      expect(await rowFor(w.sales, at30.id)).toBeUndefined();
      expect(await rowFor(w.sales, touched.id)).toBeUndefined();
    } finally {
      await updateSettings(w.admin, {
        companyName: 'Test Co',
        defaultInvoiceDueDays: 30,
        enabledCurrencies: ['INR', 'USD'],
        staleEnquiryDays: 30,
      });
    }
  });
});

describe('AC6: projects behind schedule and documents to review', () => {
  it('active projects past their planned end show for their PM', async () => {
    const past = { startDate: daysFromToday(-30), endDate: daysFromToday(-1) };
    const notStarted = (await newProject(w, past)).project;
    const inProgress = (await newProject(w, past)).project;
    const onHold = (await newProject(w, past)).project;
    const endsToday = (await newProject(w, { ...past, endDate: daysFromToday(0) })).project;
    const completed = (await newProject(w, past)).project;
    const cancelled = (await newProject(w, past)).project;
    const unassigned = (await newProject(w, { ...past, managerId: '' })).project;
    await changeProjectStatus(w.pm, { id: inProgress.id, to: 'IN_PROGRESS' });
    await changeProjectStatus(w.pm, { id: onHold.id, to: 'ON_HOLD', holdReason: 'Client audit' });
    await changeProjectStatus(w.pm, { id: completed.id, to: 'IN_PROGRESS' });
    await changeProjectStatus(w.pm, {
      id: completed.id,
      to: 'COMPLETED',
      completedDate: daysFromToday(0),
    });
    await changeProjectStatus(w.admin, { id: cancelled.id, to: 'CANCELLED', cancelReason: 'Scope' });

    for (const p of [notStarted, inProgress, onHold]) {
      expect(await rowFor(w.pm, p.id)).toMatchObject({
        kind: 'PROJECT_BEHIND_SCHEDULE',
        section: 'overdue',
        daysFromToday: -1,
        record: { type: 'PROJECT' },
      });
    }
    expect((await rowFor(w.pm, onHold.id))!.detail).toContain('Client audit');
    for (const p of [endsToday, completed, cancelled, unassigned]) {
      expect(await rowFor(w.pm, p.id)).toBeUndefined();
    }
    expect(await rowFor(w.sales, notStarted.id)).toBeUndefined();
    expect(await rowFor(w.pm2, notStarted.id)).toBeUndefined();
  });

  it('documents match listDocumentsPendingReview; confirming removes the row', async () => {
    const { invoice } = await newInvoice(w);
    const bytes = samplePdf(`my-today invoice ${invoice.id}`);
    mock.register(await sha256Hex(bytes), { type: 'result', wire: invoiceWire() });
    const doc = await uploadDocument(
      w.pm,
      { kind: 'INVOICE', entityId: invoice.id },
      { bytes, mimeType: 'application/pdf', filename: 'invoice.pdf' },
    );
    await runExtraction(system, doc.id);

    const docRows = (await rows(w.pm)).filter((r) => r.kind === 'DOCUMENT_TO_REVIEW');
    const pending = await listDocumentsPendingReview(w.pm);
    expect(docRows.map((r) => r.record.id).sort()).toEqual(pending.map((d) => d.id).sort());
    expect(docRows.find((r) => r.record.id === doc.id)).toMatchObject({
      section: 'dueToday',
      record: { type: 'DOCUMENT' },
      followUpTarget: { entityType: 'INVOICE', entityId: invoice.id },
      actions: ['REVIEW', 'OPEN'],
    });

    await confirmExtraction(w.pm, { documentId: doc.id, apply: {} });
    expect(await rowFor(w.pm, doc.id)).toBeUndefined();
  });
});

describe('AC7: sections, merging and the IST boundary', () => {
  it('an overdue invoice with a chase follow-up due is one row', async () => {
    const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
    await logFollowUp(w.pm, { entityType: 'INVOICE', entityId: invoice.id, ...call(-12, -12) });
    const matches = (await rows(w.pm)).filter((r) => r.record.id === invoice.id);
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      kind: 'INVOICE_OVERDUE',
      daysFromToday: -12,
      alsoReasons: [{ kind: 'FOLLOW_UP_DUE' }],
    });
    // The owner did not log the follow-up, so theirs has no merged reason.
    expect((await rowFor(w.sales, invoice.id))!.alsoReasons).toEqual([]);
  });

  it('`kind` narrows the sections before counting; chips and badge stay whole', async () => {
    const whole = await getMyToday(w.sales, {}, { today: today() });
    const invoices = await getMyToday(w.sales, { kind: 'invoices' }, { today: today() });
    const rowsShown = flatten(invoices);
    expect(rowsShown.length).toBeGreaterThan(0);
    expect(
      rowsShown.every((r) => r.kind === 'INVOICE_OVERDUE' || r.kind === 'INVOICE_DUE'),
    ).toBe(true);
    const { counts } = invoices;
    expect(counts.overdue + counts.dueToday + counts.comingUp).toBe(
      whole.counts.byKind.INVOICE_OVERDUE + whole.counts.byKind.INVOICE_DUE,
    );
    expect(counts.byKind).toEqual(whole.counts.byKind);
    expect(counts.badge).toBe(whole.counts.badge);
    expect(invoices.kind).toBe('invoices');
    await expect(getMyToday(w.sales, { kind: 'nope' as 'invoices' })).rejects.toThrow();
  });

  it('`today` defaults to the IST day: 23:30 IST is still that day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-09-28T18:00:00.000Z'));
      const result = await getMyToday(w.sales);
      expect(result.today).toEqual(new Date('2026-09-28T00:00:00.000Z'));
      vi.setSystemTime(new Date('2026-09-28T19:00:00.000Z'));
      expect((await getMyToday(w.sales)).today).toEqual(new Date('2026-09-29T00:00:00.000Z'));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AC8: RBAC', () => {
  it('another user’s list is not found for non-admins', async () => {
    expect(await rejection(getMyToday(w.sales, { userId: w.sales2.user.id }))).toBeInstanceOf(
      NotFoundError,
    );
    expect(await rejection(getMyToday(w.pm, { userId: w.sales.user.id }))).toBeInstanceOf(
      NotFoundError,
    );
  });

  it('admins see exactly the user’s rows, with Open as the only action', async () => {
    const own = await rows(w.sales);
    const viewed = await rows(w.admin, w.sales.user.id);
    expect(own.length).toBeGreaterThan(0);
    expect(viewed.map((r) => r.key)).toEqual(own.map((r) => r.key));
    expect(new Set(viewed.flatMap((r) => r.actions))).toEqual(new Set(['OPEN']));
    const result = await getMyToday(w.admin, { userId: w.sales.user.id });
    expect(result).toMatchObject({ viewingOther: true, user: { id: w.sales.user.id } });
  });

  it('inactive, system and unknown users are not found', async () => {
    const leaver = await createTestUser('leaver@example.test', 'SALES');
    await deactivateUser(w.admin, leaver.id);
    for (const userId of [leaver.id, system.user.id, 'no-such-user']) {
      expect(await rejection(getMyToday(w.admin, { userId }))).toBeInstanceOf(NotFoundError);
    }
  });

  it('every row names a record its user can read, with actions by permission', async () => {
    for (const ctx of [w.sales, w.pm, w.admin]) {
      for (const row of await rows(ctx)) {
        const read = {
          ENQUIRY: () => getEnquiry(ctx, row.record.id),
          QUOTATION: () => getQuotation(ctx, row.record.id),
          PROJECT: () => getProject(ctx, row.record.id),
          PURCHASE_ORDER: () => getPurchaseOrder(ctx, row.record.id),
          INVOICE: () => getInvoice(ctx, row.record.id),
          DOCUMENT: () => getDocument(ctx, row.record.id),
          CLIENT: async () => row.record.id,
        }[row.record.type];
        await expect(read()).resolves.toBeDefined();
        const expected =
          row.record.type === 'DOCUMENT'
            ? ['REVIEW', 'OPEN']
            : row.record.type === 'INVOICE'
              ? ['LOG_FOLLOW_UP', 'MARK_PAID', 'OPEN']
              : ['LOG_FOLLOW_UP', 'OPEN'];
        expect(row.actions).toEqual(expected);
      }
    }
  });
});

describe('AC9: read-only, and the badge', () => {
  it('writes nothing, and the badge is overdue + due today', async () => {
    const before = await getDb().auditLog.count();
    const result = await getMyToday(w.pm);
    const badge = await myTodayBadgeCount(w.pm);
    expect(await getDb().auditLog.count()).toBe(before);
    expect(badge).toBe(result.counts.overdue + result.counts.dueToday);
    expect(result.counts.badge).toBe(badge);
    expect(badge).toBeGreaterThan(0);
  });

  it('a user with nothing due gets empty sections', async () => {
    const quiet = ctxFor(
      actor('SALES', { id: (await createTestUser('quiet@example.test', 'SALES')).id }),
    );
    const result = await getMyToday(quiet);
    expect(result.counts).toMatchObject({ overdue: 0, dueToday: 0, comingUp: 0 });
    expect(await myTodayBadgeCount(quiet)).toBe(0);
  });
});
