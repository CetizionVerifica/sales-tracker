import { z } from 'zod';
import { listParamsSchema } from './list-params.ts';

/** Shown for every sign-in failure so the response never reveals whether an email exists. */
export const SIGN_IN_FAILED = 'Email or password is incorrect';

export const signInSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const userIdSchema = z.string().min(1);

export const roleSchema = z.enum(['ADMIN', 'SALES', 'PROJECT_MANAGER']);

export const newPasswordSchema = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(128, 'Use at most 128 characters');

const nameSchema = z.string().trim().min(1, 'Enter a name').max(100);
const emailSchema = z
  .email('Enter a valid email address')
  .transform((email) => email.trim().toLowerCase());

export const createUserSchema = z.object({
  name: nameSchema,
  email: emailSchema,
  role: roleSchema,
  password: newPasswordSchema,
});

export const updateUserSchema = z
  .object({ name: nameSchema, email: emailSchema, role: roleSchema })
  .partial()
  .refine((input) => Object.keys(input).length > 0, 'Nothing to update');

export const resetPasswordSchema = z.object({ password: newPasswordSchema });

export const changeOwnPasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Enter your current password'),
    newPassword: newPasswordSchema,
  })
  .refine((input) => input.newPassword !== input.currentPassword, {
    message: 'Choose a password different from the current one',
    path: ['newPassword'],
  });

export const listUsersSchema = listParamsSchema.extend({
  role: roleSchema.optional(),
  status: z.enum(['active', 'inactive']).optional(),
  sort: z.enum(['name', 'email', 'createdAt']).optional(),
});

export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;
export type ResetPasswordInput = z.input<typeof resetPasswordSchema>;
export type ChangeOwnPasswordInput = z.input<typeof changeOwnPasswordSchema>;
export type ListUsersInput = z.input<typeof listUsersSchema>;
