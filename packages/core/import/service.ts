import type { Prisma } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { getFileStore } from '../extraction/deps.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import { importBatchResource, scopeImportBatches } from '../rbac/scope.ts';
import type { Page } from '../schemas/common.ts';
import {
  columnMappingEntrySchema,
  createImportBatchSchema,
  DATE_FORMATS,
  editImportRowSchema,
  listImportBatchesSchema,
  listImportRowsSchema,
  setImportRowsExcludedSchema,
  undoImportBatchSchema,
  updateColumnMappingSchema,
  updateValueMappingSchema,
  type ColumnMappingEntry,
  type CreateImportBatchInput,
  type DateFormatValue,
  type EditImportRowInput,
  type ImportBatchStatusValue,
  type ImportEntityValue,
  type ImportOptions,
  type ImportRowMessage,
  type ImportRowStatusValue,
  type ListImportBatchesInput,
  type ListImportRowsInput,
  type SetImportRowsExcludedInput,
  type SheetConfig,
  type UndoImportBatchInput,
  type UpdateColumnMappingInput,
  type UpdateValueMappingInput,
  type ValueMappingEntry,
} from '../schemas/import.ts';
import { listClientOptions } from '../services/client.service.ts';
import { listEnquiryOwnerOptions } from '../services/enquiry.service.ts';
import { getSettings } from '../services/settings.service.ts';
import { listSectorOptions } from '../services/sector.service.ts';
import { listServiceOptions } from '../services/service.service.ts';
import { actorCtxFor } from './actor.ts';
import { commitBatch } from './commit/commit-batch.ts';
import { rollbackBatch, type RollbackResult } from './commit/rollback-batch.ts';
import { detectTable, headersAt, sliceDataRows } from './detect/table.ts';
import {
  assertImportFileAcceptable,
  IMPORT_FILE_TYPES,
  type ImportUploadFile,
} from './file-types.ts';
import { parseWorkbook } from './parse/read-workbook.ts';
import { enqueueImportCommit, enqueueImportParse } from './queue.ts';
import { ENQUIRY_FIELD_CATALOG } from './suggest/field-catalog.ts';
import { suggestColumns } from './suggest/heuristic.ts';
import {
  applyDuplicateChecks,
  buildValueMappingLookup,
  collectDistinctValues,
  validateRow,
  type ImportActor,
  type ReferenceData,
  type ResolvedEnquiryRow,
} from './validate/rows.ts';

const EXPIRES_IN_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 50_000;
/** Spreadsheets always upload as Cloudinary's `raw` resource type (M10b, unlike M7's `image`). */
const RAW = 'raw' as const;
const EDITABLE_STATUSES: ImportBatchStatusValue[] = ['MAPPING', 'READY'];
const DRAFT_STATUSES: ImportBatchStatusValue[] = [
  'UPLOADED',
  'PARSING',
  'MAPPING',
  'VALIDATING',
  'READY',
  'COMMITTING',
  'FAILED',
];

type ParsedSheetData = { sheetName: string; rows: unknown[][] };
type BatchMapping = { columns: ColumnMappingEntry[]; values: ValueMappingEntry[] };
export interface ImportCounts {
  total: number;
  ready: number;
  warning: number;
  error: number;
  duplicate: number;
  excluded: number;
  /** Set once the batch commits (`commitBatch`), alongside the counts above. */
  created?: number;
  skippedDuplicates?: number;
}

export interface ImportBatchView {
  id: string;
  fileName: string;
  entity: ImportEntityValue;
  status: ImportBatchStatusValue;
  sheetConfig: SheetConfig | null;
  mapping: BatchMapping | null;
  counts: ImportCounts | null;
  createdBy: { id: string; name: string };
  createdAt: Date;
  committedAt: Date | null;
  undoneAt: Date | null;
  expiresAt: Date;
  errorMessage: string | null;
}

export interface ImportRowView {
  id: string;
  rowNumber: number;
  status: ImportRowStatusValue;
  original: Record<string, unknown>;
  transformed: Record<string, unknown> | null;
  resolved: ResolvedEnquiryRow | null;
  messages: ImportRowMessage[];
  /** `{ enquiryId, clientId, clientCreated }` once committed (commit-batch.ts); else null. */
  resultRecordIds: { enquiryId: string; clientId: string; clientCreated: boolean } | null;
}

// ─── RBAC + shape helpers ───────────────────────────────────────────────────────────

