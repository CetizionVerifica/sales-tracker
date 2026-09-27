import { describe, expect, it } from 'vitest';
import {
  currencyFractionDigits,
  formatMoney,
  moneySchema,
  parseAmount,
  toAmountString,
} from '../../schemas/money.ts';

const minor = (amount: string, currency = 'INR') => {
  const result = parseAmount(amount, currency);
  if (!result.ok) throw new Error(result.message);
  return result.value;
};

const error = (amount: string, currency = 'INR') => {
  const result = parseAmount(amount, currency);
  return result.ok ? undefined : result.message;
};

// AC3: amounts round-trip exactly, with no floating-point step anywhere.
describe('AC3: money', () => {
  it('knows each currency’s minor units', () => {
    expect(currencyFractionDigits('INR')).toBe(2);
    expect(currencyFractionDigits('USD')).toBe(2);
    expect(currencyFractionDigits('JPY')).toBe(0);
    expect(currencyFractionDigits('KWD')).toBe(3);
  });

  it.each([
    ['0', 'INR', 0n],
    ['0.01', 'INR', 1n],
    ['1,25,000.50', 'INR', 12_500_050n],
    ['125000.5', 'INR', 12_500_050n],
    ['35000000.00', 'INR', 3_500_000_000n], // ₹3.5 crore: above 32-bit Int
    ['999999999999999', 'JPY', 999_999_999_999_999n],
    ['1.234', 'KWD', 1234n],
    [' 42 ', 'USD', 4200n],
  ])('parses %s %s exactly', (amount, currency, expected) => {
    expect(minor(amount, currency)).toBe(expected);
  });

  it('is exact where parseFloat × 100 is not', () => {
    expect(Math.round(parseFloat('1.15') * 100)).toBe(115); // rounding hides it...
    expect(parseFloat('1.15') * 100).not.toBe(115); // ...but the float is wrong
    expect(minor('1.15')).toBe(115n);
    expect(minor('9007199254740.99')).toBe(900_719_925_474_099n);
  });

  it.each([
    ['', 'INR'],
    ['abc', 'INR'],
    ['-5', 'INR'],
    ['+5', 'INR'],
    ['1e5', 'INR'],
    ['1.2.3', 'INR'],
    ['.', 'INR'],
    ['10.123', 'INR'],
    ['10.5', 'JPY'],
    ['1000000000000000', 'INR'], // 16 integer digits
  ])('rejects %j in %s', (amount, currency) => {
    expect(error(amount, currency)).toBeDefined();
  });

  it('explains too many decimals per currency', () => {
    expect(error('10.5', 'JPY')).toBe('JPY amounts have no decimals');
    expect(error('10.123', 'INR')).toBe('INR amounts have at most 2 decimals');
  });

  it('formats in en-IN with the currency symbol', () => {
    expect(formatMoney(12_500_050n, 'INR')).toBe('₹1,25,000.50');
    expect(formatMoney(125_000n, 'USD')).toBe('$1,250.00');
    expect(formatMoney(3_500_000_000n, 'INR')).toBe('₹3,50,00,000.00');
    expect(formatMoney(1500n, 'JPY')).toBe('JP¥1,500');
  });

  it('formats large values without losing precision', () => {
    expect(formatMoney(999_999_999_999_999n, 'JPY')).toBe('JP¥99,99,99,99,99,99,999');
  });

  it('fills edit forms with a plain amount string that parses back', () => {
    for (const [value, currency] of [
      [12_500_050n, 'INR'],
      [1n, 'INR'],
      [0n, 'USD'],
      [1234n, 'KWD'],
      [1500n, 'JPY'],
    ] as const) {
      const text = toAmountString(value, currency);
      expect(minor(text, currency)).toBe(value);
    }
    expect(toAmountString(12_500_050n, 'INR')).toBe('125000.50');
  });

  it('moneySchema turns { amount, currency } into minor units with field errors', () => {
    expect(moneySchema.parse({ amount: '1,250', currency: 'USD' })).toEqual({
      amountMinor: 125_000n,
      currency: 'USD',
    });
    const bad = moneySchema.safeParse({ amount: '10.5', currency: 'JPY' });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]?.path).toEqual(['amount']);
    const code = moneySchema.safeParse({ amount: '1', currency: 'XYZ' });
    expect(code.error?.issues[0]?.path).toEqual(['currency']);
  });
});
