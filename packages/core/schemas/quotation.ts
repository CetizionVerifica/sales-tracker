import { z } from 'zod';
import {
  calendarDateSchema,
  clearable,
  idOnlySchema,
  optionalText,
  requiredDay,
  todayInIST,
  withId,
} from './common.ts';
import { flag, listParamsSchema, multi, recordStatusSchema } from './list-params.ts';
import { currencySchema, isIsoCurrency, parseAmount } from './money.ts';

export const QUOTATION_STATUSES = ['SENT', 'UNDER_NEGOTIATION', 'PO_RECEIVED', 'LOST'] as const;
export type QuotationStatusValue = (typeof QUOTATION_STATUSES)[number];

export const NEXT_BEFORE_QUOTATION_DATE = 'The next follow-up cannot be before the quotation date';
export const QUOTATION_BEFORE_ENQUIRY = 'The quotation cannot be dated before the enquiry arrived';

const pastDate = calendarDateSchema.refine(
  (date) => date <= todayInIST(),
  'The date cannot be in the future',
);

const serviceIdsSchema = z
  .array(z.string().min(1))
  .min(1, 'Choose at least one service')
  .max(10, 'Choose at most 10 services')
  .refine((ids) => new Set(ids).size === ids.length, 'Each service can be chosen once');

const quotationFields = {
  quotationDate: pastDate,
  /** A decimal string ("1,25,000.50"); becomes `amountMinor` with `currency`. */
  amount: z.string().trim().min(1, 'Enter the amount'),
  currency: currencySchema,
  sectorId: z.string().min(1, 'Choose a sector'),
  serviceIds: serviceIdsSchema,
  nextFollowUpDate: requiredDay('Enter the next follow-up date'),
  description: optionalText(2000),
  lastFollowUpHighlights: optionalText(1000),
  /** Admins only (checked in the service); defaults to the enquiry's owner. */
  ownerId: z.string().min(1).optional(),
};

type MoneyInput = { amount?: string | undefined; currency?: string | undefined };

/** Reports an amount that doesn't parse in its currency on `amount`. */
function amountParses(input: MoneyInput, context: z.RefinementCtx) {
  // An unknown code is reported on `currency`; Intl would throw on it here.
  if (input.amount === undefined || !input.currency || !isIsoCurrency(input.currency)) return;
  const parsed = parseAmount(input.amount, input.currency);
  if (!parsed.ok) context.addIssue({ code: 'custom', path: ['amount'], message: parsed.message });
}

/** Replaces `amount` with `amountMinor` (M6 Decision 3); runs after `amountParses`. */
function withMinorUnits<T extends MoneyInput>({ amount, ...rest }: T) {
  if (amount === undefined || rest.currency === undefined) return rest;
  const parsed = parseAmount(amount, rest.currency);
  if (!parsed.ok) throw new Error('unreachable: amountParses already rejected this amount');
  return { ...rest, amountMinor: parsed.value };
}

function nextAfterQuotationDate(
  input: { quotationDate?: Date | undefined; nextFollowUpDate?: Date | null | undefined },
  context: z.RefinementCtx,
) {
  if (
    input.quotationDate &&
    input.nextFollowUpDate &&
    input.nextFollowUpDate < input.quotationDate
  ) {
    context.addIssue({
      code: 'custom',
      path: ['nextFollowUpDate'],
      message: NEXT_BEFORE_QUOTATION_DATE,
    });
  }
}

/*
 * Each input has two schemas. The `…FormSchema` validates and keeps `amount` as typed; forms
 * and server actions use it, so the service can parse the same value again (the idea behind
 * calendarDateSchema accepting a Date). The service's schema adds the step to minor units.
 */

/**
 * Always starts SENT. No `clientId` (taken from the enquiry, M6 Decision 6), `status`,
 * `number`, `poReceivedDate` or `lostReason`: strict, so any of them is an error.
 */
export const createQuotationFormSchema = z
  .strictObject({ enquiryId: z.string().min(1, 'Choose the enquiry'), ...quotationFields })
  .superRefine(nextAfterQuotationDate)
  .superRefine(amountParses);

export const createQuotationSchema = createQuotationFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'amount'> & { amountMinor: bigint },
);

