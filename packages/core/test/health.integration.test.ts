import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import { checkHealth } from '../system/health.ts';

describe('checkHealth (integration: real Postgres + Redis)', () => {
  afterAll(disconnectAll);

  it('is ok against the docker compose services', async () => {
    const result = await checkHealth();
    expect(result).toEqual({ status: 'ok', checks: { db: true, redis: true } });
  });
});
