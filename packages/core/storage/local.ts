import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { FileStore } from './types.ts';

/**
 * E2E only (FILE_STORE=local): files in a temp folder the web server and the worker both
 * read, since they run as separate processes. Never used in production (env.ts).
 */
export function createLocalFileStore(
  root = path.join(tmpdir(), 'sales-tracker-documents'),
): FileStore {
  const fileFor = (storageKey: string) => {
    const resolved = path.resolve(root, storageKey);
    if (!resolved.startsWith(path.resolve(root) + path.sep)) {
      throw new Error('Invalid storage key');
    }
    return resolved;
  };
  return {
    async put({ bytes, folder }) {
      const storageKey = `${folder}/${crypto.randomUUID()}`;
      const file = fileFor(storageKey);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
      return { storageKey, resourceType: 'image' };
    },
    async get({ storageKey }) {
      return new Uint8Array(await readFile(fileFor(storageKey)));
    },
    async remove({ storageKey }) {
      await rm(fileFor(storageKey), { force: true });
    },
    signedUrl() {
      return null;
    },
  };
}
