import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../env.ts';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'ap-south-1',
  S3_BUCKET: 'sales-tracker',
  S3_ACCESS_KEY_ID: 'key',
  S3_SECRET_ACCESS_KEY: 'secret',
};

describe('parseEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.WEB_PORT).toBe(3000);
    expect(env.MCP_PORT).toBe(3001);
    expect(env.S3_FORCE_PATH_STYLE).toBe(false);
  });

  it('coerces ports and booleans from strings', () => {
    const env = parseEnv({ ...valid, MCP_PORT: '4001', S3_FORCE_PATH_STYLE: 'true' });
    expect(env.MCP_PORT).toBe(4001);
    expect(env.S3_FORCE_PATH_STYLE).toBe(true);
  });

  it('names every missing or invalid variable in one error', () => {
    const { DATABASE_URL: _db, S3_BUCKET: _bucket, ...rest } = valid;
    const run = () => parseEnv({ ...rest, REDIS_URL: 'not-a-url' });
    expect(run).toThrow(EnvError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('S3_BUCKET');
      expect(message).toContain('REDIS_URL');
      expect(message).not.toContain('S3_REGION');
    }
  });
});
