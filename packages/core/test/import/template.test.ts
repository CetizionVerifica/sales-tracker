import { describe, expect, it } from 'vitest';
import { detectTable, sliceDataRows } from '../../import/detect/table.ts';
import { parseWorkbook } from '../../import/parse/read-workbook.ts';
import { ENQUIRY_FIELD_CATALOG } from '../../import/suggest/field-catalog.ts';
import { suggestColumns } from '../../import/suggest/heuristic.ts';
import { buildEnquiryImportTemplate } from '../../import/template.ts';
import { REQUIRED_IMPORT_FIELDS, type ImportFieldValue } from '../../schemas/import.ts';
import { parseImportDate } from '../../import/transform/dates.ts';

// The template is the first thing a user fills in, so it must stay in lockstep with the
// field catalog the heuristic actually matches against — these tests parse the generated
// file exactly as the parse job would, so drift between template.ts and field-catalog.ts
// fails here instead of silently producing an unmappable download.

describe('buildEnquiryImportTemplate', () => {
  it('produces a workbook whose first sheet is "Enquiries" with a header and one sample row', () => {
    const workbook = parseWorkbook(buildEnquiryImportTemplate(), 'template.xlsx');
    expect(workbook.sheets.map((s) => s.name)).toEqual(['Enquiries', 'Instructions']);
    const sheet = workbook.sheets[0]!;
    expect(sheet.rows).toHaveLength(2);
  });

  it('marks every required field with a trailing "*" and no optional field', () => {
    const workbook = parseWorkbook(buildEnquiryImportTemplate(), 'template.xlsx');
    const headers = workbook.sheets[0]!.rows[0] as string[];
    const required = new Set<ImportFieldValue>(REQUIRED_IMPORT_FIELDS);
    for (const field of ENQUIRY_FIELD_CATALOG) {
      const header = headers[ENQUIRY_FIELD_CATALOG.indexOf(field)]!;
      if (required.has(field.field)) expect(header).toBe(`${field.label} *`);
      else expect(header).toBe(field.label);
    }
  });

  it('every column heuristically maps back to its own field, unassisted', () => {
    const workbook = parseWorkbook(buildEnquiryImportTemplate(), 'template.xlsx');
    const detected = detectTable(workbook.sheets[0]!.rows);
    const suggestions = suggestColumns(detected.headers, ENQUIRY_FIELD_CATALOG);
    expect(suggestions.map((s) => s.field)).toEqual(ENQUIRY_FIELD_CATALOG.map((f) => f.field));
    expect(suggestions.every((s) => s.confidence === 1)).toBe(true);
  });

  it('the sample row is complete and its date parses under the default DD/MM/YYYY format', () => {
    const workbook = parseWorkbook(buildEnquiryImportTemplate(), 'template.xlsx');
    const detected = detectTable(workbook.sheets[0]!.rows);
    const [row] = sliceDataRows(
      workbook.sheets[0]!.rows,
      detected.headers,
      detected.dataStartRow,
      detected.dataEndRow,
    );
    const values = Object.values(row!.original);
    // Required columns (client, sector, services, receivedDate, source) all have a value.
    expect(values.filter((v) => v !== '' && v != null).length).toBeGreaterThanOrEqual(5);

    const dateHeader = Object.keys(row!.original).find((h) => h.startsWith('Received date'))!;
    const parsed = parseImportDate(row!.original[dateHeader], 'DD/MM/YYYY');
    expect(parsed.ok).toBe(true);
  });
});
