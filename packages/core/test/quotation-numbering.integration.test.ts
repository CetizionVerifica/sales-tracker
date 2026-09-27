import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import type { CreateQuotationInput } from '../schemas/quotation.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getQuotation,
  restoreQuotation,
  softDeleteQuotation,
  updateQuotation,
} from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

const auditOf = (entityType: string, entityId: string) =>
  getDb().auditLog.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'asc' } });

/**
 * AC13: QUO-<year>-<NNNN>, per calendar year of quotationDate, independent of enquiry
 * numbers, gap-free, immutable and never reused (M6 Decision 7).
 * AC14: racing status changes and deletes, exactly one wins each round.
 */
describe('quotation numbering and races (integration)', () => {
  let sales: Ctx;
  let admin: Ctx;
  let enquiryId: string;
  let input: (quotationDate?: string) => CreateQuotationInput;

  const numberOf = (n: string) => Number(n.split('-')[2]);

  beforeAll(async () => {
    await resetDb(getDb());
    admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    sales = ctxFor(
      actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }),
    );
    await ensureCompanySettings();
    const sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    const serviceId = (await createService(admin, { name: 'Inspection' })).id;
    const clientId = (await createClient(admin, { name: 'Acme', sectorId })).id;
    const enquiry = await createEnquiry(sales, {
      clientId,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: '2020-01-05',
      proposalSentDate: '2020-01-06',
      source: 'PHONE',
    });
    await convertEnquiry(sales, { id: enquiry.id });
    enquiryId = enquiry.id;
    input = (quotationDate = '2026-03-12') => ({
      enquiryId,
      quotationDate,
      amount: '1000',
      currency: 'INR',
      sectorId,
      serviceIds: [serviceId],
      nextFollowUpDate: quotationDate,
    });
  });
  afterAll(disconnectAll);

  describe('AC13: numbering', () => {
    it('is sequential per year of quotationDate and independent of enquiry numbers', async () => {
      const a = await createQuotation(sales, input('2025-06-01'));
      const b = await createQuotation(sales, input('2025-07-01'));
      const old = await createQuotation(sales, input('2020-02-01'));
      expect(a.number).toBe('QUO-2025-0001');
      expect(b.number).toBe('QUO-2025-0002');
      expect(old.number).toBe('QUO-2020-0001'); // ENQ-2020-0001 exists too
    });

    it('20 concurrent creates get 20 distinct, gap-free numbers', async () => {
      const created = await Promise.all(
        Array.from({ length: 20 }, () => createQuotation(sales, input('2023-05-05'))),
      );
      const values = created.map((q) => numberOf(q.number)).sort((x, y) => x - y);
      expect(values).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    });

    it('a create that fails does not consume a number', async () => {
      const first = await createQuotation(sales, input('2022-01-10'));
      await expect(
        createQuotation(sales, { ...input('2022-01-10'), sectorId: 'missing' }),
      ).rejects.toBeInstanceOf(DomainError);
      const next = await createQuotation(sales, input('2022-01-11'));
      expect(numberOf(next.number)).toBe(numberOf(first.number) + 1);
    });

    it('soft delete keeps the number, the next create does not reuse it, updates cannot change it', async () => {
      const q = await createQuotation(sales, input('2021-03-03'));
      await softDeleteQuotation(sales, q.id);
      const next = await createQuotation(sales, input('2021-03-04'));
      expect(next.number).not.toBe(q.number);
      await restoreQuotation(sales, q.id);
      await updateQuotation(sales, q.id, {
        quotationDate: '2025-03-03',
        nextFollowUpDate: '2025-03-03',
      });
      expect((await getQuotation(sales, q.id)).number).toBe(q.number);
    });
  });

  describe('AC14: concurrent status changes', () => {
    const ROUNDS = 10;

    it('PO received vs delete: a won quotation is never deleted', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const q = await createQuotation(sales, input());
        const results = await Promise.allSettled([
          changeQuotationStatus(sales, {
            id: q.id,
            to: 'PO_RECEIVED',
            poReceivedDate: '2026-04-01',
          }),
          softDeleteQuotation(sales, q.id),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(Error);
        }
        const row = await getDb().quotation.findFirstOrThrow({
          where: { id: q.id, deletedAt: undefined },
        });
        expect(row.status === 'PO_RECEIVED' && row.deletedAt !== null).toBe(false);
        expect(await auditOf('Quotation', q.id)).toHaveLength(2);
      }
    });

    it('PO received vs lost: exactly one wins and one transition is audited', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const q = await createQuotation(sales, input());
        const results = await Promise.allSettled([
          changeQuotationStatus(sales, {
            id: q.id,
            to: 'PO_RECEIVED',
            poReceivedDate: '2026-04-01',
          }),
          changeQuotationStatus(admin, { id: q.id, to: 'LOST', lostReason: 'Race' }),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DomainError);
        }
        const row = await getDb().quotation.findUniqueOrThrow({ where: { id: q.id } });
        if (row.status === 'PO_RECEIVED') expect(row.lostReason).toBeNull();
        else
          expect(row).toMatchObject({ status: 'LOST', lostReason: 'Race', poReceivedDate: null });
        expect((await auditOf('Quotation', q.id)).map((r) => r.action)).toEqual([
          'CREATE',
          'UPDATE',
        ]);
      }
    });
  });
});
