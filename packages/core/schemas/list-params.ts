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
