import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { getCtxFromHeaders, systemCtx, type Ctx } from '../context.ts';
import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError } from '../errors.ts';
import {
  createUser,
  deactivateUser,
  listUsers,
  reactivateUser,
  resetUserPassword,
  updateUser,
} from '../services/user.service.ts';
import { SYSTEM_USER_EMAIL } from '../system/seed.ts';
import { actor, createTestUser, ctxFor, signIn } from './helpers.ts';

const canSignIn = (email: string, password: string) =>
  getAuth()
    .api.signInEmail({ body: { email, password } })
    .then(
      () => true,
      () => false,
    );

async function expectDomainError(promise: Promise<unknown>, field?: string) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(DomainError);
  if (field) expect((error as DomainError).field).toBe(field);
}

describe('M3 user management (integration)', () => {
  let admin: Ctx;
  let sales: Ctx;
  let pm: Ctx;
  let repId: string;

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
  });
  afterAll(disconnectAll);

  describe('AC1: create', () => {
    it('creates a user who can sign in, audited without the password hash', async () => {
      const user = await createUser(admin, {
        name: 'New Rep',
        email: 'rep@example.test',
        role: 'SALES',
        password: 'initial-password-1',
      });
      repId = user.id;
      expect(user).toMatchObject({ name: 'New Rep', role: 'SALES', active: true });
      expect(await canSignIn('rep@example.test', 'initial-password-1')).toBe(true);

      const rows = await getDb().auditLog.findMany({ where: { actorId: admin.user.id } });
      const account = await getDb().account.findFirstOrThrow({ where: { userId: user.id } });
      expect(rows.map((r) => `${r.entityType}.${r.action}.${r.source}`).sort()).toEqual([
        'Account.CREATE.web',
        'User.CREATE.web',
      ]);
      expect(JSON.stringify(rows)).not.toContain(account.password);
    });

    it('rejects a duplicate email (any case) as a field error', async () => {
      await expectDomainError(
        createUser(admin, {
          name: 'Dup',
          email: 'REP@example.test',
          role: 'SALES',
          password: 'another-password',
        }),
        'email',
      );
    });

    it('rejects a short password', async () => {
      await expect(
        createUser(admin, {
          name: 'Short',
          email: 'short@example.test',
          role: 'SALES',
          password: 'short',
        }),
      ).rejects.toThrow();
    });
  });

  it('AC2: edits name, email and role with one UPDATE row', async () => {
    await updateUser(admin, repId, {
      name: 'Renamed Rep',
      email: 'rep2@example.test',
      role: 'PROJECT_MANAGER',
    });
    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityId: repId, action: 'UPDATE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.changedFields).toEqual(['email', 'name', 'role']);
    expect(row.actorId).toBe(admin.user.id);
  });

  it('AC3: resets a password, revokes sessions, audits without the hash', async () => {
    const session = await signIn('rep2@example.test', 'initial-password-1');
    await resetUserPassword(admin, repId, { password: 'reset-password-22' });

    expect(await canSignIn('rep2@example.test', 'initial-password-1')).toBe(false);
    expect(await canSignIn('rep2@example.test', 'reset-password-22')).toBe(true);
    await expect(getCtxFromHeaders(session, 'web')).rejects.toBeInstanceOf(UnauthenticatedError);

    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityType: 'Account', action: 'UPDATE' },
      orderBy: { createdAt: 'desc' },
    });
    expect(row.changedFields).toContain('password');
    const account = await getDb().account.findFirstOrThrow({ where: { userId: repId } });
    expect(JSON.stringify(row)).not.toContain(account.password);
  });

  it('AC4: reactivates a deactivated user', async () => {
    await deactivateUser(admin, repId);
    expect(await canSignIn('rep2@example.test', 'reset-password-22')).toBe(false);
    const user = await reactivateUser(admin, repId);
    expect(user.active).toBe(true);
    expect(await canSignIn('rep2@example.test', 'reset-password-22')).toBe(true);
  });

  describe('AC5: guardrails', () => {
    it('an admin cannot change their own role', async () => {
      await expectDomainError(updateUser(admin, admin.user.id, { role: 'SALES' }), 'role');
    });

    it('an admin can still rename themselves', async () => {
      expect((await updateUser(admin, admin.user.id, { name: 'Head Admin' })).name).toBe(
        'Head Admin',
      );
    });

    it('nobody can demote or deactivate the last active admin', async () => {
      const system = await systemCtx();
      await expectDomainError(updateUser(system, admin.user.id, { role: 'SALES' }), 'role');
      await expectDomainError(deactivateUser(system, admin.user.id));
    });

    it('with a second active admin, the first one can be demoted', async () => {
      const second = await createUser(admin, {
        name: 'Second Admin',
        email: 'admin2@example.test',
        role: 'ADMIN',
        password: 'second-admin-password',
      });
      const system = await systemCtx();
      expect((await updateUser(system, admin.user.id, { role: 'SALES' })).role).toBe('SALES');
      expect((await updateUser(system, admin.user.id, { role: 'ADMIN' })).role).toBe('ADMIN');
      await deactivateUser(admin, second.id);
    });

    it('the system user cannot be listed, edited, reset or reactivated', async () => {
      const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
      const page = await listUsers(admin, { page: 1, pageSize: 100 });
      expect(page.items.map((u) => u.id)).not.toContain(system.id);
      await expect(updateUser(admin, system.id, { name: 'x' })).rejects.toBeInstanceOf(
        NotFoundError,
      );
      await expect(
        resetUserPassword(admin, system.id, { password: 'whatever-password' }),
      ).rejects.toBeInstanceOf(NotFoundError);
      await expect(reactivateUser(admin, system.id)).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe('AC7: non-admins are forbidden', () => {
    const calls: [string, (ctx: Ctx) => Promise<unknown>][] = [
      [
        'createUser',
        (c) =>
          createUser(c, {
            name: 'X',
            email: 'x@example.test',
            role: 'SALES',
            password: 'x-password-123',
          }),
      ],
      ['updateUser', (c) => updateUser(c, repId, { name: 'X' })],
      ['resetUserPassword', (c) => resetUserPassword(c, repId, { password: 'x-password-123' })],
      ['reactivateUser', (c) => reactivateUser(c, repId)],
      ['deactivateUser', (c) => deactivateUser(c, repId)],
      ['listUsers', (c) => listUsers(c, { page: 1, pageSize: 10 })],
    ];

    it.each(calls)(
      '%s throws ForbiddenError for SALES and PROJECT_MANAGER',
      async (_name, call) => {
        await expect(call(sales)).rejects.toBeInstanceOf(ForbiddenError);
        await expect(call(pm)).rejects.toBeInstanceOf(ForbiddenError);
      },
    );

    it('a sales user cannot promote themselves', async () => {
      await expect(updateUser(sales, sales.user.id, { role: 'ADMIN' })).rejects.toBeInstanceOf(
        ForbiddenError,
      );
    });
  });

  it('listUsers filters by search, role and status', async () => {
    const byRole = await listUsers(admin, { page: 1, pageSize: 50, role: 'PROJECT_MANAGER' });
    expect(byRole.items.every((u) => u.role === 'PROJECT_MANAGER')).toBe(true);
    const search = await listUsers(admin, { page: 1, pageSize: 50, q: 'renamed' });
    expect(search.items.map((u) => u.email)).toEqual(['rep2@example.test']);
    const inactive = await listUsers(admin, { page: 1, pageSize: 50, status: 'inactive' });
    expect(inactive.items.map((u) => u.email)).toEqual(['admin2@example.test']);
  });
});
