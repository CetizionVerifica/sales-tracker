import type { EnquiryStatus } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';

/**
 * Enquiry: IN_PROGRESS → CONVERTED | LOST (CLAUDE.md). CONVERTED and LOST are terminal
 * in v1 (M4 Decision 5); reopening would be one entry here plus tests.
 */
const TRANSITIONS: Record<EnquiryStatus, readonly EnquiryStatus[]> = {
  IN_PROGRESS: ['CONVERTED', 'LOST'],
  CONVERTED: [],
  LOST: [],
};

const LABELS: Record<EnquiryStatus, string> = {
  IN_PROGRESS: 'in progress',
  CONVERTED: 'converted',
  LOST: 'lost',
};

export function canTransitionEnquiry(from: EnquiryStatus, to: EnquiryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/**
 * Throws a DomainError (with the field to highlight) unless the move is allowed.
 * `input` carries values supplied with the action, which win over the stored ones.
 */
export function assertEnquiryTransition(
  enquiry: { status: EnquiryStatus; proposalSentDate: Date | null },
  to: EnquiryStatus,
  input: { proposalSentDate?: Date | null | undefined; lostReason?: string | null | undefined },
): void {
  if (!canTransitionEnquiry(enquiry.status, to)) {
    throw new DomainError(
      `An enquiry that is ${LABELS[enquiry.status]} cannot be marked ${LABELS[to]}`,
    );
  }
  if (to === 'CONVERTED' && !(input.proposalSentDate ?? enquiry.proposalSentDate)) {
    throw new DomainError('Enter the date the proposal was sent', { field: 'proposalSentDate' });
  }
  if (to === 'LOST' && !input.lostReason?.trim()) {
    throw new DomainError('Say why the enquiry was lost', { field: 'lostReason' });
  }
}
