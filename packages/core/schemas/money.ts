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
