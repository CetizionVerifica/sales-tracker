import { createRedisConnection } from '@sales-tracker/core';
import { Worker } from 'bullmq';

export const SYSTEM_QUEUE = 'system';

/**
 * Starts the BullMQ workers. M0 has one no-op `system` queue; document extraction (M7)
 * and the nightly overdue check (M10) register their processors here.
 */
export async function startWorker() {
  const connection = createRedisConnection();
  const worker = new Worker(SYSTEM_QUEUE, async (job) => ({ ok: true, name: job.name }), {
    connection,
  });
  await worker.waitUntilReady();

  return {
    async close() {
      await worker.close();
      await connection.quit();
    },
  };
}
