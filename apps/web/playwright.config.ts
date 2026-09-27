import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

const rootEnv = fileURLToPath(new URL('../../.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const PORT = 3100;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const isCI = Boolean(process.env.CI);

// M7: the web server and the worker share a temp-folder file store and the mock extractor
// (fixtures keyed by file hash), so no E2E run reaches Cloudinary or the Anthropic API.
const documentEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  BETTER_AUTH_URL: BASE_URL,
  FILE_STORE: 'local',
  EXTRACTOR: 'mock',
  MOCK_EXTRACTOR_FIXTURES: fileURLToPath(
    new URL('../../packages/core/test/fixtures/documents/mock-extractor.json', import.meta.url),
  ),
  QUEUE_PREFIX: 'e2e-bull',
};

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  forbidOnly: isCI,
  retries: isCI ? 1 : 0,
  workers: 1, // one shared, seeded test database
  reporter: isCI ? 'github' : 'list',
  use: { baseURL: BASE_URL, trace: 'on-first-retry' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // CI runs against the production build; locally the dev server is fine.
      command: isCI ? `pnpm exec next start --port ${PORT}` : `pnpm exec next dev --port ${PORT}`,
      url: `${BASE_URL}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        // The E2E app talks to the test database, never the dev one.
        ...documentEnv,
        // Every test signs in from 127.0.0.1; the production default (5/min) would 429.
        AUTH_SIGNIN_RATE_LIMIT: '1000',
      },
    },
    {
      // Reads uploaded documents (M7). It has no HTTP port; wait for its ready line.
      command: 'pnpm --dir ../worker exec tsx src/main.ts',
      wait: { stdout: /worker ready/ },
      reuseExistingServer: false,
      timeout: 60_000,
      env: documentEnv,
    },
  ],
});
