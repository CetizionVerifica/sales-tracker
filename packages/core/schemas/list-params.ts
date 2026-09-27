import { z } from 'zod';
import { paginationSchema } from './common.ts';

/** Shared list-page input: pagination, free-text search and one sort column. */
export const listParamsSchema = paginationSchema.extend({
  q: z
    .string()
    .trim()
    .max(100)
    .optional()
    .transform((q) => (q ? q : undefined)),
  sort: z.string().max(40).optional(),
  dir: z.enum(['asc', 'desc']).optional(),
});

export type ListParams = z.output<typeof listParamsSchema>;

/** Live rows by default; "deleted" shows only soft-deleted ones (restore view). */
export const recordStatusSchema = z.enum(['live', 'deleted']).default('live');

/** A comma-separated URL value (`IN_PROGRESS,LOST`) or an array, as a list of enum values. */
export function multi<T extends readonly [string, ...string[]]>(values: T) {
  return z.preprocess(
    (value) => {
      const list = typeof value === 'string' ? value.split(',') : value;
      if (!Array.isArray(list)) return list;
      const cleaned = list.map((v) => String(v).trim()).filter(Boolean);
      return cleaned.length ? cleaned : undefined;
    },
    z.array(z.enum(values)).optional(),
  );
}

/** `true`/`false` from a URL, or a boolean. */
export const flag = z
  .union([
    z.boolean(),
    z.enum(['true', 'false', '1', '0', '']).transform((v) => v === 'true' || v === '1'),
  ])
  .default(false);
