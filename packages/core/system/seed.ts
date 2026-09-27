import { randomUUID } from 'node:crypto';
import type { Role } from '@sales-tracker/db';
import { getAuth } from '../auth/auth.ts';
import { getDb } from '../clients.ts';
import { systemCtx, withTx } from '../context.ts';
import { SYSTEM_USER_EMAIL } from './constants.ts';
import { ensureSampleEnquiries } from './seed-enquiries.ts';

export { SYSTEM_USER_EMAIL } from './constants.ts';

/** Dev-only accounts (never seeded in production). Passwords are documented in .env.example. */
export const DEV_USERS = [
  { email: 'sales@example.com', name: 'Sam Sales', role: 'SALES', password: 'sales-dev-password' },
  {
    email: 'sales2@example.com',
    name: 'Sita Sales',
    role: 'SALES',
    password: 'sales2-dev-password',
  },
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

/** Creates a credential user through Better Auth's admin API; audited as the system user. */
async function ensureCredentialUser(
  email: string,
  password: string,
  name: string,
  role: Role,
): Promise<boolean> {
  const exists = await getDb().user.findUnique({ where: { email }, select: { id: true } });
  if (exists) return false;
  // Server-side admin API: hashes the password exactly as sign-in expects. Inside withTx
  // its User and Account writes join one transaction with their audit rows.
  await withTx(await systemCtx(), () =>
    getAuth().api.createUser({ body: { email, password, name, role } }),
  );
  return true;
}

/**
 * Creates the system user if missing. Its own CREATE audit row names itself as the actor:
 * the id is chosen first, so the row it inserts satisfies the audit FK in one transaction.
 */
export async function bootstrapSystemUser(): Promise<string> {
  const existing = await getDb().user.findUnique({
    where: { email: SYSTEM_USER_EMAIL },
    select: { id: true },
  });
  if (existing) return existing.id;

  const id = randomUUID();
  const self = { user: { id, role: 'ADMIN' as const, active: true }, source: 'system' as const };
  await withTx(self, (tx) =>
    tx.user.create({
      data: { id, email: SYSTEM_USER_EMAIL, name: 'System', role: 'ADMIN', isSystem: true },
    }),
  );
  return id;
}

/** Creates the CompanySettings row with defaults if missing (never overwrites edits). */
export async function ensureCompanySettings(): Promise<boolean> {
  const existing = await getDb().companySettings.count({ where: { id: 1 } });
  if (existing) return false;
  await withTx(await systemCtx(), (tx) =>
    tx.companySettings.create({ data: { id: 1, companyName: 'Sales Tracker' } }),
  );
  return true;
}

/** Dev-only sample masters, so forms have something to pick from. */
export const SAMPLE_SECTORS = ['Manufacturing', 'Pharma', 'Infrastructure', 'Energy'];
export const SAMPLE_SERVICES = ['Inspection', 'Certification', 'Audit', 'Training'];

async function ensureSampleMasters(log: (message: string) => void) {
  const ctx = await systemCtx();
  await withTx(ctx, async (tx) => {
    for (const name of SAMPLE_SECTORS) {
      const exists = await tx.sector.count({ where: { name, deletedAt: undefined } });
      if (!exists) await tx.sector.create({ data: { name } });
    }
    for (const name of SAMPLE_SERVICES) {
      const exists = await tx.service.count({ where: { name, deletedAt: undefined } });
      if (!exists) await tx.service.create({ data: { name } });
    }
  });
  log('sample sectors and services ensured');
}

/** Idempotent: creates what is missing and never changes existing users or passwords. */
export async function seed(options: SeedOptions): Promise<void> {
  const { adminEmail, adminPassword, devUsers, log = () => {} } = options;
  if (!adminEmail || !adminPassword) {
    throw new SeedError('SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set to seed the admin');
  }

  // The system user first: every later seed write is audited as it (M2).
  const systemExisted = await getDb().user.count({ where: { email: SYSTEM_USER_EMAIL } });
  await bootstrapSystemUser();
  if (!systemExisted) log('created system user');

  const createdAdmin = await ensureCredentialUser(
    adminEmail,
    adminPassword,
    options.adminName ?? 'Administrator',
    'ADMIN',
  );
  log(createdAdmin ? `created admin ${adminEmail}` : `admin ${adminEmail} already exists`);

  if (await ensureCompanySettings()) log('created company settings');

  if (devUsers) {
    await ensureSampleMasters(log);
    for (const user of DEV_USERS) {
      if (await ensureCredentialUser(user.email, user.password, user.name, user.role)) {
        log(`created dev user ${user.email}`);
      }
    }
    await ensureSampleEnquiries(log);
  }
}
