import { z } from 'zod';
import {
  calendarDateSchema,
  idOnlySchema,
  optionalText,
  requiredDay,
  todayInIST,
  withId,
} from './common.ts';
import { DOCUMENT_STATES } from './document-state.ts';
import { listParamsSchema, multi, recordStatusSchema } from './list-params.ts';
import { currencySchema, isIsoCurrency, parseAmount } from './money.ts';

export const PURCHASE_ORDER_STATUSES = ['PENDING', 'PAID', 'OVERDUE'] as const;
export type PurchaseOrderStatusValue = (typeof PURCHASE_ORDER_STATUSES)[number];

export const PO_NUMBER_MAX = 64;
export const PAYMENT_TERMS_MAX = 500;

/**
 * The client's PO number as printed (Decision 2): trimmed, inner whitespace collapsed to one
 * space, 1–64 characters. Stored as typed; compared ignoring case.
 */
const poNumberSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter the PO number')
      .max(PO_NUMBER_MAX, `A PO number has at most ${PO_NUMBER_MAX} characters`),
  );

const serviceIdsSchema = z
  .array(z.string().min(1))
  .min(1, 'Choose at least one service')
  .max(10, 'Choose at most 10 services')
  .refine((ids) => new Set(ids).size === ids.length, 'Each service can be chosen once');

/**
 * How the PO amount splits across its services (M12b schema change 1): required with more
 * than one service, ignored with one (the service always gets one line for the full amount).
 * Amounts are parsed and checked to sum to the PO amount in `purchase-order-lines.ts`, where
 * the currency is known.
 */
const linesSchema = z
  .array(
    z.strictObject({
      serviceId: z.string().min(1),
      amount: z.string().trim().min(1, 'Enter the amount'),
    }),
  )
  .max(10)
  .optional();

const NET_DAYS_MESSAGE = 'Enter net days as a whole number from 0 to 365';

/**
 * Net days (Decision 7): a whole number 0–365, typed or read from a document as a string.
 * `undefined` = not given, `''` or `null` = none (clears it on update).
 */
const netDaysSchema = z.unknown().transform((value, context): number | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const text =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  const days = /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN;
  if (!(days >= 0 && days <= 365)) {
    context.addIssue({ code: 'custom', message: NET_DAYS_MESSAGE });
    return z.NEVER;
  }
  return days;
});

const purchaseOrderFields = {
  poNumber: poNumberSchema,
  /** When the PO reached us, not the date printed on it (Decision 12). */
  receivedDate: requiredDay('Enter the date the PO was received').refine(
    (date) => date <= todayInIST(),
    'The received date cannot be in the future',
  ),
  /** A decimal string ("12,50,000"); becomes `amountMinor` with `currency`. */
  amount: z.string().trim().min(1, 'Enter the amount'),
  currency: currencySchema,
  serviceIds: serviceIdsSchema,
  lines: linesSchema,
  paymentTerms: optionalText(PAYMENT_TERMS_MAX),
  paymentTermsDays: netDaysSchema.optional(),
  description: optionalText(2000),
};

type MoneyInput = { amount?: string | undefined; currency?: string | undefined };

/** Reports an amount that doesn't parse in its currency, or is not above zero, on `amount`. */
function amountParses(input: MoneyInput, context: z.RefinementCtx) {
  // An unknown code is reported on `currency`; Intl would throw on it here.
  if (input.amount === undefined || !input.currency || !isIsoCurrency(input.currency)) return;
  const parsed = parseAmount(input.amount, input.currency);
  if (!parsed.ok) {
    context.addIssue({ code: 'custom', path: ['amount'], message: parsed.message });
  } else if (parsed.value <= 0n) {
    context.addIssue({
      code: 'custom',
      path: ['amount'],
      message: 'The amount must be more than zero',
    });
  }
}

/** Replaces `amount` with `amountMinor` (M6 Decision 3); runs after `amountParses`. */
function withMinorUnits<T extends MoneyInput>({ amount, ...rest }: T) {
  if (amount === undefined || rest.currency === undefined) return rest;
  const parsed = parseAmount(amount, rest.currency);
  if (!parsed.ok) throw new Error('unreachable: amountParses already rejected this amount');
  return { ...rest, amountMinor: parsed.value };
}

