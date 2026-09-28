import { describe, expect, it } from 'vitest';
import { countSentence, deltaPhrase, moneySentence, sharePct } from '../../reports/headlines.ts';

// M12b AC7: headlines for an increase, a decrease, no change, zero in the current period, and
// no previous-period data.

describe('deltaPhrase', () => {
  it('an increase', () => {
    expect(deltaPhrase(124, 105, 'last month')).toBe('up 18% on last month');
  });
  it('a decrease', () => {
    expect(deltaPhrase(80, 100, 'last month')).toBe('down 20% on last month');
  });
  it('no change', () => {
    expect(deltaPhrase(50, 50, 'last month')).toBe('the same as last month');
  });
  it('no previous-period data', () => {
    expect(deltaPhrase(10, null, 'last month')).toBe('no data for last month to compare');
  });
  it('up from a previous zero', () => {
    expect(deltaPhrase(5, 0, 'last month')).toBe('up from none in last month');
  });
});

describe('countSentence', () => {
  it('an increase', () => {
    expect(
      countSentence({
        noun: 'enquiry',
        pluralNoun: 'enquiries',
        count: 124,
        periodLabel: 'this month',
        previous: 105,
        previousLabel: 'last month',
      }),
    ).toBe('124 enquiries this month, up 18% on last month.');
  });

  it('singular noun for a count of one', () => {
    expect(
      countSentence({
        noun: 'enquiry',
        pluralNoun: 'enquiries',
        count: 1,
        periodLabel: 'this month',
        previous: 1,
        previousLabel: 'last month',
      }),
    ).toBe('1 enquiry this month, the same as last month.');
  });

  it('zero in the current period, with previous-period data', () => {
    expect(
      countSentence({
        noun: 'enquiry',
        pluralNoun: 'enquiries',
        count: 0,
        periodLabel: 'this month',
        previous: 12,
        previousLabel: 'last month',
      }),
    ).toBe('No enquiries this month, down 100% on last month.');
  });

  it('zero in the current period, no previous-period data', () => {
    expect(
      countSentence({
        noun: 'enquiry',
        pluralNoun: 'enquiries',
        count: 0,
        periodLabel: 'this month',
        previous: null,
        previousLabel: 'last month',
      }),
    ).toBe('No enquiries this month.');
  });
});

describe('moneySentence', () => {
  it('an increase', () => {
    expect(
      moneySentence({
        label: 'Invoiced',
        amountMinor: 4_230_000_00n,
        periodLabel: 'this month',
        previousMinor: 3_000_000_00n,
        previousLabel: 'last month',
      }),
    ).toBe('Invoiced ₹42.3L this month, up 41% on last month.');
  });

  it('no previous-period data', () => {
    expect(
      moneySentence({
        label: 'Invoiced',
        amountMinor: 100_000_00n,
        periodLabel: 'this month',
        previousMinor: null,
        previousLabel: 'last month',
      }),
    ).toBe('Invoiced ₹1L this month, no data for last month to compare.');
  });

  it('zero with no previous data', () => {
    expect(
      moneySentence({
        label: 'Invoiced',
        amountMinor: 0n,
        periodLabel: 'this month',
        previousMinor: null,
        previousLabel: 'last month',
      }),
    ).toBe('No invoiced this month.');
  });
});

describe('sharePct', () => {
  it('rounds to a whole percentage', () => {
    expect(sharePct(31n, 100n)).toBe(31);
    expect(sharePct(1n, 3n)).toBe(33);
  });
  it('is 0 for an empty whole', () => {
    expect(sharePct(5n, 0n)).toBe(0);
  });
});
