import type { QuotationStatus } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';
import { NEXT_BEFORE_QUOTATION_DATE } from '../schemas/quotation.ts';

/**
 * Quotation: SENT ⇄ UNDER_NEGOTIATION → PO_RECEIVED | LOST (CLAUDE.md; M6 Decision 11).
 * PO_RECEIVED and LOST are terminal in v1 (M6 Decisions 9 and 11).
 */
const TRANSITIONS: Record<QuotationStatus, readonly QuotationStatus[]> = {
  SENT: ['UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST'],
  UNDER_NEGOTIATION: ['SENT', 'PO_RECEIVED', 'LOST'],
  PO_RECEIVED: [],
  LOST: [],
};

/** Statuses that need a next follow-up date (the DB CHECK enforces the same). */
export const ACTIVE_QUOTATION_STATUSES: readonly QuotationStatus[] = ['SENT', 'UNDER_NEGOTIATION'];

export const QUOTATION_STATUS_LABELS: Record<QuotationStatus, string> = {
  SENT: 'Sent',
  UNDER_NEGOTIATION: 'Under negotiation',
  PO_RECEIVED: 'PO received',
  LOST: 'Lost',
};

/**
 * The only fields a PO_RECEIVED or LOST quotation still takes (M6 Decisions 9 and 11). The
 * owner stays changeable (admins only, as always) so a won deal can move to another rep and
 * its project's Sales visibility moves with it (M8 Decision 4).
 */
export const CLOSED_QUOTATION_EDITABLE: readonly string[] = [
  'description',
  'lastFollowUpHighlights',
  'ownerId',
];

export function isActiveQuotation(status: QuotationStatus): boolean {
  return ACTIVE_QUOTATION_STATUSES.includes(status);
}

export function canTransitionQuotation(from: QuotationStatus, to: QuotationStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws a DomainError (with the field to highlight) unless the move is allowed.
 * `input` carries values supplied with the action, which win over the stored ones; `today`
 * is the calendar day in Asia/Kolkata (passed in, so this stays pure).
 */
export function assertQuotationTransition(
  quotation: { status: QuotationStatus; quotationDate: Date; nextFollowUpDate: Date | null },
  to: QuotationStatus,
  input: {
    nextFollowUpDate?: Date | null | undefined;
    poReceivedDate?: Date | null | undefined;
    lostReason?: string | null | undefined;
    today: Date;
  },
): void {
  if (!canTransitionQuotation(quotation.status, to)) {
    throw new DomainError(
      `A quotation that is ${QUOTATION_STATUS_LABELS[quotation.status].toLowerCase()} cannot be marked ${QUOTATION_STATUS_LABELS[to].toLowerCase()}`,
    );
  }
  if (isActiveQuotation(to)) {
    const next = input.nextFollowUpDate ?? quotation.nextFollowUpDate;
    if (!next) {
      throw new DomainError('Enter the next follow-up date', { field: 'nextFollowUpDate' });
    }
    if (next < quotation.quotationDate) {
      throw new DomainError(NEXT_BEFORE_QUOTATION_DATE, { field: 'nextFollowUpDate' });
    }
  }
  if (to === 'PO_RECEIVED') {
    const received = input.poReceivedDate;
    if (!received) {
      throw new DomainError('Enter the date the PO was received', { field: 'poReceivedDate' });
    }
    if (received > input.today) {
      throw new DomainError('The PO received date cannot be in the future', {
        field: 'poReceivedDate',
      });
    }
    if (received < quotation.quotationDate) {
      throw new DomainError('The PO cannot arrive before the quotation date', {
        field: 'poReceivedDate',
      });
    }
  }
  if (to === 'LOST' && !input.lostReason?.trim()) {
    throw new DomainError('Say why the quotation was lost', { field: 'lostReason' });
  }
}
