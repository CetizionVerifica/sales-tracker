import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DISABLED_AUTH_PATHS,
  ENABLED_AUTH_PATHS,
  getAuth,
  handleAuthRequest,
} from '../auth/auth.ts';
import { disconnectAll, getDb } from '../clients.ts';
import { PASSWORD, createTestUser, signIn } from './helpers.ts';

// M2 review fix A: Better Auth's own user/account endpoints would bypass can() and the
// audit log, so only an explicit allow-list of routes is reachable over HTTP.
describe('Better Auth HTTP routes (allow-list)', () => {
  let session: Headers;

  beforeAll(async () => {
    await resetDb(getDb());
    await createTestUser('sales@example.test', 'SALES');
    session = await signIn('sales@example.test');
  });
  afterAll(disconnectAll);

  it('every route Better Auth registers is explicitly enabled or disabled', () => {
    const registered = new Set(
      Object.values(getAuth().api as Record<string, { path?: string }>)
        .map((endpoint) => endpoint.path)
        .filter((path): path is string => Boolean(path)),
    );
    const reviewed = new Set([...ENABLED_AUTH_PATHS, ...DISABLED_AUTH_PATHS]);
    expect([...registered].filter((path) => !reviewed.has(path))).toEqual([]);
    expect(ENABLED_AUTH_PATHS.filter((path) => DISABLED_AUTH_PATHS.includes(path))).toEqual([]);
  });

  it.each(DISABLED_AUTH_PATHS)(
    '%s returns 404 for a signed-in user and changes nothing',
    async (path) => {
      const base = process.env.BETTER_AUTH_URL ?? '';
      const before = await getDb().user.findUniqueOrThrow({
        where: { email: 'sales@example.test' },
        include: { accounts: true },
      });
      const auditBefore = await getDb().auditLog.count();

      const concrete = path.replace(':token', 'some-token').replace(':id', 'google');
      const response = await handleAuthRequest(
        new Request(`${base}/api/auth${concrete}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: base,
            cookie: session.get('cookie') ?? '',
            'x-forwarded-for': '203.0.113.77',
          },
          body: JSON.stringify({
            name: 'Changed',
            email: 'changed@example.test',
            newEmail: 'changed@example.test',
            currentPassword: PASSWORD,
            newPassword: 'a-different-long-password',
            password: PASSWORD,
          }),
        }),
      );

      expect(response.status).toBe(404);
      const after = await getDb().user.findUniqueOrThrow({
        where: { email: 'sales@example.test' },
        include: { accounts: true },
      });
      expect(after).toEqual(before);
      expect(await getDb().auditLog.count()).toBe(auditBefore);
    },
  );

  it.each([
    ['GET', '/callback/google'],
    ['GET', '/reset-password/some-token'],
    ['GET', '/a-route-from-a-future-better-auth-version'],
    ['POST', '/sign-in/email/'],
    ['POST', '/sign-in%2Femail'],
  ])(
    '%s %s is blocked by the allow-list (param, unknown and look-alike paths)',
    async (method, path) => {
      const base = process.env.BETTER_AUTH_URL ?? '';
      const response = await handleAuthRequest(
        new Request(`${base}/api/auth${path}`, {
          method,
          headers: { cookie: session.get('cookie') ?? '', origin: base },
        }),
      );
      expect(response.status).toBe(404);
    },
  );

  it('keeps the enabled routes working through the entry point', async () => {
    const base = process.env.BETTER_AUTH_URL ?? '';
    const response = await handleAuthRequest(
      new Request(`${base}/api/auth/get-session`, {
        headers: { cookie: session.get('cookie') ?? '' },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { email: 'sales@example.test' } });
  });

  it('keeps the enabled session API working', async () => {
    const result = await getAuth().api.getSession({ headers: session });
    expect(result?.user.email).toBe('sales@example.test');
  });
});
