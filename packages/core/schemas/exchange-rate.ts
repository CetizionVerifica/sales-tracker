import { z } from 'zod';
import { currencySchema, parseRate } from './money.ts';

/*
 * Monthly exchange rates (M12 Decision 1): INR per one unit of a currency, entered by
 * admins. A rate is a decimal string with at most six decimals, kept as micro-units.
 */

/** `"2026-09"` → the first day of that month (UTC midnight). */
export const rateMonthSchema = z
  .string()
  .trim()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month, e.g. 2026-09')
  .transform((month) => new Date(`${month}-01T00:00:00.000Z`));

/** `"83.125"` → `83_125_000n` micro-units. */
export const rateSchema = z.string().transform((text, context) => {
  const parsed = parseRate(text);
  if (!parsed.ok) {
    context.addIssue({ code: 'custom', message: parsed.message });
    return z.NEVER;
  }
  return parsed.value;
});

/** What the form sends (and actions pass through): strings, validated but not converted. */
export const exchangeRateFormSchema = z
  .object({
    currency: currencySchema.refine((code) => code !== 'INR', 'INR needs no exchange rate'),
    month: z
      .string()
      .trim()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Choose a month, e.g. 2026-09'),
    rate: z.string().superRefine((text, context) => {
      const parsed = parseRate(text);
      if (!parsed.ok) context.addIssue({ code: 'custom', message: parsed.message });
    }),
  })
  .strict();

export const createExchangeRateSchema = z
  .object({
    currency: exchangeRateFormSchema.shape.currency,
    month: rateMonthSchema,
    rate: rateSchema,
  })
  .strict();

export const exchangeRateEditSchema = exchangeRateFormSchema.pick({ rate: true });
export const updateExchangeRateSchema = z.object({ rate: rateSchema }).strict();

export const listExchangeRatesSchema = z
  .object({ currency: z.string().trim().toUpperCase().optional() })
  .strict();

export type CreateExchangeRateInput = z.input<typeof createExchangeRateSchema>;
export type UpdateExchangeRateInput = z.input<typeof updateExchangeRateSchema>;
export type ListExchangeRatesInput = z.input<typeof listExchangeRatesSchema>;

/** A rate as the UI and exports show it. */
export interface ExchangeRateRow {
  id: string;
  currency: string;
  /** `YYYY-MM`. */
  month: string;
  /** `"83.125"`, at least two decimals. */
  rate: string;
  /** Records whose stored INR value was converted in this currency and month. */
  recordCount: number;
  /** Of those, how many were converted at a different rate (Recalculate would change them). */
  staleCount: number;
  updatedAt: Date;
}

// Server-action transport shapes.
export const exchangeRateIdActionSchema = z.object({ id: z.string().min(1) }).strict();
export const updateExchangeRateActionSchema = z
  .object({ id: z.string().min(1), data: exchangeRateEditSchema })
  .strict();
