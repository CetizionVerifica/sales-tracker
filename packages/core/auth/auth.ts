import { betterAuth } from 'better-auth';
import { prismaAdapter } from 'better-auth/adapters/prisma';
import { APIError } from 'better-auth/api';
import { admin } from 'better-auth/plugins';
import { adminAc, userAc } from 'better-auth/plugins/admin/access';
import { authDb, getDb } from '../clients.ts';
import { getEnv } from '../env.ts';
import { SIGN_IN_FAILED } from '../schemas/user.ts';

const DAY_SECONDS = 60 * 60 * 24;

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
    // Admin actions go through packages/core services (RBAC + audit), never these HTTP routes.
    disabledPaths: [
      '/sign-up/email',
      '/admin/create-user',
      '/admin/list-users',
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
      '/admin/get-user',
    ],
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
