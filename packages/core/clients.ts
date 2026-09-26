import { createPrismaClient, type DbClient } from '@sales-tracker/db';
import { Redis } from 'ioredis';
import { getEnv } from './env.ts';

// Shared singletons. The globalThis cache survives Next.js hot reloads in dev.
const globalForClients = globalThis as unknown as { db?: DbClient; redis?: Redis };

/** Internal to packages/core: services use this; apps never touch Prisma directly. */
export function getDb(): DbClient {
  globalForClients.db ??= createPrismaClient(getEnv().DATABASE_URL);
  return globalForClients.db;
}

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
