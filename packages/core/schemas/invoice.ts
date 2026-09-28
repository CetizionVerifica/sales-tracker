import { z } from 'zod';
import { AGEING_BUCKETS } from './dashboard.ts';
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
import { currencySchema } from './money.ts';

export const INVOICE_STATUSES = ['PENDING', 'PAID', 'OVERDUE'] as const;
export type InvoiceStatusValue = (typeof INVOICE_STATUSES)[number];

export const DUE_DATE_BASES = ['PO_TERMS', 'COMPANY_DEFAULT', 'MANUAL'] as const;
export type DueDateBasisValue = (typeof DUE_DATE_BASES)[number];

export const INVOICE_NUMBER_MAX = 64;
export const PAYMENT_REFERENCE_MAX = 200;
export const UNPAID_REASON_MAX = 500;

/**
 * Our invoice number as the accounting system issued it (Decision 2): trimmed, inner
 * whitespace collapsed to one space, 1–64 characters. Stored as typed; compared ignoring case.
 */
const invoiceNumberSchema = z
  .string()
  .transform((value) => value.trim().replace(/\s+/g, ' '))
  .pipe(
    z
      .string()
      .min(1, 'Enter the invoice number')
      .max(INVOICE_NUMBER_MAX, `An invoice number has at most ${INVOICE_NUMBER_MAX} characters`),
  );

// Digits with optional grouping commas and decimals. The currency is the PO's and not part
// of the input (Decision 3), so the service converts to minor units and checks decimals.
const AMOUNT_TEXT = /^\d[\d,]*(\.\d+)?$/;

/**
 * The invoice total as typed ("5,90,000"). It becomes `amountMinor` in the service, in the
 * PO's currency; here it only has to look like a number above zero.
 */
const amountSchema = z
  .string()
  .trim()
  .min(1, 'Enter the amount')
  .refine((value) => AMOUNT_TEXT.test(value), 'Enter an amount, e.g. 125000.50')
  .refine(
    (value) => !AMOUNT_TEXT.test(value) || /[1-9]/.test(value),
    'The amount must be more than zero',
  );

const invoiceFields = {
  invoiceNumber: invoiceNumberSchema,
  invoiceDate: requiredDay('Enter the invoice date').refine(
    (date) => date <= todayInIST(),
    'The invoice date cannot be in the future',
  ),
  /** One of the PO's services (Decision 4). */
  serviceId: z.string().min(1, 'Choose the service'),
  amount: amountSchema,
  paymentReference: optionalText(PAYMENT_REFERENCE_MAX),
  description: optionalText(2000),
};

type DatePair = { invoiceDate?: Date | undefined; dueDate?: Date | null | undefined };

function dueNotBeforeInvoice(input: DatePair, context: z.RefinementCtx) {
  if (input.invoiceDate && input.dueDate && input.dueDate < input.invoiceDate) {
    context.addIssue({
      code: 'custom',
      path: ['dueDate'],
      message: 'The due date cannot be before the invoice date',
    });
  }
}

/*
 * Unlike PO and quotation schemas there is one schema per input, not a form/service pair:
 * the currency is the PO's (Decision 3), so `amount` stays a string here and the service
 * converts it with the PO's currency. The `…FormSchema` names are kept for the review
 * screen and forms, as aliases.
 */

/**
 * No `clientId` or `currency` (the PO's, Decisions 1 and 3), `status` (the machine's),
 * `dueDateBasis` (derived from whether a due date is typed) or `documentId` (the upload's):
 * strict, so any of them is an error. `dueDate` omitted → the default (Decision 6). `paidAt`
 * records an invoice that is already paid (back-entry, M13 import).
 */
export const createInvoiceSchema = z
  .strictObject({
    purchaseOrderId: z.string().min(1, 'Choose the purchase order'),
    ...invoiceFields,
    dueDate: z
      .preprocess((value) => (value === '' ? undefined : value), calendarDateSchema)
      .optional(),
    paidAt: z
      .preprocess((value) => (value === '' ? undefined : value), calendarDateSchema)
      .refine((date) => date <= todayInIST(), 'The paid date cannot be in the future')
      .optional(),
  })
  .superRefine((input, context) => {
    dueNotBeforeInvoice(input, context);
    if (input.paidAt && input.paidAt < input.invoiceDate) {
      context.addIssue({
        code: 'custom',
        path: ['paidAt'],
        message: 'The paid date cannot be before the invoice date',
      });
    }
  });

export const createInvoiceFormSchema = createInvoiceSchema;

/**
 * Every field optional; `''` clears optional text, `undefined` leaves a field alone (M3
 * convention). `dueDate: ''` (or null) puts the due date back on its default. No
 * `purchaseOrderId` (an invoice does not move), no `paidAt` (Mark paid sets it) and nothing
 * derived.
 */
export const updateInvoiceSchema = z
  .strictObject({
    ...invoiceFields,
    dueDate: z
      .union([z.literal('').transform(() => null), z.null(), calendarDateSchema])
      .optional(),
  })
  .partial()
  .superRefine((input, context) => {
    if (Object.keys(input).length === 0) {
      context.addIssue({ code: 'custom', message: 'Nothing to update' });
    }
    dueNotBeforeInvoice(input, context);
  });

