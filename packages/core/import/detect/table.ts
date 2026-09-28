export interface TableDetection {
  /** 1-based row number, matching how the UI and error messages refer to spreadsheet rows. */
  headerRow: number;
  dataStartRow: number;
  /** Inclusive. Less than `dataStartRow` when no data rows were found. */
  dataEndRow: number;
  headers: string[];
  /** 1-based row numbers within the data range that were skipped (blank/repeated header/total). */
  skippedRows: number[];
}

const MAX_HEADER_SCAN = 30;
const TOTAL_ROW_PATTERN = /\b(total|grand total|sum)\b/i;
const BLANK_ROWS_END_DATA = 3;

function cellText(cell: unknown): string {
  return cell == null ? '' : String(cell).trim();
}

function isBlankRow(row: readonly unknown[]): boolean {
  return row.every((cell) => cellText(cell) === '');
}

/**
 * Higher for rows that look like a header: several non-empty cells, mostly unique, mostly
 * text — boosted when the following row looks like data, not another title/blank row.
 */
function scoreHeaderCandidate(row: readonly unknown[], nextRow: readonly unknown[] | undefined): number {
  const nonEmpty = row.filter((cell) => cellText(cell) !== '');
  if (nonEmpty.length < 2) return 0;
  const texts = nonEmpty.map(cellText);
  const uniqueRatio = new Set(texts.map((t) => t.toLowerCase())).size / texts.length;
  const textRatio = nonEmpty.filter((cell) => typeof cell !== 'number').length / nonEmpty.length;
  const nextLooksLikeData = nextRow ? !isBlankRow(nextRow) : false;
  const score = nonEmpty.length * uniqueRatio * (0.5 + 0.5 * textRatio);
  return nextLooksLikeData ? score * 1.25 : score;
}

/**
 * Finds the header row, the data range and the rows to skip within it (M10b "Structure
 * detection"), from a sheet already reduced to a 2D array of raw cell values. Two-row headers
 * are out of scope for phase 1 (single sheet, single entity).
 */
export function detectTable(rows: readonly (readonly unknown[])[]): TableDetection {
  if (rows.length === 0) {
    return { headerRow: 1, dataStartRow: 2, dataEndRow: 1, headers: [], skippedRows: [] };
  }

  const scanLimit = Math.min(rows.length, MAX_HEADER_SCAN);
  let bestIndex = 0;
  let bestScore = -1;
  for (let i = 0; i < scanLimit; i++) {
    const row = rows[i]!;
    if (isBlankRow(row)) continue;
    const score = scoreHeaderCandidate(row, rows[i + 1]);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  const headers = (rows[bestIndex] ?? []).map(cellText);
  const headersLower = headers.map((h) => h.toLowerCase());

  let dataStartIndex = bestIndex + 1;
  while (dataStartIndex < rows.length && isBlankRow(rows[dataStartIndex]!)) dataStartIndex++;

  let dataEndIndex = dataStartIndex - 1;
  let blankRun = 0;
  const skippedRows: number[] = [];
  for (let i = dataStartIndex; i < rows.length; i++) {
    const row = rows[i]!;
    if (isBlankRow(row)) {
      blankRun++;
      if (blankRun >= BLANK_ROWS_END_DATA) break;
      skippedRows.push(i + 1);
      continue;
    }
    blankRun = 0;

    const rowTexts = row.map(cellText);
    const repeatsHeader =
      headers.some((h) => h !== '') &&
      rowTexts.length === headers.length &&
      rowTexts.every((t, idx) => t.toLowerCase() === headersLower[idx]);
    const firstNonEmpty = rowTexts.find((t) => t !== '') ?? '';
    const isTotalRow = TOTAL_ROW_PATTERN.test(firstNonEmpty);

    if (repeatsHeader || isTotalRow) {
      // Unlike a blank run, a repeated-header or total row still marks the end of the
      // visible table (fixture 1 ends on a "Grand total" row) — count it in the range.
      skippedRows.push(i + 1);
      dataEndIndex = i;
      continue;
    }
    dataEndIndex = i;
  }

  return {
    headerRow: bestIndex + 1,
    dataStartRow: dataStartIndex + 1,
    dataEndRow: dataEndIndex + 1,
    headers,
    skippedRows,
  };
}

/** The header texts at a given (possibly user-corrected) header row. */
export function headersAt(rows: readonly (readonly unknown[])[], headerRow: number): string[] {
  return (rows[headerRow - 1] ?? []).map(cellText);
}

export interface SlicedRow {
  /** 1-based, matching the spreadsheet — shown to the user in error messages. */
  rowNumber: number;
  original: Record<string, unknown>;
}

/**
 * Re-slices data rows for a (possibly user-corrected) header/data range, keyed by header
 * text. Used both right after parsing and whenever the Columns step's sheet config changes,
 * from the sheet's full row array kept on `ImportBatch.parsed` (M10b: "not re-parsed per
 * step"). Blank, repeated-header and total rows within the range are skipped, same as
 * `detectTable`.
 */
export function sliceDataRows(
  rows: readonly (readonly unknown[])[],
  headers: readonly string[],
  dataStartRow: number,
  dataEndRow: number,
): SlicedRow[] {
  const headersLower = headers.map((h) => h.toLowerCase());
  const result: SlicedRow[] = [];
  for (let i = dataStartRow - 1; i <= dataEndRow - 1 && i < rows.length; i++) {
    if (i < 0) continue;
    const row = rows[i] ?? [];
    if (isBlankRow(row)) continue;

    const rowTexts = row.map(cellText);
    const repeatsHeader =
      headers.some((h) => h !== '') &&
      rowTexts.length === headers.length &&
      rowTexts.every((t, idx) => t.toLowerCase() === headersLower[idx]);
    const firstNonEmpty = rowTexts.find((t) => t !== '') ?? '';
    if (repeatsHeader || TOTAL_ROW_PATTERN.test(firstNonEmpty)) continue;

    const original: Record<string, unknown> = {};
    headers.forEach((header, col) => {
      if (header) original[header] = row[col] ?? null;
    });
    result.push({ rowNumber: i + 1, original });
  }
  return result;
}
