import {
  closeDocumentsQueue,
  createRedisConnection,
  DOCUMENTS_QUEUE,
  getEnv,
  runExtraction,
  sweepStuckDocuments,
  systemCtx,
} from '@sales-tracker/core';
import { UnrecoverableError, Worker, type Job } from 'bullmq';

export const SYSTEM_QUEUE = 'system';

/** Anthropic rate limits: at most two documents are read at once (M7 Decision 7). */
export const DOCUMENT_CONCURRENCY = 2;
/** The sweeper re-queues stuck documents on start and then this often (M7). */
export const SWEEP_INTERVAL_MS = 10 * 60_000;

/** One extraction job. A retryable error rethrows so BullMQ retries it with backoff. */
export async function processDocumentJob(job: Job<{ documentId: string }>) {
  const documentId = job.data?.documentId;
  if (typeof documentId !== 'string') throw new UnrecoverableError('documentId is missing');
  const ctx = await systemCtx();
  const maxAttempts = job.opts.attempts ?? 1;
  return runExtraction(ctx, documentId, { attempt: job.attemptsMade + 1, maxAttempts });
}

async function sweep() {
  try {
    const queued = await sweepStuckDocuments(await systemCtx());
    if (queued.length > 0) console.log(`re-queued ${queued.length} stuck document(s)`);
  } catch (error) {
    console.error('document sweep failed', error);
  }
}

/**
 * Starts the BullMQ workers: the no-op `system` queue from M0 and the M7 `documents`
 * queue, plus the stuck-document sweeper. M10's overdue check registers here too.
 */
export async function startWorker(options: { sweep?: boolean } = {}) {
  const prefix = getEnv().QUEUE_PREFIX;
  const connection = createRedisConnection();
  const system = new Worker(SYSTEM_QUEUE, async (job) => ({ ok: true, name: job.name }), {
    connection,
    prefix,
  });
  const documents = new Worker(DOCUMENTS_QUEUE, processDocumentJob, {
    connection,
    prefix,
    concurrency: DOCUMENT_CONCURRENCY,
  });
  documents.on('failed', (job, error) => {
    console.error(`document job ${job?.id} attempt ${job?.attemptsMade} failed: ${error.message}`);
  });
  await Promise.all([system.waitUntilReady(), documents.waitUntilReady()]);

  let timer: NodeJS.Timeout | undefined;
  if (options.sweep !== false) {
    await sweep();
    timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    timer.unref();
  }

  return {
    async close() {
      if (timer) clearInterval(timer);
      await Promise.all([system.close(), documents.close()]);
      await closeDocumentsQueue();
      await connection.quit();
    },
  };
}
