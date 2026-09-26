import { getDb } from '../clients.ts';
import { assertCan, withTx, type Ctx } from '../context.ts';
import { updateSettingsSchema, type UpdateSettingsInput } from '../schemas/settings.ts';

/** The single CompanySettings row (id = 1, enforced by a CHECK constraint). */
export const SETTINGS_ID = 1;

export async function getSettings(ctx: Ctx) {
  assertCan(ctx, 'read', 'settings');
  const settings = await getDb().companySettings.findUnique({ where: { id: SETTINGS_ID } });
  if (!settings) throw new Error('Company settings are missing; run `pnpm db:seed`');
  return settings;
}

/** Admins only. Base currency is not editable (the schema is strict and omits it). */
export async function updateSettings(ctx: Ctx, input: UpdateSettingsInput) {
  const data = updateSettingsSchema.parse(input);
  assertCan(ctx, 'update', 'settings');
  return withTx(ctx, (tx) => tx.companySettings.update({ where: { id: SETTINGS_ID }, data }));
}
