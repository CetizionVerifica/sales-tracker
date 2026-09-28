import type {
  DateFormatValue,
  ImportBatchStatusValue,
  ImportFieldValue,
} from '@sales-tracker/core/schemas';

/** The Enquiry field catalog's labels (mirrors `packages/core/import/suggest/field-catalog.ts`). */
export const IMPORT_FIELD_LABELS: Record<ImportFieldValue, string> = {
  client: 'Client',
  sector: 'Sector',
  services: 'Service(s)',
  receivedDate: 'Received date',
  proposalSentDate: 'Proposal sent date',
  source: 'Source',
  sourceDetail: 'Source detail',
  description: 'Description',
  owner: 'Owner',
};

export const IMPORT_DATE_FORMAT_LABELS: Record<DateFormatValue, string> = {
  'DD/MM/YYYY': 'DD/MM/YYYY (31/03/2026)',
  'MM/DD/YYYY': 'MM/DD/YYYY (03/31/2026)',
  'DD-MMM-YY': 'DD-MMM-YY (31-Mar-26)',
  EXCEL_SERIAL: 'Excel serial number',
};

/** One line under the page title for each stage of the wizard. */
export const IMPORT_STATUS_DESCRIPTION: Record<ImportBatchStatusValue, string> = {
  UPLOADED: 'Waiting to read the file.',
  PARSING: 'Reading the file and suggesting a column mapping…',
  MAPPING: 'Check which column is which, then map any values that need it.',
  VALIDATING: 'Checking every row…',
  READY: 'Fix any errors, then import the rows that are ready.',
  COMMITTING: 'Creating the enquiries…',
  COMMITTED: 'This import has been applied.',
  FAILED: 'This import could not be read.',
  UNDONE: 'This import was undone; nothing it created remains.',
  EXPIRED: 'This draft was never finished and has expired.',
};
