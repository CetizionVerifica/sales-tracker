import { createHash } from 'node:crypto';
import { Prisma, type DocumentKind, type ExtractionStatus } from '@sales-tracker/db';
import { getDb, type Db } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { getEnv } from '../env.ts';
import { DomainError, ForbiddenError, NotFoundError } from '../errors.ts';
import { sameCompany } from '../extraction/company-name.ts';
import { getExtractor, getFileStore } from '../extraction/deps.ts';
import {
  kindSpec,
  supportedKinds,
  type DocumentKindSpec,
  type ParentRecord,
  type ReviewField,
} from '../extraction/kinds.ts';
import { enqueueExtraction } from '../extraction/queue.ts';
import { EXTRACTION_MESSAGES, RetryableExtractionError } from '../extraction/types.ts';
import { can } from '../rbac/can.ts';
import { documentResource, scopeDocuments } from '../rbac/scope.ts';
import type { Action } from '../rbac/types.ts';
import type { Page } from '../schemas/common.ts';
import {
  confirmExtractionSchema,
  DOCUMENT_MIME_TYPES,
  listDocumentsSchema,
  uploadDocumentSchema,
  type ConfirmExtractionInput,
  type DocumentKindValue,
  type DocumentMimeType,
  type ListDocumentsInput,
  type UploadDocumentInput,
  type UploadedFile,
} from '../schemas/document.ts';
import {
  storedExtractionSchema,
  type ExtractedField,
  type StoredExtraction,
} from '../schemas/extraction.ts';
import { isIsoCurrency, parseAmount } from '../schemas/money.ts';
import { matchesMimeType } from '../storage/magic-bytes.ts';
import {
  assertCanConfirm,
  assertCanRetry,
  assertExtractionTransition,
  canTransitionExtraction,
} from '../status/document.ts';
import { SETTINGS_ID } from './settings.service.ts';

/*
 * Documents and extraction (M7). A document's permissions are its record's (Decision 4);
 * extraction is a suggestion stored on the document, and a record changes only through
 * confirmExtraction, which calls the record's own update service (Decision 1, CLAUDE.md
 * rule 9).
 */

// ─── Shapes returned to callers ─────────────────────────────────────────────────────

export interface ReviewRow {
  name: string;
  label: string;
  input: ReviewField['input'];
  /** Extracted values by extracted-field name (e.g. `amount` and `currency`). */
  extracted: Record<string, ExtractedField | null>;
  /** The record's current values by record-field name. */
  current: Record<string, string | null>;
  /** The record's field names written when this row is applied. */
  applies: readonly string[];
  /** Why this row cannot be applied to the record now, or null. */
  lockedReason: string | null;
  /** Ticked by default: differs from the record, not low confidence, not locked. */
  suggested: boolean;
}

export interface DocumentView {
  id: string;
  kind: DocumentKind;
  kindLabel: string;
  entityId: string;
  entityLabel: string;
  clientId: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string };
  createdAt: Date;
  extractionStatus: DocumentViewStatus;
  /** How many times extraction has started (retries included). */
  extractionAttempts: number;
  extractionError: string | null;
  extractionModel: string | null;
  extractedAt: Date | null;
  reviewStatus: 'PENDING' | 'CONFIRMED';
  reviewedBy: { id: string; name: string } | null;
  reviewedAt: Date | null;
  appliedFields: string[];
  deletedAt: Date | null;
  /** Whether this is the record's current document (only that one can be reviewed). */
  isCurrent: boolean;
  /** Whether the actor may upload, re-run, confirm and delete (update on the record). */
  canUpdate: boolean;
  /** Present once there is an extraction to show. */
  review: {
    fields: ReviewRow[];
    info: { name: string; label: string; extracted: ExtractedField | null }[];
    /** The client name printed on the document when it differs from the record's. */
    clientMismatch: string | null;
  } | null;
}

type DocumentViewStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'SKIPPED';

