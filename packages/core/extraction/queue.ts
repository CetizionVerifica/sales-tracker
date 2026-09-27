import { Queue } from 'bullmq';
import type { Redis } from 'ioredis';
import { createRedisConnection } from '../clients.ts';
import { getEnv } from '../env.ts';

/** The BullMQ queue the worker reads document jobs from (M7). */
export const DOCUMENTS_QUEUE = 'documents';
export const EXTRACT_JOB = 'extract';

/** Retryable failures (429, 5xx, network): 3 attempts, exponential backoff from 30 s. */
export const EXTRACT_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 30_000 },
  removeOnComplete: 1000,
  removeOnFail: 1000,
} as const;

const cache = globalThis as unknown as { documentsQueue?: Queue; documentsRedis?: Redis };

export function getDocumentsQueue(): Queue {
  if (!cache.documentsQueue) {
    cache.documentsRedis = createRedisConnection();
    cache.documentsQueue = new Queue(DOCUMENTS_QUEUE, {
      connection: cache.documentsRedis,
      prefix: getEnv().QUEUE_PREFIX,
    });
  }
  return cache.documentsQueue;
}

/**
 * Queues extraction for a document. `jobId = documentId`, so enqueueing twice while a job
 * exists is a no-op. Called after the upload transaction commits; if Redis is down then,
 * the worker's sweeper re-queues the document later.
 */
export async function enqueueExtraction(documentId: string): Promise<void> {
  const queue = getDocumentsQueue();
  // A finished job with this id would block the new one; clear it first ("Try again").
  const existing = await queue.getJob(documentId);
  if (existing && ((await existing.isCompleted()) || (await existing.isFailed()))) {
    await existing.remove();
  }
  await queue.add(EXTRACT_JOB, { documentId }, { ...EXTRACT_JOB_OPTIONS, jobId: documentId });
}

export async function closeDocumentsQueue(): Promise<void> {
  const { documentsQueue: queue, documentsRedis: redis } = cache;
  cache.documentsQueue = undefined;
  cache.documentsRedis = undefined;
  await queue?.close();
  await redis?.quit().catch(() => undefined);
}
