import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Apply migrations to the test database once per run. Each integration test file
// then calls resetDb() in beforeAll (CLAUDE.md: real test DB, reset per test file).
export default function setup() {
  const rootEnv = fileURLToPath(new URL('./.env', import.meta.url));
  if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
  const url = process.env.TEST_DATABASE_URL;
  if (!url) throw new Error('TEST_DATABASE_URL must be set to run tests');
  execFileSync('pnpm', ['--filter', '@sales-tracker/db', 'exec', 'prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}
