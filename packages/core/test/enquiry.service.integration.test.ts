import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { scopeEnquiries } from '../rbac/scope.ts';
import type { CreateEnquiryInput } from '../schemas/enquiry.ts';
import { createClient, softDeleteClient } from '../services/client.service.ts';
import {
  convertEnquiry,
  createEnquiry,
  getEnquiry,
  getQuotationDraft,
  listEnquiries,
  listEnquiryOwnerOptions,
  markEnquiryLost,
  restoreEnquiry,
  softDeleteEnquiry,
  updateEnquiry,
} from '../services/enquiry.service.ts';
import { createSector, updateSector } from '../services/sector.service.ts';
import { createService, softDeleteService, updateService } from '../services/service.service.ts';
import { deactivateUser } from '../services/user.service.ts';
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

describe('enquiries (integration)', () => {
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
  let beta: string;

  /** A valid enquiry for `sales`, overridable per test. */
  const input = (overrides: Partial<CreateEnquiryInput> = {}): CreateEnquiryInput => ({
    clientId: acme,
    sectorId: pharma,
    serviceIds: [inspection, audit],
    receivedDate: '2026-03-10',
    source: 'EMAIL',
    ...overrides,
  });

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

    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    steel = (await createSector(admin, { name: 'Steel' })).id;
    inspection = (await createService(admin, { name: 'Inspection' })).id;
    audit = (await createService(admin, { name: 'Audit' })).id;
    certification = (await createService(admin, { name: 'Certification' })).id;
    acme = (await createClient(admin, { name: 'Acme Pharma', sectorId: pharma })).id;
    beta = (await createClient(admin, { name: 'Beta Steel', sectorId: steel })).id;
  });
  afterAll(disconnectAll);

  describe('AC1: create', () => {
    it('creates an IN_PROGRESS enquiry owned by the creator, with a number and audit rows', async () => {
      const enquiry = await createEnquiry(sales, input({ description: 'Plant inspection' }));

      expect(enquiry).toMatchObject({
        status: 'IN_PROGRESS',
        ownerId: sales.user.id,
        source: 'EMAIL',
        client: { id: acme, name: 'Acme Pharma' },
        sector: { id: pharma, name: 'Pharma' },
      });
      expect(enquiry.number).toMatch(/^ENQ-2026-\d{4}$/);
      expect(enquiry.receivedDate.toISOString()).toBe('2026-03-10T00:00:00.000Z');
      expect(enquiry.services.map((s) => s.name).sort()).toEqual(['Audit', 'Inspection']);

      const [created] = await auditOf('Enquiry', enquiry.id);
      expect(created).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
      const request = await getDb().auditLog.findMany({
        where: { requestId: created!.requestId },
      });
      const byType = (type: string) => request.filter((r) => r.entityType === type);
      expect(byType('Enquiry')).toHaveLength(1);
      expect(byType('EnquiryService').map((r) => r.action)).toEqual(['CREATE', 'CREATE']);
      expect(byType('NumberSequence')).not.toHaveLength(0);
    });

    it('lets an admin create an enquiry for an active sales user', async () => {
      const enquiry = await createEnquiry(admin, input({ ownerId: sales2.user.id }));
      expect(enquiry.ownerId).toBe(sales2.user.id);
    });

    it('is forbidden for project managers', async () => {
      expect(await rejection(createEnquiry(pm, input()))).toBeInstanceOf(ForbiddenError);
    });
  });

  describe('AC2: validation', () => {
    it.each([
      ['no services', { serviceIds: [] }, 'serviceIds'],
      ['duplicate services', { serviceIds: ['x', 'x'] }, 'serviceIds'],
      ['a future received date', { receivedDate: '2099-01-01' }, 'receivedDate'],
      ['a proposal before receipt', { proposalSentDate: '2026-03-01' }, 'proposalSentDate'],
      ['a referral without detail', { source: 'REFERRAL' as const }, 'sourceDetail'],
    ])('rejects %s', async (_name, overrides, field) => {
      const error = await rejection(createEnquiry(sales, input(overrides)));
      expect(error).toMatchObject({ name: 'ZodError' });
      expect(JSON.stringify(error)).toContain(field);
    });

    it('rejects a deleted client', async () => {
      const gone = await createClient(admin, { name: 'Gone Ltd', sectorId: pharma });
      await softDeleteClient(admin, gone.id);
      expect(fieldOf(await rejection(createEnquiry(sales, input({ clientId: gone.id }))))).toBe(
        'clientId',
      );
    });

    it('rejects an inactive sector and an inactive or deleted service', async () => {
      const retired = await createSector(admin, { name: 'Retired sector' });
      await updateSector(admin, retired.id, { active: false });
      expect(fieldOf(await rejection(createEnquiry(sales, input({ sectorId: retired.id }))))).toBe(
        'sectorId',
      );

      const inactive = await createService(admin, { name: 'Inactive service' });
      await updateService(admin, inactive.id, { active: false });
      const deleted = await createService(admin, { name: 'Deleted service' });
      await softDeleteService(admin, deleted.id);
      for (const id of [inactive.id, deleted.id]) {
        const error = await rejection(
          createEnquiry(sales, input({ serviceIds: [inspection, id] })),
        );
        expect(fieldOf(error)).toBe('serviceIds');
      }
    });

    it('rejects a non-admin setting another owner', async () => {
      const error = await rejection(createEnquiry(sales, input({ ownerId: sales2.user.id })));
      expect(fieldOf(error)).toBe('ownerId');
    });

    it('rejects an owner who is inactive or a project manager', async () => {
      for (const ownerId of [inactiveSalesId, pm.user.id]) {
        expect(fieldOf(await rejection(createEnquiry(admin, input({ ownerId }))))).toBe('ownerId');
      }
    });
  });

  describe('AC3: update', () => {
    it('writes one UPDATE with the changed fields', async () => {
      const enquiry = await createEnquiry(sales, input());
      await updateEnquiry(sales, enquiry.id, { description: 'Updated', source: 'PHONE' });
      const rows = await auditOf('Enquiry', enquiry.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]!.changedFields).toEqual(expect.arrayContaining(['description', 'source']));
      expect(rows[1]!.changedFields).not.toContain('receivedDate');
    });

    it('diffs services: {A, B} → {B, C} deletes A, creates C, leaves B', async () => {
      const enquiry = await createEnquiry(sales, input({ serviceIds: [inspection, audit] }));
      const links = await getDb().enquiryService.findMany({ where: { enquiryId: enquiry.id } });
      const linkOf = (serviceId: string) => links.find((l) => l.serviceId === serviceId)!.id;

      const updated = await updateEnquiry(sales, enquiry.id, {
        serviceIds: [audit, certification],
      });
      expect(updated.services.map((s) => s.name).sort()).toEqual(['Audit', 'Certification']);

      expect((await auditOf('EnquiryService', linkOf(inspection))).map((r) => r.action)).toEqual([
        'CREATE',
        'DELETE',
      ]);
      expect((await auditOf('EnquiryService', linkOf(audit))).map((r) => r.action)).toEqual([
        'CREATE',
      ]);
      const created = await getDb().auditLog.findMany({
        where: {
          entityType: 'EnquiryService',
          action: 'CREATE',
          after: { path: ['serviceId'], equals: certification },
        },
      });
      expect(created).toHaveLength(1);
      // Only services changed: no UPDATE on the enquiry row itself.
      expect((await auditOf('Enquiry', enquiry.id)).map((r) => r.action)).toEqual(['CREATE']);
    });

    it('edits an enquiry whose sector was retired since', async () => {
      const sector = await createSector(admin, { name: 'Soon retired' });
      const enquiry = await createEnquiry(sales, input({ sectorId: sector.id }));
      await updateSector(admin, sector.id, { active: false });
      const updated = await updateEnquiry(sales, enquiry.id, { description: 'Just a note' });
      expect(updated.sector.name).toBe('Soon retired');
    });

    it('checks dates and source detail against the merged record', async () => {
      const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-12' }));
      expect(
        fieldOf(await rejection(updateEnquiry(sales, enquiry.id, { receivedDate: '2026-03-20' }))),
      ).toBe('proposalSentDate');
      expect(
        fieldOf(await rejection(updateEnquiry(sales, enquiry.id, { source: 'TENDER_PORTAL' }))),
      ).toBe('sourceDetail');
      const ok = await updateEnquiry(sales, enquiry.id, {
        source: 'TENDER_PORTAL',
        sourceDetail: 'GeM 2026/B/4411',
      });
      expect(ok.sourceDetail).toBe('GeM 2026/B/4411');
    });

    it('clears optional fields with an empty string', async () => {
      const enquiry = await createEnquiry(
        sales,
        input({ description: 'x', proposalSentDate: '2026-03-11' }),
      );
      const updated = await updateEnquiry(sales, enquiry.id, {
        description: '',
        proposalSentDate: '',
      });
      expect(updated.description).toBeNull();
      expect(updated.proposalSentDate).toBeNull();
    });

    it('does not re-check an unchanged client that was deleted since', async () => {
      const client = await createClient(admin, { name: 'Later deleted', sectorId: pharma });
      const enquiry = await createEnquiry(sales, input({ clientId: client.id }));
      await softDeleteClient(admin, client.id);
      await expect(updateEnquiry(sales, enquiry.id, { description: 'ok' })).resolves.toBeDefined();
      // Re-sending the same client id is not a change either.
      await expect(
        updateEnquiry(sales, enquiry.id, { clientId: client.id, sectorId: steel }),
      ).resolves.toMatchObject({ sectorId: steel });
    });
  });

  describe('AC4: RBAC', () => {
    let theirs: string;

    beforeAll(async () => {
      theirs = (await createEnquiry(sales2, input())).id;
    });

    it.each([
      ['get', () => getEnquiry(sales, theirs)],
      ['update', () => updateEnquiry(sales, theirs, { description: 'mine now' })],
      ['convert', () => convertEnquiry(sales, { id: theirs, proposalSentDate: '2026-03-11' })],
      ['mark lost', () => markEnquiryLost(sales, { id: theirs, lostReason: 'x' })],
      ['delete', () => softDeleteEnquiry(sales, theirs)],
      ['restore', () => restoreEnquiry(sales, theirs)],
      ['quotation draft', () => getQuotationDraft(sales, theirs)],
    ])('a sales user cannot %s another rep’s enquiry (not found)', async (_name, call) => {
      expect(await rejection(call())).toBeInstanceOf(NotFoundError);
      expect((await getEnquiry(sales2, theirs)).description).toBeNull(); // unchanged
    });

    it('a project manager sees no enquiries without a live project of theirs (M8; see project-rbac)', async () => {
      expect(await rejection(getEnquiry(pm, theirs))).toBeInstanceOf(NotFoundError);
      expect((await listEnquiries(pm, {})).total).toBe(0);
    });

    it('lists only own enquiries for sales and all for admins', async () => {
      const mine = await listEnquiries(sales, { pageSize: 100 });
      expect(mine.items.every((e) => e.ownerId === sales.user.id)).toBe(true);
      const all = await listEnquiries(admin, { pageSize: 100 });
      expect(all.total).toBeGreaterThan(mine.total);
      expect(all.items.some((e) => e.ownerId === sales2.user.id)).toBe(true);
    });

    it('only admins can reassign, and only to an active sales or admin user', async () => {
      const enquiry = await createEnquiry(sales, input());
      expect(
        fieldOf(await rejection(updateEnquiry(sales, enquiry.id, { ownerId: sales2.user.id }))),
      ).toBe('ownerId');
      expect(
        fieldOf(await rejection(updateEnquiry(admin, enquiry.id, { ownerId: pm.user.id }))),
      ).toBe('ownerId');

      const moved = await updateEnquiry(admin, enquiry.id, { ownerId: sales2.user.id });
      expect(moved.ownerId).toBe(sales2.user.id);
      const [, update] = await auditOf('Enquiry', enquiry.id);
      expect(update).toMatchObject({ action: 'UPDATE', actorId: admin.user.id });
      expect(update!.changedFields).toContain('ownerId');
    });

    it('owner options list active sales and admin users, for admins only', async () => {
      const options = await listEnquiryOwnerOptions(admin);
      const ids = options.map((o) => o.id);
      expect(ids).toEqual(expect.arrayContaining([admin.user.id, sales.user.id, sales2.user.id]));
      expect(ids).not.toContain(pm.user.id);
      expect(ids).not.toContain(inactiveSalesId);
      expect(await rejection(listEnquiryOwnerOptions(sales))).toBeInstanceOf(ForbiddenError);
    });

    it('scopeEnquiries returns the row filter per role', () => {
      expect(scopeEnquiries(admin.user)).toEqual({});
      expect(scopeEnquiries(sales.user)).toEqual({ ownerId: sales.user.id });
      // M8: enquiries behind the live projects the PM manages.
      expect(scopeEnquiries(pm.user)).toEqual({
        quotations: { some: { projects: { some: { managerId: pm.user.id, deletedAt: null } } } },
      });
    });
  });

  describe('AC6 / AC7: convert and mark lost', () => {
    it('converts with the proposal date in the same update and returns a quotation draft', async () => {
      const enquiry = await createEnquiry(
        sales,
        input({ serviceIds: [inspection, certification] }),
      );
      const { enquiry: converted, quotationDraft } = await convertEnquiry(sales, {
        id: enquiry.id,
        proposalSentDate: '2026-03-15',
      });

      expect(converted.status).toBe('CONVERTED');
      expect(converted.statusChangedAt).toBeInstanceOf(Date);
      expect(converted.proposalSentDate?.toISOString()).toBe('2026-03-15T00:00:00.000Z');

      // The PLAN.md "done when": converting pre-fills a new quotation.
      expect(quotationDraft).toEqual({
        enquiryId: enquiry.id,
        enquiryNumber: enquiry.number,
        clientId: acme,
        sectorId: pharma,
        serviceIds: [inspection, certification].sort(),
        ownerId: sales.user.id,
        quotationDate: new Date('2026-03-15T00:00:00.000Z'),
      });

      const rows = await auditOf('Enquiry', enquiry.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]!.changedFields).toEqual(
        expect.arrayContaining(['status', 'statusChangedAt', 'proposalSentDate']),
      );
    });

    it('converts using the stored proposal date', async () => {
      const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
      const { quotationDraft } = await convertEnquiry(sales, { id: enquiry.id });
      expect(quotationDraft.quotationDate.toISOString()).toBe('2026-03-11T00:00:00.000Z');
    });

    it('rejects converting without a proposal date, or with one before receipt', async () => {
      const enquiry = await createEnquiry(sales, input());
      expect(fieldOf(await rejection(convertEnquiry(sales, { id: enquiry.id })))).toBe(
        'proposalSentDate',
      );
      expect(
        fieldOf(
          await rejection(
            convertEnquiry(sales, { id: enquiry.id, proposalSentDate: '2026-03-01' }),
          ),
        ),
      ).toBe('proposalSentDate');
    });

    it('marks lost with a reason; a lost enquiry cannot be converted', async () => {
      const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
      const lost = await markEnquiryLost(sales, { id: enquiry.id, lostReason: 'Budget cut' });
      expect(lost).toMatchObject({ status: 'LOST', lostReason: 'Budget cut' });
      expect(lost.statusChangedAt).toBeInstanceOf(Date);
      expect(await rejection(convertEnquiry(sales, { id: enquiry.id }))).toBeInstanceOf(
        DomainError,
      );
      expect(
        await rejection(markEnquiryLost(sales, { id: enquiry.id, lostReason: 'again' })),
      ).toBeInstanceOf(DomainError);

      // One audited UPDATE for the transition; the rejected moves wrote nothing.
      const rows = await auditOf('Enquiry', enquiry.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]).toMatchObject({ source: 'web', actorId: sales.user.id });
      expect(rows[1]!.changedFields).toEqual(
        expect.arrayContaining(['status', 'lostReason', 'statusChangedAt']),
      );
    });
  });

  // Code-review fix: convert, mark lost and delete read the status and then write it. Two
  // requests at once must not both succeed (e.g. CONVERTED with a lostReason, or a
  // converted enquiry deleted, breaking Decision 6).
  describe('concurrent status changes', () => {
    const ROUNDS = 10;

    it('convert vs mark lost: exactly one wins and one transition is audited', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
        const results = await Promise.allSettled([
          convertEnquiry(sales, { id: enquiry.id }),
          markEnquiryLost(admin, { id: enquiry.id, lostReason: 'Race' }),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(DomainError);
        }
        const row = await getDb().enquiry.findUniqueOrThrow({ where: { id: enquiry.id } });
        if (row.status === 'CONVERTED') expect(row.lostReason).toBeNull();
        else expect(row).toMatchObject({ status: 'LOST', lostReason: 'Race' });
        expect((await auditOf('Enquiry', enquiry.id)).map((r) => r.action)).toEqual([
          'CREATE',
          'UPDATE',
        ]);
      }
    });

    it('convert vs delete: a converted enquiry is never deleted', async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
        const results = await Promise.allSettled([
          convertEnquiry(sales, { id: enquiry.id }),
          softDeleteEnquiry(sales, enquiry.id),
        ]);

        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const row = await getDb().enquiry.findFirstOrThrow({
          where: { id: enquiry.id, deletedAt: undefined },
        });
        expect(row.status === 'CONVERTED' && row.deletedAt !== null).toBe(false);
        expect(await auditOf('Enquiry', enquiry.id)).toHaveLength(2);
      }
    });
  });

  describe('AC8: status only through the machine', () => {
    it('ignores status in updates', async () => {
      const enquiry = await createEnquiry(sales, input());
      const updated = await updateEnquiry(sales, enquiry.id, {
        description: 'x',
        status: 'LOST',
      } as Parameters<typeof updateEnquiry>[2]);
      expect(updated.status).toBe('IN_PROGRESS');
    });

    it('cannot clear the proposal date of a converted enquiry', async () => {
      const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
      await convertEnquiry(sales, { id: enquiry.id });
      expect(
        fieldOf(await rejection(updateEnquiry(sales, enquiry.id, { proposalSentDate: '' }))),
      ).toBe('proposalSentDate');
    });

    it('the database rejects CONVERTED without a proposal date, even via raw SQL', async () => {
      const enquiry = await createEnquiry(sales, input());
      await expect(
        getDb().$executeRawUnsafe(
          `UPDATE "enquiry" SET "status" = 'CONVERTED' WHERE "id" = $1`,
          enquiry.id,
        ),
      ).rejects.toThrow(/enquiry_converted_has_proposal/);
    });

    it('the database rejects a proposal before receipt', async () => {
      const enquiry = await createEnquiry(sales, input());
      await expect(
        getDb().$executeRawUnsafe(
          `UPDATE "enquiry" SET "proposalSentDate" = '2026-01-01' WHERE "id" = $1`,
          enquiry.id,
        ),
      ).rejects.toThrow(/enquiry_proposal_after_received/);
    });
  });

  describe('AC9: soft delete', () => {
    it('deletes and restores in-progress and lost enquiries', async () => {
      const open = await createEnquiry(sales, input());
      const lost = await createEnquiry(sales, input());
      await markEnquiryLost(sales, { id: lost.id, lostReason: 'No budget' });

      for (const { id } of [open, lost]) {
        await softDeleteEnquiry(sales, id);
        expect(
          (await listEnquiries(sales, { pageSize: 100 })).items.map((e) => e.id),
        ).not.toContain(id);
        const deleted = await listEnquiries(sales, { pageSize: 100, recordStatus: 'deleted' });
        expect(deleted.items.map((e) => e.id)).toContain(id);
        expect((await getEnquiry(sales, id)).deletedAt).toBeInstanceOf(Date);

        await restoreEnquiry(sales, id);
        expect((await auditOf('Enquiry', id)).map((r) => r.action).slice(-2)).toEqual([
          'SOFT_DELETE',
          'RESTORE',
        ]);
      }
    });

    it('rejects deleting a converted enquiry', async () => {
      const enquiry = await createEnquiry(sales, input({ proposalSentDate: '2026-03-11' }));
      await convertEnquiry(sales, { id: enquiry.id });
      expect(await rejection(softDeleteEnquiry(sales, enquiry.id))).toBeInstanceOf(DomainError);
    });

    it('cannot update a deleted enquiry', async () => {
      const enquiry = await createEnquiry(sales, input());
      await softDeleteEnquiry(sales, enquiry.id);
      expect(
        await rejection(updateEnquiry(sales, enquiry.id, { description: 'x' })),
      ).toBeInstanceOf(NotFoundError);
    });
  });

  describe('AC10 / AC13: list filters, search, sort, source', () => {
    let owner: Ctx;
    const ids: Record<string, string> = {};

    beforeAll(async () => {
      // A dedicated owner so earlier tests' enquiries don't affect the counts.
      owner = ctxFor(
        actor('SALES', { id: (await createTestUser('lister@example.test', 'SALES')).id }),
      );
      const make = async (key: string, overrides: Partial<CreateEnquiryInput>) => {
        ids[key] = (await createEnquiry(owner, input(overrides))).id;
      };
      await make('email', { receivedDate: '2026-01-05', description: 'Boiler inspection' });
      await make('tender', {
        clientId: beta,
        sectorId: steel,
        serviceIds: [certification],
        receivedDate: '2026-02-10',
        proposalSentDate: '2026-02-20',
        source: 'TENDER_PORTAL',
        sourceDetail: 'GeM 2026/B/9001',
      });
      await make('referral', {
        receivedDate: '2026-04-01',
        source: 'REFERRAL',
        sourceDetail: 'Referred by Asha',
      });
      await markEnquiryLost(owner, { id: ids.referral!, lostReason: 'Price' });
    });

    const idsOf = async (filters: Parameters<typeof listEnquiries>[1]) =>
      (await listEnquiries(owner, { pageSize: 100, ...filters })).items.map((e) => e.id).sort();
    const sorted = (...keys: string[]) => keys.map((k) => ids[k]!).sort();

    it('filters by status, source, client, sector and service', async () => {
      expect(await idsOf({ status: ['LOST'] })).toEqual(sorted('referral'));
      expect(await idsOf({ status: 'IN_PROGRESS,LOST' })).toEqual(
        sorted('email', 'tender', 'referral'),
      );
      expect(await idsOf({ source: ['TENDER_PORTAL', 'REFERRAL'] })).toEqual(
        sorted('tender', 'referral'),
      );
      expect(await idsOf({ clientId: beta })).toEqual(sorted('tender'));
      expect(await idsOf({ sectorId: pharma })).toEqual(sorted('email', 'referral'));
      expect(await idsOf({ serviceId: certification })).toEqual(sorted('tender'));
    });

    it('filters by received and proposal-sent date ranges (inclusive)', async () => {
      expect(await idsOf({ receivedFrom: '2026-02-10', receivedTo: '2026-04-01' })).toEqual(
        sorted('tender', 'referral'),
      );
      expect(await idsOf({ proposalSentFrom: '2026-02-01', proposalSentTo: '2026-02-20' })).toEqual(
        sorted('tender'),
      );
    });

    it('searches number, client name, description and source detail', async () => {
      const tender = await getEnquiry(owner, ids.tender!);
      expect(await idsOf({ q: tender.number })).toEqual(sorted('tender'));
      expect(await idsOf({ q: '9001' })).toEqual(sorted('tender'));
      expect(await idsOf({ q: 'beta' })).toEqual(sorted('tender'));
      expect(await idsOf({ q: 'boiler' })).toEqual(sorted('email'));
      expect(await idsOf({ q: 'asha' })).toEqual(sorted('referral'));
    });

    it('sorts and paginates (default: received date, newest first)', async () => {
      const page1 = await listEnquiries(owner, { pageSize: 2 });
      expect(page1.total).toBe(3);
      expect(page1.items.map((e) => e.id)).toEqual([ids.referral, ids.tender]);
      const page2 = await listEnquiries(owner, { pageSize: 2, page: 2 });
      expect(page2.items.map((e) => e.id)).toEqual([ids.email]);
      const byClient = await listEnquiries(owner, { sort: 'client', dir: 'desc' });
      expect(byClient.items[0]!.client.name).toBe('Beta Steel');
    });

    it('combines filters with the RBAC scope', async () => {
      expect((await listEnquiries(sales, { ownerId: owner.user.id })).total).toBe(0);
      expect((await listEnquiries(admin, { ownerId: owner.user.id })).total).toBe(3);
    });

    it('stores, edits and audits source and detail', async () => {
      const updated = await updateEnquiry(owner, ids.email!, {
        source: 'OTHER',
        sourceDetail: 'Trade fair stall',
      });
      expect(updated).toMatchObject({ source: 'OTHER', sourceDetail: 'Trade fair stall' });
      const [, update] = await auditOf('Enquiry', ids.email!);
      expect(update!.changedFields).toEqual(expect.arrayContaining(['source', 'sourceDetail']));
    });
  });

  describe('AC11: quotation draft', () => {
    it('is available only for converted enquiries', async () => {
      const enquiry = await createEnquiry(sales, input());
      expect(await rejection(getQuotationDraft(sales, enquiry.id))).toBeInstanceOf(DomainError);
      await convertEnquiry(sales, { id: enquiry.id, proposalSentDate: '2026-03-10' });
      const draft = await getQuotationDraft(sales, enquiry.id);
      expect(draft.quotationDate.toISOString()).toBe('2026-03-10T00:00:00.000Z');
      expect(draft.enquiryNumber).toBe(enquiry.number);
    });
  });
});
