import { isIP } from 'node:net';
import { z } from 'zod';

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

/** An optional string where an empty value (`KEY=` in .env) means unset. */
const emptyAsUnset = z
  .string()
  .optional()
  .transform((value) => value?.trim() || undefined);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    REDIS_URL: z.url({ protocol: /^rediss?$/ }),
    CLOUDINARY_CLOUD_NAME: z.string().min(1),
    CLOUDINARY_API_KEY: z.string().min(1),
    CLOUDINARY_API_SECRET: z.string().min(1),
    // Assets land under this folder, so dev, test and prod never mix in one account (M7).
    CLOUDINARY_FOLDER: emptyAsUnset,
    // Where document files live: Cloudinary, a shared temp folder (E2E), or memory (Vitest).
    FILE_STORE: z.enum(['cloudinary', 'local', 'memory']).default('cloudinary'),
    // Who reads documents: the Claude API, or fixtures keyed by file hash (tests, E2E).
    EXTRACTOR: z.enum(['claude', 'mock']).default('claude'),
    // Required in production; elsewhere a missing key fails each extraction with a message.
    ANTHROPIC_API_KEY: emptyAsUnset,
    // M7 Decision 5: the most accurate model by default; override to trade accuracy for cost.
    ANTHROPIC_MODEL: z.string().min(1).default('claude-opus-5'),
    // 20 MB default; at most 30 MB, under the Claude API's 32 MB request limit after base64.
    DOCUMENT_MAX_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(30 * 1024 * 1024)
      .default(20 * 1024 * 1024),
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
    // BullMQ key prefix; tests use their own so they never touch dev jobs in the same Redis.
    QUEUE_PREFIX: z.string().min(1).default('bull'),
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
    // The test doubles are rejected in production, except on loopback: the CI E2E run uses
    // the production build (`next start`) against the local store and mock extractor.
    if (env.NODE_ENV === 'production' && !LOOPBACK_HOSTS.has(url.hostname)) {
      if (env.FILE_STORE !== 'cloudinary') {
        ctx.addIssue({
          code: 'custom',
          path: ['FILE_STORE'],
          message: 'must be cloudinary in production (local and memory are for tests)',
        });
      }
      if (env.EXTRACTOR !== 'claude') {
        ctx.addIssue({
          code: 'custom',
          path: ['EXTRACTOR'],
          message: 'must be claude in production (mock is for tests)',
        });
      }
    }
    if (env.NODE_ENV === 'production' && env.EXTRACTOR === 'claude' && !env.ANTHROPIC_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'is required' });
    }
    if (env.FILE_STORE === 'memory' && env.NODE_ENV !== 'test') {
      ctx.addIssue({
        code: 'custom',
        path: ['FILE_STORE'],
        message: 'memory is only for tests (files would not survive a restart)',
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
