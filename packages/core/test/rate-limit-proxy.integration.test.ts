import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import { authRequest, createTestUser } from './helpers.ts';

// Must be set before getEnv()/getAuth() first run in this file (each file is isolated).
process.env.TRUSTED_PROXY_CIDRS = '10.0.0.0/8';

async function attempts(forwardedFor: string, count: number) {
  const statuses: number[] = [];
  for (let i = 0; i < count; i++) {
    const response = await authRequest(
      '/sign-in/email',
      { email: 'sales@example.test', password: 'wrong-password-123' },
      forwardedFor,
    );
    statuses.push(response.status);
  }
  return statuses;
}

describe('rate limiting behind a trusted proxy (review fix A)', () => {
  beforeAll(async () => {
    await resetDb(getDb());
    await createTestUser('sales@example.test', 'SALES');
  });
  afterAll(disconnectAll);

  it('gives each client behind the proxy its own bucket', async () => {
    // Client A's chain: real client, then our proxy (trusted, stripped from the right).
    const clientA = await attempts('198.51.100.1, 10.0.0.5', 6);
    expect(clientA[5]).toBe(429);

    // Client B, same proxy: not affected by A hitting the limit.
    const clientB = await attempts('198.51.100.2, 10.0.0.5', 1);
    expect(clientB[0]).not.toBe(429);
  });

  it('does not let a client dodge the limit by spoofing extra hops', async () => {
    // Untrusted left-most entries are ignored: the first untrusted hop from the right is used.
    const spoofed = await attempts('203.0.113.50, 198.51.100.1, 10.0.0.5', 1);
    expect(spoofed[0]).toBe(429);
  });
});
