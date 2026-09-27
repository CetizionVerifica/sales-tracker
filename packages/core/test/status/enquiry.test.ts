import type { EnquiryStatus } from '@sales-tracker/db';
import { describe, expect, it } from 'vitest';
import { DomainError } from '../../errors.ts';
import { assertEnquiryTransition, canTransitionEnquiry } from '../../status/enquiry.ts';

const STATUSES: EnquiryStatus[] = ['IN_PROGRESS', 'CONVERTED', 'LOST'];
const ALLOWED = new Set(['IN_PROGRESS→CONVERTED', 'IN_PROGRESS→LOST']);

const sent = new Date('2026-03-12T00:00:00.000Z');

// AC5: every pair of statuses; only IN_PROGRESS → CONVERTED | LOST is allowed.
describe('AC5: enquiry status machine', () => {
  const pairs = STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from, to) => {
    expect(canTransitionEnquiry(from, to)).toBe(ALLOWED.has(`${from}→${to}`));
  });

  it.each(pairs.filter(([from, to]) => !ALLOWED.has(`${from}→${to}`)))(
    'assertEnquiryTransition rejects %s → %s',
    (from, to) => {
      expect(() =>
        assertEnquiryTransition({ status: from, proposalSentDate: sent }, to, {
          lostReason: 'Price',
        }),
      ).toThrow(DomainError);
    },
  );

  it('converts when the enquiry already has a proposal sent date', () => {
    expect(() =>
      assertEnquiryTransition({ status: 'IN_PROGRESS', proposalSentDate: sent }, 'CONVERTED', {}),
    ).not.toThrow();
  });

  it('converts when the proposal sent date is supplied with the action', () => {
    expect(() =>
      assertEnquiryTransition({ status: 'IN_PROGRESS', proposalSentDate: null }, 'CONVERTED', {
        proposalSentDate: sent,
      }),
    ).not.toThrow();
  });

  it('rejects CONVERTED without a proposal sent date, on that field', () => {
    try {
      assertEnquiryTransition({ status: 'IN_PROGRESS', proposalSentDate: null }, 'CONVERTED', {});
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).field).toBe('proposalSentDate');
    }
  });

  it.each([undefined, '', '   '])('rejects LOST with reason %j, on that field', (lostReason) => {
    try {
      assertEnquiryTransition({ status: 'IN_PROGRESS', proposalSentDate: null }, 'LOST', {
        lostReason,
      });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(DomainError);
      expect((error as DomainError).field).toBe('lostReason');
    }
  });

  it('marks lost with a reason', () => {
    expect(() =>
      assertEnquiryTransition({ status: 'IN_PROGRESS', proposalSentDate: null }, 'LOST', {
        lostReason: 'Went with a competitor',
      }),
    ).not.toThrow();
  });
});
