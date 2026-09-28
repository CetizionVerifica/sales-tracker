import * as XLSX from 'xlsx';
import { REQUIRED_IMPORT_FIELDS, type ImportFieldValue } from '../schemas/import.ts';
import { ENQUIRY_FIELD_CATALOG, type ImportFieldDef } from './suggest/field-catalog.ts';

const REQUIRED = new Set<ImportFieldValue>(REQUIRED_IMPORT_FIELDS);

/** "Field *" for the columns commit needs, so the star round-trips into the workbook. */
function headerFor(field: ImportFieldDef): string {
  return REQUIRED.has(field.field) ? `${field.label} *` : field.label;
}

/** One example row, keyed by field — same order-independence as the catalog itself. */
const SAMPLE_ROW: Record<ImportFieldValue, string> = {
  client: 'Acme Pharmaceuticals Pvt Ltd',
  sector: 'Pharmaceutical',
  services: 'ESG, HSE',
  receivedDate: '15/03/2026',
  proposalSentDate: '20/03/2026',
  source: 'Email',
  sourceDetail: '',
  description: 'Annual ESG assessment for FY26',
  owner: '',
};

const INSTRUCTIONS: (string | number)[][] = [
  ['How to use this template'],
  [],
  [
    '1. Keep the header row on the "Enquiries" sheet exactly as it is — columns are matched by name.',
  ],
  ['2. Delete the example row, then add one row per enquiry below the header.'],
  ['3. Columns marked with * are required; the rest can be left blank.'],
  [],
  ['Column', 'Required', 'Notes'],
  [
    'Client',
    'Yes',
    'The client name, exactly as it should appear (or already appears) in Sales Tracker.',
  ],
  ['Sector', 'Yes', 'Matches an existing sector, or is mapped to one during import.'],
  ['Service(s)', 'Yes', 'One or more services, separated by commas — for example "ESG, HSE".'],
  ['Received date', 'Yes', 'When the enquiry arrived. Format: DD/MM/YYYY, for example 15/03/2026.'],
  ['Source', 'Yes', 'One of: Email, Phone, Tender portal, Referral, Website, Walk-in, Other.'],
  [
    'Proposal sent date',
    'No',
    'Format: DD/MM/YYYY. Leave blank if a proposal has not been sent yet.',
  ],
  ['Source detail', 'No', 'Required only when Source is Tender portal, Referral or Other.'],
  ['Description', 'No', 'A short note about the enquiry.'],
  [
    'Owner',
    'No',
    'Admins only: the Sales user this enquiry belongs to. Leave blank to default to you.',
  ],
];

/**
 * The downloadable starting point for M10b bulk import (phase 1: Enquiries only). Column
 * names match the field catalog's own labels exactly, so a file filled in from this
 * template is auto-mapped by the heuristic with no manual work on the Columns step —
 * `template.test.ts` proves that round trip so the two can never silently drift apart.
 */
export function buildEnquiryImportTemplate(): Uint8Array {
  const headers = ENQUIRY_FIELD_CATALOG.map(headerFor);
  const sample = ENQUIRY_FIELD_CATALOG.map((field) => SAMPLE_ROW[field.field]);

  const workbook = XLSX.utils.book_new();
  // "Enquiries" first: the parser picks the first sheet with content (M10b phase 1 is
  // single-sheet), so the instructions sheet must never be mistaken for the data sheet.
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([headers, sample]), 'Enquiries');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(INSTRUCTIONS), 'Instructions');

  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }) as Uint8Array;
}
