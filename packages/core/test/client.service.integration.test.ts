import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError } from '../errors.ts';
import {
  addContact,
  createClient,
  getClient,
  listClientOptions,
  listClients,
  removeContact,
  restoreClient,
  setPrimaryContact,
  softDeleteClient,
  updateClient,
  updateContact,
} from '../services/client.service.ts';
import { createSector, softDeleteSector, updateSector } from '../services/sector.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

const fieldOf = (e: unknown) => (e instanceof DomainError ? e.field : undefined);

describe('clients and contacts (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let pm: Ctx;
  let pharma: string;
  let steel: string;
  let acmeId: string;

  beforeAll(async () => {
    await resetDb(getDb());
    admin = ctxFor(
      actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }),
    );
    sales = ctxFor(
      actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }),
    );
    pm = ctxFor(
      actor('PROJECT_MANAGER', {
        id: (await createTestUser('pm@example.test', 'PROJECT_MANAGER')).id,
      }),
    );
    pharma = (await createSector(admin, { name: 'Pharma' })).id;
    steel = (await createSector(admin, { name: 'Steel' })).id;
  });
  afterAll(disconnectAll);

  describe('AC10: clients', () => {
    it('creates a client with a sector, GSTIN and contacts', async () => {
      const client = await createClient(admin, {
        name: 'Acme Pharma',
        sectorId: pharma,
        gstin: '27aapfu0939f1zv',
        address: 'Mumbai',
        contacts: [
          { name: 'Asha', email: 'asha@acme.example', isPrimary: true },
          { name: 'Ravi', phone: '+91 98200 00000' },
        ],
      });
      acmeId = client.id;
      expect(client.gstin).toBe('27AAPFU0939F1ZV'); // normalised to upper case
      expect(client.contacts.map((c) => [c.name, c.isPrimary])).toEqual([
        ['Asha', true],
        ['Ravi', false],
      ]);
    });

    it('rejects an invalid GSTIN, a duplicate name, and two primary contacts', async () => {
      await expect(
        createClient(admin, { name: 'Bad Tax', sectorId: pharma, gstin: '12345' }),
      ).rejects.toThrow();
      expect(
        fieldOf(
          await createClient(admin, { name: 'ACME PHARMA', sectorId: pharma }).catch((e) => e),
        ),
      ).toBe('name');
      const twoPrimaries = await createClient(admin, {
        name: 'Two Heads',
        sectorId: pharma,
        contacts: [
          { name: 'A', isPrimary: true },
          { name: 'B', isPrimary: true },
        ],
      }).catch((e: unknown) => e);
      expect(fieldOf(twoPrimaries)).toBe('contacts');
    });

    it('rejects an inactive or deleted sector', async () => {
      const retired = (await createSector(admin, { name: 'Retired' })).id;
      await updateSector(admin, retired, { active: false });
      expect(
        fieldOf(await createClient(admin, { name: 'Old Co', sectorId: retired }).catch((e) => e)),
      ).toBe('sectorId');
    });

    it('updates, lists with search, sector filter, sort and pagination', async () => {
      await createClient(admin, { name: 'Bharat Steel', sectorId: steel });
      await createClient(admin, { name: 'Zenith Steel', sectorId: steel });
      await updateClient(admin, acmeId, { notes: 'Key account' });

      const bySector = await listClients(admin, {
        page: 1,
        pageSize: 50,
        sectorId: steel,
        sort: 'name',
        dir: 'desc',
      });
      expect(bySector.items.map((c) => c.name)).toEqual(['Zenith Steel', 'Bharat Steel']);
      expect(bySector.items[0]?.sector.name).toBe('Steel');
      expect(
        (await listClients(admin, { page: 1, pageSize: 50, q: 'acme' })).items.map((c) => c.id),
      ).toEqual([acmeId]);
      const page = await listClients(admin, { page: 2, pageSize: 2 });
      expect(page.items).toHaveLength(1);
      expect(page.total).toBe(3);
    });

    it('soft deletes and restores', async () => {
      await softDeleteClient(admin, acmeId);
      expect(
        (await listClients(admin, { page: 1, pageSize: 50 })).items.map((c) => c.id),
      ).not.toContain(acmeId);
      expect(
        (await listClients(admin, { page: 1, pageSize: 50, status: 'deleted' })).items.map(
          (c) => c.id,
        ),
      ).toEqual([acmeId]);
      await restoreClient(admin, acmeId);
      expect((await getClient(admin, acmeId)).deletedAt).toBeNull();
    });
  });

  describe('AC11: contacts', () => {
    it('adds, edits, removes, and keeps exactly one primary', async () => {
      const added = await addContact(admin, acmeId, { name: 'Meera', designation: 'Purchase' });
      await updateContact(admin, added.id, { designation: 'Head of Purchase' });
      await setPrimaryContact(admin, added.id);

      let client = await getClient(admin, acmeId);
      expect(client.contacts.filter((c) => c.isPrimary).map((c) => c.name)).toEqual(['Meera']);
      expect(client.contacts.find((c) => c.name === 'Meera')?.designation).toBe('Head of Purchase');

      const ravi = client.contacts.find((c) => c.name === 'Ravi')!;
      await removeContact(admin, ravi.id);
      client = await getClient(admin, acmeId);
      expect(client.contacts.map((c) => c.name).sort()).toEqual(['Asha', 'Meera']);
    });

    it('audits each contact write separately', async () => {
      const rows = await getDb().auditLog.findMany({ where: { entityType: 'ClientContact' } });
      expect(rows.some((r) => r.action === 'SOFT_DELETE')).toBe(true);
      expect(rows.some((r) => r.changedFields.includes('isPrimary'))).toBe(true);
    });
  });

  describe('AC12: pickers and retired sectors', () => {
    it('options list only live clients', async () => {
      const gone = await createClient(admin, { name: 'Gone Ltd', sectorId: pharma });
      await softDeleteClient(admin, gone.id);
      const options = await listClientOptions(sales);
      expect(options.map((o) => o.name)).toEqual(['Acme Pharma', 'Bharat Steel', 'Zenith Steel']);
    });

    it('a client still shows its sector after the sector is deactivated or deleted', async () => {
      await updateSector(admin, steel, { active: false });
      const bharat = (await listClients(admin, { page: 1, pageSize: 50, q: 'bharat' })).items[0]!;
      expect((await getClient(admin, bharat.id)).sector).toMatchObject({
        name: 'Steel',
        active: false,
      });
      await softDeleteSector(admin, steel);
      expect((await getClient(admin, bharat.id)).sector.name).toBe('Steel');
    });
  });

  describe('M3 review fixes', () => {
    it('A: a client whose sector was retired can still be edited (sector unchanged)', async () => {
      const retired = (await createSector(admin, { name: 'Sunset' })).id;
      const client = await createClient(admin, { name: 'Legacy Co', sectorId: retired });
      await updateSector(admin, retired, { active: false });
      // What ClientForm sends: every field, the same sector.
      const saved = await updateClient(admin, client.id, {
        name: 'Legacy Co',
        sectorId: retired,
        notes: 'still a customer',
      });
      expect(saved.notes).toBe('still a customer');
      // Moving it to another retired sector is still rejected.
      const other = (await createSector(admin, { name: 'Dusk' })).id;
      await updateSector(admin, other, { active: false });
      expect(
        fieldOf(await updateClient(admin, client.id, { sectorId: other }).catch((e) => e)),
      ).toBe('sectorId');
    });

    it('B: optional client fields can be cleared, and undefined leaves them unchanged', async () => {
      const client = await createClient(admin, {
        name: 'Clearable Ltd',
        sectorId: pharma,
        gstin: '27AAPFU0939F1ZV',
        address: 'Pune',
        notes: 'note',
      });
      await updateClient(admin, client.id, { notes: 'kept' });
      expect(await getClient(admin, client.id)).toMatchObject({
        gstin: '27AAPFU0939F1ZV',
        address: 'Pune',
      });
      await updateClient(admin, client.id, { gstin: '', address: '', notes: '' });
      expect(await getClient(admin, client.id)).toMatchObject({
        gstin: null,
        address: null,
        notes: null,
      });
    });

    it('B: optional contact fields can be cleared', async () => {
      const contact = await addContact(admin, acmeId, {
        name: 'Clear Me',
        designation: 'Buyer',
        email: 'clear@acme.example',
        phone: '+91 98200 11111',
      });
      await updateContact(admin, contact.id, { email: '', phone: '', designation: '' });
      const row = (await getClient(admin, acmeId)).contacts.find((c) => c.id === contact.id)!;
      expect(row).toMatchObject({ email: null, phone: null, designation: null, name: 'Clear Me' });
      await removeContact(admin, contact.id);
    });
  });

  describe('AC13: permissions (Decision 11: Sales create clients)', () => {
    it('Sales can create a client with contacts, but not change it afterwards', async () => {
      const mine = await createClient(sales, {
        name: 'Sales Lead Co',
        sectorId: pharma,
        contacts: [{ name: 'Lead Contact', isPrimary: true }],
      });
      expect(mine.contacts).toHaveLength(1);
      await expect(updateClient(sales, mine.id, { notes: 'x' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(softDeleteClient(sales, mine.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(restoreClient(sales, mine.id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(addContact(sales, mine.id, { name: 'Another' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(setPrimaryContact(sales, mine.contacts[0]!.id)).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('project managers read clients but cannot create them', async () => {
      expect((await listClients(pm, { page: 1, pageSize: 5 })).total).toBeGreaterThan(0);
      expect((await getClient(pm, acmeId)).id).toBe(acmeId);
      await expect(createClient(pm, { name: 'PM Co', sectorId: pharma })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });
});
