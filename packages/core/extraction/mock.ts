import { readFileSync } from 'node:fs';
import { normaliseExtraction, type WireExtraction } from '../schemas/extraction.ts';
import {
  EXTRACTION_MESSAGES,
  RetryableExtractionError,
  type ExtractionRequest,
  type Extractor,
} from './types.ts';

/** What the mock does for a given file (keyed by the file's SHA-256). */
export type MockBehaviour =
  | { type: 'result'; wire: WireExtraction }
  /** A final failure with this user-safe message (refusal, schema mismatch, 400). */
  | { type: 'fail'; message: string }
  /** Throws a retryable error this many times, then returns `then`. */
  | { type: 'retryable'; times: number; then: MockBehaviour }
  /** Never settles until released (worker-race and sweeper tests). */
  | { type: 'hang'; release: Promise<MockBehaviour> };

export const MOCK_MODEL = 'mock-extractor';

/**
 * Tests and E2E only (EXTRACTOR=mock). Fixtures come from `register()` (Vitest) or, for the
 * E2E server and worker processes, from the JSON file in MOCK_EXTRACTOR_FIXTURES. A file
 * with no fixture extracts nothing (every value null).
 */
export function createMockExtractor(): Extractor & {
  register(sha256: string, behaviour: MockBehaviour): void;
  calls: ExtractionRequest[];
  reset(): void;
} {
  const fixtures = new Map<string, MockBehaviour>();
  const retriesLeft = new Map<string, number>();
  const calls: ExtractionRequest[] = [];

  const fixturesFile = process.env.MOCK_EXTRACTOR_FIXTURES;
  if (fixturesFile) {
    const fromFile = JSON.parse(readFileSync(fixturesFile, 'utf8')) as Record<
      string,
      MockBehaviour
    >;
    for (const [sha, behaviour] of Object.entries(fromFile)) fixtures.set(sha, behaviour);
  }

  async function run(behaviour: MockBehaviour, request: ExtractionRequest) {
    switch (behaviour.type) {
      case 'result':
        return {
          ok: true as const,
          extraction: normaliseExtraction(request.fields, behaviour.wire),
          model: MOCK_MODEL,
        };
      case 'fail':
        return { ok: false as const, message: behaviour.message };
      case 'retryable': {
        const left = retriesLeft.get(request.sha256) ?? behaviour.times;
        if (left > 0) {
          retriesLeft.set(request.sha256, left - 1);
          throw new RetryableExtractionError(EXTRACTION_MESSAGES.unavailable);
        }
        return run(behaviour.then, request);
      }
      case 'hang':
        return run(await behaviour.release, request);
    }
  }

  return {
    calls,
    register(sha256, behaviour) {
      fixtures.set(sha256, behaviour);
      retriesLeft.delete(sha256);
    },
    reset() {
      fixtures.clear();
      retriesLeft.clear();
      calls.length = 0;
    },
    async extract(request) {
      calls.push(request);
      const behaviour = fixtures.get(request.sha256);
      if (!behaviour) {
        return {
          ok: true,
          extraction: normaliseExtraction(request.fields, {}),
          model: MOCK_MODEL,
        };
      }
      return run(behaviour, request);
    },
  };
}
