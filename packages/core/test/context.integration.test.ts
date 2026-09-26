import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { assertCan, getCtxFromHeaders, importCtx, systemCtx, withTx } from '../context.ts';
import { ForbiddenError, UnauthenticatedError } from '../errors.ts';
import { SYSTEM_USER_EMAIL } from '../system/seed.ts';
import { actor, createTestUser, ctxFor, ensureSystemCtx, signIn } from './helpers.ts';

describe('AC11: acting context (integration)', () => {
  beforeAll(async () => {
    await resetDb(getDb());
    await createTestUser('pm@example.test', 'PROJECT_MANAGER');
  });
  afterAll(disconnectAll);

  it('throws UnauthenticatedError without a session', async () => {
    await expect(getCtxFromHeaders(new Headers(), 'web')).rejects.toBeInstanceOf(
      UnauthenticatedError,
    );
  });

  it('throws UnauthenticatedError for a forged cookie', async () => {
    const headers = new Headers({ cookie: 'better-auth.session_token=forged.value' });
    await expect(getCtxFromHeaders(headers, 'web')).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  it('returns the acting user and source for a valid session', async () => {
    const ctx = await getCtxFromHeaders(await signIn('pm@example.test'), 'web');
    expect(ctx).toMatchObject({
      source: 'web',
      user: { role: 'PROJECT_MANAGER', active: true },
    });
  });

  it('assertCan throws ForbiddenError naming the action and resource type only', () => {
    const sales = ctxFor(actor('SALES'));
    expect(() => assertCan(sales, 'list', 'user')).toThrow(ForbiddenError);
    expect(() => assertCan(sales, 'list', 'user')).toThrow('Not allowed to list user');
  });

  describe('AC9: system and import contexts, request ids', () => {
    it('systemCtx() acts as the system user with source "system"', async () => {
      const ctx = await systemCtx();
      const system = await getDb().user.findUniqueOrThrow({ where: { email: SYSTEM_USER_EMAIL } });
      expect(ctx).toEqual({
        user: { id: system.id, role: 'ADMIN', active: true },
        source: 'system',
      });
    });

    it('importCtx() keeps the user and switches the source to "import"', () => {
      const ctx = ctxFor(actor('SALES'));
      expect(importCtx(ctx)).toEqual({ user: ctx.user, source: 'import' });
    });

    it('gives all rows in one withTx the same requestId, and separate calls different ones', async () => {
      const ctx = await ensureSystemCtx();
      await withTx(ctx, async (tx) => {
        await tx.user.create({ data: { id: 'r1', name: 'r1', email: 'r1@example.test' } });
        await tx.user.create({ data: { id: 'r2', name: 'r2', email: 'r2@example.test' } });
      });
      await withTx(ctx, (tx) =>
        tx.user.create({ data: { id: 'r3', name: 'r3', email: 'r3@example.test' } }),
      );
      const rows = await getDb().auditLog.findMany({
        where: { entityId: { in: ['r1', 'r2', 'r3'] } },
        orderBy: { entityId: 'asc' },
      });
      expect(rows[0]?.requestId).toBe(rows[1]?.requestId);
      expect(rows[2]?.requestId).not.toBe(rows[0]?.requestId);
    });
  });
});

describe('AC9: systemCtx before seeding', () => {
  beforeAll(() => resetDb(getDb()));

  it('throws a clear error when the system user does not exist', async () => {
    await expect(systemCtx()).rejects.toThrow(/system user.*db:seed/i);
  });
});
