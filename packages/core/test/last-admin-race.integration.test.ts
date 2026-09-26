import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { DomainError } from '../errors.ts';
import { deactivateUser, updateUser } from '../services/user.service.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

// M3 review fix D: two admins demoting (or deactivating) each other at the same moment must
// not leave the company with no admin. The last-admin check runs under an advisory lock.
describe('last-admin guard under concurrency', () => {
  let a: ReturnType<typeof ctxFor>;
  let b: ReturnType<typeof ctxFor>;

  beforeEach(async () => {
    await resetDb(getDb());
    a = ctxFor(actor('ADMIN', { id: (await createTestUser('a@example.test', 'ADMIN')).id }));
    b = ctxFor(actor('ADMIN', { id: (await createTestUser('b@example.test', 'ADMIN')).id }));
  });
  afterAll(disconnectAll);

  const activeAdmins = () =>
    getDb().user.count({ where: { role: 'ADMIN', active: true, isSystem: false } });

  it.each([
    [
      'demote',
      (actorCtx: typeof a, target: string) => updateUser(actorCtx, target, { role: 'SALES' }),
    ],
    ['deactivate', (actorCtx: typeof a, target: string) => deactivateUser(actorCtx, target)],
  ] as const)('concurrent %s of each other leaves exactly one admin', async (_label, act) => {
    const results = await Promise.allSettled([act(a, b.user.id), act(b, a.user.id)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DomainError);
    expect(await activeAdmins()).toBe(1);
  });
});
