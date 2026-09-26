import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWithCtx } from '../../audit/store.ts';
import { getAuth } from '../../auth/auth.ts';
import { disconnectAll, getDb } from '../../clients.ts';
import { withTx, type Ctx } from '../../context.ts';
import { AuditContextError } from '../../errors.ts';
import { actor, createTestUser, ctxFor, signIn } from '../helpers.ts';

let ctx: Ctx;

const auditRows = (entityId: string) =>
  getDb().auditLog.findMany({ where: { entityId }, orderBy: { createdAt: 'asc' } });

const newUser = (id: string) => ({ id, name: id, email: `${id}@example.test` });

describe('audit extension (integration)', () => {
  beforeAll(async () => {
    await resetDb(getDb());
    const admin = await createTestUser('admin@example.test', 'ADMIN');
    ctx = ctxFor(actor('ADMIN', { id: admin.id }), 'web');
  });
  afterAll(disconnectAll);

  describe('AC1: one audit row per affected record, for every write operation', () => {
    it('create', async () => {
      await withTx(ctx, (tx) => tx.user.create({ data: newUser('c1') }));
      const [row, ...rest] = await auditRows('c1');
      expect(rest).toHaveLength(0);
      expect(row).toMatchObject({
        action: 'CREATE',
        entityType: 'User',
        actorId: ctx.user.id,
        source: 'web',
        before: null,
        changedFields: [],
      });
      expect(row?.after).toMatchObject({ id: 'c1', email: 'c1@example.test', active: true });
      expect(row?.requestId).toMatch(/[0-9a-f-]{36}/);
    });

    it('createMany (still returns a count) and createManyAndReturn', async () => {
      const result = await withTx(ctx, (tx) =>
        tx.user.createMany({ data: [newUser('cm1'), newUser('cm2')] }),
      );
      expect(result).toEqual({ count: 2 });
      await withTx(ctx, (tx) =>
        tx.user.createManyAndReturn({ data: [newUser('cr1'), newUser('cr2')] }),
      );
      for (const id of ['cm1', 'cm2', 'cr1', 'cr2']) {
        expect((await auditRows(id)).map((r) => r.action)).toEqual(['CREATE']);
      }
    });

    it('update with a select that omits id (no id leaks into the result)', async () => {
      const result = await withTx(ctx, (tx) =>
        tx.user.update({ where: { id: 'c1' }, data: { name: 'Renamed' }, select: { name: true } }),
      );
      expect(result).toEqual({ name: 'Renamed' });
      const update = (await auditRows('c1')).at(-1);
      expect(update).toMatchObject({ action: 'UPDATE', changedFields: ['name'] });
      expect(update?.before).toMatchObject({ name: 'c1' });
      expect(update?.after).toMatchObject({ name: 'Renamed' });
    });

    it('updateMany: one row per record, sharing one requestId', async () => {
      await withTx(ctx, (tx) =>
        tx.user.updateMany({ where: { id: { in: ['cm1', 'cm2'] } }, data: { active: false } }),
      );
      const rows = [...(await auditRows('cm1')), ...(await auditRows('cm2'))].filter(
        (r) => r.action === 'UPDATE',
      );
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.changedFields.join() === 'active')).toBe(true);
      expect(new Set(rows.map((r) => r.requestId)).size).toBe(1);
    });

    it('upsert on both the create and update paths', async () => {
      const args = (name: string) => ({
        where: { id: 'u1' },
        create: { ...newUser('u1'), name },
        update: { name },
      });
      await withTx(ctx, (tx) => tx.user.upsert(args('first')));
      await withTx(ctx, (tx) => tx.user.upsert(args('second')));
      expect((await auditRows('u1')).map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    });

    it('delete and deleteMany (hard deletes keep the before row)', async () => {
      await withTx(ctx, (tx) => tx.user.delete({ where: { id: 'cr1' } }));
      await withTx(ctx, (tx) => tx.user.deleteMany({ where: { id: { in: ['cr2', 'u1'] } } }));
      for (const id of ['cr1', 'cr2', 'u1']) {
        const last = (await auditRows(id)).at(-1);
        expect(last).toMatchObject({ action: 'DELETE', after: null });
        expect(last?.before).toMatchObject({ id });
      }
    });

    it('rejects updateMany/deleteMany with a limit (affected rows would be ambiguous)', async () => {
      await expect(
        withTx(ctx, (tx) => tx.user.deleteMany({ where: { id: 'nobody' }, limit: 1 })),
      ).rejects.toThrow(/limit/);
    });
  });

  describe('AC2: atomic with the write', () => {
    it('a rolled-back transaction leaves neither the row nor its audit entry', async () => {
      await expect(
        withTx(ctx, async (tx) => {
          await tx.user.create({ data: newUser('rolled-back') });
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await getDb().user.count({ where: { id: 'rolled-back' } })).toBe(0);
      expect(await auditRows('rolled-back')).toHaveLength(0);
    });

    it('a failed audit insert rolls the write back', async () => {
      const ghost = ctxFor(actor('ADMIN', { id: 'no-such-user' }), 'web');
      await expect(
        withTx(ghost, (tx) => tx.user.create({ data: newUser('ghost') })),
      ).rejects.toThrow();
      expect(await getDb().user.count({ where: { id: 'ghost' } })).toBe(0);
    });
  });

  describe('AC3: fails closed', () => {
    it('rejects an audited write with no acting context', async () => {
      await expect(getDb().user.create({ data: newUser('no-ctx') })).rejects.toBeInstanceOf(
        AuditContextError,
      );
      expect(await getDb().user.count({ where: { id: 'no-ctx' } })).toBe(0);
    });

    it('rejects an audited write with a context but no transaction', async () => {
      await expect(
        runWithCtx(ctx, () => getDb().user.create({ data: newUser('no-tx') })),
      ).rejects.toBeInstanceOf(AuditContextError);
    });

    it('rejects Better Auth user creation outside withTx', async () => {
      await expect(
        getAuth().api.createUser({
          body: { email: 'stray@example.test', password: 'correct-horse-battery', name: 's' },
        }),
      ).rejects.toThrow();
      expect(await getDb().user.count({ where: { email: 'stray@example.test' } })).toBe(0);
    });
  });

  it('AC4: rejects nested writes to audited relations', async () => {
    await expect(
      withTx(ctx, (tx) =>
        tx.user.update({
          where: { id: 'c1' },
          data: { accounts: { create: { id: 'nested', accountId: 'x', providerId: 'x' } } },
        }),
      ),
    ).rejects.toThrow(/nested write/i);
    expect(await getDb().account.count({ where: { id: 'nested' } })).toBe(0);
  });

  it('AC5: never stores credentials, but records that they changed', async () => {
    await withTx(ctx, (tx) =>
      tx.account.create({
        data: {
          id: 'acc1',
          accountId: 'c1',
          providerId: 'credential',
          userId: 'c1',
          password: 'first-secret-hash',
        },
      }),
    );
    await withTx(ctx, (tx) =>
      tx.account.update({ where: { id: 'acc1' }, data: { password: 'second-secret-hash' } }),
    );
    const rows = await auditRows('acc1');
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('first-secret-hash');
    expect(serialized).not.toContain('second-secret-hash');
    expect(rows.at(-1)?.changedFields).toContain('password');
  });

  it('AC6: sign-in and sign-out write sessions but no audit rows', async () => {
    const before = await getDb().auditLog.count();
    const headers = await signIn('admin@example.test');
    expect(await getDb().session.count()).toBeGreaterThan(0);
    await getAuth().api.signOut({ headers });
    expect(await getDb().auditLog.count()).toBe(before);
  });

  describe('AC7: audit rows are append-only in the database', () => {
    it('rejects updates and deletes through Prisma', async () => {
      const row = await getDb().auditLog.findFirstOrThrow();
      await expect(
        getDb().auditLog.update({ where: { id: row.id }, data: { entityId: 'tampered' } }),
      ).rejects.toThrow(/append-only/);
      await expect(getDb().auditLog.delete({ where: { id: row.id } })).rejects.toThrow(
        /append-only/,
      );
    });

    it('rejects updates and deletes through raw SQL', async () => {
      await expect(
        getDb().$executeRawUnsafe(`UPDATE audit_log SET "entityId" = 'tampered'`),
      ).rejects.toThrow(/append-only/);
      await expect(getDb().$executeRawUnsafe('DELETE FROM audit_log')).rejects.toThrow(
        /append-only/,
      );
    });
  });
});
