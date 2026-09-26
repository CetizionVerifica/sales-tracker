import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { assertCan, getCtxFromHeaders } from '../context.ts';
import { ForbiddenError, UnauthenticatedError } from '../errors.ts';
import { actor, createTestUser, ctxFor, signIn } from './helpers.ts';

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
});
