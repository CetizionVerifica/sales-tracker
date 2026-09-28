import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.ts';
import { parseWorkbook } from '../../import/parse/read-workbook.ts';

// M10b AC1: fixture file types parse; formulas are never evaluated; corrupt/unsupported
// files fail with a clear message. Built in-memory with SheetJS's own writer, rather than
// checking binary fixtures into the repo.

function bookFromRows(rows: unknown[][]): Uint8Array {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
}

describe('parseWorkbook', () => {
  it('reads a normal .xlsx workbook into rows', () => {
    const bytes = bookFromRows([
      ['Client', 'Sector'],
      ['Sun Pharma', 'Pharma'],
    ]);
    const result = parseWorkbook(bytes, 'test.xlsx');
    expect(result.sheets).toHaveLength(1);
    expect(result.sheets[0]!.name).toBe('Sheet1');
    expect(result.sheets[0]!.rows[0]).toEqual(['Client', 'Sector']);
    expect(result.sheets[0]!.rows[1]).toEqual(['Sun Pharma', 'Pharma']);
  });

  it('keeps a formula cell at its cached value, never evaluating it', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['Amount'], [10]]);
    // Simulate a formula whose cached value differs from what re-evaluation would give,
    // so a naive re-evaluation would be caught by this assertion.
    sheet['A2'] = { t: 'n', v: 999, f: 'SUM(1,2)' };
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;

    const result = parseWorkbook(bytes, 'formula.xlsx');
    expect(result.sheets[0]!.rows[1]).toEqual([999]);
  });

  it('reads multiple sheets', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['A']]), 'One');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([['B']]), 'Two');
    const bytes = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;

    const result = parseWorkbook(bytes, 'multi.xlsx');
    expect(result.sheets.map((s) => s.name)).toEqual(['One', 'Two']);
  });

  it('reads a CSV file', () => {
    const bytes = new TextEncoder().encode('Client,Sector\nSun Pharma,Pharma\n');
    const result = parseWorkbook(bytes, 'test.csv');
    expect(result.sheets[0]!.rows[0]).toEqual(['Client', 'Sector']);
    expect(result.sheets[0]!.rows[1]).toEqual(['Sun Pharma', 'Pharma']);
  });

  it('rejects a corrupt file with a clear DomainError', () => {
    // A truncated xlsx: a real one, cut short, so the zip container itself fails to parse
    // (plain garbage bytes are valid single-cell CSV as far as SheetJS is concerned).
    const wholeFile = bookFromRows([
      ['a', 'b'],
      [1, 2],
    ]);
    const truncated = wholeFile.slice(0, 50);
    expect(() => parseWorkbook(truncated, 'garbage.xlsx')).toThrow(DomainError);
  });
});
