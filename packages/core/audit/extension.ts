import { Prisma } from '@sales-tracker/db';
import { AuditContextError } from '../errors.ts';
import { isAudited, modelFields } from './model-meta.ts';
import { assertNoNestedWrites, changedFields, classifyAction, toAuditJson } from './snapshot.ts';
import { applySoftDelete, withDeleted } from './soft-delete.ts';
import { getStore, type AuditStore } from './store.ts';

/** Audited models have a single `id` (string UUIDs, or Int for the CompanySettings singleton). */
type Row = Record<string, unknown> & { id: string };
type Args = Record<string, unknown>;

/**
 * The slice of a model delegate the extension uses on the transaction client. Typed
 * structurally because delegates differ per model; all audited models have a single `id`
 * (enforced by the AC13 coverage test).
 */
interface Delegate {
  findUnique(args: Args): Promise<Row | null>;
  findUniqueOrThrow(args: Args): Promise<Row>;
  findMany(args: Args): Promise<Row[]>;
  createManyAndReturn(args: Args): Promise<Row[]>;
}

interface AuditLogDelegate {
  createMany(args: { data: Prisma.AuditLogCreateManyInput[] }): Promise<unknown>;
}

interface TxClient {
  auditLog: AuditLogDelegate;
  [delegate: string]: unknown;
}

const WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'upsert',
  'delete',
  'deleteMany',
]);

const lcFirst = (model: string) => model.charAt(0).toLowerCase() + model.slice(1);

function requireStore(model: string, operation: string): AuditStore & { tx: TxClient } {
  const store = getStore();
  if (!store) {
    throw new AuditContextError(
      `${model}.${operation} ran without an acting context; wrap it in withTx(ctx, …)`,
    );
  }
  if (!store.tx) {
    throw new AuditContextError(
      `${model}.${operation} ran outside a transaction; audited writes must use withTx(ctx, …)`,
    );
  }
  return store as AuditStore & { tx: TxClient };
}

/** Makes sure `id` comes back so the full row can be re-read; reports whether we added it. */
function withId(args: Args): { args: Args; added: boolean } {
  const select = args.select as Record<string, unknown> | undefined;
  if (select && !select.id)
    return { args: { ...args, select: { ...select, id: true } }, added: true };
  const omit = args.omit as Record<string, unknown> | undefined;
  if (omit?.id) return { args: { ...args, omit: { ...omit, id: false } }, added: true };
  return { args, added: false };
}

function stripId<T>(result: T, added: boolean): T {
  if (!added || !result || typeof result !== 'object') return result;
  const { id: _id, ...rest } = result as Row;
  return rest as T;
}

/** Restricts a bulk write to the ids that were read (and will be audited). */
export function pinnedWhere(where: unknown, ids: string[]): Args {
  const pin = { id: { in: ids } };
  return where ? { AND: [where, pin] } : pin;
}

function rejectLimit(model: string, operation: string, args: Args) {
  if (args.limit !== undefined) {
    throw new Error(
      `${model}.${operation} with a limit is not supported: the audited rows would be ambiguous`,
    );
  }
}

type Entry = { operation: 'create' | 'update' | 'delete'; before: Row | null; after: Row | null };

async function writeAudit(store: AuditStore & { tx: TxClient }, model: string, entries: Entry[]) {
  if (entries.length === 0) return;
  await store.tx.auditLog.createMany({
    data: entries.map(({ operation, before, after }) => ({
      actorId: store.ctx.user.id,
      source: store.ctx.source,
      action: classifyAction(operation, before, after),
      entityType: model,
      entityId: String((after ?? before)!.id), // Int ids (CompanySettings) stored as text
      before: toAuditJson(before) ?? Prisma.DbNull,
      after: toAuditJson(after) ?? Prisma.DbNull,
      changedFields: changedFields(before, after),
      requestId: store.requestId,
    })),
  });
}

/** Rows affected by a bulk write, matched by id so the before/after pair up. */
async function rowsById(
  delegate: Delegate,
  model: string,
  ids: string[],
): Promise<Map<string, Row>> {
  const rows = await delegate.findMany({ where: withDeleted({ id: { in: ids } }, model) });
  return new Map(rows.map((row) => [row.id, row]));
}

