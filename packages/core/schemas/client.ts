import { z } from 'zod';
import { listParamsSchema } from './list-params.ts';

/** 2-digit state code, 10-character PAN, entity number, "Z", checksum character. */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((value) => (value ? value : undefined));

export const gstinSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, 'Enter a valid 15-character GSTIN')
  .optional()
  .or(z.literal('').transform(() => undefined));

export const contactSchema = z.object({
  name: z.string().trim().min(1, 'Enter a name').max(100),
  designation: optionalText(100),
  email: z
    .email('Enter a valid email')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9 ()-]{7,20}$/, 'Enter a valid phone number')
    .optional()
    .or(z.literal('').transform(() => undefined)),
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
