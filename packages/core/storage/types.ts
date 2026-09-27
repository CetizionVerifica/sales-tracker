/** Where a stored file lives. `resourceType` is Cloudinary's (`image` or `raw`). */
export interface StoredFile {
  storageKey: string;
  resourceType: string;
}

/**
 * Document file storage (M7). Services depend on this interface only: Cloudinary in
 * development and production, a shared temp folder for E2E, memory for Vitest.
 */
export interface FileStore {
  put(input: { bytes: Uint8Array; mimeType: string; folder: string }): Promise<StoredFile>;
  get(file: StoredFile & { mimeType: string }): Promise<Uint8Array>;
  /** Best-effort cleanup of a file whose database row never committed. */
  remove(file: StoredFile): Promise<void>;
  /**
   * A short-lived link to the file, or null when the store has no URLs of its own (then
   * the web app streams the bytes after its own permission check).
   */
  signedUrl(file: StoredFile & { mimeType: string }, ttlSeconds: number): string | null;
}

/** File extension Cloudinary uses for a MIME type. */
export function formatOf(mimeType: string): string {
  switch (mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      throw new Error(`Unsupported document type ${mimeType}`);
  }
}
