import type { FileStore } from './types.ts';

/** Vitest only (FILE_STORE=memory): files live in this process. */
export function createMemoryFileStore(): FileStore & { files: Map<string, Uint8Array> } {
  const files = new Map<string, Uint8Array>();
  return {
    files,
    async put({ bytes, folder, resourceType = 'image' }) {
      const storageKey = `${folder}/${crypto.randomUUID()}`;
      files.set(storageKey, new Uint8Array(bytes));
      return { storageKey, resourceType };
    },
    async get({ storageKey }) {
      const bytes = files.get(storageKey);
      if (!bytes) throw new Error(`No stored file ${storageKey}`);
      return bytes;
    },
    async remove({ storageKey }) {
      files.delete(storageKey);
    },
    signedUrl() {
      return null;
    },
  };
}