/*
 * Two schemas per input, as M6 and M8: the `…FormSchema` keeps `amount` as typed (forms,
 * server actions and the review screen), the service schema converts it to minor units.
 */

/**
 * Always starts PENDING. No `clientId` (the project's, Decision 1), `status` (derived,
 * Decision 4), `statusChangedAt` or `documentId` (the M7 upload sets it): strict, so any of
 * them is an error.
 */
export const createPurchaseOrderFormSchema = z
  .strictObject({
    projectId: z.string().min(1, 'Choose the project'),
    ...purchaseOrderFields,
  })
  .superRefine(amountParses);

export const createPurchaseOrderSchema = createPurchaseOrderFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'amount'> & { amountMinor: bigint },
);

/**
 * Every field optional; `''` clears optional ones, `undefined` leaves them (M3 convention).
 * No `projectId` (a PO does not move between projects) and nothing derived. An amount and
 * its currency travel together (M6).
 */
export const updatePurchaseOrderFormSchema = z
  .strictObject(purchaseOrderFields)
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
    amountParses(input, context);
  });

export const updatePurchaseOrderSchema = updatePurchaseOrderFormSchema.transform(
  (input) => withMinorUnits(input) as Omit<typeof input, 'amount'> & { amountMinor?: bigint },
);

export const PURCHASE_ORDER_SORTS = [
  'receivedDate',
  'poNumber',
  'client',
  'project',
  'amount',
  'status',
  'createdAt',
  'updatedAt',
] as const;

export const listPurchaseOrdersSchema = listParamsSchema.extend({
  status: multi(PURCHASE_ORDER_STATUSES),
  projectId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  /** The project's manager; `none` lists POs on unassigned projects. */
  managerId: z.string().min(1).optional(),
  /** The pipeline owner (the quotation's owner; admins only, checked in the service). */
  ownerId: z.string().min(1).optional(),
  currency: z.preprocess((value) => {
    const list = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(list)) return list;
    const cleaned = list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }, z.array(currencySchema).optional()),
  receivedFrom: calendarDateSchema.optional(),
  receivedTo: calendarDateSchema.optional(),
  /** Where the PO's current document is (none, reading, to review, reviewed, not read). */
  document: z.enum(DOCUMENT_STATES).optional(),
  recordStatus: recordStatusSchema,
  sort: z.enum(PURCHASE_ORDER_SORTS).optional(),
});

/** What the create form starts from (getPurchaseOrderDraft). */
export interface PurchaseOrderDraft {
  projectId: string;
  projectNumber: string;
  projectName: string;
  clientId: string;
  clientName: string;
  /** For the pipeline strip and "From QUO-…" helper text. */
  quotationId: string;
  quotationNumber: string;
  enquiryId: string;
  /** The project's services; all are ticked by default. */
  services: { id: string; name: string }[];
  serviceIds: string[];
  currency: string;
  /** Revenue minus the live POs in the project currency; null when nothing is left, or when
   * the project has POs in other currencies (then the amount is left blank). */
  amountMinor: bigint | null;
  revenueMinor: bigint;
  /** Live POs in the project currency. */
  coveredMinor: bigint;
  /** The project has live POs in another currency. */
  otherCurrencies: boolean;
  receivedDate: Date;
  /** The quotation's PO received date for the first PO, otherwise today (Decision 12). */
  receivedDateFrom: 'quotation' | 'today';
}

/** The new-PO page's project picker: projects that take POs, searched by text. */
export const searchPoProjectsSchema = z.object({ q: z.string().trim().max(100) });

export type CreatePurchaseOrderInput = z.input<typeof createPurchaseOrderSchema>;
export type UpdatePurchaseOrderInput = z.input<typeof updatePurchaseOrderSchema>;
export type ListPurchaseOrdersInput = z.input<typeof listPurchaseOrdersSchema>;

// Server-action transport shapes.
export const updatePurchaseOrderActionSchema = withId(updatePurchaseOrderFormSchema);
export const purchaseOrderIdActionSchema = idOnlySchema;
