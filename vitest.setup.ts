import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env locally (CI sets variables directly), then point
// DATABASE_URL at the test database so tests never touch dev data.
const rootEnv = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
