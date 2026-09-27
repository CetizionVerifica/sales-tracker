import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it, vi } from 'vitest';
import { createClaudeExtractor } from '../../extraction/claude.ts';
import {
  EXTRACTION_MESSAGES,
  RetryableExtractionError,
  type ExtractionRequest,
} from '../../extraction/types.ts';
import { QUOTATION_EXTRACTION_FIELDS } from '../../schemas/extraction.ts';
import { samplePdf, samplePng } from './files.ts';

// AC13: the Anthropic client is mocked; nothing reaches the network (vitest.setup.ts also
// blocks outbound HTTP).

type StreamParams = Record<string, unknown> & {
  max_tokens: number;
  messages: { content: { type: string; source?: { type: string; media_type: string } }[] }[];
};

const WIRE = {
  documentNumber: { value: 'Q-91', confidence: 'high', page: 1, sourceText: 'Ref: Q-91' },
  documentDate: { value: '2026-03-12', confidence: 'high', page: 1, sourceText: '12 Mar 2026' },
  clientName: { value: 'Acme Pharma Ltd', confidence: 'high', page: 1, sourceText: 'To: Acme' },
  amount: { value: '125000.50', confidence: 'medium', page: 2, sourceText: 'Total 1,25,000.50' },
  currency: { value: 'INR', confidence: 'high', page: 2, sourceText: '₹' },
  scopeSummary: { value: 'Inspection', confidence: 'high', page: 1, sourceText: 'Scope' },
};

function message(overrides: Record<string, unknown> = {}) {
  return {
    model: 'claude-opus-5',
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(WIRE) }],
    ...overrides,
  };
}

/** A fake client whose stream() returns the given results in order (or throws errors). */
function fakeClient(...results: (Record<string, unknown> | Error)[]) {
  const calls: StreamParams[] = [];
  const stream = vi.fn((params: StreamParams) => {
    calls.push(params);
    const next = results.shift() ?? new Error('no more results');
    return {
      finalMessage: () => (next instanceof Error ? Promise.reject(next) : Promise.resolve(next)),
    };
  });
  return { client: { beta: { messages: { stream } } } as unknown as Anthropic, calls };
}

const request = (overrides: Partial<ExtractionRequest> = {}): ExtractionRequest => ({
  kind: 'QUOTATION',
  bytes: samplePdf('quote'),
  mimeType: 'application/pdf',
  sha256: 'abc',
  fields: QUOTATION_EXTRACTION_FIELDS,
  context: { clientName: 'Acme Pharma', currencies: ['INR', 'USD'] },
  ...overrides,
});

const headers = new Headers();

describe('claudeExtractor (AC13)', () => {
  it('sends a PDF as a base64 document block, with structured output and fallbacks', async () => {
    const { client, calls } = fakeClient(message());
    const result = await createClaudeExtractor({ client, model: 'claude-test-model' }).extract(
      request(),
    );

    expect(result).toMatchObject({ ok: true, model: 'claude-opus-5' });
    expect(result.ok && result.extraction.amount?.value).toBe('125000.50');
    const params = calls[0]!;
    expect(params.model).toBe('claude-test-model');
    expect(params.fallbacks).toBe('default');
    expect(params.betas).toEqual(['server-side-fallback-2026-07-01']);
    expect((params.output_config as { format: { type: string } }).format.type).toBe('json_schema');
    const [source, text] = params.messages[0]!.content;
    expect(source).toMatchObject({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf' },
    });
    expect(text?.type).toBe('text'); // the file comes before the instructions
  });

  it('sends an image as an image block', async () => {
    const { client, calls } = fakeClient(message());
    await createClaudeExtractor({ client }).extract(
      request({ bytes: samplePng(), mimeType: 'image/png' }),
    );
    expect(calls[0]!.messages[0]!.content[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png' },
    });
  });

  it('uses ANTHROPIC_MODEL by default', async () => {
    const { client, calls } = fakeClient(message());
    await createClaudeExtractor({ client }).extract(request());
    expect(calls[0]!.model).toBe(process.env.ANTHROPIC_MODEL ?? 'claude-opus-5');
  });

  it('a refusal is a final failure', async () => {
    const { client } = fakeClient(message({ stop_reason: 'refusal', content: [] }));
    expect(await createClaudeExtractor({ client }).extract(request())).toEqual({
      ok: false,
      message: EXTRACTION_MESSAGES.refused,
    });
  });

  it('max_tokens retries once with a higher limit, then fails', async () => {
    const cut = message({ stop_reason: 'max_tokens' });
    const { client, calls } = fakeClient(cut, cut);
    const result = await createClaudeExtractor({ client }).extract(request());
    expect(calls.map((c) => c.max_tokens)).toEqual([16_000, 32_000]);
    expect(result).toEqual({ ok: false, message: EXTRACTION_MESSAGES.unreadable });
  });

  it('max_tokens then success uses the second answer', async () => {
    const { client } = fakeClient(message({ stop_reason: 'max_tokens' }), message());
    expect(await createClaudeExtractor({ client }).extract(request())).toMatchObject({ ok: true });
  });

  it('JSON that does not match the schema is a final failure, not a partial save', async () => {
    const bad = message({ content: [{ type: 'text', text: '{"amount": 5}' }] });
    const notJson = message({ content: [{ type: 'text', text: 'Sorry' }] });
    for (const reply of [bad, notJson]) {
      const { client } = fakeClient(reply);
      expect(await createClaudeExtractor({ client }).extract(request())).toEqual({
        ok: false,
        message: EXTRACTION_MESSAGES.unreadable,
      });
    }
  });

  it('rate limits, server errors and network errors are retryable', async () => {
    const errors = [
      new Anthropic.RateLimitError(429, undefined, 'slow down', headers),
      new Anthropic.InternalServerError(500, undefined, 'boom', headers),
      new Anthropic.APIConnectionError({ message: 'reset' }),
    ];
    for (const error of errors) {
      const { client } = fakeClient(error);
      await expect(createClaudeExtractor({ client }).extract(request())).rejects.toBeInstanceOf(
        RetryableExtractionError,
      );
    }
  });

  it('a 400 or an auth error is final, with a user-safe message', async () => {
    const bad = fakeClient(
      new Anthropic.BadRequestError(400, undefined, 'too many pages', headers),
    );
    expect(await createClaudeExtractor({ client: bad.client }).extract(request())).toEqual({
      ok: false,
      message: EXTRACTION_MESSAGES.rejected,
    });
    const auth = fakeClient(new Anthropic.AuthenticationError(401, undefined, 'bad key', headers));
    expect(await createClaudeExtractor({ client: auth.client }).extract(request())).toEqual({
      ok: false,
      message: EXTRACTION_MESSAGES.notConfigured,
    });
  });

  it('without an API key it fails without calling anything', async () => {
    const result = await createClaudeExtractor({ apiKey: undefined }).extract(request());
    expect(result).toEqual({ ok: false, message: EXTRACTION_MESSAGES.notConfigured });
  });
});