async function loadBatch(ctx: Ctx, id: string, action: 'read' | 'update' | 'delete') {
  const batch = await getDb().importBatch.findUnique({ where: { id } });
  if (!batch) throw new NotFoundError('import batch');
  assertCan(ctx, action, importBatchResource(batch));
  return batch;
}

function assertEditable(batch: { status: ImportBatchStatusValue }) {
  if (!EDITABLE_STATUSES.includes(batch.status)) {
    throw new DomainError('This import can no longer be edited.');
  }
}

function toView(batch: {
  id: string;
  fileName: string;
  entity: string;
  status: string;
  sheetConfig: unknown;
  mapping: unknown;
  counts: unknown;
  createdBy: { id: string; name: string };
  createdAt: Date;
  committedAt: Date | null;
  undoneAt: Date | null;
  expiresAt: Date;
  errorMessage: string | null;
}): ImportBatchView {
  return {
    id: batch.id,
    fileName: batch.fileName,
    entity: batch.entity as ImportEntityValue,
    status: batch.status as ImportBatchStatusValue,
    sheetConfig: batch.sheetConfig as SheetConfig | null,
    mapping: batch.mapping as BatchMapping | null,
    counts: batch.counts as ImportCounts | null,
    createdBy: batch.createdBy,
    createdAt: batch.createdAt,
    committedAt: batch.committedAt,
    undoneAt: batch.undoneAt,
    expiresAt: batch.expiresAt,
    errorMessage: batch.errorMessage,
  };
}

function toRowView(row: {
  id: string;
  rowNumber: number;
  status: string;
  original: unknown;
  transformed: unknown;
  resolved: unknown;
  messages: unknown;
  resultRecordIds: unknown;
}): ImportRowView {
  return {
    id: row.id,
    rowNumber: row.rowNumber,
    status: row.status as ImportRowStatusValue,
    original: row.original as Record<string, unknown>,
    transformed: row.transformed as Record<string, unknown> | null,
    resolved: row.resolved as ResolvedEnquiryRow | null,
    messages: row.messages as ImportRowMessage[],
    resultRecordIds: row.resultRecordIds as ImportRowView['resultRecordIds'],
  };
}

/** Prisma's `Json` input type doesn't structurally accept our own interfaces; the actual
 * values are always plain JSON-serializable objects (document.service.ts does the same). */
function toJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function countStatuses(rows: readonly { status: ImportRowStatusValue }[]): ImportCounts {
  const counts: ImportCounts = {
    total: rows.length,
    ready: 0,
    warning: 0,
    error: 0,
    duplicate: 0,
    excluded: 0,
  };
  for (const row of rows) {
    if (row.status === 'READY') counts.ready++;
    else if (row.status === 'WARNING') counts.warning++;
    else if (row.status === 'ERROR') counts.error++;
    else if (row.status === 'DUPLICATE') counts.duplicate++;
    else counts.excluded++;
  }
  return counts;
}

async function actorFor(ctx: Ctx): Promise<ImportActor> {
  const user = await getDb().user.findUniqueOrThrow({
    where: { id: ctx.user.id },
    select: { name: true },
  });
  return { id: ctx.user.id, role: ctx.user.role, name: user.name };
}

async function fetchReferenceData(ctx: Ctx): Promise<ReferenceData> {
  const [clients, sectors, services, owners] = await Promise.all([
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    ctx.user.role === 'ADMIN' ? listEnquiryOwnerOptions(ctx) : Promise.resolve([]),
  ]);
  return { clients, sectors, services, owners };
}

/** Client + received date of every live enquiry, for the WARNING-level DB duplicate check. */
async function existingEnquiryNaturalKeys(): Promise<Set<string>> {
  const rows = await getDb().enquiry.findMany({ select: { clientId: true, receivedDate: true } });
  return new Set(rows.map((r) => `${r.clientId}|${r.receivedDate.toISOString().slice(0, 10)}`));
}

async function recomputeCounts(db: Db, batchId: string): Promise<ImportCounts> {
  const rows = await db.importRow.findMany({ where: { batchId }, select: { status: true } });
  return countStatuses(rows as { status: ImportRowStatusValue }[]);
}

// ─── Upload + parse ─────────────────────────────────────────────────────────────────

