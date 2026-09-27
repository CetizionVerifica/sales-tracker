import type { DocumentReviewStatus, ExtractionStatus } from '@sales-tracker/db';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.ts';
import {
  assertCanConfirm,
  assertCanRetry,
  assertExtractionTransition,
  canTransitionExtraction,
} from '../../status/document.ts';

const EXTRACTION: ExtractionStatus[] = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'];
const ALLOWED = new Set([
  'QUEUED→RUNNING',
  'RUNNING→SUCCEEDED',
  'RUNNING→FAILED',
  'RUNNING→QUEUED', // a retryable API error, or the sweeper after a worker died
  'FAILED→QUEUED',
  'SUCCEEDED→QUEUED',
  'SKIPPED→QUEUED',
]);

describe('extraction status machine', () => {
  for (const from of EXTRACTION) {
    for (const to of EXTRACTION) {
      const key = `${from}→${to}`;
      const allowed = ALLOWED.has(key);
      it(`${key} is ${allowed ? 'allowed' : 'rejected'}`, () => {
        expect(canTransitionExtraction(from, to)).toBe(allowed);
        if (allowed) expect(() => assertExtractionTransition(from, to)).not.toThrow();
        else expect(() => assertExtractionTransition(from, to)).toThrow(DomainError);
      });
    }
  }
});

describe('review rules', () => {
  const doc = (
    extractionStatus: ExtractionStatus,
    reviewStatus: DocumentReviewStatus = 'PENDING',
  ) => ({
    extractionStatus,
    reviewStatus,
  });

  it('confirms with values only after a successful extraction', () => {
    expect(() => assertCanConfirm(doc('SUCCEEDED'), { applying: true })).not.toThrow();
    for (const status of ['QUEUED', 'RUNNING', 'FAILED', 'SKIPPED'] as const) {
      expect(() => assertCanConfirm(doc(status), { applying: true })).toThrow(DomainError);
    }
  });

  it('confirms without values once extraction has finished, whatever the outcome', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'SKIPPED'] as const) {
      expect(() => assertCanConfirm(doc(status), { applying: false })).not.toThrow();
    }
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      expect(() => assertCanConfirm(doc(status), { applying: false })).toThrow(DomainError);
    }
  });

  it('CONFIRMED is final', () => {
    expect(() => assertCanConfirm(doc('SUCCEEDED', 'CONFIRMED'), { applying: false })).toThrow(
      DomainError,
    );
    expect(() => assertCanRetry(doc('SUCCEEDED', 'CONFIRMED'))).toThrow(DomainError);
  });

  it('retries a finished, unreviewed extraction only', () => {
    for (const status of ['SUCCEEDED', 'FAILED', 'SKIPPED'] as const) {
      expect(() => assertCanRetry(doc(status))).not.toThrow();
    }
    for (const status of ['QUEUED', 'RUNNING'] as const) {
      expect(() => assertCanRetry(doc(status))).toThrow(DomainError);
    }
  });
});
