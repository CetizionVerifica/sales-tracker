import { describe, expect, it } from 'vitest';
import { parseImportDate } from '../../import/transform/dates.ts';
import { splitMultiValue } from '../../import/transform/split.ts';
import { normalizeText } from '../../import/transform/text.ts';

// M10b Transform + AC5: dates/amounts never guessed — unparseable values are errors.

describe('parseImportDate', () => {
  it('parses DD/MM/YYYY', () => {
    expect(parseImportDate('12/03/2025', 'DD/MM/YYYY')).toEqual({ ok: true, iso: '2025-03-12' });
  });

  it('parses MM/DD/YYYY', () => {
    expect(parseImportDate('12/03/2025', 'MM/DD/YYYY')).toEqual({ ok: true, iso: '2025-12-03' });
  });

  it('parses DD-MMM-YY with a two-digit year', () => {
    expect(parseImportDate('12-Mar-25', 'DD-MMM-YY')).toEqual({ ok: true, iso: '2025-03-12' });
  });

  it('parses an Excel serial number', () => {
    // 45728 = 2025-03-12 under Excel's 1900 date system.
    expect(parseImportDate(45728, 'DD/MM/YYYY')).toEqual({ ok: true, iso: '2025-03-12' });
    expect(parseImportDate('45728', 'EXCEL_SERIAL')).toEqual({ ok: true, iso: '2025-03-12' });
  });

  it('passes through a JS Date (already converted by the parser)', () => {
    const date = new Date(Date.UTC(2025, 2, 12));
    expect(parseImportDate(date, 'DD/MM/YYYY')).toEqual({ ok: true, iso: '2025-03-12' });
  });

  it('parses an ISO datetime string (a Date cell round-tripped through JSON storage)', () => {
    expect(parseImportDate('2025-03-12T00:00:00.000Z', 'DD/MM/YYYY')).toEqual({
      ok: true,
      iso: '2025-03-12',
    });
  });

  it('rejects an impossible calendar date instead of guessing', () => {
    const result = parseImportDate('31/02/2025', 'DD/MM/YYYY');
    expect(result.ok).toBe(false);
  });

  it('rejects unparseable text', () => {
    expect(parseImportDate('sometime in March', 'DD/MM/YYYY').ok).toBe(false);
    expect(parseImportDate(null, 'DD/MM/YYYY').ok).toBe(false);
    expect(parseImportDate('', 'DD/MM/YYYY').ok).toBe(false);
  });
});

describe('splitMultiValue', () => {
  it('splits, trims and de-duplicates', () => {
    expect(splitMultiValue('ESG, HSE, ESG', ',')).toEqual(['ESG', 'HSE']);
  });

  it('returns an empty array for a blank cell', () => {
    expect(splitMultiValue(null, ',')).toEqual([]);
    expect(splitMultiValue('   ', ',')).toEqual([]);
  });

  it('supports non-comma separators', () => {
    expect(splitMultiValue('ESG / HSE / ESIA', '/')).toEqual(['ESG', 'HSE', 'ESIA']);
  });
});

describe('normalizeText', () => {
  it('trims and collapses internal whitespace', () => {
    expect(normalizeText('  Sun   Pharma  Ltd  ')).toBe('Sun Pharma Ltd');
  });

  it('returns an empty string for null/undefined', () => {
    expect(normalizeText(null)).toBe('');
    expect(normalizeText(undefined)).toBe('');
  });
});
