import { getEnv } from '../env.ts';
import { createCloudinaryFileStore } from '../storage/cloudinary.ts';
import { createLocalFileStore } from '../storage/local.ts';
import { createMemoryFileStore } from '../storage/memory.ts';
import type { FileStore } from '../storage/types.ts';
import { createClaudeExtractor } from './claude.ts';
import { createMockExtractor } from './mock.ts';
import type { Extractor } from './types.ts';

// Chosen by FILE_STORE / EXTRACTOR (env.ts rejects the fakes in production). The globalThis
// cache survives Next.js hot reloads, like the database client.
const cache = globalThis as unknown as { fileStore?: FileStore; extractor?: Extractor };

export function getFileStore(): FileStore {
  if (!cache.fileStore) {
    const kind = getEnv().FILE_STORE;
    cache.fileStore =
      kind === 'cloudinary'
        ? createCloudinaryFileStore()
        : kind === 'local'
          ? createLocalFileStore()
          : createMemoryFileStore();
  }
  return cache.fileStore;
}

export function getExtractor(): Extractor {
  cache.extractor ??=
    getEnv().EXTRACTOR === 'claude' ? createClaudeExtractor() : createMockExtractor();
  return cache.extractor;
}

/** Tests: swap in a store or extractor (e.g. a mock with registered fixtures). */
export function setDocumentDeps(deps: { fileStore?: FileStore; extractor?: Extractor }): void {
  if (deps.fileStore) cache.fileStore = deps.fileStore;
  if (deps.extractor) cache.extractor = deps.extractor;
}