export async function createImportBatch(
  ctx: Ctx,
  input: CreateImportBatchInput,
  file: ImportUploadFile,
): Promise<ImportBatchView> {
  const data = createImportBatchSchema.parse(input);
  assertCan(ctx, 'create', 'importBatch');
  const { mimeType } = assertImportFileAcceptable(file);

  const store = getFileStore();
  const stored = await store.put({
    bytes: file.bytes,
    mimeType,
    folder: 'imports',
    resourceType: RAW,
  });

  const options: ImportOptions = { mode: 'createOnly' };
  let batchId: string;
  try {
    batchId = await withTx(ctx, async (tx) => {
      const batch = await tx.importBatch.create({
        data: {
          fileName: file.filename,
          fileStorageKey: stored.storageKey,
          fileSize: file.bytes.length,
          entity: data.entity,
          options,
          status: 'UPLOADED',
          createdById: ctx.user.id,
          expiresAt: new Date(Date.now() + EXPIRES_IN_MS),
        },
      });
      return batch.id;
    });
  } catch (error) {
    await store.remove(stored).catch(() => undefined);
    throw error;
  }

  try {
    await enqueueImportParse(batchId);
  } catch (error) {
    console.error('could not queue import parse; the batch stays in Uploaded', error);
  }
  return getImportBatch(ctx, batchId);
}

/**
 * Re-slices and re-validates every row for a (possibly new) header/data range and column
 * mapping (M10b "Resolve and validate", run synchronously — see the phase 1 summary for why
 * this isn't a worker job like parse/commit). Always the single place that writes
 * `ImportRow` rows, so parse, "Columns" and "Values" all go through it.
 */
async function regenerateRows(
  ctx: Ctx,
  batchId: string,
  sheetConfig: SheetConfig,
  columns: readonly ColumnMappingEntry[],
  values: readonly ValueMappingEntry[],
): Promise<void> {
  const batch = await getDb().importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const parsed = batch.parsed as ParsedSheetData | null;
  if (!parsed) throw new DomainError('This file has not finished parsing yet.');

  const headers = headersAt(parsed.rows, sheetConfig.headerRow);
  // The server-derived headers are authoritative; reconcile each entry's `header` by index
  // so a stale client-submitted header text never desyncs the `original` lookup key.
  const resolvedColumns = columns.map((c) => ({ ...c, header: headers[c.column] ?? c.header }));

  const sliced = sliceDataRows(
    parsed.rows,
    headers,
    sheetConfig.dataStartRow,
    sheetConfig.dataEndRow,
  );
  if (sliced.length === 0)
    throw new DomainError('No data rows were found for this header/data range.');
  if (sliced.length > MAX_ROWS) {
    throw new DomainError(
      `This file has more than ${MAX_ROWS.toLocaleString('en-IN')} rows; split it and import in parts.`,
    );
  }

  const [refs, actor, existingKeys] = await Promise.all([
    fetchReferenceData(ctx),
    actorFor(ctx),
    existingEnquiryNaturalKeys(),
  ]);
  const lookup = buildValueMappingLookup(values);

  const outcomes = new Map(
    sliced.map((row) => [
      row.rowNumber,
      validateRow(row.original, resolvedColumns, lookup, refs, actor),
    ]),
  );
  const withDuplicates = new Map(
    applyDuplicateChecks(
      sliced.map((row) => ({ id: String(row.rowNumber), result: outcomes.get(row.rowNumber)! })),
      existingKeys,
    ).map((r) => [r.id, r]),
  );

  const counts = countStatuses([...withDuplicates.values()]);

  await withTx(
    ctx,
    async (tx) => {
      await tx.importRow.deleteMany({ where: { batchId } });
      await tx.importRow.createMany({
        data: sliced.map((row) => {
          const outcome = withDuplicates.get(String(row.rowNumber))!;
          return {
            batchId,
            sheetName: sheetConfig.sheetName,
            rowNumber: row.rowNumber,
            original: toJson(row.original),
            transformed: toJson(outcome.transformed),
            resolved: toJson(outcome.resolved),
            status: outcome.status,
            messages: toJson(outcome.messages),
          };
        }),
      });
      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          sheetConfig: toJson(sheetConfig),
          mapping: toJson({ columns: resolvedColumns, values }),
          counts: toJson(counts),
          status: 'READY',
        },
      });
    },
    { timeoutMs: 60_000 },
  );
}

/**
 * Worker job (`import.parse`): reads the stored file, detects the table structure and
 * suggests a column mapping with the heuristic (no AI in phase 1 — see the module summary),
 * then runs the first validation pass. Runs as the importing user (`actorCtxFor`), not the
 * system actor: `getSettings` and the reference lookups below are per-role.
 */
