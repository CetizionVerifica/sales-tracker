import type { DocumentState, PurchaseOrderStatusValue } from '@sales-tracker/core/schemas';

export const PURCHASE_ORDER_STATUS_LABELS: Record<PurchaseOrderStatusValue, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

/** A PO's current document, as lists show and filter it (M9). */
export const DOCUMENT_STATE_LABELS: Record<DocumentState, string> = {
  none: 'No document',
  reading: 'Reading',
  toReview: 'To review',
  reviewed: 'Reviewed',
  failed: 'Could not read',
};