/**
 * Every field optional; `''` clears optional ones, `undefined` leaves them (M3 convention).
 * An amount and its currency travel together, so stored minor units are never reinterpreted
 * in another currency. Rules that need the stored record are checked in the service.
 */
export const updateQuotationFormSchema = z
  .strictObject({
    ...quotationFields,
    nextFollowUpDate: clearable(calendarDateSchema),
  })
  .partial()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: 'custom', message: 'Nothing to update' });
    }
    if (input.amount !== undefined && input.currency === undefined) {
      context.addIssue({ code: 'custom', path: ['currency'], message: 'Choose the currency' });
    }
    if (input.currency !== undefined && input.amount === undefined) {
      context.addIssue({ code: 'custom', path: ['amount'], message: 'Enter the amount' });
    }
    nextAfterQuotationDate(input, context);
    amountParses(input, context);
  });

export const updateQuotationSchema = updateQuotationFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'amount'> & { amountMinor?: bigint },
);

/**
 * The only fields a closed (PO received or lost) quotation's form edits; others are dropped.
 * The owner stays changeable, by admins only (M8 Decision 4: a won deal can change hands).
 */
export const closedQuotationFormSchema = z.object({
  description: quotationFields.description,
  lastFollowUpHighlights: quotationFields.lastFollowUpHighlights,
  ownerId: quotationFields.ownerId,
});

export const changeQuotationStatusSchema = z.discriminatedUnion('to', [
  idOnlySchema.extend({
    to: z.literal(['SENT', 'UNDER_NEGOTIATION']),
    nextFollowUpDate: calendarDateSchema.optional(),
  }),
  idOnlySchema.extend({
    to: z.literal('PO_RECEIVED'),
    poReceivedDate: requiredDay('Enter the date the PO was received'),
  }),
  idOnlySchema.extend({
    to: z.literal('LOST'),
    lostReason: z.string().trim().min(1, 'Say why the quotation was lost').max(500),
  }),
]);

export const QUOTATION_SORTS = [
  'quotationDate',
  'number',
  'amount',
  'status',
  'nextFollowUpDate',
  'client',
  'owner',
  'updatedAt',
] as const;

export const listQuotationsSchema = listParamsSchema.extend({
  status: multi(QUOTATION_STATUSES),
  currency: z.preprocess((value) => {
    const list = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(list)) return list;
    const cleaned = list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }, z.array(currencySchema).optional()),
  ownerId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  enquiryId: z.string().min(1).optional(),
  sectorId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  quotationFrom: calendarDateSchema.optional(),
  quotationTo: calendarDateSchema.optional(),
  nextFollowUpFrom: calendarDateSchema.optional(),
  nextFollowUpTo: calendarDateSchema.optional(),
  /** M12 drill-down: won (PO received date) or lost (IST day of the loss) in this range. */
  decidedFrom: calendarDateSchema.optional(),
  decidedTo: calendarDateSchema.optional(),
  /** Active, with a next follow-up date on or before today (Asia/Kolkata). */
  followUpDue: flag,
  /** PO_RECEIVED quotations with (true) or without (false) a live project (M8). */
  hasProject: z
    .union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')])
    .optional(),
  recordStatus: recordStatusSchema,
  sort: z.enum(QUOTATION_SORTS).optional(),
});

/**
 * What a PO_RECEIVED quotation hands to the M8 project form, as M4's quotationDraft does for
 * M6. Revenue is the quotation amount in its own currency.
 */
export const projectDraftSchema = z.object({
  quotationId: z.string().min(1),
  quotationNumber: z.string().min(1),
  clientId: z.string().min(1),
  serviceIds: z.array(z.string().min(1)).min(1),
  ownerId: z.string().min(1),
  revenueMinor: z.bigint(),
  currency: z.string().length(3),
  poReceivedDate: z.date(),
});

export type CreateQuotationInput = z.input<typeof createQuotationSchema>;
export type UpdateQuotationInput = z.input<typeof updateQuotationSchema>;
export type ChangeQuotationStatusInput = z.input<typeof changeQuotationStatusSchema>;
export type ListQuotationsInput = z.input<typeof listQuotationsSchema>;
export type ProjectDraft = z.output<typeof projectDraftSchema>;

// Server-action transport shapes.
export const updateQuotationActionSchema = withId(updateQuotationFormSchema);
export const quotationIdActionSchema = idOnlySchema;
