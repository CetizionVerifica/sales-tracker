import { getDb, getRedis } from '../clients.ts';

export type HealthProbe = () => Promise<unknown>;

export interface HealthResult {
  status: 'ok' | 'degraded';
  checks: { db: boolean; redis: boolean };
}

const defaultProbes: Record<keyof HealthResult['checks'], HealthProbe> = {
  db: () => getDb().$queryRaw`SELECT 1`,
  redis: () => getRedis().ping(),
};

async function passes(probe: HealthProbe, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
  });
  try {
    await Promise.race([probe(), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Liveness probe for web, MCP and ops. System-level, so it takes no `ctx` and does no RBAC;
 * it reads nothing beyond `SELECT 1` and a Redis PING.
 */
export async function checkHealth(
  probes = defaultProbes,
  { timeoutMs = 2000 }: { timeoutMs?: number } = {},
): Promise<HealthResult> {
  const [db, redis] = await Promise.all([
    passes(probes.db, timeoutMs),
    passes(probes.redis, timeoutMs),
  ]);
  return { status: db && redis ? 'ok' : 'degraded', checks: { db, redis } };
}
