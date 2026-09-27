import { z } from 'zod';
import { listParamsSchema, multi, recordStatusSchema } from './list-params.ts';
import { updateQuotationFormSchema } from './quotation.ts';

/** Every kind exists in the enum now; the service accepts only shipped ones (M7 spec). */
export const DOCUMENT_KINDS = ['QUOTATION', 'PURCHASE_ORDER', 'INVOICE'] as const;
export type DocumentKindValue = (typeof DOCUMENT_KINDS)[number];

export const EXTRACTION_STATUSES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'SKIPPED'] as const;
export type ExtractionStatusValue = (typeof EXTRACTION_STATUSES)[number];

export const REVIEW_STATUSES = ['PENDING', 'CONFIRMED'] as const;
export type ReviewStatusValue = (typeof REVIEW_STATUSES)[number];

/** The file types a document may be; the service also checks the bytes match. */
export const DOCUMENT_MIME_TYPES = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
] as const;
export type DocumentMimeType = (typeof DOCUMENT_MIME_TYPES)[number];

export const uploadDocumentSchema = z.strictObject({
  kind: z.enum(DOCUMENT_KINDS, 'Choose what the document is for'),
  entityId: z.string().min(1, 'Choose the record'),
});

export type UploadDocumentInput = z.input<typeof uploadDocumentSchema>;

/** The file part of an upload, checked in the service (size limit comes from env). */
export interface UploadedFile {
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
}

/**
 * What the reviewer ticked, with the values as they left them. Keys are the record's own
 * field names (e.g. `amount`, `currency`, `quotationDate`); the service accepts only the
 * kind's mapped fields and validates the values with the record's own update schema.
 */
export const confirmExtractionSchema = z.strictObject({
  documentId: z.string().min(1),
  apply: z.record(z.string().min(1), z.string().max(4000).nullable()).default({}),
});

export type ConfirmExtractionInput = z.input<typeof confirmExtractionSchema>;

export const documentIdSchema = z.strictObject({ id: z.string().min(1) });

export const listDocumentsSchema = listParamsSchema.extend({
  kind: multi(DOCUMENT_KINDS),
  entityId: z.string().min(1).optional(),
  clientId: z.string().min(1).optional(),
  uploadedById: z.string().min(1).optional(),
  extractionStatus: multi(EXTRACTION_STATUSES),
  reviewStatus: multi(REVIEW_STATUSES),
  recordStatus: recordStatusSchema,
});

export type ListDocumentsInput = z.input<typeof listDocumentsSchema>;

/**
 * The review form (M7): each value as the reviewer left it, keyed by the record's field
 * name, and which review rows are ticked. Ticked values are checked with the record's own
 * form schema (for quotations, `updateQuotationFormSchema`), so the review screen shows the
 * same field errors as the record's edit form before anything is sent.
 */
export function reviewExtractionFormSchema(
  kind: DocumentKindValue,
  rows: readonly { name: string; applies: readonly string[] }[],
) {
  const recordSchema = REVIEW_RECORD_SCHEMAS[kind];
  return z
    .object({
      values: z.record(z.string(), z.string().max(4000)),
      ticked: z.record(z.string(), z.boolean()),
    })
    .superRefine((form, context) => {
      const apply: Record<string, string> = {};
      for (const row of rows) {
        if (!form.ticked[row.name]) continue;
        for (const field of row.applies) apply[field] = form.values[field] ?? '';
      }
      if (!recordSchema || Object.keys(apply).length === 0) return;
      const parsed = recordSchema.safeParse(apply);
      if (parsed.success) return;
      for (const issue of parsed.error.issues) {
        const field = String(issue.path[0] ?? '');
        if (field in apply) {
          context.addIssue({ code: 'custom', path: ['values', field], message: issue.message });
        }
      }
    });
}

export type ReviewExtractionFormValues = z.infer<ReturnType<typeof reviewExtractionFormSchema>>;

/** The record form schema that validates applied values, per kind (M9/M10 add theirs). */
const REVIEW_RECORD_SCHEMAS: Partial<Record<DocumentKindValue, z.ZodType>> = {
  QUOTATION: updateQuotationFormSchema,
};
