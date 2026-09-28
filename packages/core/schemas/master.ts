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

/**
 * Sectors add `isOther` (M12b): grouped into "Other sectors" on the sales reports regardless
 * of rank. Services share every other master field but not this one, so sectors get their
 * own create/update schema instead of widening the shared one.
 */
export const createSectorSchema = createMasterSchema.extend({
  isOther: z.boolean().default(false),
});

export const updateSectorSchema = z
  .object({ name: masterNameSchema, active: z.boolean(), isOther: z.boolean() })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export type CreateSectorInput = z.input<typeof createSectorSchema>;
export type UpdateSectorInput = z.input<typeof updateSectorSchema>;

// Server-action transport shapes (sectors and services share one set of actions). `data` uses
// the sector schema, a strict superset of the service one (`isOther` optional): each entity's
// own service re-parses with its own schema, so a service update simply drops the extra field.
export const masterKindSchema = z.enum(['sector', 'service']);
export const masterCreateActionSchema = z.object({
  kind: masterKindSchema,
  data: createSectorSchema,
});
export const masterUpdateActionSchema = withId(updateSectorSchema).extend({
  kind: masterKindSchema,
});
export const masterIdActionSchema = idOnlySchema.extend({ kind: masterKindSchema });
