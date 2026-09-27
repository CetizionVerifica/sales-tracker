import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { ForbiddenError } from '../errors.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor, type MockBehaviour } from '../extraction/mock.ts';
import { closeDocumentsQueue, getDocumentsQueue } from '../extraction/queue.ts';
import type { WireExtraction } from '../schemas/extraction.ts';
import { createClient } from '../services/client.service.ts';
import {
  confirmExtraction,
  runExtraction,
  softDeleteDocument,
  sweepStuckDocuments,
  uploadDocument,
} from '../services/document.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import { createQuotation } from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from './helpers.ts';

const WIRE: WireExtraction = {
  amount: { value: '100.00', confidence: 'high', page: 1, sourceText: 'Total 100' },
  currency: { value: 'INR', confidence: 'high', page: 1, sourceText: 'INR' },
};

describe('document jobs: AC10 robustness (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let system: Ctx;
  let pharma: string;
  let inspection: string;
  let acme: string;
  const mock = createMockExtractor();
  let counter = 0;

  async function uploaded(behaviour: MockBehaviour = { type: 'result', wire: WIRE }) {
    const enquiry = await createEnquiry(sales, {
      clientId: acme,
      sectorId: pharma,
      serviceIds: [inspection],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'EMAIL',
    });
    await convertEnquiry(sales, { id: enquiry.id });
    const q = await createQuotation(sales, {
      enquiryId: enquiry.id,
      quotationDate: '2026-03-12',
      amount: '10',
      currency: 'INR',
      sectorId: pharma,
      serviceIds: [inspection],
      nextFollowUpDate: '2026-03-20',
    });
    const bytes = samplePdf(`worker ${++counter}`);
    mock.register(await sha256Hex(bytes), behaviour);
    return uploadDocument(
      sales,
      { kind: 'QUOTATION', entityId: q.id },
      {
        bytes,
        mimeType: 'application/pdf',
        filename: 'q.pdf',
      },
    );
  }

  const statusOf = async (id: string) =>
    (await getDb().document.findFirstOrThrow({ where: { id, deletedAt: undefined } }))
      .extractionStatus;

  beforeAll(async () => {
    await resetDb(getDb());
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    await getDocumentsQueue().obliterate({ force: true });
    system = await ensureSystemCtx();
    const user = async (email: string, role: 'ADMIN' | 'SALES') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR'],
    });
    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    inspection = (await createService(admin, { name: 'Inspection' })).id;
    acme = (await createClient(admin, { name: 'Acme', sectorId: pharma })).id;
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  it('the sweeper re-queues a document left QUEUED with no job', async () => {
    const doc = await uploaded();
    await (await getDocumentsQueue().getJob(doc.id))?.remove(); // the enqueue "failed"
    expect(await sweepStuckDocuments(system)).not.toContain(doc.id); // not stale yet
    const later = new Date(Date.now() + 6 * 60_000);
    expect(await sweepStuckDocuments(system, later)).toContain(doc.id);
    expect(await getDocumentsQueue().getJob(doc.id)).toBeDefined();
  });

  it('the sweeper puts a document RUNNING past the timeout back to QUEUED', async () => {
    let release!: (b: MockBehaviour) => void;
    const doc = await uploaded({ type: 'hang', release: new Promise((r) => (release = r)) });
    const job = runExtraction(system, doc.id); // the worker "dies" while this hangs
    await expect.poll(() => statusOf(doc.id)).toBe('RUNNING');

    expect(await sweepStuckDocuments(system, new Date(Date.now() + 10 * 60_000))).not.toContain(
      doc.id,
    );
    expect(await sweepStuckDocuments(system, new Date(Date.now() + 16 * 60_000))).toContain(doc.id);
    expect(await statusOf(doc.id)).toBe('QUEUED');
    const reset = await getDb().auditLog.findFirst({
      where: { entityType: 'Document', entityId: doc.id, action: 'UPDATE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(reset).toMatchObject({ source: 'system', actorId: system.user.id });
    expect((reset?.after as { extractionStatus?: string }).extractionStatus).toBe('QUEUED');

    // The stale run finishing later cannot overwrite the re-queued state.
    release({ type: 'result', wire: WIRE });
    await job;
    expect(await statusOf(doc.id)).toBe('QUEUED');
    await runExtraction(system, doc.id);
    expect(await statusOf(doc.id)).toBe('SUCCEEDED');
  });

  it('two workers racing for one job: exactly one calls the extractor', async () => {
    let release!: (b: MockBehaviour) => void;
    const doc = await uploaded({ type: 'hang', release: new Promise((r) => (release = r)) });
    const before = mock.calls.length;
    const first = runExtraction(system, doc.id);
    const second = runExtraction(system, doc.id);
    await expect.poll(() => mock.calls.length).toBe(before + 1);
    release({ type: 'result', wire: WIRE });
    const results = await Promise.all([first, second]);
    expect(results.sort()).toEqual(['done', 'skipped']);
    expect(mock.calls.length).toBe(before + 1);
  });

  it('only the system actor may sweep: web callers and non-admins are refused', async () => {
    const posing = { ...sales, source: 'system' as const };
    for (const ctx of [sales, admin, posing]) {
      await expect(sweepStuckDocuments(ctx)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it('a job for a deleted or confirmed document does nothing', async () => {
    const deleted = await uploaded();
    await softDeleteDocument(sales, deleted.id);
    const confirmed = await uploaded();
    await runExtraction(system, confirmed.id);
    await confirmExtraction(sales, { documentId: confirmed.id, apply: {} });

    const before = mock.calls.length;
    expect(await runExtraction(system, deleted.id)).toBe('skipped');
    expect(await runExtraction(system, confirmed.id)).toBe('skipped');
    expect(mock.calls.length).toBe(before);
    expect(await sweepStuckDocuments(system, new Date(Date.now() + 60 * 60_000))).not.toContain(
      confirmed.id,
    );
  });
});