export async function runImportParseJob(batchId: string): Promise<void> {
  const batch = await getDb().importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const ctx = await actorCtxFor(batch.createdById);
  try {
    await withTx(ctx, (tx) =>
      tx.importBatch.update({ where: { id: batchId }, data: { status: 'PARSING' } }),
    );

    const extension = (batch.fileName.split('.').pop() ?? '').toLowerCase();
    const mimeType = IMPORT_FILE_TYPES[extension] ?? 'application/octet-stream';
    const bytes = await getFileStore().get({
      storageKey: batch.fileStorageKey,
      resourceType: RAW,
      mimeType,
      extension,
    });

    const workbook = parseWorkbook(bytes, batch.fileName);
    // Phase 1 is single-sheet: pick the first sheet that actually has content.
    const sheet =
      workbook.sheets.find((s) =>
        s.rows.some((r) => r.some((c) => c != null && String(c).trim() !== '')),
      ) ?? workbook.sheets[0]!;

    const detected = detectTable(sheet.rows);
    if (detected.dataEndRow < detected.dataStartRow) {
      throw new DomainError('No data rows were found in this file.');
    }

    const settings = await getSettings(ctx);
    const defaultDateFormat = (DATE_FORMATS as readonly string[]).includes(
      settings.importDateFormat,
    )
      ? (settings.importDateFormat as DateFormatValue)
      : 'DD/MM/YYYY';

    const suggestions = suggestColumns(detected.headers, ENQUIRY_FIELD_CATALOG);
    const columns: ColumnMappingEntry[] = suggestions.map((s) =>
      columnMappingEntrySchema.parse({
        column: s.column,
        header: s.header,
        field: s.field,
        ...(s.field === 'receivedDate' || s.field === 'proposalSentDate'
          ? { dateFormat: defaultDateFormat }
          : {}),
        ...(s.field === 'services' ? { separator: ',' } : {}),
      }),
    );
    const sheetConfig: SheetConfig = {
      sheetName: sheet.name,
      headerRow: detected.headerRow,
      dataStartRow: detected.dataStartRow,
      dataEndRow: detected.dataEndRow,
    };

    await withTx(ctx, (tx) =>
      tx.importBatch.update({
        where: { id: batchId },
        data: {
          parsed: toJson({ sheetName: sheet.name, rows: sheet.rows } satisfies ParsedSheetData),
        },
      }),
    );

    await regenerateRows(ctx, batchId, sheetConfig, columns, []);
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : 'Could not read this file. It may be corrupt or unsupported.';
    await withTx(ctx, (tx) =>
      tx.importBatch.update({
        where: { id: batchId },
        data: { status: 'FAILED', errorMessage: message },
      }),
    );
  }
}

// ─── Wizard steps ───────────────────────────────────────────────────────────────────

export async function getImportBatch(ctx: Ctx, id: string): Promise<ImportBatchView> {
  const batch = await getDb().importBatch.findUnique({
    where: { id },
    include: { createdBy: { select: { id: true, name: true } } },
  });
  if (!batch) throw new NotFoundError('import batch');
  assertCan(ctx, 'read', importBatchResource(batch));
  return toView(batch);
}

