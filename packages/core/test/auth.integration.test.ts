import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getAuth } from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { getCtxFromHeaders } from '../context.ts';
import { UnauthenticatedError } from '../errors.ts';
import { deactivateUser } from '../services/user.service.ts';
import { PASSWORD, actor, authRequest, createTestUser, ctxFor, signIn } from './helpers.ts';

async function signInError(email: string, password: string) {
  try {
    await getAuth().api.signInEmail({ body: { email, password } });
  } catch (error) {
    return error as { status?: string; message?: string };
  }
  throw new Error('expected sign-in to fail');
}

describe('authentication (integration)', () => {
  beforeAll(async () => {
    await resetDb(getDb());
    await createTestUser('admin@example.test', 'ADMIN');
    await createTestUser('sales@example.test', 'SALES');
  });
  afterAll(disconnectAll);

  describe('AC5: sign-in', () => {
    it('succeeds with the right password', async () => {
      const result = await getAuth().api.signInEmail({
        body: { email: 'admin@example.test', password: PASSWORD },
      });
      expect(result.user.email).toBe('admin@example.test');
    });

    it('fails identically for a wrong password and an unknown email', async () => {
      const wrongPassword = await signInError('admin@example.test', 'not-the-password');
      const unknownEmail = await signInError('nobody@example.test', PASSWORD);
      expect(wrongPassword.status).toBe(unknownEmail.status);
      expect(wrongPassword.message).toBe(unknownEmail.message);
    });
  });

  describe('AC6: no public sign-up or admin HTTP routes', () => {
    it('rejects the sign-up endpoint and creates no user', async () => {
      const response = await authRequest(
        '/sign-up/email',
        { email: 'intruder@example.test', password: PASSWORD, name: 'Intruder' },
        '203.0.113.10',
      );
      expect(response.ok).toBe(false);
      expect(await getDb().user.count({ where: { email: 'intruder@example.test' } })).toBe(0);
    });

    it('does not expose the admin plugin’s create-user route over HTTP', async () => {
      const response = await authRequest(
        '/admin/create-user',
        { email: 'x@example.test', password: PASSWORD, name: 'X', role: 'ADMIN' },
        '203.0.113.11',
      );
      expect(response.status).toBe(404);
    });
  });

  describe('AC7: inactive users', () => {
    it('cannot sign in', async () => {
      const user = await createTestUser('inactive@example.test', 'SALES');
      await getDb().user.update({ where: { id: user.id }, data: { active: false } });
      await expect(
        getAuth().api.signInEmail({ body: { email: 'inactive@example.test', password: PASSWORD } }),
      ).rejects.toThrow();
    });

    it('lose their existing sessions when deactivated', async () => {
      const user = await createTestUser('leaver@example.test', 'SALES');
      const headers = await signIn('leaver@example.test');
      expect((await getCtxFromHeaders(headers, 'web')).user.id).toBe(user.id);

      const admin = await getDb().user.findUniqueOrThrow({
        where: { email: 'admin@example.test' },
      });
      await deactivateUser(ctxFor(actor('ADMIN', { id: admin.id })), user.id);

      await expect(getCtxFromHeaders(headers, 'web')).rejects.toBeInstanceOf(UnauthenticatedError);
    });
  });

  describe('rate limiting (spec: sign-in endpoints are rate limited)', () => {
    it('returns 429 on the 6th sign-in attempt within a minute from one IP', async () => {
      const statuses: number[] = [];
      for (let i = 0; i < 6; i++) {
        const response = await authRequest(
          '/sign-in/email',
          { email: 'sales@example.test', password: 'wrong-password-123' },
          '203.0.113.99',
        );
        statuses.push(response.status);
      }
      expect(statuses.slice(0, 5)).not.toContain(429);
      expect(statuses[5]).toBe(429);
    });
  });
});
