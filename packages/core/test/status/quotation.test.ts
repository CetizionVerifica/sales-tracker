import type { QuotationStatus } from '@sales-tracker/db';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.ts';
import { assertQuotationTransition, canTransitionQuotation } from '../../status/quotation.ts';

const STATUSES: QuotationStatus[] = ['SENT', 'UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST'];
const ALLOWED = new Set([
  'SENT→UNDER_NEGOTIATION',
  'UNDER_NEGOTIATION→SENT',
  'SENT→PO_RECEIVED',
  'UNDER_NEGOTIATION→PO_RECEIVED',
  'SENT→LOST',
  'UNDER_NEGOTIATION→LOST',
]);

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const quotationDate = day('2026-03-10');
const today = day('2026-09-27');

const quotation = (status: QuotationStatus, nextFollowUpDate: Date | null = day('2026-10-01')) => ({
  status,
  quotationDate,
  nextFollowUpDate,
});

/** Everything any move could need, so only the move itself decides. */
const full = { poReceivedDate: day('2026-04-01'), lostReason: 'Price', today };

function fieldOf(fn: () => void): string | undefined {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return (error as DomainError).field ?? 'none';
  }
  return undefined;
}

// AC6: every pair of the four statuses; only the six moves are allowed.
describe('AC6: quotation status machine', () => {
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from, to) => {
    expect(canTransitionQuotation(from, to)).toBe(ALLOWED.has(`${from}→${to}`));
  });

  it.each(pairs.filter(([from, to]) => !ALLOWED.has(`${from}→${to}`)))(
    'assertQuotationTransition rejects %s → %s',
    (from, to) => {
      expect(() => assertQuotationTransition(quotation(from), to, full)).toThrow(DomainError);
    },
  );

  it.each(pairs.filter(([from, to]) => ALLOWED.has(`${from}→${to}`)))(
    'assertQuotationTransition allows %s → %s with the values it needs',
    (from, to) => {
      expect(() => assertQuotationTransition(quotation(from), to, full)).not.toThrow();
    },
  );

  describe('next follow-up date for SENT and UNDER_NEGOTIATION', () => {
    it('uses the stored date', () => {
      expect(() =>
        assertQuotationTransition(quotation('SENT'), 'UNDER_NEGOTIATION', { today }),
      ).not.toThrow();
    });

    it('accepts one supplied with the action', () => {
      expect(() =>
        assertQuotationTransition(quotation('UNDER_NEGOTIATION', null), 'SENT', {
          nextFollowUpDate: day('2026-10-05'),
          today,
        }),
      ).not.toThrow();
    });

    it('rejects the move without one, on that field', () => {
      expect(
        fieldOf(() =>
          assertQuotationTransition(quotation('SENT', null), 'UNDER_NEGOTIATION', { today }),
        ),
      ).toBe('nextFollowUpDate');
    });

    it('rejects one before the quotation date', () => {
      expect(
        fieldOf(() =>
          assertQuotationTransition(quotation('SENT'), 'UNDER_NEGOTIATION', {
            nextFollowUpDate: day('2026-03-01'),
            today,
          }),
        ),
      ).toBe('nextFollowUpDate');
    });
  });

  describe('PO_RECEIVED', () => {
    it('requires a PO received date', () => {
      expect(
        fieldOf(() => assertQuotationTransition(quotation('SENT'), 'PO_RECEIVED', { today })),
      ).toBe('poReceivedDate');
    });

    it('rejects a PO received date in the future', () => {
      expect(
        fieldOf(() =>
          assertQuotationTransition(quotation('SENT'), 'PO_RECEIVED', {
            poReceivedDate: day('2026-09-28'),
            today,
          }),
        ),
      ).toBe('poReceivedDate');
    });

    it('rejects a PO received date before the quotation date', () => {
      expect(
        fieldOf(() =>
          assertQuotationTransition(quotation('SENT'), 'PO_RECEIVED', {
            poReceivedDate: day('2026-03-09'),
            today,
          }),
        ),
      ).toBe('poReceivedDate');
    });

    it('accepts today and the quotation date itself', () => {
      for (const poReceivedDate of [today, quotationDate]) {
        expect(() =>
          assertQuotationTransition(quotation('SENT'), 'PO_RECEIVED', { poReceivedDate, today }),
        ).not.toThrow();
      }
    });
  });

  describe('LOST', () => {
    it.each([undefined, '', '   '])('requires a reason (%j)', (lostReason) => {
      expect(
        fieldOf(() =>
          assertQuotationTransition(quotation('UNDER_NEGOTIATION'), 'LOST', { lostReason, today }),
        ),
      ).toBe('lostReason');
    });
  });
});
