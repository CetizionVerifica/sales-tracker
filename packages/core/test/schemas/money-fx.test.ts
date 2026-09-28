import { describe, expect, it } from 'vitest';
import {
  formatInrShort,
  formatRate,
  parseRate,
  RATE_SCALE,
  toInrMinor,
} from '../../schemas/money.ts';

// M12 AC2 (unit): converting to INR never passes through a float, and rounds half up.

const rate = (text: string) => {
  const parsed = parseRate(text);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};

describe('parseRate', () => {
  it.each([
    ['83', 83_000_000n],
    ['83.125', 83_125_000n],
    ['0.000001', 1n],
    [' 1,234.5 ', 1_234_500_000n],
  ])('%s → %s micro-units', (text, micros) => {
    expect(parseRate(text)).toEqual({ ok: true, value: micros });
  });

  it.each(['', 'abc', '0', '0.0000001', '-1', '1.2.3', '10000000000'])('refuses %j', (text) => {
    expect(parseRate(text).ok).toBe(false);
  });

  it('formats back without trailing zeros', () => {
    expect(formatRate(83_125_000n)).toBe('83.125');
    expect(formatRate(83_000_000n)).toBe('83.00');
    expect(formatRate(RATE_SCALE / 1000n)).toBe('0.001');
  });
});

describe('toInrMinor', () => {
  it('converts USD cents at 83.125 to paise', () => {
    // $12,500.00 × 83.125 = ₹10,39,062.50
    expect(toInrMinor(1_250_000n, 'USD', rate('83.125'))).toBe(103_906_250n);
  });

  it('handles currencies with 0 and 3 decimals', () => {
    // ¥1,000 × 0.56 = ₹560.00
    expect(toInrMinor(1_000n, 'JPY', rate('0.56'))).toBe(56_000n);
    // KWD 1.250 × 270.5 = ₹338.125 → ₹338.13 (half up)
    expect(toInrMinor(1_250n, 'KWD', rate('270.5'))).toBe(33_813n);
  });

  it('rounds half up to the paisa, and down below half', () => {
    // $0.01 × 83.125 = ₹0.83125 → 83 paise
    expect(toInrMinor(1n, 'USD', rate('83.125'))).toBe(83n);
    // $0.01 × 0.5 = ₹0.005 → 1 paisa (exactly half)
    expect(toInrMinor(1n, 'USD', rate('0.5'))).toBe(1n);
    // $0.01 × 0.499999 → 0 paise
    expect(toInrMinor(1n, 'USD', rate('0.499999'))).toBe(0n);
  });

  it('is exact beyond 2^53', () => {
    const huge = 9_007_199_254_740_993n; // 2^53 + 1 cents
    expect(toInrMinor(huge, 'USD', rate('83'))).toBe(huge * 83n);
  });

  it('INR converts at 1 to itself', () => {
    expect(toInrMinor(12_345n, 'INR', RATE_SCALE)).toBe(12_345n);
  });
});

describe('formatInrShort (UI guide 4.4 axis and tile style)', () => {
  it.each([
    [0n, '₹0'],
    [95_000n, '₹950'],
    [1_250_000n, '₹12.5K'],
    [1_200_000n, '₹12K'],
    [125_000_000n, '₹12.5L'],
    [1_000_000_000n, '₹1Cr'],
    [1_240_000_000n, '₹1.2Cr'],
    [1_250_000_000n, '₹1.3Cr'],
    [3_500_000_000_000n, '₹3,500Cr'],
    [-125_000_000n, '−₹12.5L'],
  ])('%s paise → %s', (paise, text) => {
    expect(formatInrShort(paise)).toBe(text);
  });
});
