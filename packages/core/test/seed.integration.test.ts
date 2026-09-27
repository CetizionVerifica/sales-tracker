import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { systemCtx, withTx } from '../context.ts';
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
    const password = await context.password.hash('sneaky-system-password');
    // Audited write: must run inside withTx (fails closed otherwise).
    await withTx(await systemCtx(), () =>
      context.internalAdapter.linkAccount({
        userId: system.id,
        providerId: 'credential',
        accountId: system.id,
        password,
      }),
    );

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
    expect(await db.user.count({ where: { role: 'SALES' } })).toBe(2);
    expect(await db.user.count({ where: { role: 'PROJECT_MANAGER' } })).toBe(1);
  });

  it('M4: dev seed adds a sample pipeline with every status and source, once', async () => {
    const db = getDb();
    await seed({ ...options, devUsers: true });
    const enquiries = await db.enquiry.findMany();
    expect(new Set(enquiries.map((e) => e.status))).toEqual(
      new Set(['IN_PROGRESS', 'CONVERTED', 'LOST']),
    );
    expect(new Set(enquiries.map((e) => e.source)).size).toBe(7);
    const audit = await db.auditLog.findMany({ where: { entityType: 'Enquiry' } });
    expect(audit.every((row) => row.source === 'system')).toBe(true);

    await seed({ ...options, devUsers: true });
    expect(await db.enquiry.count()).toBe(enquiries.length);
  });

  it('fails clearly when the admin credentials are missing', async () => {
    await expect(seed({ ...options, adminEmail: undefined })).rejects.toThrow(SeedError);
    await expect(seed({ ...options, adminPassword: undefined })).rejects.toThrow(
      /SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD/,
    );
  });

  it('AC12: audits every seeded User and Account row as the system user', async () => {
    const db = getDb();
    const system = await db.user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const users = await db.user.findMany({ select: { id: true } });
    const accounts = await db.account.findMany({
      where: { providerId: 'credential', password: { not: null } },
      select: { id: true, userId: true },
    });
    // The account linked by hand in the "sneaky password" test above was written under
    // a test ctx; every seeded account belongs to a non-system user.
    const seededAccounts = accounts.filter((a) => a.userId !== system.id);
    for (const { id } of [...users, ...seededAccounts]) {
      const create = await db.auditLog.findFirst({ where: { entityId: id, action: 'CREATE' } });
      expect(create, `CREATE audit row for ${id}`).not.toBeNull();
      expect(create?.source).toBe('system');
      expect(create?.actorId).toBe(system.id);
    }
  });

  it('AC12: the system user’s own CREATE row names itself as the actor', async () => {
    const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityType: 'User', entityId: system.id, action: 'CREATE' },
    });
    expect(row.actorId).toBe(system.id);
  });
});
