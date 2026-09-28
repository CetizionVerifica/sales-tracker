import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import type { CreateFollowUpInput } from '../schemas/follow-up.ts';
import { createClient, removeContact, softDeleteClient } from '../services/client.service.ts';
import { createEnquiry, softDeleteEnquiry } from '../services/enquiry.service.ts';
import {
  CONCURRENT_FOLLOW_UP_CHANGE,
  getFollowUp,
  getLatestFollowUp,
  listFollowUps,
  listFollowUpTargets,
  logFollowUp,
  restoreFollowUp,
  softDeleteFollowUp,
  updateFollowUp,
} from '../services/follow-up.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
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

const auditOf = (entityId: string) =>
  getDb().auditLog.findMany({
    where: { entityType: 'FollowUp', entityId },
    orderBy: { createdAt: 'asc' },
  });

describe('follow-ups (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let sales2: Ctx;
  let pm: Ctx;
  let sectorId: string;
  let serviceId: string;
  let n = 0;

  /** A fresh client with one contact, so list assertions don't see other tests' rows. */
  async function newClient() {
    n += 1;
    const client = await createClient(admin, {
      name: `Client ${n}`,
      sectorId,
      contacts: [{ name: `Contact ${n}`, isPrimary: true }],
    });
    return { id: client.id, contactId: client.contacts[0]!.id };
  }

  const newEnquiry = async (owner: Ctx, clientId: string) =>
    createEnquiry(owner, {
      clientId,
      sectorId,
      serviceIds: [serviceId],
      receivedDate: '2026-03-01',
      source: 'EMAIL',
    });

  const onEnquiry = (
    enquiryId: string,
    overrides: Partial<CreateFollowUpInput> = {},
  ): CreateFollowUpInput => ({
    entityType: 'ENQUIRY',
    entityId: enquiryId,
    date: '2026-03-10',
    channel: 'CALL',
    notes: 'Discussed scope',
    ...overrides,
  });

  const onClient = (
    clientId: string,
    overrides: Partial<CreateFollowUpInput> = {},
  ): CreateFollowUpInput => ({ ...onEnquiry(clientId), entityType: 'CLIENT', ...overrides });

  beforeAll(async () => {
    await resetDb(getDb());
    const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
      ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
    admin = await user('admin@example.test', 'ADMIN');
    sales = await user('sales@example.test', 'SALES');
    sales2 = await user('sales2@example.test', 'SALES');
    pm = await user('pm@example.test', 'PROJECT_MANAGER');
    sectorId = (await createSector(admin, { name: 'Pharma' })).id;
    serviceId = (await createService(admin, { name: 'Inspection' })).id;
  });
  afterAll(disconnectAll);

  describe('AC1: log', () => {
    it('logs a follow-up on an own enquiry, derives client and author, and audits it', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);

      const followUp = await logFollowUp(
        sales,
        onEnquiry(enquiry.id, {
          channel: 'MEETING',
          contactId: client.contactId,
          nextFollowUpDate: '2026-03-17',
        }),
      );

      expect(followUp).toMatchObject({
        clientId: client.id,
        userId: sales.user.id,
        entityType: 'ENQUIRY',
        entityId: enquiry.id,
        channel: 'MEETING',
        notes: 'Discussed scope',
        contact: { id: client.contactId },
        user: { id: sales.user.id },
        entityLabel: enquiry.number,
      });
      expect(followUp.date.toISOString()).toBe('2026-03-10T00:00:00.000Z');
      expect(followUp.nextFollowUpDate?.toISOString()).toBe('2026-03-17T00:00:00.000Z');

      const rows = await auditOf(followUp.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'CREATE', source: 'web', actorId: sales.user.id });
    });

    it('logs a client-level follow-up with entityId = clientId', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      expect(followUp).toMatchObject({
        clientId: client.id,
        entityType: 'CLIENT',
        entityId: client.id,
        entityLabel: `Client ${n}`,
      });
    });
  });

  describe('AC2: validation', () => {
    it('rejects a contact from another client, and a deleted contact', async () => {
      const client = await newClient();
      const other = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      expect(
        fieldOf(
          await rejection(
            logFollowUp(sales, onEnquiry(enquiry.id, { contactId: other.contactId })),
          ),
        ),
      ).toBe('contactId');

      await removeContact(admin, client.contactId);
      expect(
        fieldOf(
          await rejection(
            logFollowUp(sales, onEnquiry(enquiry.id, { contactId: client.contactId })),
          ),
        ),
      ).toBe('contactId');
    });

    it('rejects a record type whose module has not shipped', async () => {
      const error = await rejection(
        logFollowUp(sales, { ...onEnquiry('x'), entityType: 'INVOICE' }),
      );
      expect(fieldOf(error)).toBe('entityType');
    });

    it('rejects a missing or deleted enquiry as not found', async () => {
      expect(await rejection(logFollowUp(sales, onEnquiry('missing')))).toBeInstanceOf(
        NotFoundError,
      );
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      await softDeleteEnquiry(sales, enquiry.id);
      expect(await rejection(logFollowUp(sales, onEnquiry(enquiry.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('rejects a deleted client, directly and through its enquiry', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      await softDeleteClient(admin, client.id);
      expect(await rejection(logFollowUp(sales, onClient(client.id)))).toBeInstanceOf(
        NotFoundError,
      );
      expect(await rejection(logFollowUp(sales, onEnquiry(enquiry.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('rejects switching to a contact from another client on update', async () => {
      const client = await newClient();
      const other = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      expect(
        fieldOf(
          await rejection(updateFollowUp(sales, followUp.id, { contactId: other.contactId })),
        ),
      ).toBe('contactId');
      expect(
        (await updateFollowUp(sales, followUp.id, { contactId: client.contactId })).contact,
      ).toMatchObject({ id: client.contactId });
    });

    it('rejects an update whose next date falls before the stored date', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id, { date: '2026-03-10' }));
      expect(
        fieldOf(
          await rejection(updateFollowUp(sales, followUp.id, { nextFollowUpDate: '2026-03-05' })),
        ),
      ).toBe('nextFollowUpDate');
      expect(
        fieldOf(
          await rejection(
            updateFollowUp(sales, followUp.id, { date: '2026-03-12' }).then(() =>
              updateFollowUp(sales, followUp.id, { nextFollowUpDate: '2026-03-11' }),
            ),
          ),
        ),
      ).toBe('nextFollowUpDate');
    });

    it('the database rejects a next date before the date, even via raw SQL', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      await expect(
        getDb().$executeRawUnsafe(
          `UPDATE "follow_up" SET "nextFollowUpDate" = '2026-01-01' WHERE "id" = $1`,
          followUp.id,
        ),
      ).rejects.toThrow(/follow_up_next_after_date/);
    });

    it('the database rejects a client-level follow-up linked to something else', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      await expect(
        getDb().$executeRawUnsafe(
          `UPDATE "follow_up" SET "entityId" = 'other' WHERE "id" = $1`,
          followUp.id,
        ),
      ).rejects.toThrow(/follow_up_client_entity_is_client/);
    });
  });

  describe('AC3: RBAC on writes', () => {
    it('a Sales user cannot log on another rep’s enquiry (not found)', async () => {
      const client = await newClient();
      const theirs = await newEnquiry(sales2, client.id);
      expect(await rejection(logFollowUp(sales, onEnquiry(theirs.id)))).toBeInstanceOf(
        NotFoundError,
      );
    });

    it('a project manager cannot log on an enquiry with no project of theirs (M8; see project-rbac)', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      expect(await rejection(logFollowUp(pm, onEnquiry(enquiry.id)))).toBeInstanceOf(NotFoundError);
    });

    it('anyone may log a client-level follow-up', async () => {
      const client = await newClient();
      for (const ctx of [admin, sales, sales2, pm]) {
        expect((await logFollowUp(ctx, onClient(client.id))).userId).toBe(ctx.user.id);
      }
    });

    it('an admin may log on any enquiry', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      expect((await logFollowUp(admin, onEnquiry(enquiry.id))).userId).toBe(admin.user.id);
    });

    it('only the author or an admin edits or deletes', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      const clientNote = await logFollowUp(sales, onClient(client.id));
      const enquiryNote = await logFollowUp(sales, onEnquiry(enquiry.id));

      // sales2 can read the client-level note, so they are forbidden (not "not found").
      expect(await rejection(updateFollowUp(sales2, clientNote.id, { notes: 'x' }))).toBeInstanceOf(
        ForbiddenError,
      );
      expect(await rejection(softDeleteFollowUp(sales2, clientNote.id))).toBeInstanceOf(
        ForbiddenError,
      );
      // They cannot read the note on sales's enquiry at all.
      expect(
        await rejection(updateFollowUp(sales2, enquiryNote.id, { notes: 'x' })),
      ).toBeInstanceOf(NotFoundError);

      expect((await updateFollowUp(admin, enquiryNote.id, { notes: 'Fixed' })).notes).toBe('Fixed');
      await softDeleteFollowUp(admin, clientNote.id);
      await restoreFollowUp(admin, clientNote.id);
    });

    it('only the author or an admin restores', async () => {
      const client = await newClient();
      const note = await logFollowUp(sales, onClient(client.id));
      await softDeleteFollowUp(sales, note.id);
      // sales2 can read the client-level note, so they are forbidden (not "not found").
      expect(await rejection(restoreFollowUp(sales2, note.id))).toBeInstanceOf(ForbiddenError);
      expect((await auditOf(note.id)).map((r) => r.action)).toEqual(['CREATE', 'SOFT_DELETE']);
    });

    it('the enquiry owner cannot edit an admin’s note on their enquiry', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      const adminNote = await logFollowUp(admin, onEnquiry(enquiry.id));
      expect(await rejection(updateFollowUp(sales, adminNote.id, { notes: 'x' }))).toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe('AC4: RBAC on reads', () => {
    it('scopes lists: own, client-level, and notes on records the user can read', async () => {
      const client = await newClient();
      const mine = await newEnquiry(sales, client.id);
      const theirs = await newEnquiry(sales2, client.id);
      const own = await logFollowUp(sales, onEnquiry(mine.id));
      const byAdminOnMine = await logFollowUp(admin, onEnquiry(mine.id));
      const clientLevelByOther = await logFollowUp(sales2, onClient(client.id));
      const onTheirs = await logFollowUp(sales2, onEnquiry(theirs.id));
      const pmNote = await logFollowUp(pm, onClient(client.id));

      const idsFor = async (ctx: Ctx) =>
        new Set((await listFollowUps(ctx, { clientId: client.id })).items.map((f) => f.id));

      expect(await idsFor(sales)).toEqual(
        new Set([own.id, byAdminOnMine.id, clientLevelByOther.id, pmNote.id]),
      );
      expect(await idsFor(admin)).toEqual(
        new Set([own.id, byAdminOnMine.id, clientLevelByOther.id, onTheirs.id, pmNote.id]),
      );
      expect(await idsFor(pm)).toEqual(new Set([clientLevelByOther.id, pmNote.id]));

      expect(await rejection(getFollowUp(sales, onTheirs.id))).toBeInstanceOf(NotFoundError);
      expect((await getFollowUp(sales, byAdminOnMine.id)).id).toBe(byAdminOnMine.id);
    });
  });

  describe('AC5: update and soft delete', () => {
    it('writes one UPDATE with the changed fields and keeps the link', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      const followUp = await logFollowUp(sales, onEnquiry(enquiry.id));

      const updated = await updateFollowUp(sales, followUp.id, {
        notes: 'Sent revised scope',
        channel: 'EMAIL',
        // Not part of the update schema: silently dropped.
        ...({ entityType: 'CLIENT', entityId: client.id } as object),
      });
      expect(updated).toMatchObject({
        notes: 'Sent revised scope',
        channel: 'EMAIL',
        entityType: 'ENQUIRY',
        entityId: enquiry.id,
      });
      const rows = await auditOf(followUp.id);
      expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
      expect(rows[1]!.changedFields).toEqual(expect.arrayContaining(['notes', 'channel']));
      expect(rows[1]!.changedFields).not.toContain('entityId');
    });

    it('soft deletes and restores, hiding deleted rows from lists', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      await softDeleteFollowUp(sales, followUp.id);

      expect((await listFollowUps(sales, { clientId: client.id })).items).toHaveLength(0);
      const deleted = await listFollowUps(sales, { clientId: client.id, recordStatus: 'deleted' });
      expect(deleted.items.map((f) => f.id)).toEqual([followUp.id]);

      await restoreFollowUp(sales, followUp.id);
      expect((await listFollowUps(sales, { clientId: client.id })).items).toHaveLength(1);
      expect((await auditOf(followUp.id)).map((r) => r.action)).toEqual([
        'CREATE',
        'SOFT_DELETE',
        'RESTORE',
      ]);
    });

    it('cannot edit a deleted follow-up', async () => {
      const client = await newClient();
      const followUp = await logFollowUp(sales, onClient(client.id));
      await softDeleteFollowUp(sales, followUp.id);
      expect(await rejection(updateFollowUp(sales, followUp.id, { notes: 'x' }))).toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  // Code-review fix: update, delete and restore read the follow-up, then write it. Two
  // requests at once must not both act on the state they read (the M4 enquiry race).
  describe('concurrent changes', () => {
    const ROUNDS = 10;
    // The loser fails either at the guarded write (it read the row before the winner
    // committed) or at the read (after): both are correct refusals.
    const refusedAsRace = (error: unknown) =>
      error instanceof NotFoundError ||
      (error instanceof DomainError && error.message === CONCURRENT_FOLLOW_UP_CHANGE);

    it('delete vs delete: exactly one wins and one SOFT_DELETE is audited', async () => {
      const client = await newClient();
      for (let round = 0; round < ROUNDS; round++) {
        const note = await logFollowUp(sales, onClient(client.id));
        const results = await Promise.allSettled([
          softDeleteFollowUp(sales, note.id),
          softDeleteFollowUp(admin, note.id),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        for (const r of results) {
          if (r.status === 'rejected') expect(refusedAsRace(r.reason)).toBe(true);
        }
        expect((await auditOf(note.id)).map((r) => r.action)).toEqual(['CREATE', 'SOFT_DELETE']);
      }
    });

    it('update vs delete: a deleted follow-up is never edited', async () => {
      const client = await newClient();
      for (let round = 0; round < ROUNDS; round++) {
        const note = await logFollowUp(sales, onClient(client.id));
        const results = await Promise.allSettled([
          updateFollowUp(sales, note.id, { notes: `edit ${round}` }),
          softDeleteFollowUp(admin, note.id),
        ]);
        const [update, remove] = results;
        expect(remove!.status).toBe('fulfilled');
        const actions = (await auditOf(note.id)).map((r) => r.action);
        if (update!.status === 'fulfilled') {
          expect(actions).toEqual(['CREATE', 'UPDATE', 'SOFT_DELETE']);
        } else {
          expect(refusedAsRace(update!.reason)).toBe(true);
          expect(actions).toEqual(['CREATE', 'SOFT_DELETE']);
        }
      }
    });
  });

  describe('AC9: latest follow-up', () => {
    it('returns the newest live follow-up by date, then createdAt', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      await logFollowUp(sales, onEnquiry(enquiry.id, { date: '2026-03-10', notes: 'first' }));
      const newest = await logFollowUp(
        sales,
        onEnquiry(enquiry.id, { date: '2026-03-14', notes: 'newest' }),
      );
      await logFollowUp(sales, onEnquiry(enquiry.id, { date: '2026-03-12', notes: 'backdated' }));

      expect((await getLatestFollowUp(sales, 'ENQUIRY', enquiry.id))?.id).toBe(newest.id);

      await softDeleteFollowUp(sales, newest.id);
      expect((await getLatestFollowUp(sales, 'ENQUIRY', enquiry.id))?.notes).toBe('backdated');

      const sameDay = await logFollowUp(
        sales,
        onEnquiry(enquiry.id, { date: '2026-03-12', notes: 'same day, later' }),
      );
      expect((await getLatestFollowUp(sales, 'ENQUIRY', enquiry.id))?.id).toBe(sameDay.id);
    });

    it('returns null when there is none, and applies read RBAC', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      expect(await getLatestFollowUp(sales, 'ENQUIRY', enquiry.id)).toBeNull();
      expect(await rejection(getLatestFollowUp(sales2, 'ENQUIRY', enquiry.id))).toBeInstanceOf(
        NotFoundError,
      );
    });
  });

  describe('AC10: list filters', () => {
    it('narrows by record, author, channel and both date ranges; sorts and pages', async () => {
      const client = await newClient();
      const enquiry = await newEnquiry(sales, client.id);
      const a = await logFollowUp(
        sales,
        onEnquiry(enquiry.id, {
          date: '2026-03-02',
          channel: 'CALL',
          nextFollowUpDate: '2026-03-20',
        }),
      );
      const b = await logFollowUp(
        sales,
        onClient(client.id, {
          date: '2026-03-05',
          channel: 'EMAIL',
          nextFollowUpDate: '2026-03-06',
        }),
      );
      const c = await logFollowUp(
        admin,
        onClient(client.id, { date: '2026-03-08', channel: 'MEETING' }),
      );

      const ids = async (input: Parameters<typeof listFollowUps>[1], ctx = sales) =>
        (await listFollowUps(ctx, { clientId: client.id, ...input })).items.map((f) => f.id);

      expect(await ids({})).toEqual([c.id, b.id, a.id]); // date desc by default
      expect(await ids({ entityType: 'ENQUIRY', entityId: enquiry.id })).toEqual([a.id]);
      expect(await ids({ userId: admin.user.id })).toEqual([c.id]);
      expect(await ids({ channel: ['CALL', 'MEETING'] })).toEqual([c.id, a.id]);
      expect(await ids({ dateFrom: '2026-03-03', dateTo: '2026-03-07' })).toEqual([b.id]);
      expect(await ids({ nextFrom: '2026-03-01', nextTo: '2026-03-10' })).toEqual([b.id]);
      expect(await ids({ sort: 'nextFollowUpDate', dir: 'asc' })).toEqual([b.id, a.id, c.id]);

      const page2 = await listFollowUps(sales, { clientId: client.id, pageSize: 2, page: 2 });
      expect(page2).toMatchObject({ total: 3, page: 2 });
      expect(page2.items.map((f) => f.id)).toEqual([a.id]);
    });

    it('filters combine with the RBAC scope', async () => {
      const client = await newClient();
      const theirs = await newEnquiry(sales2, client.id);
      await logFollowUp(sales2, onEnquiry(theirs.id));
      const page = await listFollowUps(sales, { entityType: 'ENQUIRY', entityId: theirs.id });
      expect(page.total).toBe(0);
    });
  });

  describe('record picker', () => {
    it('lists the client and its live enquiries the user can read', async () => {
      const client = await newClient();
      const mine = await newEnquiry(sales, client.id);
      await newEnquiry(sales2, client.id);
      const gone = await newEnquiry(sales, client.id);
      await softDeleteEnquiry(sales, gone.id);

      const targets = await listFollowUpTargets(sales, client.id);
      expect(targets).toEqual([
        { entityType: 'CLIENT', entityId: client.id, label: `Client ${n}` },
        { entityType: 'ENQUIRY', entityId: mine.id, label: mine.number },
      ]);
    });

    it('rejects a deleted client as not found', async () => {
      const client = await newClient();
      await softDeleteClient(admin, client.id);
      expect(await rejection(listFollowUpTargets(sales, client.id))).toBeInstanceOf(NotFoundError);
    });
  });
});
