'use server';

import { changeOwnPassword } from '@sales-tracker/core';
import { changeOwnPasswordSchema } from '@sales-tracker/core/schemas';
import { action } from '@/lib/action';

export const changePasswordAction = action(changeOwnPasswordSchema, async (ctx, input) => {
  await changeOwnPassword(ctx, input);
  return null;
});
