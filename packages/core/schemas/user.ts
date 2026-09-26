import { z } from 'zod';

/** Shown for every sign-in failure so the response never reveals whether an email exists. */
export const SIGN_IN_FAILED = 'Email or password is incorrect';

export const signInSchema = z.object({
  email: z.email('Enter a valid email address'),
  password: z.string().min(1, 'Enter your password'),
});

export type SignInInput = z.infer<typeof signInSchema>;

export const userIdSchema = z.string().min(1);
