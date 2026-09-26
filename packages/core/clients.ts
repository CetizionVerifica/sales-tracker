import { createPrismaClient } from '@sales-tracker/db';
import { Redis } from 'ioredis';
import { auditOperation } from './audit/extension.ts';
import { registerModelMeta } from './audit/model-meta.ts';
import { getStore } from './audit/store.ts';
import { getEnv } from './env.ts';

function createAuditedClient(databaseUrl: string) {
  const base = createPrismaClient(databaseUrl);
  registerModelMeta(base);
  return base.$extends({
    name: 'audit',
    query: { $allModels: { $allOperations: auditOperation } },
  });
}

export type AuditedClient = ReturnType<typeof createAuditedClient>;

/** What an interactive transaction exposes (Prisma denies these inside a transaction). */
export type Db = Omit<
  AuditedClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'
>;

// Shared singletons. The globalThis cache survives Next.js hot reloads in dev.
const globalForClients = globalThis as unknown as { db?: AuditedClient; redis?: Redis };

/** The root audited client: only withTx and shutdown need it. Never export the base client. */
export function getRootDb(): AuditedClient {
  globalForClients.db ??= createAuditedClient(getEnv().DATABASE_URL);
  return globalForClients.db;
}

/**
 * Internal to packages/core. Inside withTx this is the active transaction client, so every
 * core write (services, Better Auth, the seed) joins the transaction the audit rows use.
 */
export function getDb(): Db {
  const root = getRootDb();
  return (getStore()?.tx as Db | undefined) ?? root;
}

/**
 * A client for Better Auth's Prisma adapter that resolves to getDb() on every access, so
 * its writes join our transaction. Nested $transaction calls are flattened into the
 * active one (the M2 spike showed createUser rolls back cleanly this way).
 */
export const authDb = new Proxy({} as AuditedClient, {
  get(_target, property) {
    const tx = getStore()?.tx;
    if (property === '$transaction' && tx) {
      return (fn: (client: unknown) => unknown) => fn(tx);
    }
    const client = (tx ?? getRootDb()) as unknown as Record<PropertyKey, unknown>;
    const value = client[property];
    return typeof value === 'function' ? value.bind(client) : value;
  },
});

/** New Redis connection configured for BullMQ (which requires maxRetriesPerRequest: null). */
export function createRedisConnection(): Redis {
  return new Redis(getEnv().REDIS_URL, { maxRetriesPerRequest: null });
}

export function getRedis(): Redis {
  globalForClients.redis ??= createRedisConnection();
  return globalForClients.redis;
}

export async function disconnectAll(): Promise<void> {
  const { db, redis } = globalForClients;
  globalForClients.db = undefined;
  globalForClients.redis = undefined;
  await Promise.all([db?.$disconnect(), redis?.quit()]);
}
