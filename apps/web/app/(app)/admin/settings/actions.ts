'use server';

import { updateSettings } from '@sales-tracker/core';
import { updateSettingsSchema } from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

export const updateSettingsAction = action(updateSettingsSchema, async (ctx, input) => {
  const settings = await updateSettings(ctx, input);
  revalidatePath('/admin/settings');
  return { companyName: settings.companyName };
});
