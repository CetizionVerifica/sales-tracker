import { describe, expect, it } from 'vitest';
import {
  normaliseExtraction,
  QUOTATION_EXTRACTION_FIELDS,
  type WireExtraction,
} from '../../schemas/extraction.ts';

const field = (value: string | null, confidence: 'high' | 'medium' | 'low' = 'high') => ({
  value,
  confidence,
  page: 1,
  sourceText: value,
});

describe('normaliseExtraction', () => {
  it('keeps usable values and strips symbols from amounts', () => {
    const wire: WireExtraction = {
      documentNumber: field('  Q/24/0091 '),
      documentDate: field('2026-03-12'),
      clientName: field('Acme Pharma Pvt Ltd'),
      amount: field('₹ 1,25,000.50'),
      currency: field('inr'),
      scopeSummary: field('Annual inspection'),
    };
    const out = normaliseExtraction(QUOTATION_EXTRACTION_FIELDS, wire);
    expect(out.documentNumber?.value).toBe('Q/24/0091');
    expect(out.amount?.value).toBe('125000.50');
    expect(out.currency?.value).toBe('INR');
    expect(out.documentDate?.value).toBe('2026-03-12');
  });

  it('nulls a value in the wrong format and marks it low confidence', () => {
    const out = normaliseExtraction(QUOTATION_EXTRACTION_FIELDS, {
      documentDate: field('12/03/2026'),
      amount: field('about one lakh'),
      currency: field('Rupees'),
    });
    expect(out.documentDate).toMatchObject({ value: null, confidence: 'low' });
    expect(out.amount).toMatchObject({ value: null, confidence: 'low' });
    expect(out.currency).toMatchObject({ value: null, confidence: 'low' });
  });

  it('rejects impossible dates, fills missing fields and caps long text', () => {
    const out = normaliseExtraction(QUOTATION_EXTRACTION_FIELDS, {
      documentDate: field('2026-02-30'),
      scopeSummary: { ...field('x'.repeat(5000)), sourceText: 'y'.repeat(500) },
    });
    expect(out.documentDate?.value).toBeNull();
    expect(out.scopeSummary?.value).toHaveLength(1000);
    expect(out.scopeSummary?.sourceText).toHaveLength(200);
    expect(out.clientName).toEqual({
      value: null,
      confidence: 'low',
      page: null,
      sourceText: null,
    });
  });
});