export const updateInvoiceFormSchema = updateInvoiceSchema;

/** Mark paid (Decision 14): the paid date is checked against the invoice date in the machine. */
export const markInvoicePaidSchema = z.strictObject({
  id: z.string().min(1),
  paidAt: requiredDay('Enter the date the payment was received').refine(
    (date) => date <= todayInIST(),
    'The paid date cannot be in the future',
  ),
  paymentReference: optionalText(PAYMENT_REFERENCE_MAX),
});

/** Mark unpaid (admins, Decision 8): the reason is kept on the invoice and in its audit row. */
export const markInvoiceUnpaidSchema = z.strictObject({
  id: z.string().min(1),
  reason: z
    .string()
    .trim()
    .min(1, 'Say why the payment is being reversed')
    .max(UNPAID_REASON_MAX, `At most ${UNPAID_REASON_MAX} characters`),
});

export const INVOICE_SORTS = [
  'invoiceDate',
  'dueDate',
  'invoiceNumber',
  'client',
  'amount',
  'status',
  'paidAt',
  'createdAt',
  'updatedAt',
] as const;

/** Due windows for the list and the summary chips (unpaid invoices only). */
export const INVOICE_DUE_WINDOWS = ['overdue', 'next7', 'next30'] as const;
export type InvoiceDueWindow = (typeof INVOICE_DUE_WINDOWS)[number];

export const listInvoicesSchema = listParamsSchema.extend({
  status: multi(INVOICE_STATUSES),
  purchaseOrderId: z.string().min(1).optional(),
  projectId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  /** The project's manager; `none` lists invoices on unassigned projects. */
  managerId: z.string().min(1).optional(),
  /** The pipeline owner (the quotation's owner; admins only, checked in the service). */
  ownerId: z.string().min(1).optional(),
  currency: z.preprocess((value) => {
    const list = typeof value === 'string' ? value.split(',') : value;
    if (!Array.isArray(list)) return list;
    const cleaned = list.map((v) => String(v).trim().toUpperCase()).filter(Boolean);
    return cleaned.length ? cleaned : undefined;
  }, z.array(currencySchema).optional()),
  invoiceFrom: calendarDateSchema.optional(),
  invoiceTo: calendarDateSchema.optional(),
  dueFrom: calendarDateSchema.optional(),
  dueTo: calendarDateSchema.optional(),
  /** Unpaid invoices overdue, or due from today to +7 / +30 days. */
  due: z.enum(INVOICE_DUE_WINDOWS).optional(),
  /** M12 drill-down: an ageing bucket of the dashboard's receivables panel. */
  ageing: z.enum(AGEING_BUCKETS).optional(),
  document: z.enum(DOCUMENT_STATES).optional(),
  recordStatus: recordStatusSchema,
  sort: z.enum(INVOICE_SORTS).optional(),
});

/** What the create form starts from (getInvoiceDraft). */
export interface InvoiceDraft {
  purchaseOrderId: string;
  poNumber: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  clientId: string;
  clientName: string;
  /** For the pipeline strip. */
  quotationId: string;
  enquiryId: string;
  currency: string;
  /** The PO's services; `serviceId` is set when there is exactly one. */
  services: { id: string; name: string }[];
  serviceId: string | null;
  /** The PO amount minus live invoices; null when nothing is left. */
  amountMinor: bigint | null;
  poAmountMinor: bigint;
  invoicedMinor: bigint;
  invoiceDate: Date;
  dueDate: Date;
  dueDateBasis: 'PO_TERMS' | 'COMPANY_DEFAULT';
  /** The PO's net days, or null when it has none (then `companyDefaultDays` applies). */
  poPaymentTermsDays: number | null;
  companyDefaultDays: number;
  /** "Net 45 from PO 4500012345" or "Company default, 30 days". */
  dueDateHint: string;
}

/** The hint under the due date, shared by the form and the draft. */
export function dueDateHint(
  basis: DueDateBasisValue,
  input: { poNumber: string; poPaymentTermsDays: number | null; companyDefaultDays: number },
): string {
  if (basis === 'MANUAL') return 'Custom due date';
  if (basis === 'PO_TERMS') return `Net ${input.poPaymentTermsDays} from PO ${input.poNumber}`;
  return `Company default, ${input.companyDefaultDays} days`;
}

/** The new-invoice page's PO picker: live POs, searched by text. */
export const searchInvoicePurchaseOrdersSchema = z.object({ q: z.string().trim().max(100) });

export type CreateInvoiceInput = z.input<typeof createInvoiceSchema>;
export type UpdateInvoiceInput = z.input<typeof updateInvoiceSchema>;
export type MarkInvoicePaidInput = z.input<typeof markInvoicePaidSchema>;
export type MarkInvoiceUnpaidInput = z.input<typeof markInvoiceUnpaidSchema>;
export type ListInvoicesInput = z.input<typeof listInvoicesSchema>;

// Server-action transport shapes.
export const updateInvoiceActionSchema = withId(updateInvoiceSchema);
export const invoiceIdActionSchema = idOnlySchema;
