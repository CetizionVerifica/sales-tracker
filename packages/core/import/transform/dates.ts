import type { DateFormatValue } from '../../schemas/import.ts';

const MONTH_NAMES = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

const pad2 = (n: number) => String(n).padStart(2, '0');

/** `null` when the parts don't form a real calendar date (e.g. 31 February). */
function isoFromParts(year: number, month: number, day: number): string | null {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/** Excel's 1900 date system (serial 1 = 1900-01-01), the default for `.xlsx`/`.xls`/`.csv`. */
function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial <= 0) return null;
  const epochUtcMs = Date.UTC(1899, 11, 30);
  const date = new Date(epochUtcMs + Math.round(serial) * 86_400_000);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function twoDigitYear(year: number): number {
  return year < 100 ? year + (year < 70 ? 2000 : 1900) : year;
}

export type DateParseResult = { ok: true; iso: string } | { ok: false; error: string };

/**
 * Converts one cell to an ISO `YYYY-MM-DD` string using the confirmed column format
 * (M10b Transform: dates). Values that don't parse are an error, never a guess.
 */
export function parseImportDate(raw: unknown, format: DateFormatValue): DateParseResult {
  if (raw == null) return { ok: false, error: 'Missing date' };

  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return { ok: false, error: 'Not a valid date' };
    return {
      ok: true,
      iso: `${raw.getUTCFullYear()}-${pad2(raw.getUTCMonth() + 1)}-${pad2(raw.getUTCDate())}`,
    };
  }

  if (typeof raw === 'number') {
    const iso = excelSerialToIso(raw);
    return iso ? { ok: true, iso } : { ok: false, error: 'Not a valid date' };
  }

  const text = String(raw).trim();
  if (!text) return { ok: false, error: 'Missing date' };

  // A cell parsed as a JS Date by SheetJS, then round-tripped through JSON storage
  // (ImportRow.original), comes back as an ISO datetime string rather than a Date instance.
  const isoDateTime = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}/.exec(text);
  if (isoDateTime) return { ok: true, iso: isoDateTime[1]! };

  if (format === 'EXCEL_SERIAL') {
    const serial = Number(text);
    const iso = Number.isFinite(serial) ? excelSerialToIso(serial) : null;
    return iso ? { ok: true, iso } : { ok: false, error: 'Not a valid date' };
  }

  if (format === 'DD-MMM-YY') {
    const match = /^(\d{1,2})[-\s]([a-zA-Z]{3,})[-\s](\d{2,4})$/.exec(text);
    if (!match) return { ok: false, error: 'Expected a date like 12-Mar-25' };
    const day = Number(match[1]);
    const monthIndex = MONTH_NAMES.indexOf(match[2]!.slice(0, 3).toLowerCase());
    if (monthIndex === -1) return { ok: false, error: 'Unrecognised month name' };
    const iso = isoFromParts(twoDigitYear(Number(match[3])), monthIndex + 1, day);
    return iso ? { ok: true, iso } : { ok: false, error: 'Not a real date' };
  }

  const match = /^(\d{1,4})[/-](\d{1,2})[/-](\d{1,4})$/.exec(text);
  if (!match) {
    const example = format === 'MM/DD/YYYY' ? '03/12/2025' : '12/03/2025';
    return { ok: false, error: `Expected a date like ${example}` };
  }
  const [, first, second, third] = match as unknown as [string, string, string, string];
  const day = format === 'MM/DD/YYYY' ? Number(second) : Number(first);
  const month = format === 'MM/DD/YYYY' ? Number(first) : Number(second);
  const iso = isoFromParts(twoDigitYear(Number(third)), month, day);
  return iso ? { ok: true, iso } : { ok: false, error: 'Not a real date' };
}
