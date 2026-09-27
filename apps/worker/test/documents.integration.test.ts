import {
  convertEnquiry,
  createClient,
  createEnquiry,
  createQuotation,
  createSector,
  createService,
  disconnectAll,
  EXTRACT_JOB,
  getDocument,
  getDocumentsQueue,
  setDocumentDeps,
  updateSettings,
  uploadDocument,
  type Ctx,
} from '@sales-tracker/core';
import { resetDb } from '../../../packages/db/test-utils/reset.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../packages/core/clients.ts';
import { createMockExtractor } from '../../../packages/core/extraction/mock.ts';
import { createMemoryFileStore } from '../../../packages/core/storage/memory.ts';
import { ensureCompanySettings } from '../../../packages/core/system/seed.ts';
import { samplePdf, sha256Hex } from '../../../packages/core/test/documents/files.ts';
import {
  actor,
  createTestUser,
  ctxFor,
  ensureSystemCtx,
} from '../../../packages/core/test/helpers.ts';
import { startWorker } from '../src/worker.ts';

// AC3 end to end: a queued extraction runs in the real BullMQ worker, and a 429 is retried
// by BullMQ (short backoff here instead of the 30 s default).

describe('documents worker (integration: real Redis, mock extractor)', () => {
  let sales: Ctx;
  let quotationId: string;
  const mock = createMockExtractor();
  let worker: Awaited<ReturnType<typeof startWorker>>;

  beforeAll(async () => {
    await resetDb(getDb());
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    await ensureSystemCtx();
    const admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    sales = ctxFor(
      actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }),
    );
    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR'],
    });
    const sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    const serviceId = (await createService(admin, { name: 'Inspection' })).id;
    const clientId = (await createClient(admin, { name: 'Acme', sectorId })).id;
    const enquiry = await createEnquiry(sales, {
      clientId,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'EMAIL',
    });
    await convertEnquiry(sales, { id: enquiry.id });
    quotationId = (
      await createQuotation(sales, {
        enquiryId: enquiry.id,
        quotationDate: '2026-03-12',
        amount: '10',
        currency: 'INR',
        sectorId,
        serviceIds: [serviceId],
        nextFollowUpDate: '2026-03-20',
      })
    ).id;
    worker = await startWorker({ sweep: false });
  });
  afterAll(async () => {
    await worker?.close();
    await disconnectAll();
  });

  it('retries a rate-limited extraction and then stores the result', async () => {
    const bytes = samplePdf('worker retry');
    const sha = await sha256Hex(bytes);
    mock.register(sha, {
      type: 'retryable',
      times: 1,
      then: {
        type: 'result',
        wire: { amount: { value: '99.00', confidence: 'high', page: 1, sourceText: '99' } },
      },
    });
    const queue = getDocumentsQueue();
    await queue.pause(); // hold the upload's job so its backoff can be shortened
    const doc = await uploadDocument(
      sales,
      { kind: 'QUOTATION', entityId: quotationId },
      {
        bytes,
        mimeType: 'application/pdf',
        filename: 'q.pdf',
      },
    );
    await (await queue.getJob(doc.id))?.remove();
    await queue.add(
      EXTRACT_JOB,
      { documentId: doc.id },
      {
        jobId: doc.id,
        attempts: 3,
        backoff: { type: 'fixed', delay: 50 },
      },
    );
    await queue.resume();

    await expect
      .poll(async () => (await getDocument(sales, doc.id)).extractionStatus, { timeout: 15_000 })
      .toBe('SUCCEEDED');
    expect((await getDocument(sales, doc.id)).extractionAttempts).toBe(2);
    expect(mock.calls.filter((c) => c.sha256 === sha)).toHaveLength(2);
  });
});
