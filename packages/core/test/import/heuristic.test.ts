import { describe, expect, it } from 'vitest';
import { ENQUIRY_FIELD_CATALOG } from '../../import/suggest/field-catalog.ts';
import { suggestColumns } from '../../import/suggest/heuristic.ts';

// M10b AC3: with AI off (or unavailable), heuristic mapping is used instead — this is that
// heuristic, tested directly against messy real-world header names (no AI call involved).

describe('suggestColumns', () => {
  it('maps exact field-name headers with full confidence', () => {
    const headers = ['Client', 'Sector', 'Services', 'Received Date', 'Source'];
    const result = suggestColumns(headers, ENQUIRY_FIELD_CATALOG);
    expect(result.map((r) => r.field)).toEqual([
      'client',
      'sector',
      'services',
      'receivedDate',
      'source',
    ]);
    expect(result.every((r) => r.confidence === 1)).toBe(true);
  });

  it('matches synonyms and messy casing/punctuation', () => {
    const headers = ['Customer Name', 'Industry', 'Scope', 'Date Received:', 'Lead Source'];
    const result = suggestColumns(headers, ENQUIRY_FIELD_CATALOG);
    expect(result.map((r) => r.field)).toEqual([
      'client',
      'sector',
      'services',
      'receivedDate',
      'source',
    ]);
  });

  it('leaves an unrecognised column unmapped', () => {
    const result = suggestColumns(['Internal ref code'], ENQUIRY_FIELD_CATALOG);
    expect(result[0]!.field).toBeNull();
    expect(result[0]!.confidence).toBe(0);
  });

  it('awards each field to at most one column, the best match', () => {
    // Two columns could both read as "client"; only the exact one should claim the field.
    const headers = ['Client note', 'Client'];
    const result = suggestColumns(headers, ENQUIRY_FIELD_CATALOG);
    expect(result[1]!.field).toBe('client');
    expect(result[0]!.field).not.toBe('client');
  });
});
