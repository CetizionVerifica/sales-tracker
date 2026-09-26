import { getEnv } from '@sales-tracker/core';
import { startWorker } from './worker.ts';

getEnv(); // fail fast on bad config
const handle = await startWorker();
console.log('worker ready');

let stopping = false;
async function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`worker received ${signal}, shutting down`);
  try {
    await handle.close();
    console.log('worker stopped');
    process.exit(0);
  } catch (error) {
    console.error('worker failed to stop cleanly', error);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
