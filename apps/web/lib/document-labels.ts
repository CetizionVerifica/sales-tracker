import type { ExtractionStatusValue } from '@sales-tracker/core/schemas';

/** Record field names as people read them (review screen, timeline "Applied …"). */
const FIELD_LABELS: Record<string, string> = {
  amount: 'amount',
  currency: 'currency',
  quotationDate: 'quotation date',
  description: 'description',
  poNumber: 'PO number',
  paymentTerms: 'payment terms',
  paymentTermsDays: 'net days',
  invoiceNumber: 'invoice number',
  invoiceDate: 'invoice date',
  dueDate: 'due date',
};

export function fieldLabel(name: string): string {
  return FIELD_LABELS[name] ?? name;
}

export const EXTRACTION_STATUS_TEXT: Record<ExtractionStatusValue, string> = {
  QUEUED: 'Reading document…',
  RUNNING: 'Reading document…',
  SUCCEEDED: 'Ready to review',
  FAILED: 'Could not read',
  SKIPPED: 'Extraction is turned off',
};

export const ACCEPTED_TYPES = 'application/pdf,image/png,image/jpeg,image/webp';

/** `2.4 MB`, `820 KB`. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export const CONFIDENCE_TEXT = {
  high: 'High confidence',
  medium: 'Medium confidence',
  low: 'Check this value',
} as const;
