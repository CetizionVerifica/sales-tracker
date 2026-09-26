import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { admin } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import { authDb, getDb } from '../clients.ts';
import { getEnv } from '../env.ts';
import { SIGN_IN_FAILED } from '../schemas/user.ts';

const DAY_SECONDS = 60 * 60 * 24;

/**
 * Allow-list of Better Auth HTTP routes. Everything else is disabled: user and account
 * changes go through packages/core services (can() + audit log), never Better Auth's own
 * endpoints. The auth-routes test fails if a Better Auth upgrade adds an unreviewed route.
 */
export const ENABLED_AUTH_PATHS = ['/sign-in/email', '/sign-out', '/get-session', '/ok', '/error'];

/**
 * Also passed to Better Auth's `disabledPaths` as a second layer. That option compares the
 * concrete request path literally, so it cannot block parameterised routes such as
 * `/callback/:id`; handleAuthRequest's allow-list is the real boundary.
 */
export const DISABLED_AUTH_PATHS = [
  // Sign-up and self-service account changes (no public sign-up; users are admin-managed).
  '/sign-up/email',
  '/update-user',
  '/change-password',
  '/change-email',
  '/delete-user',
  '/delete-user/callback',
  '/verify-password',
  // Email verification and password reset (not used in v1).
  '/verify-email',
  '/send-verification-email',
  '/request-password-reset',
  '/reset-password',
  '/reset-password/:token',
  // Social/OAuth accounts (email + password only).
  '/sign-in/social',
  '/callback/:id',
  '/link-social',
  '/unlink-account',
  '/list-accounts',
  '/account-info',
  '/refresh-token',
  '/get-access-token',
  // Session management beyond sign-in/out (not used yet).
  '/list-sessions',
  '/update-session',
  '/revoke-session',
  '/revoke-sessions',
  '/revoke-other-sessions',
  // Admin plugin: admin actions go through core services instead.
  '/admin/create-user',
  '/admin/list-users',
  '/admin/get-user',
  '/admin/set-role',
  '/admin/set-user-password',
  '/admin/update-user',
  '/admin/ban-user',
  '/admin/unban-user',
  '/admin/impersonate-user',
  '/admin/stop-impersonating',
  '/admin/revoke-user-session',
  '/admin/revoke-user-sessions',
  '/admin/list-user-sessions',
  '/admin/remove-user',
  '/admin/has-permission',
];

function createAuth() {
  const env = getEnv();

  return betterAuth({
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    database: prismaAdapter(authDb, { provider: 'postgresql' }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: true, // only admins create users (M3)
      minPasswordLength: 12,
    },
    session: {
      expiresIn: 7 * DAY_SECONDS,
      updateAge: DAY_SECONDS,
    },
    user: {
      additionalFields: {
        active: { type: 'boolean', defaultValue: true, input: false },
        isSystem: { type: 'boolean', defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          // Inactive users and the system actor never get a session.
          before: async (session) => {
            // Resolved per call: inside withTx this is the transaction client.
            const user = await getDb().user.findUnique({
              where: { id: session.userId },
              select: { active: true, isSystem: true },
            });
            if (!user || !user.active || user.isSystem) {
              throw new APIError('UNAUTHORIZED', { message: SIGN_IN_FAILED });
            }
          },
        },
      },
    },
    advanced: {
      // Resolve the real client IP behind our reverse proxies so each client gets its own
      // rate-limit bucket (otherwise Better Auth falls back to one shared bucket).
      ipAddress: { trustedProxies: env.TRUSTED_PROXY_CIDRS },
    },
    rateLimit: {
      enabled: true,
      storage: 'memory',
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    disabledPaths: DISABLED_AUTH_PATHS,
    telemetry: { enabled: false },
    plugins: [
      admin({
        defaultRole: 'SALES',
        adminRoles: ['ADMIN'],
        // Declared so the plugin types match the Prisma Role enum. Its own permission
        // system is unused: its HTTP routes are disabled and can() is the authority.
        roles: { ADMIN: adminAc, SALES: userAc, PROJECT_MANAGER: userAc },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

const globalForAuth = globalThis as unknown as { auth?: Auth };

export function getAuth(): Auth {
  globalForAuth.auth ??= createAuth();
  return globalForAuth.auth;
}

const AUTH_BASE_PATH = '/api/auth';

/**
 * The only HTTP entry to Better Auth (mounted at /api/auth/*). Paths not on the allow-list
 * get 404 before Better Auth sees them, including parameterised and future routes.
 */
export function handleAuthRequest(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  const path = pathname.startsWith(AUTH_BASE_PATH) ? pathname.slice(AUTH_BASE_PATH.length) : null;
  if (!path || !ENABLED_AUTH_PATHS.includes(path)) {
    return Promise.resolve(new Response('Not Found', { status: 404 }));
  }
  return getAuth().handler(request);
}
