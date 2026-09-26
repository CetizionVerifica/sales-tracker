import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { deactivateUser, getCurrentUser, getUser, listUsers } from '../services/user.service.ts';
import { SYSTEM_USER_EMAIL, seed } from '../system/seed.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

describe('AC10: user.service (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let pm: Ctx;
  let systemId: string;

  beforeAll(async () => {
    await resetDb(getDb());
    await seed({
      adminEmail: 'admin@example.test',
      adminPassword: 'admin-password-123',
      devUsers: false,
    });
    const adminRow = await getDb().user.findUniqueOrThrow({
      where: { email: 'admin@example.test' },
    });
    const salesRow = await createTestUser('sales@example.test', 'SALES');
    const pmRow = await createTestUser('pm@example.test', 'PROJECT_MANAGER');
    systemId = (await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } })).id;
    admin = ctxFor(actor('ADMIN', { id: adminRow.id }));
    sales = ctxFor(actor('SALES', { id: salesRow.id }));
    pm = ctxFor(actor('PROJECT_MANAGER', { id: pmRow.id }));
  });
  afterAll(disconnectAll);

  describe('getCurrentUser', () => {
    it('returns the acting user without secrets', async () => {
      const me = await getCurrentUser(sales);
      expect(me).toMatchObject({ id: sales.user.id, email: 'sales@example.test', role: 'SALES' });
      expect(me).not.toHaveProperty('banned');
    });

    it('denies an inactive actor', async () => {
      await expect(getCurrentUser(ctxFor({ ...sales.user, active: false }))).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  describe('getUser', () => {
    it('lets an admin read any user', async () => {
      expect((await getUser(admin, sales.user.id)).email).toBe('sales@example.test');
    });

    it('lets a user read themselves', async () => {
      expect((await getUser(pm, pm.user.id)).id).toBe(pm.user.id);
    });

    it('forbids non-admins from reading another user', async () => {
      await expect(getUser(sales, pm.user.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('throws NotFoundError for an unknown id', async () => {
      await expect(getUser(admin, 'does-not-exist')).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('listUsers', () => {
    it('pages through users and never returns the system user', async () => {
      const page = await listUsers(admin, { page: 1, pageSize: 10 });
      expect(page.total).toBe(3);
      expect(page.items.map((u) => u.id)).not.toContain(systemId);
    });

    it.each(['sales', 'pm'] as const)('is forbidden for %s', async (who) => {
      const ctx = who === 'sales' ? sales : pm;
      await expect(listUsers(ctx, { page: 1, pageSize: 10 })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });

    it('rejects an oversized page', async () => {
      await expect(listUsers(admin, { page: 1, pageSize: 500 })).rejects.toThrow();
    });
  });

  describe('deactivateUser', () => {
    it.each(['sales', 'pm'] as const)('is forbidden for %s', async (who) => {
      const ctx = who === 'sales' ? sales : pm;
      await expect(deactivateUser(ctx, admin.user.id)).rejects.toBeInstanceOf(ForbiddenError);
    });

    it('stops an admin deactivating themselves', async () => {
      await expect(deactivateUser(admin, admin.user.id)).rejects.toBeInstanceOf(DomainError);
    });

    it('stops anyone deactivating the system user', async () => {
      await expect(deactivateUser(admin, systemId)).rejects.toBeInstanceOf(DomainError);
    });

    it('deactivates a user and writes its audit row (AC11)', async () => {
      const auditBefore = await getDb().auditLog.count();
      const result = await deactivateUser(admin, pm.user.id);
      expect(result.active).toBe(false);
      const row = await getDb().user.findUniqueOrThrow({ where: { id: pm.user.id } });
      expect(row.active).toBe(false);

      // Exactly one row: the User update. Session deletions are not audited (Decision 3).
      expect(await getDb().auditLog.count()).toBe(auditBefore + 1);
      const audit = await getDb().auditLog.findFirstOrThrow({
        where: { entityType: 'User', entityId: pm.user.id, action: 'UPDATE' },
      });
      expect(audit).toMatchObject({
        actorId: admin.user.id,
        source: 'web',
        changedFields: ['active'],
      });
      expect(audit.before).toMatchObject({ active: true });
      expect(audit.after).toMatchObject({ active: false });
    });

    it('writes no audit row when it is denied (AC11)', async () => {
      const auditBefore = await getDb().auditLog.count();
      await expect(deactivateUser(sales, admin.user.id)).rejects.toBeInstanceOf(ForbiddenError);
      expect(await getDb().auditLog.count()).toBe(auditBefore);
    });
  });
});
