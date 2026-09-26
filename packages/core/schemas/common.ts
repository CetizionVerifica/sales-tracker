import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationInput = z.input<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Transport shape for actions that target one record: `{ id, data }`. */
export function withId<S extends z.ZodType>(data: S) {
  return z.object({ id: z.string().min(1), data });
}

export const idOnlySchema = z.object({ id: z.string().min(1) });
