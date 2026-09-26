import { describe, expect, it } from 'vitest';
import { checkHealth } from '../services/health.service.ts';

describe('checkHealth (unit)', () => {
  it('is ok when every probe succeeds', async () => {
    const result = await checkHealth({ db: async () => {}, redis: async () => {} });
    expect(result).toEqual({ status: 'ok', checks: { db: true, redis: true } });
  });

  it('is degraded with db: false when the database probe fails', async () => {
    const result = await checkHealth({
      db: async () => {
        throw new Error('connection refused');
      },
      redis: async () => {},
    });
    expect(result).toEqual({ status: 'degraded', checks: { db: false, redis: true } });
  });

  it('treats a probe that hangs past the timeout as failed', async () => {
    const result = await checkHealth(
      { db: async () => {}, redis: () => new Promise(() => {}) },
      { timeoutMs: 20 },
    );
    expect(result).toEqual({ status: 'degraded', checks: { db: true, redis: false } });
  });
});
