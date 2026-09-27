import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import type { CreateFollowUpInput } from '../schemas/follow-up.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import {
  listFollowUps,
  listFollowUpTargets,
  logFollowUp,
  restoreFollowUp,
  softDeleteFollowUp,
  updateFollowUp,
} from '../services/follow-up.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getQuotation,
  softDeleteQuotation,
} from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

const fieldOf = (e: unknown) => (e instanceof DomainError ? e.field : undefined);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const iso = (date: Date | null | undefined) => date?.toISOString().slice(0, 10) ?? null;

describe('quotation follow-ups (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let sectorId: string;
  let serviceId: string;
  let clientId: string;

  async function quotation(ctx: Ctx = sales, client = clientId) {
    const enquiry = await createEnquiry(ctx, {
      clientId: client,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'PHONE',
    });
    await convertEnquiry(ctx, { id: enquiry.id });
    return createQuotation(ctx, {
      enquiryId: enquiry.id,
      quotationDate: '2026-03-12',
      amount: '50000',
      currency: 'INR',
      sectorId,
      serviceIds: [serviceId],
      nextFollowUpDate: '2026-03-20',
      lastFollowUpHighlights: 'Typed by hand',
    });
  }

  const followUp = (
    entityId: string,
    overrides: Partial<CreateFollowUpInput> = {},
  ): CreateFollowUpInput => ({
    entityType: 'QUOTATION',
    entityId,
    date: '2026-03-18',
    channel: 'CALL',
    notes: 'Client wants a 5% discount',
    nextFollowUpDate: '2026-03-25',
    ...overrides,
  });

  const stored = async (id: string) => {
    const q = await getDb().quotation.findUniqueOrThrow({ where: { id } });
    return {
      next: iso(q.nextFollowUpDate),
      highlights: q.lastFollowUpHighlights,
      lastFollowUpId: q.lastFollowUpId,
    };
  };

  beforeAll(async () => {
    await resetDb(getDb());
    const user = async (email: string, role: 'ADMIN' | 'SALES') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    await ensureCompanySettings();
    sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    serviceId = (await createService(admin, { name: 'Inspection' })).id;
    clientId = (await createClient(admin, { name: 'Acme', sectorId })).id;
  });
  afterAll(disconnectAll);

  describe('AC9: sync from the latest follow-up', () => {
    it('logging sets highlights, next date and lastFollowUpId in the same request', async () => {
      const q = await quotation();
      const f = await logFollowUp(sales, followUp(q.id));

      expect(await stored(q.id)).toEqual({
        next: '2026-03-25',
        highlights: 'Client wants a 5% discount',
        lastFollowUpId: f.id,
      });
      const created = await getDb().auditLog.findFirstOrThrow({
        where: { entityType: 'FollowUp', entityId: f.id, action: 'CREATE' },
      });
      const sync = await getDb().auditLog.findMany({
        where: { entityType: 'Quotation', entityId: q.id, requestId: created.requestId },
      });
      expect(sync).toHaveLength(1);
      expect(sync[0]).toMatchObject({ action: 'UPDATE', source: 'web' });
      expect(sync[0]!.changedFields).toEqual(
        expect.arrayContaining(['lastFollowUpHighlights', 'lastFollowUpId', 'nextFollowUpDate']),
      );
    });

    it('keeps only the first 1000 characters of the notes', async () => {
      const q = await quotation();
      await logFollowUp(sales, followUp(q.id, { notes: 'n'.repeat(1500) }));
      expect((await stored(q.id)).highlights).toHaveLength(1000);
    });

    it('a back-dated follow-up older than the latest changes nothing', async () => {
      const q = await quotation();
      const latest = await logFollowUp(sales, followUp(q.id));
      const syncsBefore = await getDb().auditLog.count({
        where: { entityType: 'Quotation', entityId: q.id },
      });
      await logFollowUp(
        sales,
        followUp(q.id, { date: '2026-03-14', notes: 'Older call', nextFollowUpDate: '2026-03-16' }),
      );
      expect(await stored(q.id)).toMatchObject({ next: '2026-03-25', lastFollowUpId: latest.id });
      expect(
        await getDb().auditLog.count({ where: { entityType: 'Quotation', entityId: q.id } }),
      ).toBe(syncsBefore);
    });

    it('editing the latest re-syncs; deleting falls back; restoring re-syncs', async () => {
      const q = await quotation();
      const older = await logFollowUp(
        sales,
        followUp(q.id, { date: '2026-03-14', notes: 'First call', nextFollowUpDate: '2026-03-18' }),
      );
      const latest = await logFollowUp(sales, followUp(q.id));

      await updateFollowUp(sales, latest.id, {
        notes: 'Discount agreed',
        nextFollowUpDate: '2026-03-30',
      });
      expect(await stored(q.id)).toEqual({
        next: '2026-03-30',
        highlights: 'Discount agreed',
        lastFollowUpId: latest.id,
      });

      await softDeleteFollowUp(sales, latest.id);
      expect(await stored(q.id)).toEqual({
        next: '2026-03-18',
        highlights: 'First call',
        lastFollowUpId: older.id,
      });

      await restoreFollowUp(sales, latest.id);
      expect(await stored(q.id)).toMatchObject({ lastFollowUpId: latest.id, next: '2026-03-30' });
    });

    it('deleting the only follow-up leaves the fields as they were', async () => {
      const q = await quotation();
      const only = await logFollowUp(sales, followUp(q.id));
      await softDeleteFollowUp(sales, only.id);
      expect(await stored(q.id)).toEqual({
        next: '2026-03-25',
        highlights: 'Client wants a 5% discount',
        lastFollowUpId: only.id,
      });
    });

    it('an active quotation needs a next date on every follow-up', async () => {
      const q = await quotation();
      expect(
        fieldOf(await rejection(logFollowUp(sales, followUp(q.id, { nextFollowUpDate: '' })))),
      ).toBe('nextFollowUpDate');
      const f = await logFollowUp(sales, followUp(q.id));
      expect(fieldOf(await rejection(updateFollowUp(sales, f.id, { nextFollowUpDate: '' })))).toBe(
        'nextFollowUpDate',
      );
    });

    it.each(['PO_RECEIVED', 'LOST'] as const)(
      'on a %s quotation a follow-up updates highlights only and needs no next date',
      async (to) => {
        const q = await quotation();
        await changeQuotationStatus(
          sales,
          to === 'LOST'
            ? { id: q.id, to, lostReason: 'Price' }
            : { id: q.id, to, poReceivedDate: '2026-04-01' },
        );
        await logFollowUp(
          sales,
          followUp(q.id, { date: '2026-04-02', notes: 'Closing call', nextFollowUpDate: '' }),
        );
        expect(await stored(q.id)).toMatchObject({
          next: '2026-03-20',
          highlights: 'Closing call',
        });
        await logFollowUp(
          sales,
          followUp(q.id, { date: '2026-04-03', notes: 'Later', nextFollowUpDate: '2026-05-01' }),
        );
        expect(await stored(q.id)).toMatchObject({ next: '2026-03-20', highlights: 'Later' });
      },
    );

    it('follow-ups on enquiries and clients do not touch quotations', async () => {
      const q = await quotation();
      await logFollowUp(sales, {
        entityType: 'CLIENT',
        entityId: clientId,
        date: '2026-03-19',
        channel: 'EMAIL',
        notes: 'General note',
        nextFollowUpDate: '2026-04-30',
      });
      await logFollowUp(sales, {
        entityType: 'ENQUIRY',
        entityId: q.enquiryId,
        date: '2026-03-19',
        channel: 'EMAIL',
        notes: 'Enquiry note',
      });
      expect(await stored(q.id)).toEqual({
        next: '2026-03-20',
        highlights: 'Typed by hand',
        lastFollowUpId: null,
      });
    });
  });

  describe('AC10: follow-up RBAC and timeline', () => {
    it('Sales log on their own quotations, not on another rep’s', async () => {
      const mine = await quotation(sales);
      const theirs = await quotation(sales2);
      await logFollowUp(sales, followUp(mine.id));
      expect(await rejection(logFollowUp(sales, followUp(theirs.id)))).toBeInstanceOf(
        NotFoundError,
      );
      expect(await rejection(logFollowUp(sales, followUp('missing')))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('cannot log on a deleted quotation', async () => {
      const q = await quotation();
      await softDeleteQuotation(sales, q.id);
      expect(await rejection(logFollowUp(sales, followUp(q.id)))).toBeInstanceOf(NotFoundError);
    });

    it('lists include follow-ups on readable quotations, including an admin’s', async () => {
      const mine = await quotation(sales);
      const theirs = await quotation(sales2);
      const byAdmin = await logFollowUp(admin, followUp(mine.id, { notes: 'Admin call' }));
      const hidden = await logFollowUp(sales2, followUp(theirs.id));
      const ids = (
        await listFollowUps(sales, { entityType: 'QUOTATION', pageSize: 100 })
      ).items.map((f) => f.id);
      expect(ids).toContain(byAdmin.id);
      expect(ids).not.toContain(hidden.id);
      const labelled = (await listFollowUps(sales, { entityId: mine.id })).items[0]!;
      expect(labelled.entityLabel).toBe(mine.number);
    });

    it('the record picker offers the user’s live quotations on the client', async () => {
      const client = (await createClient(admin, { name: 'Picker Ltd', sectorId })).id;
      const mine = await quotation(sales, client);
      const theirs = await quotation(sales2, client);
      const targets = await listFollowUpTargets(sales, client);
      const quotations = targets.filter((t) => t.entityType === 'QUOTATION');
      expect(quotations).toEqual([
        { entityType: 'QUOTATION', entityId: mine.id, label: mine.number },
      ]);
      expect(quotations.map((t) => t.entityId)).not.toContain(theirs.id);
    });

    it('the client timeline shows quotation creation and status changes, in scope', async () => {
      const client = (await createClient(admin, { name: 'Timeline Ltd', sectorId })).id;
      const mine = await quotation(sales, client);
      await changeQuotationStatus(sales, { id: mine.id, to: 'UNDER_NEGOTIATION' });
      await changeQuotationStatus(admin, {
        id: mine.id,
        to: 'PO_RECEIVED',
        poReceivedDate: '2026-04-01',
      });
      const lost = await quotation(sales, client);
      await changeQuotationStatus(sales, { id: lost.id, to: 'LOST', lostReason: 'Budget cut' });
      const theirs = await quotation(sales2, client);

      const events = (await getClientTimeline(sales, { clientId: client, limit: 100 })).items;
      const quotationEvents = events.filter((e) => e.entity.type === 'QUOTATION');

      expect(quotationEvents.map((e) => e.entity.id)).not.toContain(theirs.id);
      const forMine = quotationEvents
        .filter((e) => e.entity.id === mine.id)
        .map((e) => e.change ?? e.kind);
      expect(forMine).toEqual([
        { from: 'UNDER_NEGOTIATION', to: 'PO_RECEIVED', poReceivedDate: '2026-04-01' },
        { from: 'SENT', to: 'UNDER_NEGOTIATION' },
        'CREATED',
      ]);
      const lostChange = quotationEvents.find((e) => e.entity.id === lost.id && e.change);
      expect(lostChange?.change).toEqual({ from: 'SENT', to: 'LOST', lostReason: 'Budget cut' });
      expect(quotationEvents.every((e) => !JSON.stringify(e).includes('amountMinor'))).toBe(true);

      // Narrowed to one quotation.
      const narrowed = await getClientTimeline(sales, {
        clientId: client,
        entityType: 'QUOTATION',
        entityId: mine.id,
      });
      expect(narrowed.items.every((e) => e.entity.id === mine.id)).toBe(true);

      // Admin sees the other rep's quotation too.
      const adminEvents = (await getClientTimeline(admin, { clientId: client, limit: 100 })).items;
      expect(adminEvents.map((e) => e.entity.id)).toContain(theirs.id);
    });

    it('a follow-up sync does not show up as a status change', async () => {
      const client = (await createClient(admin, { name: 'Quiet Ltd', sectorId })).id;
      const q = await quotation(sales, client);
      await logFollowUp(sales, followUp(q.id));
      const events = (
        await getClientTimeline(sales, {
          clientId: client,
          entityType: 'QUOTATION',
          entityId: q.id,
        })
      ).items;
      expect(events.map((e) => e.kind).sort()).toEqual(['CREATED', 'FOLLOW_UP']);
    });

    it('getQuotation shows the synced values', async () => {
      const q = await quotation();
      await logFollowUp(sales, followUp(q.id));
      expect(await getQuotation(sales, q.id)).toMatchObject({
        lastFollowUpHighlights: 'Client wants a 5% discount',
      });
    });
  });
});
