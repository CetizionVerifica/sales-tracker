import { z } from 'zod';

/**
 * Money is integer minor units (`bigint`) plus an ISO 4217 code (CLAUDE.md rule 5, M6
 * Decision 3). Amounts typed by people are parsed by splitting the string, never through
 * `Number` or `parseFloat`, so no value ever passes through a float. M9 and M10 reuse this.
 */

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** At most 15 integer digits: ₹999 lakh crore, far beyond any quotation. */
const MAX_INTEGER_DIGITS = 15;

const AMOUNT = /^(\d+)(?:\.(\d+))?$/;

export function isIsoCurrency(code: string): boolean {
  return /^[A-Z]{3}$/.test(code) && ISO_CURRENCIES.has(code);
}

/** How many minor-unit digits a currency has: INR/USD 2, JPY 0, KWD 3. */
export function currencyFractionDigits(currency: string): number {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).resolvedOptions()
    .maximumFractionDigits!;
}

export type ParsedAmount = { ok: true; value: bigint } | { ok: false; message: string };

/** `"1,25,000.50"` INR → `12500050n`. Commas and surrounding spaces are ignored. */
export function parseAmount(amount: string, currency: string): ParsedAmount {
  const match = AMOUNT.exec(amount.trim().replaceAll(',', ''));
  if (!match) return { ok: false, message: 'Enter an amount, e.g. 125000.50' };
  const [, whole, fraction = ''] = match as unknown as [string, string, string | undefined];
  const digits = currencyFractionDigits(currency);
  if (fraction.length > digits) {
    return {
      ok: false,
      message:
        digits === 0
          ? `${currency} amounts have no decimals`
          : `${currency} amounts have at most ${digits} decimals`,
    };
  }
  if (whole.replace(/^0+(?=\d)/, '').length > MAX_INTEGER_DIGITS) {
    return { ok: false, message: 'The amount is too large' };
  }
  const scale = 10n ** BigInt(digits);
  return { ok: true, value: BigInt(whole) * scale + BigInt(fraction.padEnd(digits, '0') || '0') };
}

