import { describe, expect, it } from 'vitest';
import {
  normaliseExtraction,
  PURCHASE_ORDER_EXTRACTION_FIELDS,
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

  // AC6 (M9): whole numbers in range only; anything else is left for the reviewer.
  it('keeps net days that are digits in range, and nulls the rest with low confidence', () => {
    const days = (value: string) =>
      normaliseExtraction(PURCHASE_ORDER_EXTRACTION_FIELDS, { paymentTermsDays: field(value) })
        .paymentTermsDays;
    expect(days('45')).toMatchObject({ value: '45', confidence: 'high' });
    expect(days(' 0 ')).toMatchObject({ value: '0', confidence: 'high' });
    expect(days('365')).toMatchObject({ value: '365', confidence: 'high' });
    for (const bad of ['45 days', '400', '-5', '4.5', 'forty-five']) {
      expect(days(bad)).toMatchObject({ value: null, confidence: 'low' });
    }
  });

  it('reads the PO fields: number, date, client, amount, currency and terms', () => {
    const out = normaliseExtraction(PURCHASE_ORDER_EXTRACTION_FIELDS, {
      poNumber: field(' 4500012345 '),
      documentDate: field('2026-09-20'),
      clientName: field('Globex Ltd'),
      amount: field('INR 12,50,000'),
      currency: field('inr'),
      paymentTerms: field('x'.repeat(600)),
    });
    expect(out.poNumber?.value).toBe('4500012345');
    expect(out.amount?.value).toBe('1250000');
    expect(out.currency?.value).toBe('INR');
    expect(out.paymentTerms?.value).toHaveLength(500);
    expect(Object.keys(out).sort()).toEqual(
      [
        'amount',
        'clientName',
        'currency',
        'documentDate',
        'paymentTerms',
        'paymentTermsDays',
        'poNumber',
      ].sort(),
    );
  });
});
