import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError } from '../errors.ts';
import * as sectors from '../services/sector.service.ts';
import * as services from '../services/service.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

// Sectors and services share one lifecycle; the same suite runs against both.
const kinds = [
  {
    entity: 'Sector',
    list: sectors.listSectors,
    get: sectors.getSector,
    create: sectors.createSector,
    update: sectors.updateSector,
    softDelete: sectors.softDeleteSector,
    restore: sectors.restoreSector,
    options: sectors.listSectorOptions,
  },
  {
    entity: 'Service',
    list: services.listServices,
    get: services.getService,
    create: services.createService,
    update: services.updateService,
    softDelete: services.softDeleteService,
    restore: services.restoreService,
    options: services.listServiceOptions,
  },
] as const;

let admin: Ctx;
let sales: Ctx;
let pm: Ctx;

beforeAll(async () => {
  await resetDb(getDb());
  admin = ctxFor(actor('ADMIN', { id: (await createTestUser('admin@example.test', 'ADMIN')).id }));
  sales = ctxFor(actor('SALES', { id: (await createTestUser('sales@example.test', 'SALES')).id }));
  pm = ctxFor(
    actor('PROJECT_MANAGER', {
      id: (await createTestUser('pm@example.test', 'PROJECT_MANAGER')).id,
    }),
  );
});
afterAll(disconnectAll);

describe.each(kinds)('$entity (AC8, AC13)', (kind) => {
  let id: string;

  it('creates, rejecting a case-insensitive duplicate as a name field error', async () => {
    id = (await kind.create(admin, { name: 'Pharma' })).id;
    const error = await kind.create(admin, { name: '  pharma ' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).field).toBe('name');
  });

  it('renames and deactivates; options only list active rows', async () => {
    await kind.update(admin, id, { name: 'Pharmaceuticals' });
    const other = await kind.create(admin, { name: 'Steel' });
    await kind.update(admin, id, { active: false });
    const options = await kind.options(sales);
    expect(options.map((o) => o.id)).toEqual([other.id]);
    expect((await kind.get(admin, id)).active).toBe(false);
  });

  it('soft deletes, frees the name, and restores (unless the name was taken)', async () => {
    await kind.softDelete(admin, id);
    expect(
      (await kind.list(admin, { page: 1, pageSize: 50 })).items.map((r) => r.id),
    ).not.toContain(id);
    expect(
      (await kind.list(admin, { page: 1, pageSize: 50, status: 'deleted' })).items.map((r) => r.id),
    ).toEqual([id]);

    const replacement = await kind.create(admin, { name: 'PHARMACEUTICALS' });
    const conflict = await kind.restore(admin, id).catch((e: unknown) => e);
    expect((conflict as DomainError).field).toBe('name');

    await kind.softDelete(admin, replacement.id);
    expect((await kind.restore(admin, id)).deletedAt).toBeNull();
  });

  it('records CREATE, UPDATE, SOFT_DELETE and RESTORE (M2 carry-over)', async () => {
    const rows = await getDb().auditLog.findMany({
      where: { entityType: kind.entity, entityId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(rows.map((r) => r.action)).toEqual([
      'CREATE',
      'UPDATE',
      'UPDATE',
      'SOFT_DELETE',
      'RESTORE',
    ]);
    expect(rows[3]?.after).toMatchObject({ deletedAt: expect.any(String) });
    expect(rows[4]?.after).toMatchObject({ deletedAt: null });
  });

  it('lists with search, status filter, sort and pagination', async () => {
    await kind.create(admin, { name: 'Automotive' });
    const sorted = await kind.list(admin, { page: 1, pageSize: 50, sort: 'name', dir: 'desc' });
    const names = sorted.items.map((r) => r.name);
    expect(names).toEqual([...names].sort().reverse());
    expect(
      (await kind.list(admin, { page: 1, pageSize: 50, q: 'auto' })).items.map((r) => r.name),
    ).toEqual(['Automotive']);
    expect(
      (await kind.list(admin, { page: 1, pageSize: 50, status: 'inactive' })).items.map(
        (r) => r.id,
      ),
    ).toEqual([id]);
    const page = await kind.list(admin, { page: 2, pageSize: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.total).toBeGreaterThan(1);
  });

  it('AC13: every role reads; only admins write', async () => {
    for (const reader of [sales, pm]) {
      expect((await kind.list(reader, { page: 1, pageSize: 5 })).total).toBeGreaterThan(0);
      expect((await kind.get(reader, id)).id).toBe(id);
      await expect(kind.create(reader, { name: `No ${reader.user.role}` })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(kind.update(reader, id, { name: 'Nope' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
      await expect(kind.softDelete(reader, id)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(kind.restore(reader, id)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });
});
