import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { withTx, type Ctx } from '../context.ts';
import { ForbiddenError } from '../errors.ts';
import { getAuditEntry, listAuditLog } from '../services/audit-log.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

describe('AC10: audit-log service (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let pm: Ctx;

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
    // One change by each of admin and sales (ids sort in creation order).
    await withTx(admin, (tx) =>
      tx.user.update({ where: { id: pm.user.id }, data: { name: 'PM renamed' } }),
    );
    await withTx(sales, (tx) =>
      tx.user.update({ where: { id: sales.user.id }, data: { name: 'Sales renamed' } }),
    );
  });
  afterAll(disconnectAll);

  it('admins see every row, newest first', async () => {
    const page = await listAuditLog(admin, { page: 1, pageSize: 100 });
    expect(page.total).toBe(await getDb().auditLog.count());
    const times = page.items.map((r) => r.createdAt.getTime());
    expect(times).toEqual([...times].sort((a, b) => b - a));
  });

  it('non-admins see only their own changes', async () => {
    const mine = await listAuditLog(sales, { page: 1, pageSize: 100 });
    expect(mine.total).toBe(1);
    expect(mine.items[0]).toMatchObject({ actorId: sales.user.id, changedFields: ['name'] });
    expect((await listAuditLog(pm, { page: 1, pageSize: 100 })).total).toBe(0);
  });

  it('filters by entity, actor and date range, and pages', async () => {
    const byEntity = await listAuditLog(admin, {
      entityType: 'User',
      entityId: pm.user.id,
      page: 1,
      pageSize: 100,
    });
    expect(byEntity.items.every((r) => r.entityId === pm.user.id)).toBe(true);
    expect(byEntity.items.map((r) => r.action)).toEqual(['UPDATE', 'CREATE']);

    const byActor = await listAuditLog(admin, { actorId: admin.user.id, page: 1, pageSize: 100 });
    expect(byActor.items.every((r) => r.actorId === admin.user.id)).toBe(true);

    const future = await listAuditLog(admin, {
      from: new Date(Date.now() + 60_000),
      page: 1,
      pageSize: 100,
    });
    expect(future.total).toBe(0);

    const firstPage = await listAuditLog(admin, { page: 1, pageSize: 1 });
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.total).toBeGreaterThan(1);
  });

  it('a non-admin cannot widen the scope with an actor filter', async () => {
    const page = await listAuditLog(sales, { actorId: admin.user.id, page: 1, pageSize: 100 });
    expect(page.total).toBe(0);
  });

  it('getAuditEntry: own rows yes, others’ rows forbidden for non-admins', async () => {
    const [own] = (await listAuditLog(sales, { page: 1, pageSize: 1 })).items;
    const [adminRow] = (await listAuditLog(admin, { actorId: admin.user.id, page: 1, pageSize: 1 }))
      .items;
    expect((await getAuditEntry(sales, own!.id)).id).toBe(own!.id);
    await expect(getAuditEntry(sales, adminRow!.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await getAuditEntry(admin, own!.id)).id).toBe(own!.id);
  });

  it('rejects an oversized page', async () => {
    await expect(listAuditLog(admin, { page: 1, pageSize: 1000 })).rejects.toThrow();
  });
});
