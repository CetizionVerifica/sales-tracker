import { describe, expect, it } from 'vitest';
import { todayInIST } from '../../schemas/common.ts';
import {
  assertInvoiceTransition,
  canTransitionInvoice,
  daysOverdue,
  defaultDueDate,
  INVOICE_TRANSITIONS,
  invoiceStatusForDueDate,
  type InvoiceActor,
} from '../../status/invoice.ts';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const STATUSES = ['PENDING', 'PAID', 'OVERDUE'] as const;
const ACTORS: InvoiceActor[] = ['user', 'admin', 'system'];

// AC4: the status machine, as pure functions.
describe('AC4: invoice transitions', () => {
  it('lists exactly the moves in the M10 spec', () => {
    expect(INVOICE_TRANSITIONS).toEqual({
      PENDING: ['PAID', 'OVERDUE'],
      OVERDUE: ['PAID', 'PENDING'],
      PAID: ['PENDING', 'OVERDUE'],
    });
  });

  // Who may make each move without a due-date change, and with one.
  const allowed: Record<string, { plain: InvoiceActor[]; dueDate: InvoiceActor[] }> = {
    'PENDING->PAID': { plain: ['user', 'admin'], dueDate: ['user', 'admin'] },
    'OVERDUE->PAID': { plain: ['user', 'admin'], dueDate: ['user', 'admin'] },
    'PENDING->OVERDUE': { plain: ['system'], dueDate: ['user', 'admin', 'system'] },
    'OVERDUE->PENDING': { plain: [], dueDate: ['user', 'admin', 'system'] },
    'PAID->PENDING': { plain: ['admin'], dueDate: ['admin'] },
    'PAID->OVERDUE': { plain: ['admin'], dueDate: ['admin'] },
  };

  for (const from of STATUSES) {
    for (const to of STATUSES) {
      if (from === to) continue;
      const rule = allowed[`${from}->${to}`]!;
      for (const by of ACTORS) {
        it(`${from} → ${to} by ${by}: ${rule.plain.includes(by) ? 'allowed' : 'refused'}`, () => {
          expect(canTransitionInvoice(from, to, { by })).toBe(rule.plain.includes(by));
        });
        it(`${from} → ${to} by ${by} after a due-date edit: ${rule.dueDate.includes(by) ? 'allowed' : 'refused'}`, () => {
          expect(canTransitionInvoice(from, to, { by, dueDateChange: true })).toBe(
            rule.dueDate.includes(by),
          );
        });
      }
    }
  }

  it('refuses staying in the same status', () => {
    for (const status of STATUSES) {
      expect(canTransitionInvoice(status, status, { by: 'admin' })).toBe(false);
    }
  });
});

describe('AC4: assertInvoiceTransition', () => {
  const today = day('2026-09-28');
  const invoice = { status: 'PENDING' as const, invoiceDate: day('2026-09-01') };

  it('refuses PAID without a paid date', () => {
    expect(() => assertInvoiceTransition(invoice, 'PAID', { by: 'user', today })).toThrow(
      expect.objectContaining({ field: 'paidAt' }),
    );
  });

  it('refuses a paid date in the future or before the invoice date', () => {
    expect(() =>
      assertInvoiceTransition(invoice, 'PAID', { by: 'user', today, paidAt: day('2026-09-29') }),
    ).toThrow(expect.objectContaining({ field: 'paidAt' }));
    expect(() =>
      assertInvoiceTransition(invoice, 'PAID', { by: 'user', today, paidAt: day('2026-08-31') }),
    ).toThrow(expect.objectContaining({ field: 'paidAt' }));
  });

  it('accepts a paid date between the invoice date and today', () => {
    expect(() =>
      assertInvoiceTransition(invoice, 'PAID', { by: 'user', today, paidAt: day('2026-09-01') }),
    ).not.toThrow();
    expect(() =>
      assertInvoiceTransition(invoice, 'PAID', { by: 'user', today, paidAt: today }),
    ).not.toThrow();
  });

  it('names the move it refuses', () => {
    expect(() =>
      assertInvoiceTransition({ ...invoice, status: 'PAID' }, 'PENDING', { by: 'user', today }),
    ).toThrow('A paid invoice cannot be marked pending');
  });
});

describe('AC4: invoiceStatusForDueDate', () => {
  const today = day('2026-09-28');

  it('is OVERDUE only once the due date has passed (IST calendar days)', () => {
    expect(invoiceStatusForDueDate('PENDING', day('2026-09-27'), today)).toBe('OVERDUE');
    expect(invoiceStatusForDueDate('PENDING', day('2026-09-28'), today)).toBe('PENDING');
    expect(invoiceStatusForDueDate('PENDING', day('2026-09-29'), today)).toBe('PENDING');
    expect(invoiceStatusForDueDate('OVERDUE', day('2026-09-28'), today)).toBe('PENDING');
    expect(invoiceStatusForDueDate('OVERDUE', day('2026-09-27'), today)).toBe('OVERDUE');
  });

  it('leaves a paid invoice paid', () => {
    expect(invoiceStatusForDueDate('PAID', day('2020-01-01'), today)).toBe('PAID');
  });

  it('uses the IST day at 23:30 IST (18:00 UTC), not the UTC one', () => {
    // 23:30 IST on 28 Sep is still 28 Sep in Kolkata; at 00:30 IST on 29 Sep it is the 29th,
    // though UTC still says the 28th.
    const lateEvening = todayInIST(new Date('2026-09-28T18:00:00.000Z'));
    const justAfterMidnight = todayInIST(new Date('2026-09-28T19:00:00.000Z'));
    expect(lateEvening).toEqual(day('2026-09-28'));
    expect(justAfterMidnight).toEqual(day('2026-09-29'));
    expect(invoiceStatusForDueDate('PENDING', day('2026-09-28'), lateEvening)).toBe('PENDING');
    expect(invoiceStatusForDueDate('PENDING', day('2026-09-28'), justAfterMidnight)).toBe(
      'OVERDUE',
    );
  });

  it('counts days overdue', () => {
    expect(daysOverdue(day('2026-09-18'), today)).toBe(10);
    expect(daysOverdue(day('2026-09-28'), today)).toBe(0);
    expect(daysOverdue(day('2026-10-05'), today)).toBe(-7);
  });
});

describe('AC4: defaultDueDate', () => {
  const invoiceDate = day('2026-09-01');

  it('adds the PO net days', () => {
    expect(defaultDueDate({ invoiceDate, poPaymentTermsDays: 45, companyDefaultDays: 30 })).toEqual(
      { dueDate: day('2026-10-16'), basis: 'PO_TERMS' },
    );
  });

  it('treats net 0 as PO terms: due on the invoice date', () => {
    expect(defaultDueDate({ invoiceDate, poPaymentTermsDays: 0, companyDefaultDays: 30 })).toEqual({
      dueDate: invoiceDate,
      basis: 'PO_TERMS',
    });
  });

  it('falls back to the company default when the PO has no net days', () => {
    expect(
      defaultDueDate({ invoiceDate, poPaymentTermsDays: null, companyDefaultDays: 30 }),
    ).toEqual({ dueDate: day('2026-10-01'), basis: 'COMPANY_DEFAULT' });
  });
});
