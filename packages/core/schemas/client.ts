import { z } from 'zod';
import { idOnlySchema, withId } from './common.ts';
import { listParamsSchema } from './list-params.ts';

/** 2-digit state code, 10-character PAN, entity number, "Z", checksum character. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

/**
 * Optional text: `undefined` = not provided / unchanged (updates), `''` or `null` = empty
 * (stored as null, so an update can clear a field that was set).
 */
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' ? null : value));

/** Same contract for fields with a format: '' clears, otherwise the format must match. */
function clearable<T extends z.ZodType>(format: T) {
  return z.union([z.literal('').transform(() => null), z.null(), format]).optional();
}

export const gstinSchema = clearable(
  z.string().trim().toUpperCase().regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN'),
);

export const contactSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  designation: optionalText(100),
  email: clearable(z.email('Enter a valid email')),
  phone: clearable(
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number'),
  ),
  isPrimary: z.boolean().default(false),
});

export const updateContactSchema = contactSchema
  .omit({ isPrimary: true })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

const clientFields = {
  name: z.string().trim().min(1, 'Enter a name').max(200),
  sectorId: z.string().min(1, 'Choose a sector'),
  gstin: gstinSchema,
  address: optionalText(500),
  notes: optionalText(2000),
};

export const createClientSchema = z.object({
  ...clientFields,
  contacts: z.array(contactSchema).max(20).default([]),
});

/** The client form (new and edit pages): contacts are managed separately on the detail page. */
export const clientFormSchema = createClientSchema.omit({ contacts: true });

export const updateClientSchema = z
  .object(clientFields)
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const listClientsSchema = listParamsSchema.extend({
  sectorId: z.string().min(1).optional(),
  status: z.enum(['live', 'deleted']).default('live'),
  sort: z.enum(['name', 'createdAt']).optional(),
});

export type ContactInput = z.input<typeof contactSchema>;
export type UpdateContactInput = z.input<typeof updateContactSchema>;
export type CreateClientInput = z.input<typeof createClientSchema>;
export type ClientFormInput = z.input<typeof clientFormSchema>;
export type UpdateClientInput = z.input<typeof updateClientSchema>;
export type ListClientsInput = z.input<typeof listClientsSchema>;

// Server-action transport shapes for contacts (the client id is for revalidating its page).
export const contactUpdateActionSchema = withId(updateContactSchema).extend({
  clientId: z.string().min(1),
});
export const contactIdActionSchema = idOnlySchema.extend({ clientId: z.string().min(1) });
