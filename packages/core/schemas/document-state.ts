/**
 * Where a record's current document is, as lists show and filter it (M9; M10 reuses it for
 * invoices): none attached, being read, ready to review, reviewed, or not read (failed, or
 * extraction turned off).
 */
export const DOCUMENT_STATES = ['none', 'reading', 'toReview', 'reviewed', 'failed'] as const;
export type DocumentState = (typeof DOCUMENT_STATES)[number];
