import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { quotationResource, scopeQuotations } from '../rbac/scope.ts';
import { toCalendarDateString, todayInIST } from '../schemas/common.ts';
import type { CreateEnquiryInput } from '../schemas/enquiry.ts';
import type { CreateQuotationInput } from '../schemas/quotation.ts';
import { createClient, softDeleteClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getProjectDraft,
  getQuotation,
  listQuotations,
  listQuotationsForEnquiry,
  restoreQuotation,
  softDeleteQuotation,
  updateQuotation,
} from '../services/quotation.service.ts';
import { createSector, updateSector } from '../services/sector.service.ts';
import { createService, updateService } from '../services/service.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { deactivateUser } from '../services/user.service.ts';
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

/** Audit rows for one entity, oldest first. */
const auditOf = (entityType: string, entityId: string) =>
  getDb().auditLog.findMany({ where: { entityType, entityId }, orderBy: { createdAt: 'asc' } });

const FAR_FUTURE = '2099-01-01';

describe('quotations (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let inactiveSalesId: string;
  let pharma: string;
  let steel: string;
  let inspection: string;
  let audit: string;
  let certification: string;
  let acme: string;

  const enquiryInput = (overrides: Partial<CreateEnquiryInput> = {}): CreateEnquiryInput => ({
    clientId: acme,
    sectorId: pharma,
    serviceIds: [inspection, audit],
    receivedDate: '2026-03-10',
    proposalSentDate: '2026-03-12',
    source: 'EMAIL',
    ...overrides,
  });

  /** A converted enquiry owned by `ctx` (Sales by default). */
  async function convertedEnquiry(ctx: Ctx = sales, overrides: Partial<CreateEnquiryInput> = {}) {
    const enquiry = await createEnquiry(ctx, enquiryInput(overrides));
    await convertEnquiry(ctx, { id: enquiry.id });
    return enquiry;
  }

  const input = (
    enquiryId: string,
    overrides: Partial<CreateQuotationInput> = {},
  ): CreateQuotationInput => ({
    enquiryId,
    quotationDate: '2026-03-12',
    amount: '1,25,000.50',
    currency: 'INR',
    sectorId: pharma,
    serviceIds: [inspection, audit],
    nextFollowUpDate: '2026-03-20',
    ...overrides,
  });

  /** A fresh SENT quotation for `ctx`. */
  async function quotation(ctx: Ctx = sales, overrides: Partial<CreateQuotationInput> = {}) {
    const enquiry = await convertedEnquiry(ctx);
    return createQuotation(ctx, input(enquiry.id, overrides));
  }

  beforeAll(async () => {
    await resetDb(getDb());
    const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    pm = await user('pm@example.test', 'PROJECT_MANAGER');
    inactiveSalesId = (await createTestUser('gone@example.test', 'SALES')).id;
    await deactivateUser(admin, inactiveSalesId);

    await ensureCompanySettings();
    await updateSettings(admin, {
      companyName: 'Test Co',
      defaultInvoiceDueDays: 30,
      enabledCurrencies: ['INR', 'USD', 'JPY', 'EUR'],
    });

    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    steel = (await createSector(admin, { name: 'Steel' })).id;
    inspection = (await createService(admin, { name: 'Inspection' })).id;
    audit = (await createService(admin, { name: 'Audit' })).id;
    certification = (await createService(admin, { name: 'Certification' })).id;
    acme = (await createClient(admin, { name: 'Acme Pharma', sectorId: pharma })).id;
  });
  afterAll(disconnectAll);

  describe('AC1: create', () => {
    it('creates a SENT quotation from a converted enquiry, with a number and audit rows', async () => {
      const enquiry = await convertedEnquiry();
      const q = await createQuotation(sales, input(enquiry.id, { description: 'Phase 1' }));

      expect(q).toMatchObject({
        status: 'SENT',
        ownerId: sales.user.id,
        clientId: acme,
        enquiryId: enquiry.id,
        amountMinor: 12_500_050n,
        currency: 'INR',
        client: { id: acme, name: 'Acme Pharma' },
        enquiry: { id: enquiry.id, number: enquiry.number },
        description: 'Phase 1',
      });
      expect(q.number).toMatch(/^QUO-2026-\d{4}$/);
      expect(q.quotationDate.toISOString()).toBe('2026-03-12T00:00:00.000Z');
      expect(q.nextFollowUpDate?.toISOString()).toBe('2026-03-20T00:00:00.000Z');
      expect(q.statusChangedAt).not.toBeNull();
      expect(q.services.map((s) => s.name).sort()).toEqual(['Audit', 'Inspection']);

      const [created] = await auditOf('Quotation', q.id);
      expect(created).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      expect((created!.after as { amountMinor: unknown }).amountMinor).toBe('12500050');
      const request = await getDb().auditLog.findMany({
        where: { requestId: created!.requestId },
      });
      const byType = (type: string) => request.filter((r) => r.entityType === type);
      expect(byType('Quotation')).toHaveLength(1);
      expect(byType('QuotationService').map((r) => r.action)).toEqual(['CREATE', 'CREATE']);
    });

    it('defaults the owner to the enquiry owner when an admin creates it', async () => {
      const enquiry = await convertedEnquiry(sales2);
      const q = await createQuotation(admin, input(enquiry.id));
      expect(q.ownerId).toBe(sales2.user.id);
    });

    it('lets an admin choose another active sales owner', async () => {
      const enquiry = await convertedEnquiry();
      const q = await createQuotation(admin, input(enquiry.id, { ownerId: sales2.user.id }));
      expect(q.ownerId).toBe(sales2.user.id);
    });

    it('is forbidden for project managers', async () => {
      const enquiry = await convertedEnquiry();
      expect(await rejection(createQuotation(pm, input(enquiry.id)))).toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe('AC2: validation', () => {
    it('rejects an enquiry that is not converted, on enquiryId', async () => {
      const open = await createEnquiry(sales, enquiryInput());
      expect(fieldOf(await rejection(createQuotation(sales, input(open.id))))).toBe('enquiryId');

      const lost = await createEnquiry(sales, enquiryInput());
      await markEnquiryLost(sales, { id: lost.id, lostReason: 'Price' });
      expect(fieldOf(await rejection(createQuotation(sales, input(lost.id))))).toBe('enquiryId');
    });

    it('rejects a missing enquiry, or one whose client is deleted, as not found', async () => {
      expect(await rejection(createQuotation(sales, input('nope')))).toBeInstanceOf(NotFoundError);

      const doomed = (await createClient(admin, { name: 'Doomed Ltd', sectorId: pharma })).id;
      const enquiry = await convertedEnquiry(sales, { clientId: doomed });
      await softDeleteClient(admin, doomed);
      expect(await rejection(createQuotation(sales, input(enquiry.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('rejects a currency that is not enabled', async () => {
      const enquiry = await convertedEnquiry();
      const error = await rejection(
        createQuotation(sales, input(enquiry.id, { currency: 'GBP', amount: '10' })),
      );
      expect(fieldOf(error)).toBe('currency');
    });

    it.each([
      [{ amount: '-1' }, 'amount'],
      [{ amount: '10.123' }, 'amount'],
      [{ amount: '10.5', currency: 'JPY' }, 'amount'],
      [{ amount: '1000000000000000' }, 'amount'],
      [{ currency: 'XYZ' }, 'currency'],
      [{ serviceIds: [] }, 'serviceIds'],
      [{ quotationDate: FAR_FUTURE }, 'quotationDate'],
      [{ nextFollowUpDate: '2026-03-01' }, 'nextFollowUpDate'],
    ])('rejects %j (schema)', async (overrides, path) => {
      const enquiry = await convertedEnquiry();
      const result = await rejection(createQuotation(sales, input(enquiry.id, overrides)));
      expect(result).toMatchObject({ name: 'ZodError' });
      const paths = (result as { issues: { path: PropertyKey[] }[] }).issues.map((i) =>
        i.path.join('.'),
      );
      expect(paths).toContain(path);
    });

    it('rejects a quotation date before the enquiry was received', async () => {
      const enquiry = await convertedEnquiry();
      const error = await rejection(
        createQuotation(sales, input(enquiry.id, { quotationDate: '2026-03-09' })),
      );
      expect(fieldOf(error)).toBe('quotationDate');
    });

    it('rejects an inactive sector or service', async () => {
      const retiredSector = (await createSector(admin, { name: 'Retired sector' })).id;
      await updateSector(admin, retiredSector, { active: false });
      const retiredService = (await createService(admin, { name: 'Retired service' })).id;
      await updateService(admin, retiredService, { active: false });
      const enquiry = await convertedEnquiry();

      expect(
        fieldOf(
          await rejection(createQuotation(sales, input(enquiry.id, { sectorId: retiredSector }))),
        ),
      ).toBe('sectorId');
      expect(
        fieldOf(
          await rejection(
            createQuotation(sales, input(enquiry.id, { serviceIds: [retiredService] })),
          ),
        ),
      ).toBe('serviceIds');
    });

    it('rejects a non-admin setting the owner, and an inactive owner', async () => {
      const enquiry = await convertedEnquiry();
      expect(
        fieldOf(
          await rejection(createQuotation(sales, input(enquiry.id, { ownerId: sales2.user.id }))),
        ),
      ).toBe('ownerId');
      expect(
        fieldOf(
          await rejection(createQuotation(admin, input(enquiry.id, { ownerId: inactiveSalesId }))),
        ),
      ).toBe('ownerId');
    });

    it('never takes clientId, status or number from input', async () => {
      const enquiry = await convertedEnquiry();
      const sneaky = { ...input(enquiry.id), clientId: 'x', status: 'PO_RECEIVED', number: 'Q-1' };
      expect(await rejection(createQuotation(sales, sneaky as CreateQuotationInput))).toMatchObject(
        { name: 'ZodError' },
      );
    });
  });

  describe('AC4: update', () => {
    it('writes one UPDATE with the changed fields', async () => {
      const q = await quotation();
      await updateQuotation(sales, q.id, { amount: '200000', currency: 'USD' });
      const rows = await auditOf('Quotation', q.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]!.changedFields).toEqual(['amountMinor', 'currency']);
      expect((await getQuotation(sales, q.id)).amountMinor).toBe(20_000_000n);
    });

    it('diffs services: {A, B} → {B, C} deletes A, creates C, leaves B', async () => {
      const q = await quotation();
      const before = await getDb().quotationService.findMany({ where: { quotationId: q.id } });
      const keptB = before.find((l) => l.serviceId === audit)!;

      await updateQuotation(sales, q.id, { serviceIds: [audit, certification] });

      const after = await getDb().quotationService.findMany({ where: { quotationId: q.id } });
      expect(after.map((l) => l.serviceId).sort()).toEqual([audit, certification].sort());
      expect(after.find((l) => l.serviceId === audit)!.id).toBe(keptB.id);
      const links = await getDb().auditLog.findMany({
        where: { entityType: 'QuotationService', action: { in: ['DELETE', 'CREATE'] } },
        orderBy: { createdAt: 'desc' },
        take: 2,
      });
      expect(links.map((r) => r.action).sort()).toEqual(['CREATE', 'DELETE']);
    });

    it('keeps a quotation in a since-disabled currency editable', async () => {
      const q = await quotation(sales, { amount: '99', currency: 'EUR' });
      await updateSettings(admin, {
        companyName: 'Test Co',
        defaultInvoiceDueDays: 30,
        enabledCurrencies: ['INR', 'USD', 'JPY'],
      });
      try {
        const updated = await updateQuotation(sales, q.id, { description: 'Still fine' });
        expect(updated).toMatchObject({ description: 'Still fine', currency: 'EUR' });
        expect(
          fieldOf(await rejection(updateQuotation(sales, q.id, { amount: '5', currency: 'GBP' }))),
        ).toBe('currency');
      } finally {
        await updateSettings(admin, {
          companyName: 'Test Co',
          defaultInvoiceDueDays: 30,
          enabledCurrencies: ['INR', 'USD', 'JPY', 'EUR'],
        });
      }
    });

    it('keeps a quotation whose sector was since retired editable', async () => {
      const temp = (await createSector(admin, { name: 'Temp sector' })).id;
      const q = await quotation(sales, { sectorId: temp });
      await updateSector(admin, temp, { active: false });
      const updated = await updateQuotation(sales, q.id, { description: 'Sector retired' });
      expect(updated.sector.id).toBe(temp);
    });

    it('rejects clearing the next follow-up date on an active quotation', async () => {
      const q = await quotation();
      expect(fieldOf(await rejection(updateQuotation(sales, q.id, { nextFollowUpDate: '' })))).toBe(
        'nextFollowUpDate',
      );
    });

    it('rejects a next follow-up date before the (merged) quotation date', async () => {
      const q = await quotation();
      expect(
        fieldOf(await rejection(updateQuotation(sales, q.id, { quotationDate: '2026-03-25' }))),
      ).toBe('nextFollowUpDate');
    });

    it.each(['PO_RECEIVED', 'LOST'] as const)(
      'on a %s quotation only description and highlights change',
      async (to) => {
        const q = await quotation();
        await changeQuotationStatus(
          sales,
          to === 'LOST'
            ? { id: q.id, to, lostReason: 'Price' }
            : { id: q.id, to, poReceivedDate: '2026-04-01' },
        );
        expect(
          fieldOf(await rejection(updateQuotation(sales, q.id, { amount: '1', currency: 'INR' }))),
        ).toBe('amount');
        expect(
          await rejection(updateQuotation(sales, q.id, { serviceIds: [certification] })),
        ).toBeInstanceOf(DomainError);
        const updated = await updateQuotation(sales, q.id, {
          description: 'Closed',
          lastFollowUpHighlights: 'Wrap-up',
        });
        expect(updated).toMatchObject({ description: 'Closed', lastFollowUpHighlights: 'Wrap-up' });
      },
    );

    it('only admins change the owner', async () => {
      const q = await quotation();
      expect(
        fieldOf(await rejection(updateQuotation(sales, q.id, { ownerId: sales2.user.id }))),
      ).toBe('ownerId');
      const moved = await updateQuotation(admin, q.id, { ownerId: sales2.user.id });
      expect(moved.ownerId).toBe(sales2.user.id);
    });
  });

  describe('AC5: RBAC', () => {
    it('Sales cannot see or change another rep’s quotation (not found)', async () => {
      const q = await quotation(sales2);
      for (const call of [
        () => getQuotation(sales, q.id),
        () => updateQuotation(sales, q.id, { description: 'x' }),
        () => changeQuotationStatus(sales, { id: q.id, to: 'UNDER_NEGOTIATION' }),
        () => softDeleteQuotation(sales, q.id),
        () => getProjectDraft(sales, q.id),
      ]) {
        expect(await rejection(call())).toBeInstanceOf(NotFoundError);
      }
    });

    it('Sales cannot create a quotation on another rep’s enquiry', async () => {
      const enquiry = await convertedEnquiry(sales2);
      expect(await rejection(createQuotation(sales, input(enquiry.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('lists: Sales see their own, admins all, project managers none (until M8)', async () => {
      const mine = await quotation(sales);
      const theirs = await quotation(sales2);
      const ids = async (ctx: Ctx) =>
        (await listQuotations(ctx, { pageSize: 100 })).items.map((q) => q.id);

      expect(await ids(sales)).toContain(mine.id);
      expect(await ids(sales)).not.toContain(theirs.id);
      expect(await ids(admin)).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(await ids(pm)).toEqual([]);
      expect(scopeQuotations(pm.user)).toEqual({ id: { in: [] } });
      expect(quotationResource({ ownerId: 'u' })).toEqual({
        type: 'quotation',
        ownerId: 'u',
        projectManagerIds: [],
      });
    });

    it('project managers cannot read a quotation (pinned until M8)', async () => {
      const q = await quotation();
      expect(await rejection(getQuotation(pm, q.id))).toBeInstanceOf(NotFoundError);
    });

    it('owner changes go only to active Sales or Admin users', async () => {
      const q = await quotation();
      expect(fieldOf(await rejection(updateQuotation(admin, q.id, { ownerId: pm.user.id })))).toBe(
        'ownerId',
      );
      expect(
        fieldOf(await rejection(updateQuotation(admin, q.id, { ownerId: inactiveSalesId }))),
      ).toBe('ownerId');
    });

    it('project managers cannot list an enquiry’s quotations or change one (until M8)', async () => {
      const enquiry = await convertedEnquiry();
      const q = await createQuotation(sales, input(enquiry.id));
      expect(await rejection(listQuotationsForEnquiry(pm, enquiry.id))).toBeInstanceOf(
        NotFoundError,
      );
      expect(
        await rejection(changeQuotationStatus(pm, { id: q.id, to: 'LOST', lostReason: 'x' })),
      ).toBeInstanceOf(NotFoundError);
    });

    it('only the owner or an admin restores a deleted quotation; a refusal is not audited', async () => {
      const q = await quotation(sales2);
      await softDeleteQuotation(sales2, q.id);
      const restores = () =>
        getDb().auditLog.count({
          where: { entityType: 'Quotation', entityId: q.id, action: 'RESTORE' },
        });

      expect(await rejection(restoreQuotation(sales, q.id))).toBeInstanceOf(NotFoundError);
      expect(await rejection(restoreQuotation(pm, q.id))).toBeInstanceOf(NotFoundError);
      expect(await restores()).toBe(0);
      expect((await getQuotation(sales2, q.id)).deletedAt).not.toBeNull();

      await restoreQuotation(admin, q.id);
      expect(await restores()).toBe(1);
    });
  });

  describe('AC7: PO received (the “done when”)', () => {
    it('moves to PO_RECEIVED in one audited UPDATE and returns the project draft', async () => {
      const q = await quotation();
      await changeQuotationStatus(sales, {
        id: q.id,
        to: 'UNDER_NEGOTIATION',
        nextFollowUpDate: '2026-03-25',
      });
      const { quotation: won, projectDraft } = await changeQuotationStatus(sales, {
        id: q.id,
        to: 'PO_RECEIVED',
        poReceivedDate: '2026-04-01',
      });

      expect(won.status).toBe('PO_RECEIVED');
      expect(won.poReceivedDate?.toISOString()).toBe('2026-04-01T00:00:00.000Z');
      expect(projectDraft).toEqual({
        quotationId: q.id,
        quotationNumber: q.number,
        clientId: acme,
        serviceIds: [inspection, audit].sort(),
        ownerId: sales.user.id,
        revenueMinor: 12_500_050n,
        currency: 'INR',
        poReceivedDate: new Date('2026-04-01T00:00:00.000Z'),
      });

      const rows = await auditOf('Quotation', q.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE', 'UPDATE']);
      expect(rows[2]!.changedFields).toEqual(
        expect.arrayContaining(['status', 'poReceivedDate', 'statusChangedAt']),
      );
      expect(await getProjectDraft(sales, q.id)).toEqual(projectDraft);
    });

    it('getProjectDraft rejects any other status', async () => {
      const q = await quotation();
      expect(await rejection(getProjectDraft(sales, q.id))).toBeInstanceOf(DomainError);
    });

    it('rejects a PO received date before the quotation date or in the future', async () => {
      const q = await quotation();
      for (const poReceivedDate of ['2026-03-01', FAR_FUTURE]) {
        expect(
          fieldOf(
            await rejection(
              changeQuotationStatus(sales, { id: q.id, to: 'PO_RECEIVED', poReceivedDate }),
            ),
          ),
        ).toBe('poReceivedDate');
      }
    });
  });

  describe('AC8: status only through the machine', () => {
    it('updateQuotation rejects a status field', async () => {
      const q = await quotation();
      expect(
        await rejection(updateQuotation(sales, q.id, { status: 'PO_RECEIVED' } as never)),
      ).toMatchObject({ name: 'ZodError' });
    });

    it('PO_RECEIVED and LOST are terminal', async () => {
      const won = await quotation();
      await changeQuotationStatus(sales, {
        id: won.id,
        to: 'PO_RECEIVED',
        poReceivedDate: '2026-04-01',
      });
      const lost = await quotation();
      await changeQuotationStatus(sales, { id: lost.id, to: 'LOST', lostReason: 'Budget cut' });

      for (const id of [won.id, lost.id]) {
        for (const move of [
          { id, to: 'SENT' as const },
          { id, to: 'UNDER_NEGOTIATION' as const },
          { id, to: 'LOST' as const, lostReason: 'x' },
          { id, to: 'PO_RECEIVED' as const, poReceivedDate: '2026-04-02' },
        ]) {
          expect(await rejection(changeQuotationStatus(sales, move))).toBeInstanceOf(DomainError);
        }
      }
    });

    it('marking lost stores the reason in one audited UPDATE and ends follow-up due', async () => {
      const q = await quotation();
      const { quotation: lost, projectDraft } = await changeQuotationStatus(sales, {
        id: q.id,
        to: 'LOST',
        lostReason: 'Went with a competitor',
      });
      expect(projectDraft).toBeUndefined();
      expect(lost).toMatchObject({ status: 'LOST', lostReason: 'Went with a competitor' });
      const rows = await auditOf('Quotation', q.id);
      expect(rows.at(-1)!.changedFields).toEqual(
        expect.arrayContaining(['status', 'lostReason', 'statusChangedAt']),
      );
      const due = await listQuotations(sales, { enquiryId: q.enquiryId, followUpDue: true });
      expect(due.items).toEqual([]);
      expect(await rejection(getProjectDraft(sales, q.id))).toBeInstanceOf(DomainError);
    });

    it('moving back to SENT with a new next date stores it', async () => {
      const q = await quotation();
      await changeQuotationStatus(sales, { id: q.id, to: 'UNDER_NEGOTIATION' });
      const { quotation: back } = await changeQuotationStatus(sales, {
        id: q.id,
        to: 'SENT',
        nextFollowUpDate: '2026-04-10',
      });
      expect(back.status).toBe('SENT');
      expect(back.nextFollowUpDate?.toISOString()).toBe('2026-04-10T00:00:00.000Z');
    });

    it('the database rejects rows that break the status rules, even via raw SQL', async () => {
      const q = await quotation();
      const raw = (sql: string) => getDb().$executeRawUnsafe(sql, q.id);
      await expect(
        raw(`UPDATE "quotation" SET "nextFollowUpDate" = NULL WHERE id = $1`),
      ).rejects.toThrow(/quotation_active_needs_next_follow_up/);
      await expect(
        raw(`UPDATE "quotation" SET status = 'PO_RECEIVED' WHERE id = $1`),
      ).rejects.toThrow(/quotation_po_received_needs_date/);
      await expect(raw(`UPDATE "quotation" SET status = 'LOST' WHERE id = $1`)).rejects.toThrow(
        /quotation_lost_needs_reason/,
      );
      await expect(raw(`UPDATE "quotation" SET "amountMinor" = -1 WHERE id = $1`)).rejects.toThrow(
        /quotation_amount_non_negative/,
      );
      await expect(raw(`UPDATE "quotation" SET currency = 'inr' WHERE id = $1`)).rejects.toThrow(
        /quotation_currency_iso/,
      );
      await expect(
        raw(
          `UPDATE "quotation" SET status = 'PO_RECEIVED', "poReceivedDate" = '2026-01-01' WHERE id = $1`,
        ),
      ).rejects.toThrow(/quotation_po_after_quotation/);
    });
  });

  describe('AC11: soft delete', () => {
    it('SENT, UNDER_NEGOTIATION and LOST quotations can be deleted and restored', async () => {
      const sent = await quotation();
      const negotiating = await quotation();
      await changeQuotationStatus(sales, { id: negotiating.id, to: 'UNDER_NEGOTIATION' });
      const lost = await quotation();
      await changeQuotationStatus(sales, { id: lost.id, to: 'LOST', lostReason: 'Price' });

      for (const q of [sent, negotiating, lost]) {
        await softDeleteQuotation(sales, q.id);
        const live = await listQuotations(sales, { enquiryId: q.enquiryId });
        expect(live.items).toEqual([]);
        const deleted = await listQuotations(sales, {
          enquiryId: q.enquiryId,
          recordStatus: 'deleted',
        });
        expect(deleted.items.map((r) => r.id)).toEqual([q.id]);
        await restoreQuotation(sales, q.id);
        expect((await auditOf('Quotation', q.id)).map((r) => r.action).slice(-2)).toEqual([
          'SOFT_DELETE',
          'RESTORE',
        ]);
      }
    });

    it('a PO_RECEIVED quotation cannot be deleted', async () => {
      const q = await quotation();
      await changeQuotationStatus(sales, {
        id: q.id,
        to: 'PO_RECEIVED',
        poReceivedDate: '2026-04-01',
      });
      expect(await rejection(softDeleteQuotation(sales, q.id))).toBeInstanceOf(DomainError);
    });

    it('a deleted quotation cannot be edited or change status', async () => {
      const q = await quotation();
      await softDeleteQuotation(sales, q.id);
      expect(await rejection(updateQuotation(sales, q.id, { description: 'x' }))).toBeInstanceOf(
        NotFoundError,
      );
      expect(
        await rejection(changeQuotationStatus(sales, { id: q.id, to: 'UNDER_NEGOTIATION' })),
      ).toBeInstanceOf(NotFoundError);
      // Still readable (detail page with Restore).
      expect((await getQuotation(sales, q.id)).deletedAt).not.toBeNull();
    });
  });

  describe('AC12: list', () => {
    it('narrows by each filter and searches numbers, client and description', async () => {
      const beta = (await createClient(admin, { name: 'Beta Steel', sectorId: steel })).id;
      const betaEnquiry = await convertedEnquiry(sales, { clientId: beta, sectorId: steel });
      const usd = await createQuotation(
        sales,
        input(betaEnquiry.id, {
          amount: '5000',
          currency: 'USD',
          sectorId: steel,
          serviceIds: [certification],
          quotationDate: '2026-05-02',
          nextFollowUpDate: '2026-05-09',
          description: 'Tower crane certification',
        }),
      );
      const inr = await quotation(sales, {
        quotationDate: '2026-03-15',
        nextFollowUpDate: FAR_FUTURE,
      });
      await changeQuotationStatus(sales, { id: inr.id, to: 'UNDER_NEGOTIATION' });

      const ids = async (filter: Parameters<typeof listQuotations>[1]) =>
        (await listQuotations(sales, { pageSize: 100, ...filter })).items.map((q) => q.id);

      expect(await ids({ clientId: beta })).toEqual([usd.id]);
      expect(await ids({ enquiryId: inr.enquiryId })).toEqual([inr.id]);
      expect(await ids({ sectorId: steel })).toEqual([usd.id]);
      expect(await ids({ serviceId: certification, clientId: beta })).toEqual([usd.id]);
      expect(await ids({ currency: 'USD' })).toContain(usd.id);
      expect(await ids({ currency: 'USD' })).not.toContain(inr.id);
      expect(await ids({ status: 'UNDER_NEGOTIATION' })).toContain(inr.id);
      expect(await ids({ status: 'UNDER_NEGOTIATION' })).not.toContain(usd.id);
      expect(await ids({ quotationFrom: '2026-05-01', quotationTo: '2026-05-31' })).toEqual([
        usd.id,
      ]);
      expect(await ids({ nextFollowUpFrom: '2026-05-09', nextFollowUpTo: '2026-05-09' })).toEqual([
        usd.id,
      ]);
      expect(await ids({ q: usd.number })).toEqual([usd.id]);
      expect(await ids({ q: betaEnquiry.number })).toEqual([usd.id]);
      expect(await ids({ q: 'beta steel' })).toEqual([usd.id]);
      expect(await ids({ q: 'crane' })).toEqual([usd.id]);
      expect(await ids({ ownerId: sales2.user.id })).toEqual([]); // RBAC scope still applies

      const sorted = await listQuotations(sales, {
        clientId: beta,
        sort: 'amount',
        dir: 'desc',
        pageSize: 1,
      });
      expect(sorted.total).toBe(1);

      const rows = (
        await listQuotations(sales, { pageSize: 100, sort: 'quotationDate', dir: 'asc' })
      ).items;
      const dates = rows.map((r) => r.quotationDate.getTime());
      expect(dates).toEqual([...dates].sort((a, b) => a - b));
    });

    it('pages results', async () => {
      const first = await listQuotations(admin, { page: 1, pageSize: 2 });
      const second = await listQuotations(admin, { page: 2, pageSize: 2 });
      expect(first.items).toHaveLength(2);
      expect(second.items.map((r) => r.id)).not.toContain(first.items[0]!.id);
      expect(first.total).toBeGreaterThan(2);
    });

    describe('follow-up due, with today in Asia/Kolkata', () => {
      afterEach(() => vi.useRealTimers());

      it('matches active quotations with a next date on or before today', async () => {
        const today = toCalendarDateString(todayInIST());
        const due = await quotation(sales, { nextFollowUpDate: today });
        const later = await quotation(sales, { nextFollowUpDate: FAR_FUTURE });
        const ids = async (enquiryId: string) =>
          (await listQuotations(sales, { enquiryId, followUpDue: true })).items.map((q) => q.id);
        expect(await ids(due.enquiryId)).toEqual([due.id]);
        expect(await ids(later.enquiryId)).toEqual([]);
      });

      it('rolls over at midnight IST, not UTC', async () => {
        const q = await quotation(sales, { nextFollowUpDate: '2026-09-28' });
        const due = async () =>
          (await listQuotations(sales, { enquiryId: q.enquiryId, followUpDue: true })).items.length;

        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-09-27T18:25:00.000Z')); // 23:55 IST on the 27th
        expect(await due()).toBe(0);
        vi.setSystemTime(new Date('2026-09-27T18:35:00.000Z')); // 00:05 IST on the 28th
        expect(await due()).toBe(1);
      });
    });
  });

  describe('AC15: several quotations per enquiry', () => {
    it('allows more than one and lists them for the enquiry, in scope', async () => {
      const enquiry = await convertedEnquiry();
      const a = await createQuotation(sales, input(enquiry.id));
      const b = await createQuotation(sales, input(enquiry.id, { amount: '99000' }));
      const listed = await listQuotationsForEnquiry(sales, enquiry.id);
      expect(listed.map((q) => q.id).sort()).toEqual([a.id, b.id].sort());
      expect(await rejection(listQuotationsForEnquiry(sales2, enquiry.id))).toBeInstanceOf(
        NotFoundError,
      );
    });
  });
});
