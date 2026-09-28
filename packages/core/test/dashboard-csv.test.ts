import { describe, expect, it } from 'vitest';
import { toCsv } from '../services/dashboard/export.ts';

// M12 AC11 (unit): the CSV writer quotes per RFC 4180 and defuses formula injection.

const body = (rows: string[][]) => toCsv({ columns: ['A', 'B'], rows }).replace(/^\uFEFF/, '');

describe('toCsv', () => {
  it('starts with a BOM and ends lines with CRLF', () => {
    const csv = toCsv({ columns: ['A'], rows: [['x']] });
    expect(csv).toBe('\uFEFFA\r\nx\r\n');
  });

  it('quotes fields with commas, quotes or line breaks', () => {
    expect(body([['Acme, Pune', 'He said "hi"']])).toBe('A,B\r\n"Acme, Pune","He said ""hi"""\r\n');
  });

  it.each([
    ['=HYPERLINK("http://evil","x")', `"'=HYPERLINK(""http://evil"",""x"")"`],
    ['+91 cmd', "'+91 cmd"],
    ['-2+3', "'-2+3"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\tTabbed', "'\tTabbed"],
  ])('turns %j into text', (value, expected) => {
    expect(body([[value, 'ok']])).toBe(`A,B\r\n${expected},ok\r\n`);
  });

  it('leaves plain numbers alone, including negative days late', () => {
    expect(body([['-3', '125000.50']])).toBe('A,B\r\n-3,125000.50\r\n');
  });
});
