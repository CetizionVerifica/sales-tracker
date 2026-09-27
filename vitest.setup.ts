import { existsSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

// Load the repo-root .env locally (CI sets variables directly), then point
// DATABASE_URL at the test database so tests never touch dev data.
const rootEnv = fileURLToPath(new URL('./.env', import.meta.url));
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);
process.env.NODE_ENV = 'test';
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;

// M7: documents use the in-memory store and the fixture extractor; no test reaches
// Cloudinary or the Anthropic API (CLAUDE.md testing rules).
process.env.FILE_STORE = 'memory';
process.env.EXTRACTOR = 'mock';
process.env.ANTHROPIC_API_KEY ??= 'test-key-never-sent';
process.env.QUEUE_PREFIX = 'test-bull';

// Fail any outbound HTTP to a non-loopback host, so a missed mock cannot call a real service.
const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
function assertLoopback(host: string | null | undefined) {
  const name = (host ?? '').split(':')[0] ?? '';
  if (host && !LOOPBACK.has(name) && !LOOPBACK.has(host)) {
    throw new Error(`Outbound HTTP to ${host} is blocked in tests; mock the client instead`);
  }
}
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assertLoopback(url.hostname);
  return realFetch(input, init);
};
for (const mod of [http, https]) {
  const { request, get } = mod;
  const hostOf = (args: unknown[]) => {
    const [first] = args;
    if (typeof first === 'string' || first instanceof URL) return new URL(first).hostname;
    const options = first as { hostname?: string; host?: string } | undefined;
    return options?.hostname ?? options?.host;
  };
  mod.request = ((...args: unknown[]) => {
    assertLoopback(hostOf(args));
    return (request as (...a: unknown[]) => http.ClientRequest)(...args);
  }) as typeof mod.request;
  mod.get = ((...args: unknown[]) => {
    assertLoopback(hostOf(args));
    return (get as (...a: unknown[]) => http.ClientRequest)(...args);
  }) as typeof mod.get;
}
