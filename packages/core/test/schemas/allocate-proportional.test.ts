import { describe, expect, it } from 'vitest';
import { allocateProportional } from '../../schemas/money.ts';

// M12b AC4 (unit): purchase order line splits always sum back to the total, exactly.

describe('allocateProportional', () => {
  it('splits an amount equally, remainder to the earliest parts', () => {
    expect(allocateProportional(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateProportional(99n, [1n, 1n, 1n])).toEqual([33n, 33n, 33n]);
    expect(allocateProportional(0n, [1n, 1n])).toEqual([0n, 0n]);
  });

  it('splits by weight, largest fractional remainder first', () => {
    // Weights 1:2:3 of 100: exact shares 16.67, 33.33, 50 — the largest two remainders
    // (.67, .33 tie broken by index) each get one extra unit.
    const result = allocateProportional(100n, [1n, 2n, 3n]);
    expect(result).toEqual([17n, 33n, 50n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(100n);
  });

  it('always sums back to the total for a range of amounts and weights', () => {
    const weightSets = [
      [1n, 1n],
      [1n, 1n, 1n, 1n, 1n],
      [7n, 1n, 3n],
      [10n, 10n, 10n, 1n],
    ];
    for (const weights of weightSets) {
      for (const total of [0n, 1n, 7n, 12345601n, 999999999n]) {
        const shares = allocateProportional(total, weights);
        expect(shares).toHaveLength(weights.length);
        expect(shares.reduce((a, b) => a + b, 0n)).toBe(total);
        expect(shares.every((s) => s >= 0n)).toBe(true);
      }
    }
  });

  it('falls back to an equal split when every weight is zero', () => {
    expect(allocateProportional(10n, [0n, 0n, 0n])).toEqual(
      allocateProportional(10n, [1n, 1n, 1n]),
    );
  });

  it('handles a negative total by splitting its magnitude and negating', () => {
    expect(allocateProportional(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
  });

  it('an empty weight list allocates nothing', () => {
    expect(allocateProportional(100n, [])).toEqual([]);
  });
});
