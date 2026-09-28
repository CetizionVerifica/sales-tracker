import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor, type MockBehaviour } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import { EXTRACTION_MESSAGES } from '../extraction/types.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { UploadedFile } from '../schemas/document.ts';
import type { WireExtraction } from '../schemas/extraction.ts';
import { createClient } from '../services/client.service.ts';
import {
  confirmExtraction,
  getCurrentDocument,
  getDocument,
  getDocumentFile,
  listDocuments,
  listDocumentsPendingReview,
  restoreDocument,
  retryExtraction,
  runExtraction,
  softDeleteDocument,
  uploadDocument,
} from '../services/document.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getQuotation,
  softDeleteQuotation,
} from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { getSettings, updateSettings } from '../services/settings.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { samplePdf, samplePng, sha256Hex } from './documents/files.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from './helpers.ts';

const fieldOf = (e: unknown) => (e instanceof DomainError ? e.field : undefined);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const auditOf = (entityType: string, entityId: string) =>
  getDb().auditLog.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'asc' } });

const field = (value: string | null, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  value,
  confidence,
  page: 1,
  sourceText: value,
});

const WIRE: WireExtraction = {
  documentNumber: field('ACME/Q/91'),
  documentDate: field('2026-03-11'),
  clientName: field('Acme Pharma Pvt. Ltd.'),
  amount: field('2,50,000.00'),
  currency: field('INR'),
  scopeSummary: field('Annual GMP inspection of two plants'),
};

