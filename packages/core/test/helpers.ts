import type { Role } from '@sales-tracker/db';
import { getAuth } from '../auth/auth.ts';
import type { Actor, Ctx, Source } from '../context.ts';

export const PASSWORD = 'correct-horse-battery';

export function actor(role: Role, overrides: Partial<Actor> = {}): Actor {
  return { id: `${role.toLowerCase()}-1`, role, active: true, ...overrides };
}

export function ctxFor(user: Actor, source: Source = 'web'): Ctx {
  return { user, source };
}

/** Creates a user through the admin plugin's server API (same path as the seed and M3). */
export async function createTestUser(email: string, role: Role, password = PASSWORD) {
  const { user } = await getAuth().api.createUser({
    body: { email, password, name: email.split('@')[0] ?? email, role },
  });
  return user;
}

/** Signs in and returns request headers carrying the session cookie. */
export async function signIn(email: string, password = PASSWORD): Promise<Headers> {
  const { headers } = await getAuth().api.signInEmail({
    body: { email, password },
    returnHeaders: true,
  });
  const cookie = headers
    .getSetCookie()
    .map((c) => c.split(';')[0])
    .join('; ');
  return new Headers({ cookie });
}

/** Sends a raw HTTP request through Better Auth's handler (exercises routing, rate limits). */
export function authRequest(path: string, body: unknown, ip = '203.0.113.1') {
  const base = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';
  return getAuth().handler(
    new Request(`${base}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }),
  );
}
