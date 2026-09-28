import type {
  DueDateBasisValue,
  InvoiceDueWindow,
  InvoiceStatusValue,
} from '@sales-tracker/core/schemas';

export const INVOICE_STATUS_LABELS: Record<InvoiceStatusValue, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

/** The list's due-window filter (unpaid invoices only). */
export const DUE_WINDOW_LABELS: Record<InvoiceDueWindow, string> = {
  overdue: 'Overdue',
  next7: 'Due in 7 days',
  next30: 'Due in 30 days',
};

/** How a due date was set (M10 Decision 6), shown next to it. */
export const DUE_DATE_BASIS_LABELS: Record<DueDateBasisValue, string> = {
  PO_TERMS: 'PO terms',
  COMPANY_DEFAULT: 'Company default',
  MANUAL: 'Custom',
};
