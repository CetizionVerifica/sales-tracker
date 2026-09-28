import type { MyTodayKind, MyTodayKindGroup } from '@sales-tracker/core/schemas';

/** Short names for each row kind, for "also" reasons and screen readers (M11). */
export const MY_TODAY_KIND_LABELS: Record<MyTodayKind, string> = {
  INVOICE_OVERDUE: 'Invoice overdue',
  INVOICE_DUE: 'Invoice due',
  QUOTATION_AWAITING_REPLY: 'Quotation follow-up',
  FOLLOW_UP_DUE: 'Follow-up due',
  PROJECT_BEHIND_SCHEDULE: 'Project behind schedule',
  STALE_ENQUIRY: 'Stale enquiry',
  DOCUMENT_TO_REVIEW: 'Document to review',
};

/** The kind chips above the panels, in display order. */
export const MY_TODAY_GROUP_LABELS: Record<MyTodayKindGroup, string> = {
  followUps: 'Follow-ups',
  quotations: 'Quotations',
  invoices: 'Invoices',
  projects: 'Projects',
  enquiries: 'Enquiries',
  documents: 'Documents',
};
