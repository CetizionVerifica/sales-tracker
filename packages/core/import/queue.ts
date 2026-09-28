import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../clients.ts';
import { getEnv } from '../env.ts';

/**
 * The BullMQ queue the worker reads M10b import jobs from. Undo (`rollback-batch.ts`) runs
 * synchronously inside `undoImportBatch` instead of as a job: phase 1 has no update-existing
 * mode, so undo is a plain soft-delete of the batch's created records, small and fast enough
 * not to need the same async/progress treatment as parsing or committing.
 */
export const IMPORTS_QUEUE = 'imports';
export const IMPORT_PARSE_JOB = 'import.parse';
export const IMPORT_COMMIT_JOB = 'import.commit';

/** No AI call and no external network I/O in these jobs, so failures are rarely transient. */
export const IMPORT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'exponential', delay: 10_000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

const cache = globalThis as unknown as { importsQueue?: Queue; importsRedis?: Redis };

export function getImportsQueue(): Queue {
  if (!cache.importsQueue) {
    cache.importsRedis = createRedisConnection();
    cache.importsQueue = new Queue(IMPORTS_QUEUE, {
      connection: cache.importsRedis,
      prefix: getEnv().QUEUE_PREFIX,
    });
  }
  return cache.importsQueue;
}

async function enqueue(jobName: string, batchId: string): Promise<void> {
  const queue = getImportsQueue();
  // BullMQ rejects a custom job id containing ":" — it uses that as its own delimiter.
  const jobId = `${jobName}_${batchId}`;
  const existing = await queue.getJob(jobId);
  if (existing && ((await existing.isCompleted()) || (await existing.isFailed()))) {
    await existing.remove();
  }
  await queue.add(jobName, { batchId }, { ...IMPORT_JOB_OPTIONS, jobId });
}

/** Queues parsing + structure detection + heuristic column suggestion for a new upload. */
export async function enqueueImportParse(batchId: string): Promise<void> {
  await enqueue(IMPORT_PARSE_JOB, batchId);
}

/** Queues the all-or-nothing commit transaction. */
export async function enqueueImportCommit(batchId: string): Promise<void> {
  await enqueue(IMPORT_COMMIT_JOB, batchId);
}

export async function closeImportsQueue(): Promise<void> {
  const { importsQueue: queue, importsRedis: redis } = cache;
  cache.importsQueue = undefined;
  cache.importsRedis = undefined;
  await queue?.close();
  await redis?.quit().catch(() => undefined);
}
