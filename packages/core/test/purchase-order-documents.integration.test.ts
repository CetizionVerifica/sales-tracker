import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import type { WireExtraction } from '../schemas/extraction.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import {
  confirmExtraction,
  getCurrentDocument,
  getDocument,
  listDocuments,
  listDocumentsPendingReview,
  runExtraction,
  uploadDocument,
} from '../services/document.service.ts';
import {
  getPurchaseOrder,
  restorePurchaseOrder,
  softDeletePurchaseOrder,
} from '../services/purchase-order.service.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { ensureSystemCtx } from './helpers.ts';
import { fieldOf, rejection } from './project-fixtures.ts';
import { newPurchaseOrder, poWorld, type PoWorld } from './purchase-order-fixtures.ts';

const field = (value: string | null, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  value,
  confidence,
  page: 1,
  sourceText: value,
});

const WIRE: WireExtraction = {
  poNumber: field('4500012345'),
  documentDate: field('2026-03-28'),
  clientName: field('Acme Pharma Pvt. Ltd.'),
  amount: field('12,50,000'),
  currency: field('INR'),
  paymentTerms: field('Net 45 days from invoice'),
  paymentTermsDays: field('45'),
};

// AC6: the PURCHASE_ORDER document kind, through the unchanged M7 flow.
describe('AC6: purchase order documents (integration)', () => {
  let w: PoWorld;
  let system: Ctx;
  const mock = createMockExtractor();
  let counter = 0;

  async function pdf(wire?: WireExtraction) {
    const bytes = samplePdf(`po file ${++counter}`);
    if (wire) mock.register(await sha256Hex(bytes), { type: 'result', wire });
    return { bytes, mimeType: 'application/pdf', filename: 'client-po.pdf' };
  }

  /** A PO with an extracted, unreviewed document uploaded by `ctx`. */
  async function extracted(ctx: Ctx, wire: WireExtraction = WIRE) {
    const made = await newPurchaseOrder(w);
    const doc = await uploadDocument(
      ctx,
      { kind: 'PURCHASE_ORDER', entityId: made.purchaseOrder.id },
      await pdf(wire),
    );
    await runExtraction(system, doc.id);
    return { ...made, doc };
  }

  beforeAll(async () => {
    w = await poWorld();
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('the PM uploads a PO document; the PO is unchanged until confirm', async () => {
    const { purchaseOrder, doc } = await extracted(w.pm);
    expect(doc).toMatchObject({ kind: 'PURCHASE_ORDER', entityId: purchaseOrder.id });
    const after = await getPurchaseOrder(w.pm, purchaseOrder.id);
    expect(after.documentId).toBe(doc.id);
    expect(after).toMatchObject({
      poNumber: purchaseOrder.poNumber,
      amountMinor: purchaseOrder.amountMinor,
      paymentTerms: null,
      paymentTermsDays: null,
    });

    const view = await getDocument(w.pm, doc.id);
    expect(view.extractionStatus).toBe('SUCCEEDED');
    expect(view.kindLabel).toBe('Purchase order');
    expect(view.entityLabel).toBe(`PO ${purchaseOrder.poNumber}`);
    expect(view.review?.fields.map((f) => f.name)).toEqual([
      'poNumber',
      'amount',
      'paymentTerms',
      'paymentTermsDays',
    ]);
    expect(view.review?.info.map((i) => i.name)).toEqual(['documentDate', 'clientName']);
    expect(view.review?.clientMismatch).toBeNull();
    expect(view.review?.fields.every((f) => f.suggested)).toBe(true);
    expect((await getCurrentDocument(w.sales, 'PURCHASE_ORDER', purchaseOrder.id))?.id).toBe(
      doc.id,
    );
  });

  it('confirming applies the values through updatePurchaseOrder, in one request', async () => {
    const { purchaseOrder, doc } = await extracted(w.sales);
    await confirmExtraction(w.sales, {
      documentId: doc.id,
      apply: {
        poNumber: '4500012345',
        amount: '12,50,000',
        currency: 'INR',
        paymentTerms: 'Net 45 days from invoice',
        paymentTermsDays: '45',
      },
    });
    const after = await getPurchaseOrder(w.sales, purchaseOrder.id);
    expect(after).toMatchObject({
      poNumber: '4500012345',
      amountMinor: 12_50_000_00n,
      currency: 'INR',
      paymentTerms: 'Net 45 days from invoice',
      paymentTermsDays: 45,
      status: 'PENDING',
    });
    const view = await getDocument(w.sales, doc.id);
    expect(view.reviewStatus).toBe('CONFIRMED');
    expect(view.appliedFields).toEqual([
      'amount',
      'currency',
      'paymentTerms',
      'paymentTermsDays',
      'poNumber',
    ]);
    const rows = await getDb().auditLog.findMany({
      where: {
        OR: [
          { entityType: 'PurchaseOrder', entityId: purchaseOrder.id, action: 'UPDATE' },
          { entityType: 'Document', entityId: doc.id, action: 'UPDATE' },
        ],
      },
    });
    const confirm = rows.find(
      (r) => r.entityType === 'Document' && r.changedFields.includes('reviewStatus'),
    )!;
    const update = rows.find(
      (r) => r.entityType === 'PurchaseOrder' && r.changedFields.includes('poNumber'),
    )!;
    expect(update.requestId).toBe(confirm.requestId);
    expect(update.changedFields).toEqual(
      expect.arrayContaining(['poNumber', 'amountMinor', 'paymentTerms', 'paymentTermsDays']),
    );
  });

  it('a PO number another live PO of the client has fails the whole confirm', async () => {
    const taken = await newPurchaseOrder(w);
    const { purchaseOrder, doc } = await extracted(w.sales, {
      ...WIRE,
      poNumber: field(taken.purchaseOrder.poNumber),
    });
    const error = await rejection(
      confirmExtraction(w.sales, {
        documentId: doc.id,
        apply: {
          poNumber: taken.purchaseOrder.poNumber,
          paymentTerms: 'Net 45 days from invoice',
        },
      }),
    );
    expect(error).toBeInstanceOf(DomainError);
    expect(fieldOf(error)).toBe('poNumber');
    const after = await getPurchaseOrder(w.sales, purchaseOrder.id);
    expect(after.poNumber).toBe(purchaseOrder.poNumber);
    expect(after.paymentTerms).toBeNull();
    expect((await getDocument(w.sales, doc.id)).reviewStatus).toBe('PENDING');
  });

  it('warns when the client on the PO differs from the PO’s client', async () => {
    const { doc } = await extracted(w.sales, { ...WIRE, clientName: field('Globex Ltd') });
    expect((await getDocument(w.sales, doc.id)).review?.clientMismatch).toBe('Globex Ltd');
  });

  it('treats a PO id sent as an INVOICE upload as not found (M10 ships INVOICE)', async () => {
    const { purchaseOrder } = await newPurchaseOrder(w);
    const error = await rejection(
      uploadDocument(w.sales, { kind: 'INVOICE', entityId: purchaseOrder.id }, await pdf()),
    );
    expect(error).toBeInstanceOf(NotFoundError);
  });

  it('another PM or Sales rep gets not found for the PO’s document', async () => {
    const { doc, purchaseOrder } = await extracted(w.pm);
    for (const ctx of [w.pm2, w.sales2]) {
      await expect(getDocument(ctx, doc.id)).rejects.toThrow(NotFoundError);
      await expect(getCurrentDocument(ctx, 'PURCHASE_ORDER', purchaseOrder.id)).rejects.toThrow(
        NotFoundError,
      );
      await expect(
        uploadDocument(ctx, { kind: 'PURCHASE_ORDER', entityId: purchaseOrder.id }, await pdf()),
      ).rejects.toThrow(NotFoundError);
      expect(
        (await listDocuments(ctx, { kind: ['PURCHASE_ORDER'] })).items.map((d) => d.id),
      ).not.toContain(doc.id);
    }
    expect(
      (await listDocuments(w.sales, { kind: ['PURCHASE_ORDER'] })).items.map((d) => d.id),
    ).toContain(doc.id);
  });

  it('lists an unreviewed PO document for review by its pipeline owner and PM', async () => {
    const { doc } = await extracted(w.admin);
    for (const ctx of [w.sales, w.pm]) {
      expect((await listDocumentsPendingReview(ctx)).map((d) => d.id)).toContain(doc.id);
    }
    expect((await listDocumentsPendingReview(w.pm2)).map((d) => d.id)).not.toContain(doc.id);
  });

  it('a deleted PO keeps its document, which is current again after restore', async () => {
    const { doc, purchaseOrder } = await extracted(w.sales);
    await softDeletePurchaseOrder(w.sales, purchaseOrder.id);
    expect((await getPurchaseOrder(w.sales, purchaseOrder.id)).documentId).toBe(doc.id);
    await restorePurchaseOrder(w.sales, purchaseOrder.id);
    expect((await getCurrentDocument(w.sales, 'PURCHASE_ORDER', purchaseOrder.id))?.id).toBe(
      doc.id,
    );
  });
});
