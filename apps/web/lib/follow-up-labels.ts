import type {
  FollowUpChannelValue,
  FollowUpEntityTypeValue,
  TimelineKind,
} from '@sales-tracker/core/schemas';

export const CHANNEL_LABELS: Record<FollowUpChannelValue, string> = {
  CALL: 'Call',
  EMAIL: 'Email',
  MEETING: 'Meeting',
  SITE_VISIT: 'Site visit',
  WHATSAPP: 'WhatsApp',
  OTHER: 'Other',
};

/** Kinds a user can filter by. */
export const KIND_LABELS: Partial<Record<TimelineKind, string>> = {
  FOLLOW_UP: 'Follow-ups',
  CREATED: 'Created',
  STATUS_CHANGE: 'Status changes',
  DELETED: 'Deleted',
  RESTORED: 'Restored',
  DOCUMENT: 'Documents',
};

export const ENTITY_TYPE_LABELS: Record<FollowUpEntityTypeValue, string> = {
  CLIENT: 'Client',
  ENQUIRY: 'Enquiry',
  QUOTATION: 'Quotation',
  PROJECT: 'Project',
  PURCHASE_ORDER: 'Purchase order',
  INVOICE: 'Invoice',
};

/** Where a linked record's page lives, for types that have one. */
export function recordHref(type: FollowUpEntityTypeValue, id: string): string | null {
  if (type === 'ENQUIRY') return `/enquiries/${id}`;
  if (type === 'QUOTATION') return `/quotations/${id}`;
  if (type === 'PROJECT') return `/projects/${id}`;
  if (type === 'PURCHASE_ORDER') return `/purchase-orders/${id}`;
  return null;
}
