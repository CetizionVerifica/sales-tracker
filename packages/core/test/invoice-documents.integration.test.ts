import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import { toCalendarDateString } from '../schemas/common.ts';
import { normaliseExtraction, INVOICE_EXTRACTION_FIELDS } from '../schemas/extraction.ts';
import type { WireExtraction } from '../schemas/extraction.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { createClient, updateClient } from '../services/client.service.ts';
import {
  confirmExtraction,
  getDocument,
  listDocumentsPendingReview,
  runExtraction,
  uploadDocument,
} from '../services/document.service.ts';
import { createInvoice, getInvoice } from '../services/invoice.service.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';
import {
  daysFromToday,
  invoiceInput,
  invoiceWorld,
  newInvoice,
  uniqueInvoiceNumber,
} from './invoice-fixtures.ts';
import { auditOf, fieldOf, rejection } from './project-fixtures.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

const field = (value: string | null, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  value,
  confidence,
  page: 1,
  sourceText: value,
});

const ACME_GSTIN = '27AAACA1234A1Z5';
const OTHER_GSTIN = '29AAACB9876B1Z3';

const wire = (
  overrides: Partial<Record<string, ReturnType<typeof field>>> = {},
): WireExtraction => ({
  invoiceNumber: field('INV/26-27/0042'),
  invoiceDate: field(daysFromToday(-2)),
  dueDate: field(null),
  clientName: field('Acme Pharma Pvt. Ltd.'),
  clientGstin: field(null),
  poNumber: field(null),
  amount: field('5,90,000'),
  currency: field('INR'),
  ...overrides,
});

const ymd = (date: Date) => toCalendarDateString(date);

