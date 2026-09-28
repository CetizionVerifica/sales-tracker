import { z } from 'zod';
import {
  calendarDateSchema,
  clearable,
  idOnlySchema,
  optionalText,
  todayInIST,
  withId,
} from './common.ts';
import { flag, listParamsSchema, multi } from './list-params.ts';

export const ENQUIRY_STATUSES = ['IN_PROGRESS', 'CONVERTED', 'LOST'] as const;
export const ENQUIRY_SOURCES = [
  'EMAIL',
  'PHONE',
  'TENDER_PORTAL',
  'REFERRAL',
  'WEBSITE',
  'WALK_IN',
  'OTHER',
] as const;

export const enquiryStatusSchema = z.enum(ENQUIRY_STATUSES);
export const enquirySourceSchema = z.enum(ENQUIRY_SOURCES, 'Choose where the enquiry came from');

export type EnquirySourceValue = (typeof ENQUIRY_SOURCES)[number];
export type EnquiryStatusValue = (typeof ENQUIRY_STATUSES)[number];

/** Sources where the channel alone is not enough to follow up (M4 Decision 10). */
export const SOURCES_NEEDING_DETAIL: ReadonlySet<EnquirySourceValue> = new Set([
  'TENDER_PORTAL',
  'REFERRAL',
  'OTHER',
]);

export const SOURCE_DETAIL_REQUIRED = 'Add the details for this source';
export const PROPOSAL_BEFORE_RECEIVED = 'The proposal cannot be sent before the enquiry arrived';

const notInFuture = (date: Date) => date <= todayInIST();
const pastDate = calendarDateSchema.refine(notInFuture, 'The date cannot be in the future');

const enquiryFields = {
  clientId: z.string().min(1, 'Choose a client'),
  sectorId: z.string().min(1, 'Choose a sector'),
  serviceIds: z
    .array(z.string().min(1))
    .min(1, 'Choose at least one service')
    .max(10, 'Choose at most 10 services')
    .refine((ids) => new Set(ids).size === ids.length, 'Each service can be chosen once'),
  receivedDate: pastDate,
  proposalSentDate: clearable(pastDate),
  source: enquirySourceSchema,
  sourceDetail: optionalText(200),
  description: optionalText(2000),
  /** Admins only (checked in the service); defaults to the creator. */
  ownerId: z.string().min(1).optional(),
};

/** The cross-field rules, shared by create and by the service's check on merged updates. */
export function enquiryRuleIssues(record: {
  receivedDate: Date;
  proposalSentDate?: Date | null | undefined;
  source: EnquirySourceValue;
  sourceDetail?: string | null | undefined;
}): { field: 'proposalSentDate' | 'sourceDetail'; message: string }[] {
  const issues: { field: 'proposalSentDate' | 'sourceDetail'; message: string }[] = [];
  if (record.proposalSentDate && record.proposalSentDate < record.receivedDate) {
    issues.push({ field: 'proposalSentDate', message: PROPOSAL_BEFORE_RECEIVED });
  }
  if (SOURCES_NEEDING_DETAIL.has(record.source) && !record.sourceDetail) {
    issues.push({ field: 'sourceDetail', message: SOURCE_DETAIL_REQUIRED });
  }
  return issues;
}

export const createEnquirySchema = z.object(enquiryFields).superRefine((input, context) => {
  for (const { field, message } of enquiryRuleIssues(input)) {
    context.addIssue({ code: 'custom', path: [field], message });
  }
});

/**
 * No `status` (CLAUDE.md rule 8: status changes go through convert / mark lost) and no
 * `number` (immutable). Unknown keys are stripped. Cross-field rules need the stored
 * record, so the service checks them on the merged values.
 */
export const updateEnquirySchema = z
  .object(enquiryFields)
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const convertEnquirySchema = idOnlySchema.extend({
  proposalSentDate: pastDate.optional(),
});

export const markEnquiryLostSchema = idOnlySchema.extend({
  lostReason: z.string().trim().min(1, 'Say why the enquiry was lost').max(500),
});

export const ENQUIRY_SORTS = [
  'receivedDate',
  'number',
  'proposalSentDate',
  'status',
  'source',
  'client',
  'owner',
  'updatedAt',
] as const;

export const listEnquiriesSchema = listParamsSchema.extend({
  status: multi(ENQUIRY_STATUSES),
  source: multi(ENQUIRY_SOURCES),
  ownerId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  sectorId: z.string().min(1).optional(),
  serviceId: z.string().min(1).optional(),
  receivedFrom: calendarDateSchema.optional(),
  receivedTo: calendarDateSchema.optional(),
  proposalSentFrom: calendarDateSchema.optional(),
  proposalSentTo: calendarDateSchema.optional(),
  recordStatus: z.enum(['live', 'deleted']).default('live'),
  /** M11: in progress, no next step planned, untouched for `staleEnquiryDays`. */
  stale: flag,
  sort: z.enum(ENQUIRY_SORTS).optional(),
});

/**
 * What a converted enquiry hands to the M6 quotation form (M4 Decision 8). The quotation
 * date defaults to the enquiry's proposal sent date (PLAN.md decision).
 */
export const quotationDraftSchema = z.object({
  enquiryId: z.string().min(1),
  enquiryNumber: z.string().min(1),
  clientId: z.string().min(1),
  sectorId: z.string().min(1),
  serviceIds: z.array(z.string().min(1)).min(1),
  ownerId: z.string().min(1),
  quotationDate: z.date(),
});

export type CreateEnquiryInput = z.input<typeof createEnquirySchema>;
export type UpdateEnquiryInput = z.input<typeof updateEnquirySchema>;
export type ConvertEnquiryInput = z.input<typeof convertEnquirySchema>;
export type MarkEnquiryLostInput = z.input<typeof markEnquiryLostSchema>;
export type ListEnquiriesInput = z.input<typeof listEnquiriesSchema>;
export type QuotationDraft = z.output<typeof quotationDraftSchema>;

// Server-action transport shapes.
export const updateEnquiryActionSchema = withId(updateEnquirySchema);
export const enquiryIdActionSchema = idOnlySchema;