export type DocumentFile =
  | { type: 'redirect'; url: string }
  | { type: 'bytes'; bytes: Uint8Array; mimeType: string; filename: string };

export interface DocumentRow {
  id: string;
  kind: DocumentKind;
  entityId: string;
  entityLabel: string;
  originalFilename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: { id: string; name: string };
  createdAt: Date;
  extractionStatus: DocumentViewStatus;
  reviewStatus: 'PENDING' | 'CONFIRMED';
  deletedAt: Date | null;
}

// ─── Loading with permission checks ─────────────────────────────────────────────────

const documentInclude = {
  uploadedBy: { select: { id: true, name: true } },
  reviewedBy: { select: { id: true, name: true } },
} satisfies Prisma.DocumentInclude;

type DocumentWithUsers = Prisma.DocumentGetPayload<{ include: typeof documentInclude }>;

function specFor(kind: DocumentKindValue): DocumentKindSpec {
  const spec = kindSpec(kind);
  if (!spec) {
    throw new DomainError('Documents for this kind of record are not available yet', {
      field: 'kind',
    });
  }
  return spec;
}

/**
 * The record a document belongs to. Not readable (or missing, or soft deleted) → not found,
 * so other reps' ids don't leak (M4 Decision 7). `update` also needs update on the record.
 */
async function loadParent(
  db: Db,
  ctx: Ctx,
  spec: DocumentKindSpec,
  entityId: string,
  action: 'read' | 'update',
): Promise<{ parent: ParentRecord; canUpdate: boolean }> {
  const parent = await spec.load(db, entityId);
  if (!parent || !can(ctx.user, 'read', parent.resource)) {
    throw new NotFoundError(spec.label.toLowerCase());
  }
  const canUpdate = can(ctx.user, 'update', parent.resource);
  if (action === 'update' && !canUpdate) throw new ForbiddenError('update', 'document');
  return { parent, canUpdate };
}

const ROW_FILTER = {
  live: {},
  deleted: { deletedAt: { not: null } },
  any: { deletedAt: undefined },
} as const;

/** A document plus its record, after checking `action` (read, update or delete). */
async function loadDocument(
  db: Db,
  ctx: Ctx,
  id: string,
  action: Action,
  rows: keyof typeof ROW_FILTER = 'live',
) {
  const doc = await db.document.findFirst({
    where: { id, ...ROW_FILTER[rows] },
    include: documentInclude,
  });
  const spec = doc ? kindSpec(doc.kind) : undefined;
  const parent = doc && spec ? await spec.load(db, doc.entityId) : null;
  if (!doc || !spec || !parent || !can(ctx.user, 'read', parent.resource)) {
    throw new NotFoundError('document');
  }
  const canUpdate = can(ctx.user, 'update', parent.resource);
  assertCan(ctx, action, documentResource(true, canUpdate));
  return { doc, spec, parent, canUpdate };
}

// ─── Review view ────────────────────────────────────────────────────────────────────