interface OperationParams {
  model: string;
  operation: string;
  args: Args;
  query: (args: Args) => Promise<unknown>;
}

/**
 * The audit hook for every model write (CLAUDE.md rule 3). Runs the before-read, the write
 * and the audit insert on the active transaction client, so they commit or roll back
 * together. Reads and excluded models pass straight through.
 */
export async function auditOperation(params: OperationParams) {
  // Soft delete first: filters reads and rejects hard deletes on soft-deletable models (M3).
  const args = applySoftDelete(params.model, params.operation, params.args);
  const { model, operation, query } = params;
  if (!WRITE_OPERATIONS.has(operation) || !isAudited(model)) return query(args);

  const store = requireStore(model, operation);
  const delegate = store.tx[lcFirst(model)] as Delegate;
  const relations = modelFields()[model]?.relations ?? [];
  assertNoNestedWrites(model, relations, args.data);
  if (operation === 'upsert') {
    assertNoNestedWrites(model, relations, args.create);
    assertNoNestedWrites(model, relations, args.update);
  }

  switch (operation) {
    case 'create': {
      const call = withId(args);
      const result = (await query(call.args)) as Row;
      const after = await delegate.findUniqueOrThrow({
        where: withDeleted({ id: result.id }, model),
      });
      await writeAudit(store, model, [{ operation: 'create', before: null, after }]);
      return stripId(result, call.added);
    }

    case 'createMany': {
      // Needs the new ids: re-issue as createManyAndReturn (audited via this same hook).
      const rows = await delegate.createManyAndReturn({ ...args, select: { id: true } });
      return { count: rows.length };
    }

    case 'createManyAndReturn': {
      const call = withId(args);
      const result = (await query(call.args)) as Row[];
      const after = await rowsById(
        delegate,
        model,
        result.map((row) => row.id),
      );
      await writeAudit(
        store,
        model,
        result.map((row) => ({ operation: 'create', before: null, after: after.get(row.id)! })),
      );
      return result.map((row) => stripId(row, call.added));
    }

    case 'update':
    case 'upsert': {
      const before = await delegate.findUnique({ where: withDeleted(args.where, model) });
      const call = withId(args);
      const result = (await query(call.args)) as Row;
      const after = await delegate.findUniqueOrThrow({
        where: withDeleted({ id: result.id }, model),
      });
      await writeAudit(store, model, [{ operation: before ? 'update' : 'create', before, after }]);
      return stripId(result, call.added);
    }

    case 'updateMany':
    case 'updateManyAndReturn': {
      rejectLimit(model, operation, args);
      const before = await delegate.findMany({ where: withDeleted(args.where, model) });
      const ids = before.map((row) => row.id);
      // Write exactly the rows read and audited: under READ COMMITTED the original filter
      // could also match a row another transaction commits in between (M2 review fix B).
      const result = await query({ ...args, where: pinnedWhere(args.where, ids) });
      const after = await rowsById(delegate, model, ids);
      await writeAudit(
        store,
        model,
        before.map((row) => ({
          operation: 'update',
          before: row,
          after: after.get(row.id) ?? null,
        })),
      );
      return result;
    }

    case 'delete': {
      const before = await delegate.findUnique({ where: withDeleted(args.where, model) });
      const result = await query(args);
      if (before) await writeAudit(store, model, [{ operation: 'delete', before, after: null }]);
      return result;
    }

    case 'deleteMany': {
      rejectLimit(model, operation, args);
      const before = await delegate.findMany({ where: withDeleted(args.where, model) });
      const result = await query({
        ...args,
        where: pinnedWhere(
          args.where,
          before.map((row) => row.id),
        ),
      });
      await writeAudit(
        store,
        model,
        before.map((row) => ({ operation: 'delete', before: row, after: null })),
      );
      return result;
    }

    default:
      throw new Error(`Unhandled audited operation ${model}.${operation}`);
  }
}
