import type { DocumentKindValue } from '../schemas/document.ts';
import type { ExtractionFields, StoredExtraction } from '../schemas/extraction.ts';

export interface ExtractionRequest {
  kind: DocumentKindValue;
  bytes: Uint8Array;
  mimeType: string;
  /** Hex SHA-256 of the file (the mock keys fixtures by it). */
  sha256: string;
  fields: ExtractionFields;
  /** What Claude may compare against: the record's own client and enabled currencies only. */
  context: { clientName: string; currencies: readonly string[] };
}

export type ExtractionResult =
  { ok: true; extraction: StoredExtraction; model: string } | { ok: false; message: string };

/** Reads a document (M7). Never writes anything; the caller stores the result. */
export interface Extractor {
  extract(request: ExtractionRequest): Promise<ExtractionResult>;
}

/**
 * A failure worth retrying (rate limit, server error, network). The worker lets BullMQ
 * retry it; anything else is a final `{ ok: false }`.
 */
export class RetryableExtractionError extends Error {
  override name = 'RetryableExtractionError';
}

/** User-safe messages; raw API errors never reach the database or the UI. */
export const EXTRACTION_MESSAGES = {
  notConfigured: 'Document reading is not configured. Ask an admin to set it up.',
  refused: 'The document could not be read automatically. Enter the values by hand.',
  unreadable: 'The document could not be read automatically. Enter the values by hand.',
  rejected:
    'The document could not be sent for reading. It may be too large or have too many pages.',
  unavailable: 'The reading service is busy. It will try again shortly.',
} as const;
