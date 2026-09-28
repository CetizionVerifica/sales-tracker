import * as XLSX from 'xlsx';
import { DomainError } from '../../errors.ts';

export interface ParsedSheet {
  name: string;
  /** Row-major, 0-indexed, ragged (short rows are not padded). Cached values only. */
  rows: unknown[][];
}

export interface ParsedWorkbook {
  sheets: ParsedSheet[];
}

/** Zip-bomb guard (M10b Security): a 20 MB upload should never inflate past this. */
const MAX_UNCOMPRESSED_BYTES = 200 * 1024 * 1024;

/**
 * Reads a spreadsheet with SheetJS (xlsx/xlsm/xls/ods/csv/tsv). Only cached cell values are
 * read — formulas are never evaluated and macros are never run (M10b "Parsing"). Excel date
 * cells come back as JS `Date`; everything else as its literal string/number/boolean.
 */
export function parseWorkbook(bytes: Uint8Array, fileName: string): ParsedWorkbook {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'buffer',
      cellDates: true,
      cellFormula: false,
      cellNF: false,
      cellText: false,
      bookVBA: false,
      WTF: false,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/password|encrypt/i.test(message)) {
      throw new DomainError(
        'This file is password-protected. Remove the password in Excel and upload again.',
      );
    }
    throw new DomainError(`Could not read "${fileName}": the file may be corrupt or unsupported.`);
  }

  let uncompressedBytes = 0;
  for (const name of workbook.SheetNames) {
    const sheet = workbook.Sheets[name];
    if (sheet?.['!ref']) uncompressedBytes += XLSX.utils.decode_range(sheet['!ref']).e.r * 64;
  }
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) {
    throw new DomainError('This file is too large to import.');
  }

  const sheets = workbook.SheetNames.map((name): ParsedSheet => {
    const sheet = workbook.Sheets[name]!;
    const rows = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
      header: 1,
      raw: true,
      defval: null,
      blankrows: true,
    });
    return { name, rows };
  });

  if (sheets.length === 0) throw new DomainError('The file has no sheets.');
  return { sheets };
}
