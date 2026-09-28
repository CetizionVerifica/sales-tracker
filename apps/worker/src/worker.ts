import {
  closeDocumentsQueue,
  closeImportsQueue,
  createRedisConnection,
  DOCUMENTS_QUEUE,
  expireImportDrafts,
  getEnv,
  IMPORT_COMMIT_JOB,
  IMPORT_PARSE_JOB,
  IMPORTS_QUEUE,
  markOverdueInvoices,
  runExtraction,
  runImportCommitJob,
  runImportParseJob,
  sweepStuckDocuments,
  systemCtx,
} from '@sales-tracker/core';
import { Queue, UnrecoverableError, Worker, type Job } from 'bullmq';

export const SYSTEM_QUEUE = 'system';

/** The nightly overdue check (M10): 00:05 in Asia/Kolkata, as a BullMQ job scheduler. */
export const OVERDUE_JOB = 'invoices:mark-overdue';
export const OVERDUE_SCHEDULE = '5 0 * * *';
const OVERDUE_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 60_000 },
  removeOnComplete: 100,
  removeOnFail: 100,
} as const;

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

/** M10b: parse+detect+heuristic-map, or the all-or-nothing commit transaction. */
export async function processImportJob(job: Job<{ batchId: string }>) {
  const batchId = job.data?.batchId;
  if (typeof batchId !== 'string') throw new UnrecoverableError('batchId is missing');
  if (job.name === IMPORT_PARSE_JOB) return runImportParseJob(batchId);
  if (job.name === IMPORT_COMMIT_JOB) return runImportCommitJob(batchId);
  throw new UnrecoverableError(`unknown import job "${job.name}"`);
}

/** The overdue check as the system user (`source: 'system'`), with its counts logged. */
async function checkOverdue() {
  const run = await markOverdueInvoices(await systemCtx());
  console.log(
    `overdue check: ${run.markedOverdue} invoice(s) marked overdue, ${run.posRecomputed} PO(s) updated, ${run.failed} failed`,
  );
  return run;
}

/** Nightly: batches left untouched 7+ days past their `expiresAt` move to EXPIRED (M10b). */
export const IMPORT_EXPIRE_JOB = 'imports:expire-drafts';
export const IMPORT_EXPIRE_SCHEDULE = '10 0 * * *';
async function checkImportExpiry() {
  const run = await expireImportDrafts(await systemCtx());
  console.log(`import expiry check: ${run.expired} draft(s) expired`);
  return run;
}

/** Jobs on the `system` queue by name; any other name is the M0 no-op. */
const SYSTEM_JOBS: Record<string, () => Promise<unknown>> = {
  [OVERDUE_JOB]: checkOverdue,
  [IMPORT_EXPIRE_JOB]: checkImportExpiry,
};

export async function processSystemJob(job: Job) {
  const handler = SYSTEM_JOBS[job.name];
  return handler ? handler() : { ok: true, name: job.name };
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
 * Starts the BullMQ workers: the `system` queue (M0; M10's nightly overdue check, M10b's
 * nightly draft-expiry check), the M7 `documents` queue, and the M10b `imports` queue, plus
 * the stuck-document sweeper. Both nightly schedules are upserts, so restarts do not add a
 * second one, and each also runs once on start, so a night the worker was down is caught up
 * (both checks are idempotent).
 */
export async function startWorker(options: { sweep?: boolean } = {}) {
  const prefix = getEnv().QUEUE_PREFIX;
  const connection = createRedisConnection();
  const systemQueue = new Queue(SYSTEM_QUEUE, { connection, prefix });
  await systemQueue.upsertJobScheduler(
    OVERDUE_JOB,
    { pattern: OVERDUE_SCHEDULE, tz: 'Asia/Kolkata' },
    { name: OVERDUE_JOB, opts: OVERDUE_JOB_OPTIONS },
  );
  await systemQueue.upsertJobScheduler(
    IMPORT_EXPIRE_JOB,
    { pattern: IMPORT_EXPIRE_SCHEDULE, tz: 'Asia/Kolkata' },
    { name: IMPORT_EXPIRE_JOB, opts: OVERDUE_JOB_OPTIONS },
  );
  const system = new Worker(SYSTEM_QUEUE, processSystemJob, { connection, prefix });
  system.on('failed', (job, error) => {
    console.error(`system job ${job?.name} attempt ${job?.attemptsMade} failed: ${error.message}`);
  });
  const documents = new Worker(DOCUMENTS_QUEUE, processDocumentJob, {
    connection,
    prefix,
    concurrency: DOCUMENT_CONCURRENCY,
  });
  documents.on('failed', (job, error) => {
    console.error(`document job ${job?.id} attempt ${job?.attemptsMade} failed: ${error.message}`);
  });
  const imports = new Worker(IMPORTS_QUEUE, processImportJob, { connection, prefix });
  imports.on('failed', (job, error) => {
    console.error(`import job ${job?.name} attempt ${job?.attemptsMade} failed: ${error.message}`);
  });
  await Promise.all([
    system.waitUntilReady(),
    documents.waitUntilReady(),
    imports.waitUntilReady(),
  ]);

  let timer: NodeJS.Timeout | undefined;
  if (options.sweep !== false) {
    await sweep();
    timer = setInterval(sweep, SWEEP_INTERVAL_MS);
    timer.unref();
  }
  try {
    await checkOverdue();
  } catch (error) {
    // The schedule still runs tonight; a failed catch-up must not stop the worker starting.
    console.error('overdue catch-up failed', error);
  }
  try {
    await checkImportExpiry();
  } catch (error) {
    console.error('import expiry catch-up failed', error);
  }

  return {
    async close() {
      if (timer) clearInterval(timer);
      await Promise.all([system.close(), documents.close(), imports.close()]);
      await systemQueue.close();
      await closeDocumentsQueue();
      await closeImportsQueue();
      await connection.quit();
    },
  };
}