function readExtraction(value: Prisma.JsonValue | null): StoredExtraction | null {
  if (value === null) return null;
  const parsed = storedExtractionSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Whether the extracted values differ from the record's (amounts compared numerically). */
function differs(
  row: ReviewField,
  extracted: StoredExtraction,
  current: Record<string, string | null>,
) {
  if (row.input === 'money') {
    const amount = extracted[row.from[0]!]?.value;
    const currency = extracted[row.from[1]!]?.value;
    if (!amount || !currency || !isIsoCurrency(currency)) return false;
    const parsed = parseAmount(amount, currency);
    const now =
      current.currency && current.amount ? parseAmount(current.amount, current.currency) : null;
    if (!parsed.ok) return false;
    return currency !== current.currency || !now?.ok || now.value !== parsed.value;
  }
  const value = extracted[row.from[0]!]?.value ?? null;
  return value !== null && value !== (current[row.applies[0]!] ?? null);
}

function reviewOf(
  spec: DocumentKindSpec,
  parent: ParentRecord,
  extraction: StoredExtraction,
): NonNullable<DocumentView['review']> {
  const fields = spec.reviewFields.map((row): ReviewRow => {
    const extracted = Object.fromEntries(row.from.map((name) => [name, extraction[name] ?? null]));
    const current = Object.fromEntries(
      row.applies.map((name) => [name, parent.values[name] ?? null]),
    );
    const lockedReason = parent.locked[row.name] ?? null;
    const present = row.from.every((name) => extraction[name]?.value);
    const confident = row.from.every((name) => extraction[name]?.confidence !== 'low');
    return {
      name: row.name,
      label: row.label,
      input: row.input,
      extracted,
      current,
      applies: row.applies,
      lockedReason,
      suggested: !lockedReason && present && confident && differs(row, extraction, current),
    };
  });
  const printedClient = extraction.clientName?.value ?? null;
  return {
    fields,
    info: spec.infoFields.map((info) => ({ ...info, extracted: extraction[info.name] ?? null })),
    clientMismatch:
      printedClient && !sameCompany(printedClient, parent.clientName) ? printedClient : null,
  };
}

function toView(
  doc: DocumentWithUsers,
  spec: DocumentKindSpec,
  parent: ParentRecord,
  canUpdate: boolean,
): DocumentView {
  const extraction = readExtraction(doc.extraction);
  return {
    id: doc.id,
    kind: doc.kind,
    kindLabel: spec.label,
    entityId: doc.entityId,
    entityLabel: parent.label,
    clientId: doc.clientId,
    originalFilename: doc.originalFilename,
    mimeType: doc.mimeType,
    sizeBytes: doc.sizeBytes,
    uploadedBy: doc.uploadedBy,
    createdAt: doc.createdAt,
    extractionStatus: doc.extractionStatus,
    extractionAttempts: doc.extractionAttempts,
    extractionError: doc.extractionError,
    extractionModel: doc.extractionModel,
    extractedAt: doc.extractedAt,
    reviewStatus: doc.reviewStatus,
    reviewedBy: doc.reviewedBy,
    reviewedAt: doc.reviewedAt,
    appliedFields: doc.appliedFields,
    deletedAt: doc.deletedAt,
    isCurrent: parent.documentId === doc.id,
    canUpdate,
    review: extraction ? reviewOf(spec, parent, extraction) : null,
  };
}

async function viewOf(db: Db, ctx: Ctx, id: string, rows: keyof typeof ROW_FILTER = 'any') {
  const { doc, spec, parent, canUpdate } = await loadDocument(db, ctx, id, 'read', rows);
  return toView(doc, spec, parent, canUpdate);
}

// ─── Upload ─────────────────────────────────────────────────────────────────────────

async function extractionEnabled(db: Db): Promise<boolean> {
  const settings = await db.companySettings.findUnique({
    where: { id: SETTINGS_ID },
    select: { documentExtractionEnabled: true },
  });
  if (!settings) throw new Error('Company settings are missing; run `pnpm db:seed`');
  return settings.documentExtractionEnabled;
}

function assertFileAcceptable(file: UploadedFile): DocumentMimeType {
  const max = getEnv().DOCUMENT_MAX_BYTES;
  const mimeType = file.mimeType as DocumentMimeType;
  if (!DOCUMENT_MIME_TYPES.includes(mimeType)) {
    throw new DomainError('Upload a PDF, PNG, JPEG or WebP file', { field: 'file' });
  }
  if (file.bytes.length === 0) throw new DomainError('The file is empty', { field: 'file' });
  if (file.bytes.length > max) {
    const mb = Math.floor(max / (1024 * 1024));
    throw new DomainError(`The file is larger than ${mb} MB`, { field: 'file' });
  }
  if (!matchesMimeType(file.bytes, mimeType)) {
    throw new DomainError('The file’s contents do not match its type', { field: 'file' });
  }
  return mimeType;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function cleanFilename(name: string): string {
  // Path parts and control characters never reach the database or a download header.
  const base = name.split(/[\\/]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return (clean || 'document').slice(0, 255);
}

/** Queues after commit; a Redis failure is left to the worker's sweeper (M7 risks). */
async function queueAfterCommit(documentId: string) {
  try {
    await enqueueExtraction(documentId);
  } catch (error) {
    console.error('could not queue document extraction; the sweeper will retry', error);
  }
}

/**
 * Attaches a file to a record: stored first (an orphaned file is harmless, an orphaned row
 * is not), then one transaction creates the document, makes it the record's current one
 * and soft-deletes the previous one (Decision 2). Extraction is queued after commit.
 */
export async function uploadDocument(
  ctx: Ctx,
  input: UploadDocumentInput,
  file: UploadedFile,
): Promise<DocumentView> {
  const p = uploadDocumentSchema.parse(input);
  const spec = specFor(p.kind);
  assertCan(ctx, 'create', 'document');
  // Checked before storing anything; re-checked inside the transaction.
  const { parent } = await loadParent(getDb(), ctx, spec, p.entityId, 'update');
  assertCan(ctx, 'create', documentResource(true, true));
  const mimeType = assertFileAcceptable(file);
  const sha256 = sha256Hex(file.bytes);

  const store = getFileStore();
  const folder = `${getEnv().CLOUDINARY_FOLDER ?? `sales-tracker/${getEnv().NODE_ENV}`}/${p.kind.toLowerCase()}`;
  const stored = await store.put({ bytes: file.bytes, mimeType, folder });

  let documentId: string;
  let queued: boolean;
  try {
    ({ documentId, queued } = await withTx(ctx, async (tx) => {
      const { parent: current } = await loadParent(tx, ctx, spec, p.entityId, 'update');
      const enabled = await extractionEnabled(tx);
      const doc = await tx.document.create({
        data: {
          kind: p.kind,
          entityId: parent.id,
          clientId: current.clientId,
          uploadedById: ctx.user.id,
          storageKey: stored.storageKey,
          resourceType: stored.resourceType,
          originalFilename: cleanFilename(file.filename),
          mimeType,
          sizeBytes: file.bytes.length,
          sha256,
          extractionStatus: enabled ? 'QUEUED' : 'SKIPPED',
        },
      });
      if (current.documentId) {
        await tx.document.updateMany({
          where: { id: current.documentId, deletedAt: null },
          data: { deletedAt: new Date() },
        });
      }
      if (!(await spec.setDocument(tx, parent.id, doc.id, current.documentId))) {
        throw new DomainError('Someone else changed this document. Reload and try again.');
      }
      return { documentId: doc.id, queued: enabled };
    }));
  } catch (error) {
    await store.remove(stored).catch(() => undefined);
    throw error;
  }

  if (queued) await queueAfterCommit(documentId);
  return viewOf(getDb(), ctx, documentId);
}

// ─── Extraction (worker) ────────────────────────────────────────────────────────────

const FILE_UNREADABLE = 'The stored file could not be opened. Upload it again.';

/**
 * Jobs run as the system actor only: the source must be `system`, and the type-level
 * `update` on documents passes only for admins (the system user is one), never for a
 * rep who could otherwise start or re-queue extractions from the web.
 */
function assertSystemJob(ctx: Ctx) {
  if (ctx.source !== 'system') throw new ForbiddenError('run', 'document');
  assertCan(ctx, 'update', 'document');
}

/**
 * Runs one extraction job (worker only, system context). Claims the document with a
 * conditional update, so two workers never both call the extractor; reads the file; asks
 * the extractor; stores the result on the document. **Never writes to the record.**
 *
 * A retryable failure puts the document back to QUEUED and rethrows, so BullMQ retries;
 * on the last attempt it is FAILED instead.
 */
export async function runExtraction(
  ctx: Ctx,
  documentId: string,
  options: { attempt?: number; maxAttempts?: number } = {},
): Promise<'done' | 'skipped'> {
  assertSystemJob(ctx);
  const attempt = options.attempt ?? 1;
  const maxAttempts = options.maxAttempts ?? 1;
  const db = getDb();

  // Turned off after this job was queued: leave it QUEUED for "Try again" (AC9).
  if (!(await extractionEnabled(db))) return 'skipped';

  // Deleted, reviewed, or not in a state that can start (e.g. already running): nothing to do.
  const current = await db.document.findFirst({
    where: { id: documentId, reviewStatus: 'PENDING' },
    select: { extractionStatus: true },
  });
  if (!current || !canTransitionExtraction(current.extractionStatus, 'RUNNING')) return 'skipped';

  // The claim is conditional on the status just read, so two workers never both run it.
  const claimed = await withTx(ctx, async (tx) => {
    const { count } = await tx.document.updateMany({
      where: {
        id: documentId,
        extractionStatus: current.extractionStatus,
        reviewStatus: 'PENDING',
        deletedAt: null,
      },
      data: { extractionStatus: 'RUNNING', extractionAttempts: { increment: 1 } },
    });
    return count === 1;
  });
  if (!claimed) return 'skipped';

  const doc = await db.document.findUniqueOrThrow({ where: { id: documentId } });
  const spec = kindSpec(doc.kind);
  /**
   * Every outcome is written only while the document is still RUNNING (a run the sweeper
   * re-queued meanwhile writes nothing), so the machine checks each move from RUNNING.
   */
  const finish = (to: ExtractionStatus, data: Prisma.DocumentUpdateManyMutationInput) => {
    assertExtractionTransition('RUNNING', to);
    return withTx(ctx, (tx) =>
      tx.document.updateMany({
        where: { id: documentId, extractionStatus: 'RUNNING' },
        data: { ...data, extractionStatus: to },
      }),
    );
  };
  const fail = (message: string) => finish('FAILED', { extractionError: message.slice(0, 500) });
  if (!spec) {
    await fail(EXTRACTION_MESSAGES.unreadable);
    return 'done';
  }

  let bytes: Uint8Array;
  try {
    bytes = await getFileStore().get(doc);
  } catch (error) {
    console.error('document file could not be read', documentId, error);
    await fail(FILE_UNREADABLE);
    return 'done';
  }

  const [client, settings] = await Promise.all([
    db.client.findFirst({
      where: { id: doc.clientId, deletedAt: undefined },
      select: { name: true },
    }),
    db.companySettings.findUnique({
      where: { id: SETTINGS_ID },
      select: { enabledCurrencies: true },
    }),
  ]);

  try {
    const result = await getExtractor().extract({
      kind: doc.kind,
      bytes,
      mimeType: doc.mimeType,
      sha256: doc.sha256,
      fields: spec.fields,
      context: { clientName: client?.name ?? '', currencies: settings?.enabledCurrencies ?? [] },
    });
    if (result.ok) {
      await finish('SUCCEEDED', {
        extraction: result.extraction as unknown as Prisma.InputJsonValue,
        extractionModel: result.model,
        extractedAt: new Date(),
        extractionError: null,
      });
    } else {
      await fail(result.message);
    }
    return 'done';
  } catch (error) {
    if (error instanceof RetryableExtractionError) {
      if (attempt < maxAttempts) {
        await finish('QUEUED', { extractionError: error.message });
        throw error; // BullMQ retries with backoff
      }
      await fail(EXTRACTION_MESSAGES.unavailable);
      return 'done';
    }
    console.error('document extraction failed', documentId, error);
    await fail(EXTRACTION_MESSAGES.unreadable);
    return 'done';
  }
}

/** Minutes before a QUEUED document without a job, or a RUNNING one, counts as stuck. */
export const STUCK_QUEUED_MINUTES = 5;
export const STUCK_RUNNING_MINUTES = 15;

/**
 * The worker's sweeper (M7): re-queues documents left QUEUED (the enqueue after commit
 * failed) or RUNNING (the worker died mid-job). Returns the ids it queued.
 */
export async function sweepStuckDocuments(ctx: Ctx, now = new Date()): Promise<string[]> {
  assertSystemJob(ctx);
  const minutesAgo = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
  const stale = await getDb().document.findMany({
    where: {
      reviewStatus: 'PENDING',
      OR: [
        { extractionStatus: 'QUEUED', updatedAt: { lt: minutesAgo(STUCK_QUEUED_MINUTES) } },
        { extractionStatus: 'RUNNING', updatedAt: { lt: minutesAgo(STUCK_RUNNING_MINUTES) } },
      ],
    },
    select: { id: true, extractionStatus: true },
  });
  const running = stale.filter((d) => d.extractionStatus === 'RUNNING');
  for (const d of running) assertExtractionTransition(d.extractionStatus, 'QUEUED');
  if (running.length > 0) {
    await withTx(ctx, (tx) =>
      tx.document.updateMany({
        where: { id: { in: running.map((d) => d.id) }, extractionStatus: 'RUNNING' },
        data: { extractionStatus: 'QUEUED' },
      }),
    );
  }
  for (const { id } of stale) await enqueueExtraction(id);
  return stale.map((d) => d.id);
}

// ─── Reads ──────────────────────────────────────────────────────────────────────────

export async function getDocument(ctx: Ctx, id: string): Promise<DocumentView> {
  return viewOf(getDb(), ctx, id);
}

/** The record's current document, or null. */
export async function getCurrentDocument(
  ctx: Ctx,
  kind: DocumentKindValue,
  entityId: string,
): Promise<DocumentView | null> {
  const spec = specFor(kind);
  const { parent } = await loadParent(getDb(), ctx, spec, entityId, 'read');
  return parent.documentId ? viewOf(getDb(), ctx, parent.documentId, 'live') : null;
}

/**
 * The file itself, after a read check: a short-lived signed link where the store has them
 * (Cloudinary), otherwise the bytes for the web app to stream (Decision 3).
 */
export async function getDocumentFile(ctx: Ctx, id: string): Promise<DocumentFile> {
  const { doc } = await loadDocument(getDb(), ctx, id, 'read', 'any');
  const store = getFileStore();
  const url = store.signedUrl(doc, 300);
  if (url) return { type: 'redirect', url };
  return {
    type: 'bytes',
    bytes: await store.get(doc),
    mimeType: doc.mimeType,
    filename: doc.originalFilename,
  };
}

/** Document scope for the actor: admins all, others per kind's readable records. */
async function documentScope(db: Db, ctx: Ctx): Promise<Prisma.DocumentWhereInput> {
  if (ctx.user.role === 'ADMIN') return {};
  const visible: Partial<Record<DocumentKindValue, string[]>> = {};
  for (const [kind, spec] of supportedKinds()) {
    visible[kind] = await spec.visibleIds(db, ctx.user);
  }
  return scopeDocuments(ctx.user, visible);
}

async function toRows(db: Db, docs: DocumentWithUsers[]): Promise<DocumentRow[]> {
  const labels = new Map<string, string>();
  for (const [kind, spec] of supportedKinds()) {
    const ids = docs.filter((d) => d.kind === kind).map((d) => d.entityId);
    if (ids.length === 0) continue;
    for (const [id, { label }] of await spec.labels(db, ids)) labels.set(id, label);
  }
  return docs.map((d) => ({
    id: d.id,
    kind: d.kind,
    entityId: d.entityId,
    entityLabel: labels.get(d.entityId) ?? '',
    originalFilename: d.originalFilename,
    mimeType: d.mimeType,
    sizeBytes: d.sizeBytes,
    uploadedBy: d.uploadedBy,
    createdAt: d.createdAt,
    extractionStatus: d.extractionStatus,
    reviewStatus: d.reviewStatus,
    deletedAt: d.deletedAt,
  }));
}

export async function listDocuments(
  ctx: Ctx,
  input: ListDocumentsInput,
): Promise<Page<DocumentRow>> {
  const p = listDocumentsSchema.parse(input);
  assertCan(ctx, 'list', 'document');
  const db = getDb();
  const where: Prisma.DocumentWhereInput = {
    ...(p.recordStatus === 'deleted' ? { deletedAt: { not: null } } : { deletedAt: null }),
    ...(p.kind && { kind: { in: p.kind } }),
    ...(p.entityId && { entityId: p.entityId }),
    ...(p.clientId && { clientId: p.clientId }),
    ...(p.uploadedById && { uploadedById: p.uploadedById }),
    ...(p.extractionStatus && { extractionStatus: { in: p.extractionStatus } }),
    ...(p.reviewStatus && { reviewStatus: { in: p.reviewStatus } }),
    ...(p.q && { originalFilename: { contains: p.q, mode: 'insensitive' as const } }),
    AND: [await documentScope(db, ctx)],
  };
  const [total, docs] = await Promise.all([
    db.document.count({ where }),
    db.document.findMany({
      where,
      include: documentInclude,
      orderBy: [{ createdAt: p.dir ?? 'desc' }, { id: 'asc' }],
      skip: (p.page - 1) * p.pageSize,
      take: p.pageSize,
    }),
  ]);
  return { items: await toRows(db, docs), total, page: p.page, pageSize: p.pageSize };
}

/**
 * Extracted, unreviewed current documents the actor uploaded or whose record they own
 * (M11's "documents to review"; the M7 open question, drafted as uploader + owner).
 */
export async function listDocumentsPendingReview(ctx: Ctx): Promise<DocumentRow[]> {
  assertCan(ctx, 'list', 'document');
  const db = getDb();
  const mine: Prisma.DocumentWhereInput[] = [{ uploadedById: ctx.user.id }];
  const current: Prisma.DocumentWhereInput[] = [];
  for (const [kind, spec] of supportedKinds()) {
    current.push({ kind, ...spec.currentWhere });
    if (kind === 'QUOTATION') mine.push({ kind, quotation: { is: { ownerId: ctx.user.id } } });
    // M9: a PO document is its pipeline owner's and its project manager's to review.
    if (kind === 'PURCHASE_ORDER') {
      mine.push({
        kind,
        purchaseOrder: {
          is: {
            project: {
              OR: [{ managerId: ctx.user.id }, { quotation: { ownerId: ctx.user.id } }],
            },
          },
        },
      });
    }
  }
  const docs = await db.document.findMany({
    where: {
      deletedAt: null,
      extractionStatus: 'SUCCEEDED',
      reviewStatus: 'PENDING',
      AND: [{ OR: mine }, { OR: current }, await documentScope(db, ctx)],
    },
    include: documentInclude,
    orderBy: [{ extractedAt: 'asc' }, { id: 'asc' }],
  });
  return toRows(db, docs);
}

// ─── Review, retry, delete ──────────────────────────────────────────────────────────

const CONCURRENT_DOCUMENT_CHANGE = 'Someone else changed this document. Reload and try again.';

/** "Try again": queues a finished, unreviewed extraction again (clears the old result). */
export async function retryExtraction(ctx: Ctx, id: string): Promise<DocumentView> {
  await withTx(ctx, async (tx) => {
    const { doc, parent } = await loadDocument(tx, ctx, id, 'update');
    if (parent.documentId !== doc.id) {
      throw new DomainError('Only the current document can be read again');
    }
    assertCanRetry(doc);
    if (!(await extractionEnabled(tx))) {
      throw new DomainError('Reading documents with AI is turned off in settings');
    }
    assertExtractionTransition(doc.extractionStatus, 'QUEUED');
    const { count } = await tx.document.updateMany({
      where: {
        id,
        extractionStatus: doc.extractionStatus,
        reviewStatus: 'PENDING',
        deletedAt: null,
      },
      data: {
        extractionStatus: 'QUEUED',
        extractionError: null,
        extraction: Prisma.DbNull,
        extractionModel: null,
        extractedAt: null,
      },
    });
    if (count === 0) throw new DomainError(CONCURRENT_DOCUMENT_CHANGE);
  });
  await queueAfterCommit(id);
  return viewOf(getDb(), ctx, id);
}

/**
 * The only path from an extraction to a record (the M7 "done when"). Applies the ticked
 * values, as the reviewer left them, through the record's own update service, and marks
 * the document reviewed, in one transaction. An empty `apply` is "confirm without changes".
 */
export async function confirmExtraction(
  ctx: Ctx,
  input: ConfirmExtractionInput,
): Promise<DocumentView> {
  const p = confirmExtractionSchema.parse(input);
  await withTx(ctx, async (tx) => {
    const { doc, spec, parent } = await loadDocument(tx, ctx, p.documentId, 'update');
    if (parent.documentId !== doc.id) {
      throw new DomainError(`This is no longer the ${spec.label.toLowerCase()}’s current document`);
    }
    const keys = Object.keys(p.apply);
    assertCanConfirm(doc, { applying: keys.length > 0 });

    const mapped = new Set(spec.reviewFields.flatMap((row) => row.applies));
    const unknown = keys.find((key) => !mapped.has(key));
    if (unknown) {
      throw new DomainError('That field cannot be set from a document', { field: unknown });
    }
    for (const row of spec.reviewFields) {
      const given = row.applies.filter((name) => name in p.apply);
      if (given.length === 0) continue;
      if (given.length !== row.applies.length) {
        throw new DomainError(`${row.label} needs all of its values`, { field: row.name });
      }
      const locked = parent.locked[row.name];
      if (locked) throw new DomainError(locked, { field: row.name });
    }

    if (keys.length > 0) await spec.applyConfirmed(ctx, parent.id, p.apply);

    const { count } = await tx.document.updateMany({
      where: {
        id: doc.id,
        reviewStatus: 'PENDING',
        extractionStatus: doc.extractionStatus,
        deletedAt: null,
      },
      data: {
        reviewStatus: 'CONFIRMED',
        reviewedById: ctx.user.id,
        reviewedAt: new Date(),
        appliedFields: keys.sort(),
      },
    });
    if (count === 0) throw new DomainError(CONCURRENT_DOCUMENT_CHANGE);
  });
  return viewOf(getDb(), ctx, p.documentId);
}

/** Soft delete; the record loses it as its current document. The stored file is kept. */
export async function softDeleteDocument(ctx: Ctx, id: string): Promise<DocumentView> {
  await withTx(ctx, async (tx) => {
    const { doc, spec, parent } = await loadDocument(tx, ctx, id, 'delete');
    const { count } = await tx.document.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new DomainError(CONCURRENT_DOCUMENT_CHANGE);
    if (parent.documentId === doc.id) await spec.setDocument(tx, parent.id, null, doc.id);
  });
  return viewOf(getDb(), ctx, id);
}

/** Restores a document; it becomes current again only if the record has none. */
export async function restoreDocument(ctx: Ctx, id: string): Promise<DocumentView> {
  await withTx(ctx, async (tx) => {
    const { doc, spec, parent } = await loadDocument(tx, ctx, id, 'delete', 'deleted');
    const { count } = await tx.document.updateMany({
      where: { id, deletedAt: { not: null } },
      data: { deletedAt: null },
    });
    if (count === 0) throw new DomainError(CONCURRENT_DOCUMENT_CHANGE);
    if (parent.documentId === null) await spec.setDocument(tx, parent.id, doc.id, null);
  });
  return viewOf(getDb(), ctx, id);
}
