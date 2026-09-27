import { z } from 'zod';

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));

/** Base currency is fixed (CLAUDE.md); it is not part of the editable input. */
export const BASE_CURRENCY = 'INR';

export const updateSettingsSchema = z
  .object({
    companyName: z.string().trim().min(1, 'Enter the company name').max(200),
    defaultInvoiceDueDays: z.coerce
      .number()
      .int('Use whole days')
      .min(0, 'Cannot be negative')
      .max(365, 'At most 365 days'),
    enabledCurrencies: z
      .array(
        z
          .string()
          .regex(/^[A-Z]{3}$/, 'Use 3-letter ISO codes, e.g. USD')
          .refine((code) => ISO_CURRENCIES.has(code), 'Unknown currency code'),
      )
      .min(1)
      .refine((codes) => new Set(codes).size === codes.length, 'Each currency only once')
      .refine((codes) => codes.includes(BASE_CURRENCY), `${BASE_CURRENCY} must stay enabled`),
    /** M7 Decision 6: whether uploaded documents are sent to the Claude API. */
    documentExtractionEnabled: z.boolean().optional(),
  })
  .strict(); // rejects baseCurrency and any other unknown key

export type UpdateSettingsInput = z.input<typeof updateSettingsSchema>;
