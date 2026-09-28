import { z } from 'zod';
import { idOnlySchema } from './common.ts';
import { enquirySourceSchema } from './enquiry.ts';
import { listParamsSchema, multi } from './list-params.ts';

// Mirrors the Prisma enums in packages/db/prisma/schema.prisma. Phase 1 (M10b) ships a
// single entity; adding another later extends this list, not its shape.
export const IMPORT_ENTITIES = ['ENQUIRY'] as const;
export type ImportEntityValue = (typeof IMPORT_ENTITIES)[number];
export const importEntitySchema = z.enum(IMPORT_ENTITIES);

export const IMPORT_BATCH_STATUSES = [
  'UPLOADED',
  'PARSING',
  'MAPPING',
  'VALIDATING',
  'READY',
  'COMMITTING',
  'COMMITTED',
  'FAILED',
  'UNDONE',
  'EXPIRED',
] as const;
export type ImportBatchStatusValue = (typeof IMPORT_BATCH_STATUSES)[number];
export const importBatchStatusSchema = z.enum(IMPORT_BATCH_STATUSES);

export const IMPORT_ROW_STATUSES = ['READY', 'WARNING', 'ERROR', 'DUPLICATE', 'EXCLUDED'] as const;
export type ImportRowStatusValue = (typeof IMPORT_ROW_STATUSES)[number];
export const importRowStatusSchema = z.enum(IMPORT_ROW_STATUSES);

/**
 * The Enquiry field catalog (M10b phase 1: single entity, so this is the whole catalog for
 * now — `suggest/field-catalog.ts` adds labels/synonyms/examples on top of these keys).
 */
export const IMPORT_FIELDS = [
  'client',
  'sector',
  'services',
  'receivedDate',
  'proposalSentDate',
  'source',
  'sourceDetail',
  'description',
  'owner',
] as const;
export type ImportFieldValue = (typeof IMPORT_FIELDS)[number];
export const importFieldSchema = z.enum(IMPORT_FIELDS);

/** Every non-reference field the importer requires for an Enquiry row to be creatable. */
export const REQUIRED_IMPORT_FIELDS = [
  'client',
  'sector',
  'services',
  'receivedDate',
  'source',
] as const;

/**
 * Fields resolved through the Values step against a bounded set of app targets, rather than
 * typed freehand: `client`/`sector`/`services`/`owner` resolve to another record's id,
 * `source` resolves to the fixed `ENQUIRY_SOURCES` enum.
 */
export const REFERENCE_FIELDS = ['client', 'sector', 'services', 'source', 'owner'] as const;
export type ReferenceFieldValue = (typeof REFERENCE_FIELDS)[number];

export const DATE_FIELDS = ['receivedDate', 'proposalSentDate'] as const;

/** Phase 1 supports the formats the field catalog can disambiguate without AI. */
export const DATE_FORMATS = ['DD/MM/YYYY', 'MM/DD/YYYY', 'DD-MMM-YY', 'EXCEL_SERIAL'] as const;
export type DateFormatValue = (typeof DATE_FORMATS)[number];

/** `mode` only has `createOnly` in phase 1; update-existing mode is out of scope for now. */
export const importOptionsSchema = z.strictObject({
  mode: z.literal('createOnly').default('createOnly'),
});
export type ImportOptions = z.output<typeof importOptionsSchema>;

export const createImportBatchSchema = z.strictObject({
  fileName: z.string().trim().min(1).max(255),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024, 'The file is larger than 20 MB'),
  entity: importEntitySchema,
});
export type CreateImportBatchInput = z.input<typeof createImportBatchSchema>;

/** Phase 1 processes exactly one sheet per batch (the module's "single-sheet" stage). */
export const sheetConfigSchema = z.strictObject({
  sheetName: z.string().min(1),
  headerRow: z.number().int().min(1),
  dataStartRow: z.number().int().min(1),
  dataEndRow: z.number().int().min(1),
});
export type SheetConfig = z.output<typeof sheetConfigSchema>;

export const columnMappingEntrySchema = z
  .strictObject({
    column: z.number().int().min(0),
    header: z.string(),
    field: importFieldSchema.nullable(),
    dateFormat: z.enum(DATE_FORMATS).optional(),
    separator: z.string().min(1).max(3).optional(),
  })
  .refine((entry) => entry.field !== 'services' || !!entry.separator, {
    message: 'Choose a separator for this multi-value column',
    path: ['separator'],
  })
  .refine(
    (entry) => !entry.dateFormat || (DATE_FIELDS as readonly string[]).includes(entry.field ?? ''),
    {
      message: 'Only date fields take a date format',
      path: ['dateFormat'],
    },
  );