export async function listImportBatches(
  ctx: Ctx,
  input: ListImportBatchesInput,
): Promise<Page<ImportBatchView>> {
  const { page, pageSize, status, entity, sort, dir } = listImportBatchesSchema.parse(input);
  assertCan(ctx, 'list', 'importBatch');
  const where = {
    ...scopeImportBatches(ctx.user),
    ...(status?.length ? { status: { in: status } } : {}),
    ...(entity?.length ? { entity: { in: entity } } : {}),
  };
  const [items, total] = await Promise.all([
    getDb().importBatch.findMany({
      where,
      include: { createdBy: { select: { id: true, name: true } } },
      orderBy: [{ [sort ?? 'createdAt']: dir ?? 'desc' }, { id: 'asc' }],
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getDb().importBatch.count({ where }),
  ]);
  return { items: items.map(toView), total, page, pageSize };
}

export async function listImportRows(
  ctx: Ctx,
  input: ListImportRowsInput,
): Promise<Page<ImportRowView>> {
  const { batchId, status, page, pageSize } = listImportRowsSchema.parse(input);
  await loadBatch(ctx, batchId, 'read');
  const where = { batchId, ...(status?.length ? { status: { in: status } } : {}) };
  const [items, total] = await Promise.all([
    getDb().importRow.findMany({
      where,
      orderBy: { rowNumber: 'asc' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    getDb().importRow.count({ where }),
  ]);
  return { items: items.map(toRowView), total, page, pageSize };
}

export async function updateImportMapping(
  ctx: Ctx,
  input: UpdateColumnMappingInput,
): Promise<ImportBatchView> {
  const data = updateColumnMappingSchema.parse(input);
  const batch = await loadBatch(ctx, data.batchId, 'update');
  assertEditable(batch);
  const existingValues = (batch.mapping as BatchMapping | null)?.values ?? [];
  await regenerateRows(ctx, batch.id, data.sheetConfig, data.columns, existingValues);
  return getImportBatch(ctx, batch.id);
}

export async function getDistinctImportValues(
  ctx: Ctx,
  batchId: string,
): Promise<ReturnType<typeof collectDistinctValues>> {
  const batch = await loadBatch(ctx, batchId, 'read');
  const mapping = batch.mapping as BatchMapping | null;
  if (!mapping) return [];
  const rows = await getDb().importRow.findMany({ where: { batchId }, select: { original: true } });
  return collectDistinctValues(
    rows.map((r) => r.original as Record<string, unknown>),
    mapping.columns,
  );
}

export async function updateImportValueMapping(
  ctx: Ctx,
  input: UpdateValueMappingInput,
): Promise<ImportBatchView> {
  const data = updateValueMappingSchema.parse(input);
  const batch = await loadBatch(ctx, data.batchId, 'update');
  assertEditable(batch);
  const mapping = batch.mapping as BatchMapping | null;
  const sheetConfig = batch.sheetConfig as SheetConfig | null;
  if (!mapping || !sheetConfig) throw new DomainError('Map the columns first.');
  await regenerateRows(ctx, batch.id, sheetConfig, mapping.columns, data.values);
  return getImportBatch(ctx, batch.id);
}

/**
 * "Fix in place" on the Review grid. Phase 1 simplification: re-validates this row only —
 * whether it now matches an existing DB enquiry (WARNING) is re-checked, but a new
 * in-file duplicate created by the edit is not; rerun the Columns or Values step (which
 * revalidates every row) to refresh that.
 */
export async function editImportRow(ctx: Ctx, input: EditImportRowInput): Promise<ImportRowView> {
  const data = editImportRowSchema.parse(input);
  const row = await getDb().importRow.findUnique({ where: { id: data.rowId } });
  if (!row) throw new NotFoundError('import row');
  const batch = await loadBatch(ctx, row.batchId, 'update');
  assertEditable(batch);
  if (row.status === 'EXCLUDED') throw new DomainError('Include this row again before editing it.');

  const mapping = batch.mapping as BatchMapping | null;
  if (!mapping) throw new DomainError('Map the columns first.');

  const merged = { ...(row.original as Record<string, unknown>), ...data.original };
  const [refs, actor, existingKeys] = await Promise.all([
    fetchReferenceData(ctx),
    actorFor(ctx),
    existingEnquiryNaturalKeys(),
  ]);
  const lookup = buildValueMappingLookup(mapping.values);
  const result = validateRow(merged, mapping.columns, lookup, refs, actor);
  const [checked] = applyDuplicateChecks([{ id: row.id, result }], existingKeys);

  const updated = await withTx(ctx, async (tx) => {
    const saved = await tx.importRow.update({
      where: { id: row.id },
      data: {
        original: toJson(merged),
        transformed: toJson(checked!.transformed),
        resolved: toJson(checked!.resolved),
        status: checked!.status,
        messages: toJson(checked!.messages),
      },
    });
    const counts = await recomputeCounts(tx, batch.id);
    await tx.importBatch.update({ where: { id: batch.id }, data: { counts: toJson(counts) } });
    return saved;
  });
  return toRowView(updated);
}

export async function setImportRowsExcluded(
  ctx: Ctx,
  input: SetImportRowsExcludedInput,
): Promise<void> {
  const data = setImportRowsExcludedSchema.parse(input);
  const rows = await getDb().importRow.findMany({ where: { id: { in: data.rowIds } } });
  if (rows.length === 0) return;
  const batchIds = new Set(rows.map((r) => r.batchId));
  if (batchIds.size !== 1) throw new DomainError('Rows must belong to the same import.');
  const batch = await loadBatch(ctx, [...batchIds][0]!, 'update');
  assertEditable(batch);

  const mapping = batch.mapping as BatchMapping | null;
  const [refs, actor, existingKeys] = data.excluded
    ? [null, null, null]
    : await Promise.all([fetchReferenceData(ctx), actorFor(ctx), existingEnquiryNaturalKeys()]);
  const lookup = mapping ? buildValueMappingLookup(mapping.values) : null;

  await withTx(ctx, async (tx) => {
    for (const row of rows) {
      if (data.excluded) {
        await tx.importRow.update({ where: { id: row.id }, data: { status: 'EXCLUDED' } });
        continue;
      }
      if (!mapping || !refs || !actor || !lookup || !existingKeys) continue;
      const result = validateRow(
        row.original as Record<string, unknown>,
        mapping.columns,
        lookup,
        refs,
        actor,
      );
      const [checked] = applyDuplicateChecks([{ id: row.id, result }], existingKeys);
      await tx.importRow.update({
        where: { id: row.id },
        data: {
          status: checked!.status,
          resolved: toJson(checked!.resolved),
          transformed: toJson(checked!.transformed),
          messages: toJson(checked!.messages),
        },
      });
    }
    const counts = await recomputeCounts(tx, batch.id);
    await tx.importBatch.update({ where: { id: batch.id }, data: { counts: toJson(counts) } });
  });
}

// ─── Commit + undo ──────────────────────────────────────────────────────────────────

export async function commitImportBatch(ctx: Ctx, input: { id: string }): Promise<ImportBatchView> {
  const batch = await loadBatch(ctx, input.id, 'update');
  if (batch.status !== 'READY') throw new DomainError('This import is not ready to commit.');
  const counts = batch.counts as ImportCounts | null;
  if (counts && counts.error > 0) {
    throw new DomainError('Fix or exclude every row with an error before importing.');
  }

  const claim = await withTx(ctx, (tx) =>
    tx.importBatch.updateMany({
      where: { id: batch.id, status: 'READY' },
      data: { status: 'COMMITTING' },
    }),
  );
  if (claim.count === 0) throw new DomainError('This import is not ready to commit.');

  try {
    await enqueueImportCommit(batch.id);
  } catch (error) {
    await withTx(ctx, (tx) =>
      tx.importBatch.update({
        where: { id: batch.id },
        data: { status: 'READY', errorMessage: 'Could not start the import. Try again.' },
      }),
    );
    console.error('could not queue import commit', error);
    throw new DomainError('Could not start the import. Try again.');
  }
  return getImportBatch(ctx, batch.id);
}

/**
 * Worker job (`import.commit`): runs as the importing user (not the system actor — commit
 * calls `createEnquiry`/`createClient`, whose RBAC depends on who is really creating the
 * record). `commitBatch` sets the batch to COMMITTED itself, inside its own transaction, on
 * success; on failure the batch returns to READY with the error shown (M10b "Commit and
 * undo": nothing is saved).
 */
export async function runImportCommitJob(batchId: string): Promise<void> {
  const batch = await getDb().importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const ctx = await actorCtxFor(batch.createdById);
  try {
    await commitBatch(ctx, batchId);
  } catch (error) {
    const message =
      error instanceof DomainError
        ? error.message
        : 'The import could not be completed. Nothing was saved.';
    await withTx(ctx, (tx) =>
      tx.importBatch.update({
        where: { id: batchId },
        data: { status: 'READY', errorMessage: message },
      }),
    );
  }
}

export async function undoImportBatch(
  ctx: Ctx,
  input: UndoImportBatchInput,
): Promise<RollbackResult> {
  const data = undoImportBatchSchema.parse(input);
  const batch = await loadBatch(ctx, data.id, 'delete');
  if (batch.status !== 'COMMITTED') {
    throw new DomainError('This import has not been committed, or was already undone.');
  }
  if (!batch.committedAt || Date.now() - batch.committedAt.getTime() > EXPIRES_IN_MS) {
    throw new DomainError('This import can no longer be undone (the 7-day window has passed).');
  }
  return rollbackBatch(ctx, batch.id, { force: !!data.force && ctx.user.role === 'ADMIN' });
}

/** Nightly job (`import.expire-drafts`, run as the system actor): batches left untouched 7+
 * days past their `expiresAt` move to EXPIRED (M10b: "Drafts expire after 7 days"). */
export async function expireImportDrafts(ctx: Ctx): Promise<{ expired: number }> {
  const stale = await getDb().importBatch.findMany({
    where: { status: { in: DRAFT_STATUSES }, expiresAt: { lt: new Date() } },
    select: { id: true },
  });
  if (stale.length === 0) return { expired: 0 };
  await withTx(ctx, (tx) =>
    tx.importBatch.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'EXPIRED' },
    }),
  );
  return { expired: stale.length };
}