/** `12500050n` INR → `"125000.50"`: the plain form an edit field starts from. */
export function toAmountString(amountMinor: bigint, currency: string): string {
  const digits = currencyFractionDigits(currency);
  const negative = amountMinor < 0n;
  const text = (negative ? -amountMinor : amountMinor).toString().padStart(digits + 1, '0');
  const whole = text.slice(0, text.length - digits);
  const fraction = digits > 0 ? `.${text.slice(-digits)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** `12500050n` INR → `"₹1,25,000.50"` (Intl formats the exact decimal string). */
export function formatMoney(amountMinor: bigint, currency: string): string {
  const decimal = toAmountString(amountMinor, currency) as Intl.StringNumericLiteral;
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(decimal);
}

export const currencySchema = z
  .string()
  .trim()
  .refine(isIsoCurrency, 'Choose a currency, e.g. INR');

/** `{ amount: "1,250", currency: "USD" }` → `{ amountMinor: 125000n, currency: "USD" }`. */
export const moneySchema = z
  .object({ amount: z.string(), currency: currencySchema })
  .transform(({ amount, currency }, context) => {
    const parsed = parseAmount(amount, currency);
    if (!parsed.ok) {
      context.addIssue({ code: 'custom', path: ['amount'], message: parsed.message });
      return z.NEVER;
    }
    return { amountMinor: parsed.value, currency };
  });

// ─── M12: exchange rates and INR equivalents ────────────────────────────────────

/**
 * Exchange rates are exact decimals (Postgres `Decimal(14, 6)`), handled in TypeScript as
 * micro-units in a `bigint`: 83.125 → 83_125_000n. Like amounts, never a float.
 */
export const RATE_SCALE = 1_000_000n;
const RATE_DECIMALS = 6;
/** Decimal(14, 6) leaves 8 integer digits. */
const RATE_MAX_INTEGER_DIGITS = 8;

/** `"83.125"` → `83_125_000n`. Commas and surrounding spaces are ignored; must be > 0. */
export function parseRate(text: string): ParsedAmount {
  const match = AMOUNT.exec(text.trim().replaceAll(',', ''));
  if (!match) return { ok: false, message: 'Enter a rate, e.g. 83.25' };
  const [, whole, fraction = ''] = match as unknown as [string, string, string | undefined];
  if (fraction.length > RATE_DECIMALS) {
    return { ok: false, message: `A rate has at most ${RATE_DECIMALS} decimals` };
  }
  if (whole.replace(/^0+(?=\d)/, '').length > RATE_MAX_INTEGER_DIGITS) {
    return { ok: false, message: 'The rate is too large' };
  }
  const value = BigInt(whole) * RATE_SCALE + BigInt(fraction.padEnd(RATE_DECIMALS, '0'));
  if (value <= 0n) return { ok: false, message: 'The rate must be more than 0' };
  return { ok: true, value };
}

/** `83_125_000n` → `"83.125"`; at least two decimals (`"83.00"`). */
export function formatRate(micros: bigint): string {
  const whole = micros / RATE_SCALE;
  const fraction = (micros % RATE_SCALE)
    .toString()
    .padStart(RATE_DECIMALS, '0')
    .replace(/0+$/, '')
    .padEnd(2, '0');
  return `${whole}.${fraction}`;
}

/** A Prisma `Decimal` (or its string) as rate micro-units, without passing through a float. */
export function rateFromDecimal(value: { toString(): string } | string): bigint {
  const parsed = parseRate(value.toString());
  if (!parsed.ok) throw new Error(`Invalid stored rate ${value.toString()}`);
  return parsed.value;
}

/** Rate micro-units as the string Prisma writes to a `Decimal` column. */
export const rateToDecimalString = (micros: bigint) =>
  `${micros / RATE_SCALE}.${(micros % RATE_SCALE).toString().padStart(RATE_DECIMALS, '0')}`;

/** a ÷ b for positive-or-negative a and positive b, rounded half away from zero. */
function divideRounded(a: bigint, b: bigint): bigint {
  const negative = a < 0n;
  const abs = negative ? -a : a;
  const quotient = abs / b + ((abs % b) * 2n >= b ? 1n : 0n);
  return negative ? -quotient : quotient;
}

/**
 * An amount in `currency` minor units → INR paise at `rateMicros` INR per unit, rounded
 * half up to the paisa (M12). Exact for any size: all `bigint`.
 */
export function toInrMinor(amountMinor: bigint, currency: string, rateMicros: bigint): bigint {
  const scale = 10n ** BigInt(currencyFractionDigits(currency));
  // paise = amount / scale × rate / RATE_SCALE × 100
  return divideRounded(amountMinor * rateMicros * 100n, scale * RATE_SCALE);
}

// ─── M12b: splitting a total across parts (purchase order lines) ───────────────────

/**
 * `total` split across `weights` in proportion, each part an integer minor unit summing back
 * to exactly `total` (largest-remainder method: floor every share, then give the leftover
 * units, one each, to the parts with the largest dropped fraction, ties broken by index for a
 * deterministic result). An equal split is `allocateProportional(total, weights.map(() => 1n))`.
 * All-zero weights fall back to an equal split, since there is nothing else to divide by.
 */
export function allocateProportional(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.length === 0) return [];
  const sumWeights = weights.reduce((a, b) => a + b, 0n);
  if (sumWeights === 0n) {
    return allocateProportional(
      total,
      weights.map(() => 1n),
    );
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const shares = weights.map((w) => (abs * w) / sumWeights);
  const remainder = abs - shares.reduce((a, b) => a + b, 0n);
  const order = weights
    .map((w, i) => ({ i, frac: (abs * w) % sumWeights }))
    .sort((a, b) => (b.frac > a.frac ? 1 : b.frac < a.frac ? -1 : a.i - b.i));
  for (let k = 0; BigInt(k) < remainder; k++) shares[order[k]!.i]! += 1n;
  return negative ? shares.map((v) => -v) : shares;
}

const SHORT_UNITS = [
  { paise: 1_000_000_000n, suffix: 'Cr' }, // ₹1,00,00,000
  { paise: 10_000_000n, suffix: 'L' }, // ₹1,00,000
  { paise: 100_000n, suffix: 'K' }, // ₹1,000
] as const;

/**
 * INR paise in the short Indian style for chart axes and KPI tiles (UI guide 4.4): `₹950`,
 * `₹12.5K`, `₹12.5L`, `₹1.2Cr`. One decimal, rounded half up, dropped when zero. Full values
 * use `formatMoney`.
 */
export function formatInrShort(paise: bigint): string {
  const negative = paise < 0n;
  const abs = negative ? -paise : paise;
  const unit = SHORT_UNITS.find((u) => abs >= u.paise);
  let text: string;
  if (!unit) {
    text = new Intl.NumberFormat('en-IN').format(divideRounded(abs, 100n));
  } else {
    const tenths = divideRounded(abs * 10n, unit.paise);
    const whole = new Intl.NumberFormat('en-IN').format(tenths / 10n);
    text = `${whole}${tenths % 10n ? `.${tenths % 10n}` : ''}${unit.suffix}`;
  }
  return `${negative ? '−' : ''}₹${text}`;
}
