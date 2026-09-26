import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { SYSTEM_USER_EMAIL, SeedError, seed } from '../system/seed.ts';

const options = {
  adminEmail: 'root@example.test',
  adminPassword: 'seed-admin-password',
  devUsers: false,
};

describe('AC8: seed (integration)', () => {
  beforeAll(() => resetDb(getDb()));
  afterAll(disconnectAll);

  it('is idempotent: one admin, one system user, admin password still works', async () => {
    await seed(options);
    await seed(options);

    const db = getDb();
    expect(await db.user.count({ where: { role: 'ADMIN', isSystem: false } })).toBe(1);
    expect(await db.user.count({ where: { isSystem: true } })).toBe(1);

    const result = await getAuth().api.signInEmail({
      body: { email: options.adminEmail, password: options.adminPassword },
    });
    expect(result.user.email).toBe(options.adminEmail);
  });

  it('creates the system user as a non-login ADMIN with no credential account', async () => {
    const system = await getDb().user.findUniqueOrThrow({
      where: { email: SYSTEM_USER_EMAIL },
      include: { accounts: true },
    });
    expect(system).toMatchObject({ role: 'ADMIN', isSystem: true, active: true });
    expect(system.accounts).toHaveLength(0);
  });

  it('never lets the system user sign in, even if a password is attached', async () => {
    const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const context = await getAuth().$context;
    await context.internalAdapter.linkAccount({
      userId: system.id,
      providerId: 'credential',
      accountId: system.id,
      password: await context.password.hash('sneaky-system-password'),
    });

    await expect(
      getAuth().api.signInEmail({
        body: { email: SYSTEM_USER_EMAIL, password: 'sneaky-system-password' },
      }),
    ).rejects.toThrow();
  });

  it('seeds dev users only when asked', async () => {
    const db = getDb();
    expect(await db.user.count({ where: { role: { not: 'ADMIN' } } })).toBe(0);
    await seed({ ...options, devUsers: true });
    expect(await db.user.count({ where: { role: 'SALES' } })).toBe(1);
    expect(await db.user.count({ where: { role: 'PROJECT_MANAGER' } })).toBe(1);
  });

  it('fails clearly when the admin credentials are missing', async () => {
    await expect(seed({ ...options, adminEmail: undefined })).rejects.toThrow(SeedError);
    await expect(seed({ ...options, adminPassword: undefined })).rejects.toThrow(
      /SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD/,
    );
  });
});
