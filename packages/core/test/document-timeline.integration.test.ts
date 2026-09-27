import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { setDocumentDeps } from '../extraction/deps.ts';
import { createMockExtractor } from '../extraction/mock.ts';
import { closeDocumentsQueue } from '../extraction/queue.ts';
import { createClient } from '../services/client.service.ts';
import {
  confirmExtraction,
  getCurrentDocument,
  restoreDocument,
  runExtraction,
  softDeleteDocument,
  uploadDocument,
} from '../services/document.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import { createQuotation } from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { samplePdf, sha256Hex } from './documents/files.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx } from './helpers.ts';

// AC12: document events on the client timeline, scoped by the record, never with values.

describe('document events on the timeline (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let acme: string;
  let quotationId: string;
  let enquiryId: string;
  const mock = createMockExtractor();

  beforeAll(async () => {
    await resetDb(getDb());
    setDocumentDeps({ extractor: mock, fileStore: createMemoryFileStore() });
    const system = await ensureSystemCtx();
    const user = async (email: string, role: 'ADMIN' | 'SALES') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR'],
    });
    const sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    const serviceId = (await createService(admin, { name: 'Inspection' })).id;
    acme = (await createClient(admin, { name: 'Acme', sectorId })).id;
    const enquiry = await createEnquiry(sales, {
      clientId: acme,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'EMAIL',
    });
    enquiryId = enquiry.id;
    await convertEnquiry(sales, { id: enquiry.id });
    const q = await createQuotation(sales, {
      enquiryId: enquiry.id,
      quotationDate: '2026-03-12',
      amount: '10',
      currency: 'INR',
      sectorId,
      serviceIds: [serviceId],
      nextFollowUpDate: '2026-03-20',
    });
    quotationId = q.id;

    const first = samplePdf('timeline one');
    mock.register(await sha256Hex(first), {
      type: 'result',
      wire: {
        amount: { value: '4242.00', confidence: 'high', page: 1, sourceText: 'Total 4242' },
        currency: { value: 'INR', confidence: 'high', page: 1, sourceText: 'INR' },
      },
    });
    const doc = await uploadDocument(
      sales,
      { kind: 'QUOTATION', entityId: q.id },
      {
        bytes: first,
        mimeType: 'application/pdf',
        filename: 'first.pdf',
      },
    );
    await runExtraction(system, doc.id);
    await confirmExtraction(sales, {
      documentId: doc.id,
      apply: { amount: '4242.00', currency: 'INR' },
    });
    await uploadDocument(
      sales,
      { kind: 'QUOTATION', entityId: q.id },
      {
        bytes: samplePdf('timeline two'),
        mimeType: 'application/pdf',
        filename: 'second.pdf',
      },
    );
  });
  afterAll(async () => {
    await closeDocumentsQueue();
    await disconnectAll();
  });

  const documentEvents = async (ctx: Ctx, extra: object = {}) =>
    (await getClientTimeline(ctx, { clientId: acme, limit: 100, ...extra })).items.filter(
      (e) => e.kind === 'DOCUMENT',
    );

  it('shows upload, review and replacement, newest first, on the quotation', async () => {
    const events = await documentEvents(sales);
    const summaries = events.map((e) => e.summary);
    // The replacement's two rows share a transaction (and its timestamp), so either order.
    expect(summaries.slice(0, 2).sort()).toEqual(['Replaced first.pdf', 'Uploaded second.pdf']);
    expect(summaries.slice(2)).toEqual([
      'Confirmed first.pdf · applied amount, currency',
      'Uploaded first.pdf',
    ]);
    for (const event of events) {
      expect(event.entity).toMatchObject({ type: 'QUOTATION', id: quotationId });
      expect(event.actor.id).toBe(sales.user.id);
    }
  });

  it('a plain delete (no new upload) reads as deleted, not replaced', async () => {
    const current = await getCurrentDocument(sales, 'QUOTATION', quotationId);
    await softDeleteDocument(sales, current!.id);
    try {
      const [latest] = await documentEvents(sales);
      expect(latest?.summary).toBe('Deleted second.pdf');
      expect(latest?.document?.action).toBe('DELETED');
    } finally {
      await restoreDocument(sales, current!.id);
    }
  });

  it('never shows extracted or applied values', async () => {
    const json = JSON.stringify(await getClientTimeline(sales, { clientId: acme, limit: 100 }));
    expect(json).not.toContain('4242');
  });

  it('is limited to users who can read the quotation', async () => {
    expect(await documentEvents(sales2)).toEqual([]);
    expect(await documentEvents(admin)).toHaveLength(6); // + the delete/restore test's pair
  });

  it('appears on the quotation’s record timeline, not the enquiry’s, and can be filtered', async () => {
    expect(
      await documentEvents(sales, { entityType: 'QUOTATION', entityId: quotationId }),
    ).toHaveLength(6);
    expect(await documentEvents(sales, { entityType: 'ENQUIRY', entityId: enquiryId })).toEqual([]);
    const onlyFollowUps = await getClientTimeline(sales, { clientId: acme, kinds: ['FOLLOW_UP'] });
    expect(onlyFollowUps.items).toEqual([]);
  });

  it('keeps document rows out of the quotation’s status changes', async () => {
    const items = (await getClientTimeline(sales, { clientId: acme, limit: 100 })).items;
    expect(items.filter((e) => e.kind === 'STATUS_CHANGE')).toHaveLength(1); // the enquiry's conversion
  });
});
