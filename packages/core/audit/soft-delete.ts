import { SoftDeleteError } from '../errors.ts';
import { modelFields } from './model-meta.ts';

type Args = Record<string, unknown>;

/** Top-level reads that hide soft-deleted rows by default. */
const FILTERED_READS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** A model is soft-deletable when it has a `deletedAt` column (CLAUDE.md rule 4). */
export function isSoftDeletable(model: string): boolean {
  return modelFields()[model]?.scalars.includes('deletedAt') ?? false;
}

/**
 * Adds `deletedAt: null` to reads unless the top-level `where` already mentions `deletedAt`
 * (the explicit opt-in: `{ deletedAt: { not: null } }` for deleted rows, or
 * `{ deletedAt: undefined }` for all rows, which Prisma ignores). Relations loaded with
 * `include` are not filtered here; services filter those themselves.
 */
export function applySoftDelete(model: string, operation: string, args: Args): Args {
  if (!isSoftDeletable(model)) return args;
  if (operation === 'delete' || operation === 'deleteMany') {
    throw new SoftDeleteError(
      `${model}.${operation} is not allowed: soft delete by setting deletedAt instead`,
    );
  }
  if (!FILTERED_READS.has(operation)) return args;
  const where = (args.where ?? {}) as Args;
  if ('deletedAt' in where) return args;
  return { ...args, where: { ...where, deletedAt: null } };
}

/** Marks an internal read as seeing every row (used by the audit extension). */
export function withDeleted(where: unknown, model: string): Args {
  const base = (where ?? {}) as Args;
  return isSoftDeletable(model) ? { ...base, deletedAt: undefined } : base;
}
