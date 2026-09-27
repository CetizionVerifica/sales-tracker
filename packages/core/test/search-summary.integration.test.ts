import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { ForbiddenError } from '../errors.ts';
import { toCalendarDateString, todayInIST } from '../schemas/common.ts';
import { createClient, softDeleteClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';
import { changeQuotationStatus, createQuotation } from '../services/quotation.service.ts';
import { searchRecords } from '../services/search.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { enquiryStatusCounts, quotationStatusCounts } from '../services/summary.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

// Phase C of the UI guide work: ⌘K search and list summary strips. Both are reads scoped
// exactly like the lists they lead to.

describe('search and summary counts (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let acme: string;
  let globex: string;
  let pharma: string;
  let inspection: string;
  const today = toCalendarDateString(todayInIST());

  async function enquiry(ctx: Ctx, clientId: string) {
    return createEnquiry(ctx, {
      clientId,
      sectorId: pharma,
      serviceIds: [inspection],
      receivedDate: '2026-03-10',
      proposalSentDate: '2026-03-12',
      source: 'EMAIL',
    });
  }

  async function quotation(ctx: Ctx, clientId: string, next = '2099-01-01') {
    const e = await enquiry(ctx, clientId);
    await convertEnquiry(ctx, { id: e.id });
    return createQuotation(ctx, {
      enquiryId: e.id,
      quotationDate: '2026-03-12',
      amount: '100',
      currency: 'INR',
      sectorId: pharma,
      serviceIds: [inspection],
      nextFollowUpDate: next,
    });
  }

  beforeAll(async () => {
    await resetDb(getDb());
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
      enabledCurrencies: ['INR'],
    });
    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    inspection = (await createService(admin, { name: 'Inspection' })).id;
    acme = (await createClient(admin, { name: 'Acme Pharma', sectorId: pharma })).id;
    globex = (await createClient(admin, { name: 'Globex Steel', sectorId: pharma })).id;

    // sales: 2 in progress, 1 lost, 2 converted (both with quotations: one due, one not)
    await enquiry(sales, acme);
    await enquiry(sales, acme);
    const lost = await enquiry(sales, acme);
    await markEnquiryLost(sales, { id: lost.id, lostReason: 'Budget' });
    await quotation(sales, acme, today); // follow-up due today
    const negotiating = await quotation(sales, acme);
    await changeQuotationStatus(sales, { id: negotiating.id, to: 'UNDER_NEGOTIATION' });
    // sales2: one enquiry and one quotation for Globex
    await enquiry(sales2, globex);
    await quotation(sales2, globex);
  });
  afterAll(disconnectAll);

  describe('searchRecords', () => {
    it('finds enquiries and quotations by number, and clients by name', async () => {
      const results = await searchRecords(sales, { q: 'acme' });
      expect(results.filter((r) => r.type === 'CLIENT').map((r) => r.label)).toEqual([
        'Acme Pharma',
      ]);
      expect(results.some((r) => r.type === 'ENQUIRY')).toBe(true);
      expect(results.some((r) => r.type === 'QUOTATION')).toBe(true);

      const byNumber = await searchRecords(sales, { q: 'QUO-2026-0001' });
      expect(byNumber).toContainEqual(
        expect.objectContaining({ type: 'QUOTATION', label: 'QUO-2026-0001' }),
      );
    });

    it('only returns records the user can read (RBAC)', async () => {
      const mine = await searchRecords(sales, { q: 'globex' });
      expect(mine.filter((r) => r.type !== 'CLIENT')).toEqual([]); // sales2's records
      expect(mine.map((r) => r.label)).toContain('Globex Steel'); // clients are readable by all
      const theirs = await searchRecords(sales2, { q: 'globex' });
      expect(theirs.some((r) => r.type === 'QUOTATION')).toBe(true);
      expect((await searchRecords(pm, { q: 'acme' })).filter((r) => r.type !== 'CLIENT')).toEqual(
        [],
      );
      const all = await searchRecords(admin, { q: 'QUO-' });
      expect(all.filter((r) => r.type === 'QUOTATION')).toHaveLength(3);
    });

    it('caps each type and validates the query', async () => {
      const results = await searchRecords(admin, { q: 'ENQ-', limit: 2 });
      expect(results.filter((r) => r.type === 'ENQUIRY')).toHaveLength(2);
      await expect(searchRecords(sales, { q: 'a' })).rejects.toBeInstanceOf(z.ZodError);
    });

    it('hides soft-deleted clients and returns nothing for no match', async () => {
      const gone = await createClient(admin, { name: 'Initech Retired', sectorId: pharma });
      await softDeleteClient(admin, gone.id);
      expect(await searchRecords(sales, { q: 'initech' })).toEqual([]);
      expect(await searchRecords(sales, { q: 'nothing matches this' })).toEqual([]);
    });
  });

  describe('status counts', () => {
    it('counts enquiries by status within the user’s scope', async () => {
      expect(await enquiryStatusCounts(sales)).toEqual({ IN_PROGRESS: 2, CONVERTED: 2, LOST: 1 });
      expect(await enquiryStatusCounts(sales2)).toEqual({ IN_PROGRESS: 1, CONVERTED: 1, LOST: 0 });
      expect(await enquiryStatusCounts(admin)).toEqual({ IN_PROGRESS: 3, CONVERTED: 3, LOST: 1 });
      expect(await enquiryStatusCounts(pm)).toEqual({ IN_PROGRESS: 0, CONVERTED: 0, LOST: 0 });
    });

    it('counts quotations by status plus follow-ups due (today in IST)', async () => {
      expect(await quotationStatusCounts(sales)).toEqual({
        SENT: 1,
        UNDER_NEGOTIATION: 1,
        PO_RECEIVED: 0,
        LOST: 0,
        followUpDue: 1,
      });
      expect((await quotationStatusCounts(sales2)).followUpDue).toBe(0);
      expect((await quotationStatusCounts(admin)).SENT).toBe(2);
    });

    it('denies roles that cannot list the type', async () => {
      const inactive = { ...sales, user: { ...sales.user, active: false } };
      await expect(enquiryStatusCounts(inactive)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(searchRecords(inactive, { q: 'acme' })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});
