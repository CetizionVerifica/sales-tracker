import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = Boolean(process.env.CI);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1, // one shared, seeded test database
  reporter: isCI ? 'github' : 'list',
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // CI runs against the production build; locally the dev server is fine.
    command: isCI ? `pnpm exec next start --port ${PORT}` : `pnpm exec next dev --port ${PORT}`,
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      // The E2E app talks to the test database, never the dev one.
      DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
      BETTER_AUTH_URL: BASE_URL,
    },
  },
});
