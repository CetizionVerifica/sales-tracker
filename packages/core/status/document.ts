import type { DocumentReviewStatus, ExtractionStatus } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';
import type { DocumentState } from '../schemas/document-state.ts';

/**
 * Document extraction: QUEUED → RUNNING → SUCCEEDED | FAILED, with RUNNING → QUEUED for a
 * retryable error or a job lost with its worker, and SUCCEEDED | FAILED | SKIPPED → QUEUED
 * for "Try again" (M7). SKIPPED is only ever an initial state (extraction turned off).
 */
const TRANSITIONS: Record<ExtractionStatus, readonly ExtractionStatus[]> = {
  QUEUED: ['RUNNING'],
  RUNNING: ['SUCCEEDED', 'FAILED', 'QUEUED'],
  SUCCEEDED: ['QUEUED'],
  FAILED: ['QUEUED'],
  SKIPPED: ['QUEUED'],
};

/** Statuses in which extraction has finished (the review screen can open). */
export const FINISHED_EXTRACTION: readonly ExtractionStatus[] = ['SUCCEEDED', 'FAILED', 'SKIPPED'];

export const EXTRACTION_STATUS_LABELS: Record<ExtractionStatus, string> = {
  QUEUED: 'Reading document…',
  RUNNING: 'Reading document…',
  SUCCEEDED: 'Ready to review',
  FAILED: 'Could not read',
  SKIPPED: 'Extraction is turned off',
};

export function canTransitionExtraction(from: ExtractionStatus, to: ExtractionStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertExtractionTransition(from: ExtractionStatus, to: ExtractionStatus): void {
  if (!canTransitionExtraction(from, to)) {
    throw new DomainError(`A document cannot go from ${from} to ${to}`);
  }
}

interface ReviewState {
  extractionStatus: ExtractionStatus;
  reviewStatus: DocumentReviewStatus;
}

/**
 * Review: PENDING → CONFIRMED, which is final (CLAUDE.md rule 9). Values can be applied only
 * from a successful extraction; "confirm without changes" works once extraction finished.
 */
export function assertCanConfirm(doc: ReviewState, { applying }: { applying: boolean }): void {
  if (doc.reviewStatus === 'CONFIRMED') {
    throw new DomainError('This document has already been reviewed');
  }
  if (applying && doc.extractionStatus !== 'SUCCEEDED') {
    throw new DomainError('There are no extracted values to apply');
  }
  if (!FINISHED_EXTRACTION.includes(doc.extractionStatus)) {
    throw new DomainError('The document is still being read');
  }
}

/** "Try again": a finished extraction that nobody has reviewed yet. */
export function assertCanRetry(doc: ReviewState): void {
  if (doc.reviewStatus === 'CONFIRMED') {
    throw new DomainError('This document has already been reviewed');
  }
  if (!FINISHED_EXTRACTION.includes(doc.extractionStatus)) {
    throw new DomainError('The document is still being read');
  }
}

/** Where a record's current document is, for list columns and filters (M9). */
export function documentStateOf(doc: ReviewState | null): DocumentState {
  if (!doc) return 'none';
  if (doc.reviewStatus === 'CONFIRMED') return 'reviewed';
  if (doc.extractionStatus === 'SUCCEEDED') return 'toReview';
  if (doc.extractionStatus === 'FAILED' || doc.extractionStatus === 'SKIPPED') return 'failed';
  return 'reading';
}