describe('documents (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let system: Ctx;
  let pharma: string;
  let inspection: string;
  let acme: string;
  const mock = createMockExtractor();
  const store = createMemoryFileStore();
  let fileCounter = 0;

  /** A unique PDF, optionally with a mock behaviour for its hash. */
  async function pdf(behaviour?: MockBehaviour, name = 'quote.pdf'): Promise<UploadedFile> {
    const bytes = samplePdf(`file ${++fileCounter}`);
    if (behaviour) mock.register(await sha256Hex(bytes), behaviour);
    return { bytes, mimeType: 'application/pdf', filename: name };
  }

  async function quotation(ctx: Ctx = sales) {
    const enquiry = await createEnquiry(ctx, {
      clientId: acme,
      sectorId: pharma,
      serviceIds: [inspection],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'EMAIL',
    });
    await convertEnquiry(ctx, { id: enquiry.id });
    return createQuotation(ctx, {
      enquiryId: enquiry.id,
      quotationDate: '2026-03-12',
      amount: '1,25,000.50',
      currency: 'INR',
      sectorId: pharma,
      serviceIds: [inspection],
      nextFollowUpDate: '2026-03-20',
    });
  }

  /** Upload + run the job, as the worker would. */
  async function extracted(
    ctx: Ctx = sales,
    behaviour: MockBehaviour = { type: 'result', wire: WIRE },
  ) {
    const q = await quotation(ctx);
    const doc = await uploadDocument(
      ctx,
      { kind: 'QUOTATION', entityId: q.id },
      await pdf(behaviour),
    );
    await runExtraction(system, doc.id);
    return { q, doc: await getDocument(ctx, doc.id) };
  }

  beforeAll(async () => {
    await resetDb(getDb());
    setDocumentDeps({ extractor: mock, fileStore: store });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();
    const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    pm = await user('pm@example.test', 'PROJECT_MANAGER');
    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR', 'USD', 'JPY'],
    });
    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    inspection = (await createService(admin, { name: 'Inspection' })).id;
    acme = (await createClient(admin, { name: 'Acme Pharma Private Limited', sectorId: pharma }))
      .id;
  });
  beforeEach(() => {
    mock.calls.length = 0;
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  describe('AC1: upload', () => {
    it('stores the file, attaches it to the quotation, queues one job and audits both writes', async () => {
      const q = await quotation();
      const file = await pdf();
      const doc = await uploadDocument(sales, { kind: 'QUOTATION', entityId: q.id }, file);

      const row = await getDb().document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row).toMatchObject({
        kind: 'QUOTATION',
        entityId: q.id,
        clientId: acme,
        uploadedById: sales.user.id,
        originalFilename: 'quote.pdf',
        mimeType: 'application/pdf',
        sizeBytes: file.bytes.length,
        sha256: await sha256Hex(file.bytes),
        extractionStatus: 'QUEUED',
        reviewStatus: 'PENDING',
      });
      expect(store.files.has(row.storageKey)).toBe(true);
      expect((await getQuotation(sales, q.id)).documentId).toBe(doc.id);

      const job = await getDocumentsQueue().getJob(doc.id);
      expect(job?.data).toEqual({ documentId: doc.id });

      const [created] = await auditOf('Document', doc.id);
      const quotationRows = await auditOf('Quotation', q.id);
      const linked = quotationRows.at(-1)!;
      expect(created).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      expect(linked).toMatchObject({ action: 'UPDATE', changedFields: ['documentId'] });
      expect(linked.requestId).toBe(created!.requestId);
    });

    it('accepts images', async () => {
      const q = await quotation();
      const doc = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        { bytes: samplePng('scan'), mimeType: 'image/png', filename: 'scan.png' },
      );
      expect(doc.mimeType).toBe('image/png');
    });
  });

  describe('AC2: validation', () => {
    let quotationId: string;
    beforeAll(async () => {
      quotationId = (await quotation()).id;
    });
    const upload = (
      file: Partial<UploadedFile>,
      kind: 'QUOTATION' | 'PURCHASE_ORDER' | 'INVOICE' = 'QUOTATION',
      entityId = quotationId,
    ) =>
      uploadDocument(
        sales,
        { kind, entityId },
        {
          bytes: samplePdf('x'),
          mimeType: 'application/pdf',
          filename: 'a.pdf',
          ...file,
        },
      );

    it.each([
      [
        'a .docx',
        { mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
      ],
      ['a HEIC photo', { mimeType: 'image/heic' }],
      ['an empty file', { bytes: new Uint8Array() }],
      ['a PNG named .pdf', { bytes: samplePng() }],
      ['a file over the size limit', { bytes: new Uint8Array(21 * 1024 * 1024).fill(0x25) }],
    ] as const)('rejects %s on the file field', async (_name, file) => {
      expect(fieldOf(await rejection(upload(file)))).toBe('file');
    });

    it('rejects an unknown or soft-deleted quotation as not found', async () => {
      expect(await rejection(upload({}, 'QUOTATION', 'no-such-id'))).toBeInstanceOf(NotFoundError);
      const gone = await quotation();
      await softDeleteQuotation(sales, gone.id);
      expect(await rejection(upload({}, 'QUOTATION', gone.id))).toBeInstanceOf(NotFoundError);
    });

    // PURCHASE_ORDER shipped with M9 (purchase-order-documents.integration.test.ts).
    it.each(['INVOICE'] as const)('rejects %s until its module ships', async (kind) => {
      expect(fieldOf(await rejection(upload({}, kind)))).toBe('kind');
    });

    it('writes nothing when rejected', async () => {
      const before = await getDb().document.count();
      await rejection(upload({ bytes: samplePng() }));
      expect(await getDb().document.count()).toBe(before);
    });
  });

  describe('AC3: extraction', () => {
    it('stores the validated extraction and never touches the quotation', async () => {
      const q = await quotation();
      const doc = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf({ type: 'result', wire: WIRE }),
      );
      const quotationAudit = (await auditOf('Quotation', q.id)).length;

      await runExtraction(system, doc.id);

      const row = await getDb().document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row).toMatchObject({
        extractionStatus: 'SUCCEEDED',
        extractionModel: 'mock-extractor',
        extractionAttempts: 1,
      });
      expect(row.extractedAt).toBeInstanceOf(Date);
      expect(row.extraction).toMatchObject({ amount: { value: '250000.00', confidence: 'high' } });
      expect(await auditOf('Quotation', q.id)).toHaveLength(quotationAudit);
      const [, update] = await auditOf('Document', doc.id);
      expect(update).toMatchObject({ action: 'UPDATE', source: 'system' });
    });

    it.each([
      ['a schema mismatch', EXTRACTION_MESSAGES.unreadable],
      ['a refusal', EXTRACTION_MESSAGES.refused],
      ['a 400', EXTRACTION_MESSAGES.rejected],
    ])('%s ends FAILED with a user-safe message and no extraction', async (_name, message) => {
      const q = await quotation();
      const doc = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf({ type: 'fail', message }),
      );
      await runExtraction(system, doc.id);
      const row = await getDb().document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row).toMatchObject({
        extractionStatus: 'FAILED',
        extractionError: message,
        extraction: null,
      });
    });

    it('a retryable error goes back to QUEUED for BullMQ, then succeeds on the next attempt', async () => {
      const q = await quotation();
      const doc = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf({ type: 'retryable', times: 1, then: { type: 'result', wire: WIRE } }),
      );
      await expect(runExtraction(system, doc.id, { attempt: 1, maxAttempts: 3 })).rejects.toThrow();
      expect(
        (await getDb().document.findUniqueOrThrow({ where: { id: doc.id } })).extractionStatus,
      ).toBe('QUEUED');
      await runExtraction(system, doc.id, { attempt: 2, maxAttempts: 3 });
      expect(await getDb().document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({
        extractionStatus: 'SUCCEEDED',
        extractionAttempts: 2,
      });
    });

    it('a retryable error on the last attempt ends FAILED', async () => {
      const q = await quotation();
      const doc = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf({ type: 'retryable', times: 5, then: { type: 'result', wire: WIRE } }),
      );
      await runExtraction(system, doc.id, { attempt: 3, maxAttempts: 3 });
      expect(await getDb().document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({
        extractionStatus: 'FAILED',
        extractionError: EXTRACTION_MESSAGES.unavailable,
      });
    });

    it('only the system context may run a job', async () => {
      const { doc } = await extracted();
      expect(await rejection(runExtraction(sales, doc.id))).toBeInstanceOf(ForbiddenError);
    });
  });

  describe('AC4: the "done when": nothing reaches the quotation without confirmation', () => {
    it('reads, retries and repeated jobs leave the quotation as it was', async () => {
      const { q, doc } = await extracted();
      const before = await getQuotation(sales, q.id);
      await getDocument(sales, doc.id);
      await retryExtraction(sales, doc.id);
      await runExtraction(system, doc.id);
      await runExtraction(system, doc.id); // a second job run for the same document
      const after = await getQuotation(sales, q.id);
      expect(after.amountMinor).toBe(before.amountMinor);
      expect(after.quotationDate).toEqual(before.quotationDate);
      expect(after.description).toBe(before.description);
      expect(after.updatedAt).toEqual(before.updatedAt);
    });
  });

  describe('AC5: confirm', () => {
    it('applies the ticked values through updateQuotation and marks the document reviewed', async () => {
      const { q, doc } = await extracted();
      const result = await confirmExtraction(sales, {
        documentId: doc.id,
        apply: { amount: '2,40,000.00', currency: 'INR', quotationDate: '2026-03-11' },
      });

      const updated = await getQuotation(sales, q.id);
      expect(updated.amountMinor).toBe(24000000n); // the corrected value, not the extracted one
      expect(toCalendarDateString(updated.quotationDate)).toBe('2026-03-11');
      expect(result).toMatchObject({ reviewStatus: 'CONFIRMED' });
      const row = await getDb().document.findUniqueOrThrow({ where: { id: doc.id } });
      expect(row).toMatchObject({ reviewStatus: 'CONFIRMED', reviewedById: sales.user.id });
      expect([...row.appliedFields].sort()).toEqual(['amount', 'currency', 'quotationDate']);

      const quotationUpdate = (await auditOf('Quotation', q.id)).at(-1)!;
      const documentUpdate = (await auditOf('Document', doc.id)).at(-1)!;
      expect(quotationUpdate).toMatchObject({ action: 'UPDATE', source: 'web' });
      expect(quotationUpdate.changedFields).toEqual(
        expect.arrayContaining(['amountMinor', 'quotationDate']),
      );
      expect(documentUpdate.changedFields).toEqual(expect.arrayContaining(['reviewStatus']));
      expect(documentUpdate.requestId).toBe(quotationUpdate.requestId);
    });

    it('"confirm without changes" leaves the quotation alone', async () => {
      const { q, doc } = await extracted();
      const before = await getQuotation(sales, q.id);
      await confirmExtraction(sales, { documentId: doc.id, apply: {} });
      expect((await getQuotation(sales, q.id)).updatedAt).toEqual(before.updatedAt);
      expect(await getDb().document.findUniqueOrThrow({ where: { id: doc.id } })).toMatchObject({
        reviewStatus: 'CONFIRMED',
        appliedFields: [],
      });
    });

    it('applies the description to a closed quotation', async () => {
      const { q, doc } = await extracted();
      await changeQuotationStatus(sales, { id: q.id, to: 'LOST', lostReason: 'Price' });
      await confirmExtraction(sales, {
        documentId: doc.id,
        apply: { description: 'Scope from PDF' },
      });
      expect((await getQuotation(sales, q.id)).description).toBe('Scope from PDF');
    });
  });

  describe('AC6: confirm rules', () => {
    async function expectNothingChanged(qId: string, docId: string, run: () => Promise<unknown>) {
      const before = await getQuotation(admin, qId);
      const docBefore = await getDb().document.findFirstOrThrow({
        where: { id: docId, deletedAt: undefined },
      });
      const error = await rejection(run());
      expect((await getQuotation(admin, qId)).updatedAt).toEqual(before.updatedAt);
      const docAfter = await getDb().document.findFirstOrThrow({
        where: { id: docId, deletedAt: undefined },
      });
      expect(docAfter.updatedAt).toEqual(docBefore.updatedAt);
      return error;
    }

    it('rejects a document that is no longer the current one', async () => {
      const { q, doc } = await extracted();
      await uploadDocument(sales, { kind: 'QUOTATION', entityId: q.id }, await pdf());
      // Replaced: soft deleted, so not found.
      expect(
        await rejection(confirmExtraction(sales, { documentId: doc.id, apply: {} })),
      ).toBeInstanceOf(NotFoundError);
      // Restored while another is current: live but not current.
      await restoreDocument(sales, doc.id);
      const error = await rejection(confirmExtraction(sales, { documentId: doc.id, apply: {} }));
      expect(error).toBeInstanceOf(DomainError);
    });

    it('rejects an already confirmed or still running document', async () => {
      const { q, doc } = await extracted();
      await confirmExtraction(sales, { documentId: doc.id, apply: {} });
      await expectNothingChanged(q.id, doc.id, () =>
        confirmExtraction(sales, { documentId: doc.id, apply: {} }),
      );

      const q2 = await quotation();
      const queued = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q2.id },
        await pdf(),
      );
      expect(
        await rejection(confirmExtraction(sales, { documentId: queued.id, apply: {} })),
      ).toBeInstanceOf(DomainError);
    });

    it('rejects a soft-deleted document as not found', async () => {
      const { doc } = await extracted();
      await softDeleteDocument(sales, doc.id);
      expect(
        await rejection(confirmExtraction(sales, { documentId: doc.id, apply: {} })),
      ).toBeInstanceOf(NotFoundError);
    });

    it.each([
      ['a future date', { quotationDate: '2099-01-01' }, 'quotationDate'],
      ['a disabled currency', { amount: '10', currency: 'EUR' }, 'currency'],
      ['too many decimals', { amount: '10.123', currency: 'INR' }, 'amount'],
      ['an amount without its currency', { amount: '10' }, 'amount'],
      ['a field the kind does not map', { number: 'QUO-1' }, 'number'],
    ] as const)('rejects %s and writes nothing', async (_name, apply, fieldName) => {
      const { q, doc } = await extracted();
      const error = await expectNothingChanged(q.id, doc.id, () =>
        confirmExtraction(sales, { documentId: doc.id, apply }),
      );
      const fields =
        error instanceof DomainError
          ? [error.field]
          : Object.keys(z.flattenError(error as z.ZodError).fieldErrors);
      expect(fields).toContain(fieldName);
    });

    it.each(['PO_RECEIVED', 'LOST'] as const)('rejects an amount on a %s quotation', async (to) => {
      const { q, doc } = await extracted();
      await changeQuotationStatus(
        sales,
        to === 'LOST'
          ? { id: q.id, to, lostReason: 'Price' }
          : { id: q.id, to, poReceivedDate: toCalendarDateString(todayInIST()) },
      );
      const error = await expectNothingChanged(q.id, doc.id, () =>
        confirmExtraction(sales, { documentId: doc.id, apply: { amount: '1', currency: 'INR' } }),
      );
      expect(fieldOf(error)).toBe('amount');
    });
  });

  describe('AC7: RBAC', () => {
    it("another rep cannot see or change a rep's documents", async () => {
      const { q, doc } = await extracted(sales);
      expect(await rejection(getDocument(sales2, doc.id))).toBeInstanceOf(NotFoundError);
      expect(await rejection(getDocumentFile(sales2, doc.id))).toBeInstanceOf(NotFoundError);
      expect(
        await rejection(uploadDocument(sales2, { kind: 'QUOTATION', entityId: q.id }, await pdf())),
      ).toBeInstanceOf(NotFoundError);
      expect(await rejection(retryExtraction(sales2, doc.id))).toBeInstanceOf(NotFoundError);
      expect(
        await rejection(confirmExtraction(sales2, { documentId: doc.id, apply: {} })),
      ).toBeInstanceOf(NotFoundError);
      expect(await rejection(softDeleteDocument(sales2, doc.id))).toBeInstanceOf(NotFoundError);
      expect((await listDocuments(sales2, {})).items.map((d) => d.id)).not.toContain(doc.id);
    });

    it('project managers see no documents on quotations without a project of theirs (M8; see project-rbac)', async () => {
      const { doc } = await extracted(sales);
      expect(await rejection(getDocument(pm, doc.id))).toBeInstanceOf(NotFoundError);
      expect((await listDocuments(pm, {})).total).toBe(0);
    });

    it('admins can view, confirm and delete any document', async () => {
      const { doc } = await extracted(sales);
      expect((await getDocument(admin, doc.id)).id).toBe(doc.id);
      expect((await listDocuments(admin, {})).items.map((d) => d.id)).toContain(doc.id);
      await confirmExtraction(admin, { documentId: doc.id, apply: {} });
      await softDeleteDocument(admin, doc.id);
    });

    it('reading a file needs read access and returns the bytes from a store without URLs', async () => {
      const { doc } = await extracted(sales);
      const file = await getDocumentFile(sales, doc.id);
      expect(file).toMatchObject({
        type: 'bytes',
        mimeType: 'application/pdf',
        filename: 'quote.pdf',
      });
    });
  });

  describe('AC8: replace and delete', () => {
    it('a new upload replaces the current document and soft-deletes the old one', async () => {
      const { q, doc: first } = await extracted();
      const second = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf(),
      );
      expect((await getQuotation(sales, q.id)).documentId).toBe(second.id);
      expect((await auditOf('Document', first.id)).at(-1)).toMatchObject({ action: 'SOFT_DELETE' });
      expect(await getCurrentDocument(sales, 'QUOTATION', q.id)).toMatchObject({ id: second.id });
    });

    it('deleting clears the quotation; restoring makes it current again when empty', async () => {
      const { q, doc } = await extracted();
      await softDeleteDocument(sales, doc.id);
      expect((await getQuotation(sales, q.id)).documentId).toBeNull();
      expect(await getCurrentDocument(sales, 'QUOTATION', q.id)).toBeNull();
      await restoreDocument(sales, doc.id);
      expect((await getQuotation(sales, q.id)).documentId).toBe(doc.id);
    });

    it('restoring does not replace a newer current document', async () => {
      const { q, doc: first } = await extracted();
      const second = await uploadDocument(
        sales,
        { kind: 'QUOTATION', entityId: q.id },
        await pdf(),
      );
      await restoreDocument(sales, first.id);
      expect((await getQuotation(sales, q.id)).documentId).toBe(second.id);
    });
  });

  describe('RBAC and audit for the remaining service functions', () => {
    it('restoreDocument: another rep gets not found; a restore writes a RESTORE row', async () => {
      const { doc } = await extracted(sales);
      await softDeleteDocument(sales, doc.id);
      expect(await rejection(restoreDocument(sales2, doc.id))).toBeInstanceOf(NotFoundError);
      await restoreDocument(sales, doc.id);
      expect((await auditOf('Document', doc.id)).at(-1)).toMatchObject({
        action: 'RESTORE',
        source: 'web',
        actorId: sales.user.id,
      });
    });

    it('retryExtraction: queues again with an audited UPDATE', async () => {
      const { doc } = await extracted(sales);
      await retryExtraction(sales, doc.id);
      const row = (await auditOf('Document', doc.id)).at(-1)!;
      expect(row).toMatchObject({ action: 'UPDATE', source: 'web', actorId: sales.user.id });
      expect(row.changedFields).toEqual(expect.arrayContaining(['extractionStatus', 'extraction']));
    });

    it('getCurrentDocument: another rep gets not found for the record', async () => {
      const { q } = await extracted(sales);
      expect(await rejection(getCurrentDocument(sales2, 'QUOTATION', q.id))).toBeInstanceOf(
        NotFoundError,
      );
      expect(await rejection(getCurrentDocument(pm, 'QUOTATION', q.id))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('runExtraction: a non-admin with a system source is refused by can()', async () => {
      const { doc } = await extracted(sales);
      const posing = { ...sales, source: 'system' as const };
      expect(await rejection(runExtraction(posing, doc.id))).toBeInstanceOf(ForbiddenError);
    });
  });

  describe('AC9: extraction turned off', () => {
    it('skips extraction, queues nothing, and "Try again" queues it once turned back on', async () => {
      const current = await getSettings(admin);
      const settings = {
        companyName: current.companyName,
        defaultInvoiceDueDays: current.defaultInvoiceDueDays,
        enabledCurrencies: current.enabledCurrencies,
      };
      await updateSettings(admin, { ...settings, documentExtractionEnabled: false });
      try {
        const q = await quotation();
        const doc = await uploadDocument(sales, { kind: 'QUOTATION', entityId: q.id }, await pdf());
        expect(doc.extractionStatus).toBe('SKIPPED');
        expect(await getDocumentsQueue().getJob(doc.id)).toBeUndefined();

        await updateSettings(admin, { ...settings, documentExtractionEnabled: true });
        await retryExtraction(sales, doc.id);
        expect((await getDocument(sales, doc.id)).extractionStatus).toBe('QUEUED');
        expect(await getDocumentsQueue().getJob(doc.id)).toBeDefined();
        expect(mock.calls).toHaveLength(0);
      } finally {
        await updateSettings(admin, { ...settings, documentExtractionEnabled: true });
      }
    });

    it('a job for a document uploaded while off, run after turning off again, does not call the extractor', async () => {
      const current = await getSettings(admin);
      const settings = {
        companyName: current.companyName,
        defaultInvoiceDueDays: current.defaultInvoiceDueDays,
        enabledCurrencies: current.enabledCurrencies,
      };
      const q = await quotation();
      const doc = await uploadDocument(sales, { kind: 'QUOTATION', entityId: q.id }, await pdf());
      await updateSettings(admin, { ...settings, documentExtractionEnabled: false });
      try {
        await runExtraction(system, doc.id);
        expect(mock.calls).toHaveLength(0);
        expect((await getDocument(sales, doc.id)).extractionStatus).toBe('QUEUED');
      } finally {
        await updateSettings(admin, { ...settings, documentExtractionEnabled: true });
      }
    });
  });

  describe('review view and the client check (AC11 in context)', () => {
    it('lists each review field with extracted and current values, and warns on a client mismatch', async () => {
      const matching = await extracted();
      expect(matching.doc.review?.clientMismatch).toBeNull();
      const amount = matching.doc.review!.fields.find((f) => f.name === 'amount')!;
      expect(amount).toMatchObject({
        extracted: { amount: { value: '250000.00' }, currency: { value: 'INR' } },
        current: { amount: '125000.50', currency: 'INR' },
        lockedReason: null,
        suggested: true,
      });

      const other = await extracted(sales, {
        type: 'result',
        wire: { ...WIRE, clientName: field('Globex Ltd') },
      });
      expect(other.doc.review?.clientMismatch).toBe('Globex Ltd');
    });

    it('does not suggest low-confidence or unchanged values, and locks closed fields', async () => {
      const { q, doc } = await extracted(sales, {
        type: 'result',
        wire: { ...WIRE, amount: field('125000.50'), documentDate: field('2026-03-11', 'low') },
      });
      const byName = Object.fromEntries(doc.review!.fields.map((f) => [f.name, f]));
      expect(byName.amount?.suggested).toBe(false); // same as the current value
      expect(byName.quotationDate?.suggested).toBe(false); // low confidence
      expect(byName.description?.suggested).toBe(true);

      await changeQuotationStatus(sales, { id: q.id, to: 'LOST', lostReason: 'Price' });
      const locked = await getDocument(sales, doc.id);
      expect(locked.review!.fields.find((f) => f.name === 'amount')?.lockedReason).toMatch(
        /keeps its amount/,
      );
    });
  });

  describe('lists', () => {
    it('pending review lists the reviewer’s extracted, unreviewed documents only', async () => {
      const { doc } = await extracted(sales);
      const pending = await listDocumentsPendingReview(sales);
      expect(pending.map((d) => d.id)).toContain(doc.id);
      await confirmExtraction(sales, { documentId: doc.id, apply: {} });
      expect((await listDocumentsPendingReview(sales)).map((d) => d.id)).not.toContain(doc.id);
      expect((await listDocumentsPendingReview(sales2)).map((d) => d.id)).not.toContain(doc.id);
    });

    it('filters by status and record, and shows deleted ones only under "deleted"', async () => {
      const { q, doc } = await extracted(sales);
      const byRecord = await listDocuments(sales, { entityId: q.id });
      expect(byRecord.items.map((d) => d.id)).toEqual([doc.id]);
      expect(
        (await listDocuments(sales, { reviewStatus: 'CONFIRMED', entityId: q.id })).total,
      ).toBe(0);
      await softDeleteDocument(sales, doc.id);
      expect((await listDocuments(sales, { entityId: q.id })).total).toBe(0);
      expect((await listDocuments(sales, { entityId: q.id, recordStatus: 'deleted' })).total).toBe(
        1,
      );
    });
  });
});
