import { describe, expect, it } from 'vitest';
import { EnvError, parseEnv } from '../env.ts';

const valid = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  CLOUDINARY_CLOUD_NAME: 'sales-tracker-test',
  CLOUDINARY_API_KEY: 'key',
  CLOUDINARY_API_SECRET: 'secret',
  BETTER_AUTH_SECRET: 'x'.repeat(32),
  BETTER_AUTH_URL: 'http://localhost:3000',
};

describe('parseEnv', () => {
  it('parses a valid environment and applies defaults', () => {
    const env = parseEnv(valid);
    expect(env.DATABASE_URL).toBe(valid.DATABASE_URL);
    expect(env.WEB_PORT).toBe(3000);
    expect(env.MCP_PORT).toBe(3001);
  });

  it('coerces ports from strings', () => {
    const env = parseEnv({ ...valid, MCP_PORT: '4001' });
    expect(env.MCP_PORT).toBe(4001);
  });

  it('names every missing or invalid variable in one error', () => {
    const { DATABASE_URL: _db, CLOUDINARY_API_SECRET: _secret, ...rest } = valid;
    const run = () => parseEnv({ ...rest, REDIS_URL: 'not-a-url' });
    expect(run).toThrow(EnvError);
    try {
      run();
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain('DATABASE_URL');
      expect(message).toContain('CLOUDINARY_API_SECRET');
      expect(message).toContain('REDIS_URL');
      expect(message).not.toContain('CLOUDINARY_CLOUD_NAME');
    }
  });

  it('AC9: rejects a BETTER_AUTH_SECRET shorter than 32 characters', () => {
    expect(() => parseEnv({ ...valid, BETTER_AUTH_SECRET: 'too-short' })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it('leaves the seed admin variables optional', () => {
    expect(parseEnv(valid).SEED_ADMIN_EMAIL).toBeUndefined();
  });

  describe('TRUSTED_PROXY_CIDRS', () => {
    it('defaults to no trusted proxies', () => {
      expect(parseEnv(valid).TRUSTED_PROXY_CIDRS).toEqual([]);
    });

    it('parses a comma-separated list of IPs and CIDRs', () => {
      const env = parseEnv({
        ...valid,
        TRUSTED_PROXY_CIDRS: '10.0.0.0/8, 172.16.0.1,2001:db8::/32',
      });
      expect(env.TRUSTED_PROXY_CIDRS).toEqual(['10.0.0.0/8', '172.16.0.1', '2001:db8::/32']);
    });

    it.each(['10.0.0.0/33', 'not-an-ip', '10.0.0.0/8/1', '2001:db8::/129'])(
      'rejects %s',
      (entry) => {
        expect(() => parseEnv({ ...valid, TRUSTED_PROXY_CIDRS: entry })).toThrow(
          /TRUSTED_PROXY_CIDRS/,
        );
      },
    );
  });

  describe('BETTER_AUTH_URL in production (secure cookies)', () => {
    it('rejects a non-loopback http URL', () => {
      expect(() =>
        parseEnv({ ...valid, NODE_ENV: 'production', BETTER_AUTH_URL: 'http://sales.example.com' }),
      ).toThrow(/BETTER_AUTH_URL: must use https in production/);
    });

    it.each(['https://sales.example.com', 'http://localhost:3000', 'http://127.0.0.1:3100'])(
      'accepts %s',
      (url) => {
        expect(
          parseEnv({ ...valid, NODE_ENV: 'production', BETTER_AUTH_URL: url }).BETTER_AUTH_URL,
        ).toBe(url);
      },
    );

    it('allows http outside production', () => {
      expect(() =>
        parseEnv({
          ...valid,
          NODE_ENV: 'development',
          BETTER_AUTH_URL: 'http://sales.example.com',
        }),
      ).not.toThrow();
    });
  });
});
