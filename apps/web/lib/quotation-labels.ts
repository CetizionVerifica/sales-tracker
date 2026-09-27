import type { QuotationStatusValue } from '@sales-tracker/core/schemas';
import type { Badge } from '@/components/ui/badge';

export const QUOTATION_STATUS_LABELS: Record<QuotationStatusValue, string> = {
  SENT: 'Sent',
  UNDER_NEGOTIATION: 'Under negotiation',
  PO_RECEIVED: 'PO received',
  LOST: 'Lost',
};

export const QUOTATION_STATUS_BADGE: Record<
  QuotationStatusValue,
  NonNullable<React.ComponentProps<typeof Badge>['variant']>
> = {
  SENT: 'secondary',
  UNDER_NEGOTIATION: 'secondary',
  PO_RECEIVED: 'default',
  LOST: 'outline',
};

/** Open quotations need a next follow-up date (CLAUDE.md status machines). */
export const isOpenQuotation = (status: QuotationStatusValue) =>
  status === 'SENT' || status === 'UNDER_NEGOTIATION';
