import type { DueDateBasis, InvoiceStatus } from '@sales-tracker/db';
import { DomainError } from '../errors.ts';

/**
 * Invoice (M10): PENDING → PAID, PENDING → OVERDUE → PAID (CLAUDE.md), plus two moves the
 * product owner confirmed: OVERDUE → PENDING when a due date is corrected (Decision 7) and
 * PAID → PENDING | OVERDUE by an admin's "Mark unpaid" (Decision 8).
 *
 * Who makes a move matters here, unlike the other machines: OVERDUE is the nightly job's
 * (`system`) or follows from a due-date edit, never a user's choice, and only admins undo a
 * payment. The service passes the actor; this module stays pure.
 */
export const INVOICE_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  PENDING: ['PAID', 'OVERDUE'],
  OVERDUE: ['PAID', 'PENDING'],
  PAID: ['PENDING', 'OVERDUE'],
};

/** `user` is any non-admin with update permission; `system` is the nightly job. */
export type InvoiceActor = 'user' | 'admin' | 'system';

export interface InvoiceMove {
  by: InvoiceActor;
  /** The move follows from a due-date edit (create, update or confirm), not a choice. */
  dueDateChange?: boolean;
}

export const INVOICE_STATUS_LABELS: Record<InvoiceStatus, string> = {
  PENDING: 'Pending',
  PAID: 'Paid',
  OVERDUE: 'Overdue',
};

export const UNPAID_INVOICE_STATUSES: readonly InvoiceStatus[] = ['PENDING', 'OVERDUE'];

export const DUE_DATE_BASIS_LABELS: Record<DueDateBasis, string> = {
  PO_TERMS: 'PO terms',
  COMPANY_DEFAULT: 'Company default',
  MANUAL: 'Custom',
};

export function canTransitionInvoice(
  from: InvoiceStatus,
  to: InvoiceStatus,
  { by, dueDateChange = false }: InvoiceMove,
): boolean {
  if (!INVOICE_TRANSITIONS[from].includes(to)) return false;
  // Undoing a payment is admin-only, whatever caused it.
  if (from === 'PAID') return by === 'admin';
  // Paying is a person's choice; the job never marks anything paid.
  if (to === 'PAID') return by !== 'system';
  // Going overdue: the job, or a due date moved into the past.
  if (to === 'OVERDUE') return by === 'system' || dueDateChange;
  // OVERDUE → PENDING: only a due date moved to today or later.
  return dueDateChange;
}

/**
 * Throws a DomainError (with the field to highlight) unless the move is allowed. A move to
 * PAID needs `paidAt`, not in the future and not before the invoice date. `today` is the
 * calendar day in Asia/Kolkata, passed in so this stays pure.
 */
export function assertInvoiceTransition(
  invoice: { status: InvoiceStatus; invoiceDate: Date },
  to: InvoiceStatus,
  move: InvoiceMove & { paidAt?: Date | null | undefined; today: Date },
): void {
  if (!canTransitionInvoice(invoice.status, to, move)) {
    throw new DomainError(
      `A ${INVOICE_STATUS_LABELS[invoice.status].toLowerCase()} invoice cannot be marked ${INVOICE_STATUS_LABELS[to].toLowerCase()}`,
    );
  }
  if (to !== 'PAID') return;
  if (!move.paidAt) {
    throw new DomainError('Enter the date the payment was received', { field: 'paidAt' });
  }
  if (move.paidAt > move.today) {
    throw new DomainError('The paid date cannot be in the future', { field: 'paidAt' });
  }
  if (move.paidAt < invoice.invoiceDate) {
    throw new DomainError('The paid date cannot be before the invoice date', { field: 'paidAt' });
  }
}

/**
 * The one definition of "overdue" (Decision 7): an unpaid invoice whose due date is before
 * today (IST calendar days) is OVERDUE, otherwise PENDING. PAID stays PAID. The nightly job,
 * create and due-date edits all use it.
 */
export function invoiceStatusForDueDate(
  status: InvoiceStatus,
  dueDate: Date,
  today: Date,
): InvoiceStatus {
  if (status === 'PAID') return 'PAID';
  return dueDate < today ? 'OVERDUE' : 'PENDING';
}

const DAY_MS = 86_400_000;

/** Whole days past the due date: positive when overdue, 0 on the day, negative before. */
export function daysOverdue(dueDate: Date, today: Date): number {
  return Math.round((today.getTime() - dueDate.getTime()) / DAY_MS);
}

/**
 * The due date an invoice gets unless one is typed (M9 Decision 7, M10 Decision 6): the
 * PO's net days (0 included) after the invoice date, or the company default when the PO
 * states none. Shared by the service and the form, so the hint and the saved date agree.
 */
export function defaultDueDate(input: {
  invoiceDate: Date;
  poPaymentTermsDays: number | null;
  companyDefaultDays: number;
}): { dueDate: Date; basis: 'PO_TERMS' | 'COMPANY_DEFAULT' } {
  const fromPo = input.poPaymentTermsDays !== null;
  const days = fromPo ? input.poPaymentTermsDays! : input.companyDefaultDays;
  return {
    dueDate: new Date(input.invoiceDate.getTime() + days * DAY_MS),
    basis: fromPo ? 'PO_TERMS' : 'COMPANY_DEFAULT',
  };
}
