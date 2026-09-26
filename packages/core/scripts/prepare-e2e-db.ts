// Test-only: migrate, wipe and seed the database named by DATABASE_URL for Playwright.
// Refuses to run against anything but TEST_DATABASE_URL.
import { execFileSync } from 'node:child_process';
import { resetDb } from '@sales-tracker/db/test-utils';
import { disconnectAll, getDb } from '../clients.ts';
import { seed } from '../system/seed.ts';

const url = process.env.DATABASE_URL;
if (!url || url !== process.env.TEST_DATABASE_URL) {
  throw new Error('prepare-e2e-db: DATABASE_URL must equal TEST_DATABASE_URL');
}

execFileSync('pnpm', ['--filter', '@sales-tracker/db', 'exec', 'prisma', 'migrate', 'deploy'], {
  stdio: 'pipe',
});
try {
  await resetDb(getDb());
  await seed({
    adminEmail: process.env.SEED_ADMIN_EMAIL,
    adminPassword: process.env.SEED_ADMIN_PASSWORD,
    adminName: 'E2E Admin',
    devUsers: true,
  });
} finally {
  await disconnectAll();
}
