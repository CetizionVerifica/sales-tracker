/** Status badge tones and labels for every pipeline entity (UI guide §5 table). */

export type StatusTone =
  'neutral' | 'primary' | 'success' | 'warning' | 'destructive' | 'attention';
export type StatusEntity =
  'enquiry' | 'quotation' | 'project' | 'po' | 'invoice' | 'importBatch' | 'importRow';

const STYLES: Record<StatusEntity, Record<string, { tone: StatusTone; label: string }>> = {
  enquiry: {
    IN_PROGRESS: { tone: 'neutral', label: 'In progress' },
    CONVERTED: { tone: 'success', label: 'Converted' },
    LOST: { tone: 'destructive', label: 'Lost' },
  },
  quotation: {
    SENT: { tone: 'neutral', label: 'Sent' },
    UNDER_NEGOTIATION: { tone: 'warning', label: 'Under negotiation' },
    PO_RECEIVED: { tone: 'success', label: 'PO received' },
    // Not in the guide's table (M6 added it); lost reads like a lost enquiry.
    LOST: { tone: 'destructive', label: 'Lost' },
  },
  project: {
    NOT_STARTED: { tone: 'neutral', label: 'Not started' },
    IN_PROGRESS: { tone: 'primary', label: 'In progress' },
    ON_HOLD: { tone: 'warning', label: 'On hold' },
    COMPLETED: { tone: 'success', label: 'Completed' },
    CANCELLED: { tone: 'destructive', label: 'Cancelled' },
  },
  po: {
    PENDING: { tone: 'neutral', label: 'Pending' },
    PAID: { tone: 'success', label: 'Paid' },
    OVERDUE: { tone: 'attention', label: 'Overdue' },
  },
  invoice: {
    PENDING: { tone: 'neutral', label: 'Pending' },
    PAID: { tone: 'success', label: 'Paid' },
    OVERDUE: { tone: 'attention', label: 'Overdue' },
  },
  // M10b: a bulk import batch, working through the wizard.
  importBatch: {
    UPLOADED: { tone: 'neutral', label: 'Uploaded' },
    PARSING: { tone: 'neutral', label: 'Reading file' },
    MAPPING: { tone: 'neutral', label: 'Mapping columns' },
    VALIDATING: { tone: 'neutral', label: 'Validating' },
    READY: { tone: 'primary', label: 'Ready to review' },
    COMMITTING: { tone: 'neutral', label: 'Importing' },
    COMMITTED: { tone: 'success', label: 'Imported' },
    FAILED: { tone: 'destructive', label: 'Failed' },
    UNDONE: { tone: 'neutral', label: 'Undone' },
    EXPIRED: { tone: 'neutral', label: 'Expired' },
  },
  // M10b: one staged spreadsheet row.
  importRow: {
    READY: { tone: 'success', label: 'Ready' },
    WARNING: { tone: 'warning', label: 'Warning' },
    ERROR: { tone: 'destructive', label: 'Error' },
    DUPLICATE: { tone: 'warning', label: 'Duplicate' },
    EXCLUDED: { tone: 'neutral', label: 'Excluded' },
  },
};

/** Sentence-case fallback so an enum string is never shown. */
function sentence(status: string): string {
  const text = status.toLowerCase().replaceAll('_', ' ');
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function statusStyle(
  entity: StatusEntity,
  status: string,
): { tone: StatusTone; label: string } {
  return STYLES[entity][status] ?? { tone: 'neutral', label: sentence(status) };
}

/** Soft fill + strong text per tone (tokens only). */
export const TONE_CLASSES: Record<StatusTone, { badge: string; dot: string }> = {
  neutral: { badge: 'bg-neutral-soft text-foreground', dot: 'bg-neutral' },
  primary: { badge: 'bg-secondary text-secondary-foreground', dot: 'bg-primary' },
  success: { badge: 'bg-success-soft text-success', dot: 'bg-success' },
  // --warning on --warning-soft is below 4.5:1 contrast, so the text stays foreground.
  warning: { badge: 'bg-warning-soft text-foreground', dot: 'bg-warning' },
  destructive: { badge: 'bg-destructive-soft text-destructive', dot: 'bg-destructive' },
  attention: { badge: 'bg-attention-soft text-attention-foreground', dot: 'bg-attention' },
};
