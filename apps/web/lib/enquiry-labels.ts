import type { EnquirySourceValue, EnquiryStatusValue } from '@sales-tracker/core/schemas';
import type { Badge } from '@/components/ui/badge';

export const STATUS_LABELS: Record<EnquiryStatusValue, string> = {
  IN_PROGRESS: 'In progress',
  CONVERTED: 'Converted',
  LOST: 'Lost',
};

export const STATUS_BADGE: Record<
  EnquiryStatusValue,
  NonNullable<React.ComponentProps<typeof Badge>['variant']>
> = {
  IN_PROGRESS: 'secondary',
  CONVERTED: 'default',
  LOST: 'outline',
};

export const SOURCE_LABELS: Record<EnquirySourceValue, string> = {
  EMAIL: 'Email',
  PHONE: 'Phone',
  TENDER_PORTAL: 'Tender portal',
  REFERRAL: 'Referral',
  WEBSITE: 'Website',
  WALK_IN: 'Walk-in',
  OTHER: 'Other',
};

/** The source-detail field follows the source (M4 spec: web form). */
export const SOURCE_DETAIL: Record<EnquirySourceValue, { label: string; placeholder: string }> = {
  EMAIL: { label: 'Sender', placeholder: 'e.g. purchase@client.example' },
  PHONE: { label: 'Caller', placeholder: 'e.g. Ravi, +91 98200 00000' },
  TENDER_PORTAL: { label: 'Portal and tender ID', placeholder: 'e.g. GeM GEM/2026/B/1234' },
  REFERRAL: { label: 'Referred by', placeholder: 'e.g. Anil Kumar, Acme Pharma' },
  WEBSITE: { label: 'Form or page', placeholder: 'e.g. Contact form' },
  WALK_IN: { label: 'Visitor', placeholder: 'e.g. Name and company' },
  OTHER: { label: 'Where it came from', placeholder: 'e.g. Trade fair, Mumbai' },
};

export const toOptions = <K extends string>(labels: Record<K, string>) =>
  (Object.entries(labels) as [K, string][]).map(([value, label]) => ({ value, label }));
