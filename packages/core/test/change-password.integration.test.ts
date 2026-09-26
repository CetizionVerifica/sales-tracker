import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { getCtxFromHeaders } from '../context.ts';
import { DomainError, UnauthenticatedError } from '../errors.ts';
import { changeOwnPassword } from '../services/user.service.ts';
import { PASSWORD, createTestUser, signIn } from './helpers.ts';

describe('AC6: change own password (integration)', () => {
  beforeAll(async () => {
    await resetDb(getDb());
    await createTestUser('me@example.test', 'SALES');
  });
  afterAll(disconnectAll);

  it('rejects a wrong current password as a field error', async () => {
    const ctx = await getCtxFromHeaders(await signIn('me@example.test'), 'web');
    const error = await changeOwnPassword(ctx, {
      currentPassword: 'not-my-password',
      newPassword: 'brand-new-password',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).field).toBe('currentPassword');
  });

  it('rejects reusing the current password', async () => {
    const ctx = await getCtxFromHeaders(await signIn('me@example.test'), 'web');
    await expect(
      changeOwnPassword(ctx, { currentPassword: PASSWORD, newPassword: PASSWORD }),
    ).rejects.toThrow();
  });

  it('changes the password, keeps this session, revokes the others, and is audited', async () => {
    const current = await signIn('me@example.test');
    const other = await signIn('me@example.test');
    const ctx = await getCtxFromHeaders(current, 'web');

    await changeOwnPassword(ctx, { currentPassword: PASSWORD, newPassword: 'brand-new-password' });

    await expect(getCtxFromHeaders(current, 'web')).resolves.toMatchObject({
      user: { id: ctx.user.id },
    });
    await expect(getCtxFromHeaders(other, 'web')).rejects.toBeInstanceOf(UnauthenticatedError);
    await expect(
      getAuth().api.signInEmail({
        body: { email: 'me@example.test', password: 'brand-new-password' },
      }),
    ).resolves.toBeTruthy();

    const row = await getDb().auditLog.findFirstOrThrow({
      where: { entityType: 'Account', action: 'UPDATE', actorId: ctx.user.id },
    });
    expect(row).toMatchObject({
      source: 'web',
      changedFields: expect.arrayContaining(['password']),
    });
  });
});
