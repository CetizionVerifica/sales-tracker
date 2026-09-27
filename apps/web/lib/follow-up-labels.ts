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

/** Kinds a user can filter by (DOCUMENT arrives in M7). */
export const KIND_LABELS: Partial<Record<TimelineKind, string>> = {
  FOLLOW_UP: 'Follow-ups',
  CREATED: 'Created',
  STATUS_CHANGE: 'Status changes',
  DELETED: 'Deleted',
  RESTORED: 'Restored',
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
  return type === 'ENQUIRY' ? `/enquiries/${id}` : null;
}