export type ColumnMappingEntry = z.output<typeof columnMappingEntrySchema>;

export const updateColumnMappingSchema = z.strictObject({
  batchId: z.string().min(1),
  sheetConfig: sheetConfigSchema,
  columns: z.array(columnMappingEntrySchema).min(1),
});
export type UpdateColumnMappingInput = z.input<typeof updateColumnMappingSchema>;

const VALUE_ACTIONS = ['map', 'create', 'blank'] as const;

/**
 * One distinct file value resolved to an app target. `targetEnumValue` is used only for
 * `source` (a fixed enum); every other reference field resolves through `targetId`.
 * `create` is accepted only for `client` (M10b phase 1: sales already creates clients on the
 * regular form; sector/service creation stays admin-only via the masters page, so an
 * unmatched sector or service value blocks the row instead of offering "create new" here).
 */
export const valueMappingEntrySchema = z
  .strictObject({
    field: z.enum(REFERENCE_FIELDS),
    sourceValue: z.string().min(1),
    action: z.enum(VALUE_ACTIONS),
    targetId: z.string().min(1).optional(),
    targetEnumValue: enquirySourceSchema.optional(),
  })
  .superRefine((entry, ctx) => {
    if (entry.action === 'create' && entry.field !== 'client') {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'Only a new client can be created from this step',
      });
    }
    if (entry.field === 'source' && entry.action !== 'map') {
      ctx.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'Choose which source this maps to',
      });
    }
    if (entry.action === 'map') {
      if (entry.field === 'source' && !entry.targetEnumValue) {
        ctx.addIssue({ code: 'custom', path: ['targetEnumValue'], message: 'Choose a source' });
      }
      if (entry.field !== 'source' && !entry.targetId) {
        ctx.addIssue({ code: 'custom', path: ['targetId'], message: 'Choose a match' });
      }
    }
  });
export type ValueMappingEntry = z.output<typeof valueMappingEntrySchema>;

export const updateValueMappingSchema = z.strictObject({
  batchId: z.string().min(1),
  values: z.array(valueMappingEntrySchema),
});
export type UpdateValueMappingInput = z.input<typeof updateValueMappingSchema>;

/** "Fix in place" on the Review grid: edits the row's raw cells and re-validates it. */
export const editImportRowSchema = z.strictObject({
  rowId: z.string().min(1),
  original: z.record(z.string(), z.string().max(2000)),
});
export type EditImportRowInput = z.input<typeof editImportRowSchema>;

export const setImportRowsExcludedSchema = z.strictObject({
  rowIds: z.array(z.string().min(1)).min(1),
  excluded: z.boolean(),
});
export type SetImportRowsExcludedInput = z.input<typeof setImportRowsExcludedSchema>;

export const commitImportBatchSchema = idOnlySchema;
export const importBatchIdSchema = idOnlySchema;

export const IMPORT_SORTS = ['createdAt', 'status', 'fileName'] as const;

export const listImportBatchesSchema = listParamsSchema.extend({
  status: multi(IMPORT_BATCH_STATUSES),
  entity: multi(IMPORT_ENTITIES),
  recordStatus: z.enum(['live', 'deleted']).default('live'),
  sort: z.enum(IMPORT_SORTS).optional(),
});
export type ListImportBatchesInput = z.input<typeof listImportBatchesSchema>;

/** One staged row's messages (stored in `ImportRow.messages`). */
export const importRowMessageSchema = z.object({
  field: z.string().optional(),
  code: z.string(),
  message: z.string(),
});
export type ImportRowMessage = z.output<typeof importRowMessageSchema>;

export const listImportRowsSchema = z.object({
  batchId: z.string().min(1),
  status: multi(IMPORT_ROW_STATUSES),
  page: z.coerce.number().int().min(1).default(1),
  // Higher than the shared list pages' 100 (packages/core/schemas/common.ts): the Review
  // grid shows a batch's rows in one page rather than paginated controls (M10b phase 1).
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
});
export type ListImportRowsInput = z.input<typeof listImportRowsSchema>;

export const undoImportBatchSchema = idOnlySchema.extend({
  /** Admin only: undo the rest even though some records were edited since the import. */
  force: z.boolean().optional(),
});
export type UndoImportBatchInput = z.input<typeof undoImportBatchSchema>;
