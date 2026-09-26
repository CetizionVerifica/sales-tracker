import type { AuditAction } from '@sales-tracker/db';

export const REDACTED = '[redacted]';

/** Never stored in audit rows; a change still shows up in changedFields. */
const CREDENTIAL_FIELDS = new Set(['password', 'accessToken', 'refreshToken', 'idToken', 'token']);

/** Always changes on update; excluded from changedFields to keep them meaningful. */
const NOISE_FIELDS = new Set(['updatedAt']);

type Row = Record<string, unknown>;
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

function toJsonValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (typeof value === 'object') {
    // Prisma Decimal and other value objects serialise via toJSON/toString.
    if ('toJSON' in value && typeof value.toJSON === 'function') return toJsonValue(value.toJSON());
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonValue(v)]));
  }
  return value as JsonValue;
}

/** A row as stored in AuditLog.before/after: JSON-safe, credentials redacted. */
export function toAuditJson(row: Row | null | undefined): Record<string, JsonValue> | null {
  if (!row) return null;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      CREDENTIAL_FIELDS.has(key) && value !== null && value !== undefined
        ? REDACTED
        : toJsonValue(value),
    ]),
  );
}

/** Fields whose values differ between two raw (unredacted) rows. Empty for create/delete. */
export function changedFields(before: Row | null, after: Row | null): string[] {
  if (!before || !after) return [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys]
    .filter((key) => !NOISE_FIELDS.has(key))
    .filter(
      (key) => JSON.stringify(toJsonValue(before[key])) !== JSON.stringify(toJsonValue(after[key])),
    )
    .sort();
}

export function classifyAction(
  operation: 'create' | 'update' | 'delete',
  before: Row | null,
  after: Row | null,
): AuditAction {
  if (operation === 'create') return 'CREATE';
  if (operation === 'delete') return 'DELETE';
  if (after && 'deletedAt' in after) {
    const was = before?.deletedAt ?? null;
    const now = after.deletedAt ?? null;
    if (was === null && now !== null) return 'SOFT_DELETE';
    if (was !== null && now === null) return 'RESTORE';
  }
  return 'UPDATE';
}

/** Relation operations that write the related model (invisible to its audit hook). */
const NESTED_WRITE_OPS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'delete',
  'deleteMany',
  'connectOrCreate',
]);

/**
 * Rejects nested writes on relation fields (M2 AC4). `connect`, `disconnect` and `set`
 * only change foreign keys, which the parent's before/after already records.
 */
export function assertNoNestedWrites(model: string, relations: readonly string[], data: unknown) {
  for (const row of Array.isArray(data) ? data : [data]) {
    if (!row || typeof row !== 'object') continue;
    for (const field of relations) {
      const value = (row as Row)[field];
      if (!value || typeof value !== 'object') continue;
      const nested = Object.keys(value).filter((op) => NESTED_WRITE_OPS.has(op));
      if (nested.length > 0) {
        throw new Error(
          `Nested write (${nested.join(', ')}) on ${model}.${field} is not audited; ` +
            'write each model separately inside withTx.',
        );
      }
    }
  }
}
