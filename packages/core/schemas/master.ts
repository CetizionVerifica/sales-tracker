import { z } from 'zod';
import { idOnlySchema, withId } from './common.ts';
import { listParamsSchema } from './list-params.ts';

/** Sectors and services share one shape (M3). */
export const masterNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name')
  .max(100, 'Keep it under 100 characters');

export const createMasterSchema = z.object({
  name: masterNameSchema,
  active: z.boolean().default(true),
});

export const updateMasterSchema = z
  .object({ name: masterNameSchema, active: z.boolean() })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listMastersSchema = listParamsSchema.extend({
  status: z.enum(['live', 'active', 'inactive', 'deleted']).default('live'),
  sort: z.enum(['name', 'createdAt']).optional(),
});

export type CreateMasterInput = z.input<typeof createMasterSchema>;
export type UpdateMasterInput = z.input<typeof updateMasterSchema>;
export type ListMastersInput = z.input<typeof listMastersSchema>;

// Server-action transport shapes (sectors and services share one set of actions).
export const masterKindSchema = z.enum(['sector', 'service']);
export const masterCreateActionSchema = z.object({
  kind: masterKindSchema,
  data: createMasterSchema,
});
export const masterUpdateActionSchema = withId(updateMasterSchema).extend({
  kind: masterKindSchema,
});
export const masterIdActionSchema = idOnlySchema.extend({ kind: masterKindSchema });
