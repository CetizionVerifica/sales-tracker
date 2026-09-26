import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { E2E_USERS } from './users.ts';

const script = fileURLToPath(
  new URL('../../../packages/core/scripts/prepare-e2e-db.ts', import.meta.url),
);

/** Prepares the test database (never the dev one) before the web server starts. */
export default function globalSetup() {
  const testUrl = process.env.TEST_DATABASE_URL;
  if (!testUrl) throw new Error('TEST_DATABASE_URL must be set for E2E tests');
  execFileSync(process.execPath, ['--import', 'tsx', script], {
    env: {
      ...process.env,
      DATABASE_URL: testUrl,
      SEED_ADMIN_EMAIL: E2E_USERS.admin.email,
      SEED_ADMIN_PASSWORD: E2E_USERS.admin.password,
    },
    stdio: 'inherit',
  });
}
