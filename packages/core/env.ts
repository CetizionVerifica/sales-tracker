import { isIP } from 'node:net';
import { z } from 'zod';

const booleanString = z
  .enum(['true', 'false'])
  .default('false')
  .transform((value) => value === 'true');

/** An IP address or CIDR range, e.g. `10.0.0.0/8` or `2001:db8::/32`. */
function isCidr(entry: string): boolean {
  const [address = '', prefix, ...rest] = entry.split('/');
  const version = isIP(address);
  if (version === 0 || rest.length > 0) return false;
  if (prefix === undefined) return true;
  const bits = Number(prefix);
  return /^\d+$/.test(prefix) && bits <= (version === 4 ? 32 : 128);
}

/** Comma-separated CIDR list; empty or unset means no proxies are trusted. */
const cidrList = z
  .string()
  .optional()
  .transform((value) =>
    (value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean),
  )
  .refine((entries) => entries.every(isCidr), 'must be a comma-separated list of IPs or CIDRs');

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    S3_ENDPOINT: z.url(),
    S3_REGION: z.string().min(1),
    S3_BUCKET: z.string().min(1),
    S3_ACCESS_KEY_ID: z.string().min(1),
    S3_SECRET_ACCESS_KEY: z.string().min(1),
    S3_FORCE_PATH_STYLE: booleanString,
    BETTER_AUTH_SECRET: z.string().min(32, 'must be at least 32 characters'),
    BETTER_AUTH_URL: z.url(),
    // Reverse proxies whose x-forwarded-for entries are trusted. Without this, production
    // rate limiting cannot tell clients apart behind a proxy (all share one bucket).
    TRUSTED_PROXY_CIDRS: cidrList,
    // Sign-in attempts per minute per client IP. Keep the default in production; the E2E
    // server raises it because every test signs in from 127.0.0.1.
    AUTH_SIGNIN_RATE_LIMIT: z.coerce.number().int().min(1).max(1000).default(5),
    // Only the seed script needs these; it reports a clear error when they are missing.
    SEED_ADMIN_EMAIL: z.email().optional(),
    SEED_ADMIN_PASSWORD: z.string().min(12).optional(),
    WEB_PORT: z.coerce.number().int().positive().default(3000),
    MCP_PORT: z.coerce.number().int().positive().default(3001),
  })
  .superRefine((env, ctx) => {
    // Better Auth marks cookies Secure only for https URLs. Loopback is exempt so the
    // production build can run locally and in CI (cookies never leave the machine).
    const url = new URL(env.BETTER_AUTH_URL);
    if (
      env.NODE_ENV === 'production' &&
      url.protocol !== 'https:' &&
      !LOOPBACK_HOSTS.has(url.hostname)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['BETTER_AUTH_URL'],
        message: 'must use https in production (session cookies are only Secure over https)',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export class EnvError extends Error {
  override name = 'EnvError';
}

/** Validates an env source, throwing one error that lists every bad variable. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(source);
  if (result.success) return result.data;
  const lines = result.error.issues.map(
    (issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`,
  );
  throw new EnvError(`Invalid environment variables:\n${lines.join('\n')}`);
}

let cached: Env | undefined;

/** Parsed `process.env`, validated once. Apps call this at startup so bad config fails fast. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
