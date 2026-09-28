import { describe, expect, it } from 'vitest';
import { detectTable, sliceDataRows } from '../../import/detect/table.ts';

// M10b AC2: header row, data range and skipped rows (titles, blanks, repeated headers,
// totals) are detected correctly, including the messy fixture 1 shape.

describe('detectTable', () => {
  it('finds a header in row 1 with no clutter', () => {
    const rows = [
      ['Client', 'Sector', 'Received Date'],
      ['Sun Pharma', 'Pharma', '12/03/2025'],
      ['Acme Co', 'Metal', '13/03/2025'],
    ];
    const result = detectTable(rows);
    expect(result.headerRow).toBe(1);
    expect(result.dataStartRow).toBe(2);
    expect(result.dataEndRow).toBe(3);
    expect(result.headers).toEqual(['Client', 'Sector', 'Received Date']);
    expect(result.skippedRows).toEqual([]);
  });

  it('finds a header past logo/title rows, skips blanks and a grand total row', () => {
    const rows = [
      ['ACME EXPORTS PVT LTD'],
      ['Enquiry register FY24'],
      [],
      ['Client', 'Sector', 'Received Date'],
      ['Sun Pharma', 'Pharma', '12/03/2025'],
      [],
      ['Acme Co', 'Metal', '13/03/2025'],
      ['Grand total', '', ''],
    ];
    const result = detectTable(rows);
    expect(result.headerRow).toBe(4);
    expect(result.dataStartRow).toBe(5);
    expect(result.dataEndRow).toBe(8);
    expect(result.skippedRows).toEqual([6, 8]);
  });

  it('stops the data range after a run of 3+ blank rows (a trailing notes block)', () => {
    const rows = [
      ['Client', 'Sector'],
      ['Sun Pharma', 'Pharma'],
      [],
      [],
      [],
      ['Notes: figures as of March 2025'],
    ];
    const result = detectTable(rows);
    expect(result.dataStartRow).toBe(2);
    expect(result.dataEndRow).toBe(2);
  });

  it('skips a repeated header row from a printed export', () => {
    const rows = [
      ['Client', 'Sector'],
      ['Sun Pharma', 'Pharma'],
      ['Client', 'Sector'],
      ['Acme Co', 'Metal'],
    ];
    const result = detectTable(rows);
    expect(result.headerRow).toBe(1);
    expect(result.dataEndRow).toBe(4);
    expect(result.skippedRows).toEqual([3]);
  });

  it('handles an empty sheet without throwing', () => {
    const result = detectTable([]);
    expect(result.dataEndRow).toBeLessThan(result.dataStartRow);
  });
});

describe('sliceDataRows', () => {
  it('keys each row by header and skips blank/total rows within the range', () => {
    const rows = [
      ['Client', 'Sector'],
      ['Sun Pharma', 'Pharma'],
      [],
      ['Acme Co', 'Metal'],
      ['Grand total', ''],
    ];
    const sliced = sliceDataRows(rows, ['Client', 'Sector'], 2, 5);
    expect(sliced).toEqual([
      { rowNumber: 2, original: { Client: 'Sun Pharma', Sector: 'Pharma' } },
      { rowNumber: 4, original: { Client: 'Acme Co', Sector: 'Metal' } },
    ]);
  });

  it('supports a user-corrected header row further down the sheet', () => {
    const rows = [['Title row'], ['Client', 'Sector'], ['Sun Pharma', 'Pharma']];
    const sliced = sliceDataRows(rows, ['Client', 'Sector'], 3, 3);
    expect(sliced).toEqual([
      { rowNumber: 3, original: { Client: 'Sun Pharma', Sector: 'Pharma' } },
    ]);
  });
});