// AC7: the INVOICE document kind, through the unchanged M7 flow.
describe('AC7: invoice documents (integration)', () => {
  let w: PoWorld;
  let system: Ctx;
  const mock = createMockExtractor();
  let counter = 0;

  async function pdf(extraction?: WireExtraction) {
    const bytes = samplePdf(`invoice file ${++counter}`);
    if (extraction) mock.register(await sha256Hex(bytes), { type: 'result', wire: extraction });
    return { bytes, mimeType: 'application/pdf', filename: 'invoice.pdf' };
  }

  /** An invoice with an extracted, unreviewed document uploaded by `ctx`. */
  async function extracted(
    ctx: Ctx,
    extraction: WireExtraction = wire(),
    invoice: Parameters<typeof newInvoice>[1] = {},
    options: Parameters<typeof newInvoice>[2] = {},
  ) {
    const made = await newInvoice(w, invoice, options);
    const doc = await uploadDocument(
      ctx,
      { kind: 'INVOICE', entityId: made.invoice.id },
      await pdf(extraction),
    );
    await runExtraction(system, doc.id);
    return { ...made, doc };
  }

  beforeAll(async () => {
    w = await invoiceWorld();
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('uploads an INVOICE document; the invoice is unchanged until confirm', async () => {
    const { invoice, doc } = await extracted(w.pm);
    expect(doc).toMatchObject({ kind: 'INVOICE', entityId: invoice.id });
    const after = await getInvoice(w.pm, invoice.id);
    expect(after.documentId).toBe(doc.id);
    expect(after).toMatchObject({
      invoiceNumber: invoice.invoiceNumber,
      amountMinor: invoice.amountMinor,
    });

    const view = await getDocument(w.pm, doc.id);
    expect(view).toMatchObject({
      extractionStatus: 'SUCCEEDED',
      kindLabel: 'Invoice',
      entityLabel: `Invoice ${invoice.invoiceNumber}`,
    });
    expect(view.review?.fields.map((f) => f.name)).toEqual([
      'invoiceNumber',
      'invoiceDate',
      'amount',
      'dueDate',
    ]);
    const amount = view.review!.fields.find((f) => f.name === 'amount')!;
    expect(amount).toMatchObject({
      applies: ['amount'],
      fixedCurrency: 'INR',
      suggested: true,
      current: { amount: '50000.00', currency: 'INR' },
    });
    // No due date printed: nothing to suggest.
    expect(view.review!.fields.find((f) => f.name === 'dueDate')!.suggested).toBe(false);
    expect(view.review?.info.map((i) => i.name)).toEqual([
      'clientName',
      'clientGstin',
      'poNumber',
      'currency',
    ]);
    expect(view.review).toMatchObject({ clientMismatch: null, warnings: [] });

    const pending = await listDocumentsPendingReview(w.pm);
    expect(pending.map((d) => d.id)).toContain(doc.id);
  });

  it('confirming applies number, date and amount through updateInvoice, in one request', async () => {
    const number = uniqueInvoiceNumber();
    const { invoice, doc } = await extracted(w.sales, wire({ invoiceNumber: field(number) }), {
      invoiceDate: daysFromToday(-5),
    });
    await confirmExtraction(w.sales, {
      documentId: doc.id,
      apply: { invoiceNumber: number, invoiceDate: daysFromToday(-2), amount: '5,90,000' },
    });
    const after = await getInvoice(w.sales, invoice.id);
    expect(after).toMatchObject({ invoiceNumber: number, amountMinor: 5_90_000_00n });
    expect(ymd(after.invoiceDate)).toBe(daysFromToday(-2));
    // A company-default due date moves with the invoice date (Decision 6).
    expect(ymd(after.dueDate)).toBe(daysFromToday(28));

    const confirmed = await getDocument(w.sales, doc.id);
    expect(confirmed).toMatchObject({ reviewStatus: 'CONFIRMED' });
    expect(confirmed.appliedFields.sort()).toEqual(['amount', 'invoiceDate', 'invoiceNumber']);
    const invoiceRow = (await auditOf('Invoice', invoice.id)).at(-1)!;
    const docRow = (await auditOf('Document', doc.id)).at(-1)!;
    expect(invoiceRow.requestId).toBe(docRow.requestId);
  });

  it('confirming only the invoice date keeps a manual due date, and fails if it would pass it', async () => {
    const { invoice, doc } = await extracted(
      w.sales,
      wire({ invoiceDate: field(daysFromToday(-3)) }),
      { invoiceDate: daysFromToday(-10), dueDate: daysFromToday(-4) },
    );
    const error = await rejection(
      confirmExtraction(w.sales, { documentId: doc.id, apply: { invoiceDate: daysFromToday(-3) } }),
    );
    expect(error).toBeInstanceOf(DomainError);
    expect(fieldOf(error)).toBe('dueDate');
    const unchanged = await getInvoice(w.sales, invoice.id);
    expect(ymd(unchanged.invoiceDate)).toBe(daysFromToday(-10));
    expect((await getDocument(w.sales, doc.id)).reviewStatus).toBe('PENDING');

    const { invoice: kept, doc: keptDoc } = await extracted(
      w.sales,
      wire({ invoiceDate: field(daysFromToday(-8)) }),
      { invoiceDate: daysFromToday(-10), dueDate: daysFromToday(15) },
    );
    await confirmExtraction(w.sales, {
      documentId: keptDoc.id,
      apply: { invoiceDate: daysFromToday(-8) },
    });
    const after = await getInvoice(w.sales, kept.id);
    expect(ymd(after.dueDate)).toBe(daysFromToday(15));
    expect(after.dueDateBasis).toBe('MANUAL');
  });

  it('moves a PO-terms due date with a confirmed invoice date', async () => {
    const { invoice, doc } = await extracted(
      w.sales,
      wire({ invoiceDate: field(daysFromToday(-1)) }),
      { invoiceDate: daysFromToday(-5) },
      { po: { paymentTermsDays: 45 } },
    );
    await confirmExtraction(w.sales, {
      documentId: doc.id,
      apply: { invoiceDate: daysFromToday(-1) },
    });
    const after = await getInvoice(w.sales, invoice.id);
    expect(ymd(after.dueDate)).toBe(daysFromToday(44));
    expect(after.dueDateBasis).toBe('PO_TERMS');
  });

  describe('client, PO and currency warnings', () => {
    it('warns when the billed name differs and there is no GSTIN to decide', async () => {
      const { doc } = await extracted(w.sales, wire({ clientName: field('Initech Corp') }));
      expect((await getDocument(w.sales, doc.id)).review?.clientMismatch).toBe('Initech Corp');
    });

    it('lets GSTIN decide when both the document and the client have one', async () => {
      const gstinClient = (
        await createClient(w.admin, { name: 'Umbrella Labs', sectorId: w.pharma })
      ).id;
      await updateClient(w.admin, gstinClient, { gstin: ACME_GSTIN });

      async function onUmbrella(extraction: WireExtraction) {
        const { purchaseOrder } = await newPurchaseOrder(w, {}, { clientId: gstinClient });
        const { invoice } = await createInvoice(
          w.sales,
          invoiceInput(purchaseOrder.id, w.inspection),
        );
        const doc = await uploadDocument(
          w.sales,
          { kind: 'INVOICE', entityId: invoice.id },
          await pdf(extraction),
        );
        await runExtraction(system, doc.id);
        return (await getDocument(w.sales, doc.id)).review!;
      }

      // Different name, same GSTIN: the same company.
      expect(
        (
          await onUmbrella(
            wire({ clientName: field('UMB Labs India'), clientGstin: field(ACME_GSTIN) }),
          )
        ).clientMismatch,
      ).toBeNull();
      // Same name, different GSTIN: another company.
      expect(
        (
          await onUmbrella(
            wire({ clientName: field('Umbrella Labs'), clientGstin: field(OTHER_GSTIN) }),
          )
        ).clientMismatch,
      ).toBe('Umbrella Labs');
      // A GSTIN that fails the format is dropped, so the name decides.
      expect(
        (
          await onUmbrella(
            wire({ clientName: field('Umbrella Labs'), clientGstin: field('27ABC') }),
          )
        ).clientMismatch,
      ).toBeNull();
    });

    it('warns on a different PO number, ignoring case and spaces', async () => {
      const { purchaseOrder, doc } = await extracted(w.sales, wire({ poNumber: field('9999') }));
      expect((await getDocument(w.sales, doc.id)).review?.warnings).toEqual([
        `The invoice quotes PO 9999, but it is recorded against PO ${purchaseOrder.poNumber}.`,
      ]);
      const poNumber = `PO 4500 ${uniqueInvoiceNumber().slice(-6)}`;
      const same = await extracted(
        w.sales,
        wire({ poNumber: field(` ${poNumber.replaceAll(' ', '').toLowerCase()} `) }),
        {},
        { po: { poNumber } },
      );
      expect((await getDocument(w.sales, same.doc.id)).review?.warnings).toEqual([]);
    });

    it('warns on another currency and leaves the amount unticked', async () => {
      const { doc } = await extracted(
        w.sales,
        wire({ currency: field('USD'), amount: field('7000') }),
      );
      const review = (await getDocument(w.sales, doc.id)).review!;
      expect(review.warnings).toEqual([
        'The invoice is in USD, but its PO is in INR. The amount is not applied unless you tick it.',
      ]);
      expect(review.fields.find((f) => f.name === 'amount')!.suggested).toBe(false);
    });
  });

  it('fails the whole confirm on a duplicate invoice number, writing nothing', async () => {
    const taken = uniqueInvoiceNumber();
    await newInvoice(w, { invoiceNumber: taken });
    const { invoice, doc } = await extracted(w.sales, wire({ invoiceNumber: field(taken) }));
    const before = await getDb().auditLog.count();
    const error = await rejection(
      confirmExtraction(w.sales, {
        documentId: doc.id,
        apply: { invoiceNumber: taken, amount: '5,90,000' },
      }),
    );
    expect(fieldOf(error)).toBe('invoiceNumber');
    expect(await getDb().auditLog.count()).toBe(before);
    expect((await getInvoice(w.sales, invoice.id)).amountMinor).toBe(invoice.amountMinor);
    expect((await getDocument(w.sales, doc.id)).reviewStatus).toBe('PENDING');
  });

  it('normalises the extracted GSTIN', () => {
    const stored = normaliseExtraction(INVOICE_EXTRACTION_FIELDS, {
      ...wire(),
      clientGstin: field(' 27aaaca1234a1z5 '),
    });
    expect(stored.clientGstin).toMatchObject({ value: ACME_GSTIN, confidence: 'high' });
    const bad = normaliseExtraction(INVOICE_EXTRACTION_FIELDS, {
      ...wire(),
      clientGstin: field('GSTIN: 27AAACA'),
    });
    expect(bad.clientGstin).toMatchObject({ value: null, confidence: 'low' });
  });
});
