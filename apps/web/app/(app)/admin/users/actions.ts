'use server';

import {
  createUser,
  deactivateUser,
  reactivateUser,
  resetUserPassword,
  updateUser,
} from '@sales-tracker/core';
import {
  createUserSchema,
  idOnlySchema,
  resetPasswordSchema,
  updateUserSchema,
  withId,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

const done = <T>(value: T) => {
  revalidatePath('/admin/users');
  return value;
};

export const createUserAction = action(createUserSchema, async (ctx, input) =>
  done(await createUser(ctx, input)),
);

export const updateUserAction = action(withId(updateUserSchema), async (ctx, { id, data }) =>
  done(await updateUser(ctx, id, data)),
);

export const resetPasswordAction = action(withId(resetPasswordSchema), async (ctx, { id, data }) =>
  done(await resetUserPassword(ctx, id, data)),
);

export const deactivateUserAction = action(idOnlySchema, async (ctx, { id }) =>
  done(await deactivateUser(ctx, id)),
);

export const reactivateUserAction = action(idOnlySchema, async (ctx, { id }) =>
  done(await reactivateUser(ctx, id)),
);
