import { randomUUID } from 'node:crypto';
import type { Role } from '@sales-tracker/db';
import { getAuth } from '../auth/auth.ts';
import { getDb } from '../clients.ts';

export const SYSTEM_USER_EMAIL = 'system@internal';

/** Dev-only accounts (never seeded in production). Passwords are documented in .env.example. */
export const DEV_USERS = [
  { email: 'sales@example.com', name: 'Sam Sales', role: 'SALES', password: 'sales-dev-password' },
  {
    email: 'pm@example.com',
    name: 'Priya PM',
    role: 'PROJECT_MANAGER',
    password: 'pm-dev-password1',
  },
] as const satisfies readonly { email: string; name: string; role: Role; password: string }[];

export class SeedError extends Error {
  override name = 'SeedError';
}

export interface SeedOptions {
  adminEmail: string | undefined;
  adminPassword: string | undefined;
  adminName?: string;
  /** Adds the DEV_USERS; the CLI passes true only when NODE_ENV=development. */
  devUsers: boolean;
  log?: (message: string) => void;
}

async function ensureCredentialUser(
  email: string,
  password: string,
  name: string,
  role: Role,
): Promise<boolean> {
  const exists = await getDb().user.findUnique({ where: { email }, select: { id: true } });
  if (exists) return false;
  // Server-side admin API: hashes the password exactly as sign-in expects.
  await getAuth().api.createUser({ body: { email, password, name, role } });
  return true;
}

/** Idempotent: creates what is missing and never changes existing users or passwords. */
export async function seed(options: SeedOptions): Promise<void> {
  const { adminEmail, adminPassword, devUsers, log = () => {} } = options;
  if (!adminEmail || !adminPassword) {
    throw new SeedError('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set to seed the admin');
  }

  const createdAdmin = await ensureCredentialUser(
    adminEmail,
    adminPassword,
    options.adminName ?? 'Administrator',
    'ADMIN',
  );
  log(createdAdmin ? `created admin ${adminEmail}` : `admin ${adminEmail} already exists`);

  // The non-login actor for jobs and imports (M1 Decision 5): no credential account.
  const db = getDb();
  const system = await db.user.findUnique({ where: { email: SYSTEM_USER_EMAIL } });
  if (!system) {
    await db.user.create({
      data: {
        id: randomUUID(),
        email: SYSTEM_USER_EMAIL,
        name: 'System',
        role: 'ADMIN',
        isSystem: true,
      },
    });
    log('created system user');
  }

  if (devUsers) {
    for (const user of DEV_USERS) {
      if (await ensureCredentialUser(user.email, user.password, user.name, user.role)) {
        log(`created dev user ${user.email}`);
      }
    }
  }
}
