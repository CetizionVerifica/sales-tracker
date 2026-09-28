'use server';

import {
  createExchangeRate,
  recalculateExchangeRate,
  softDeleteExchangeRate,
  updateExchangeRate,
} from '@sales-tracker/core';
import {
  exchangeRateFormSchema,
  exchangeRateIdActionSchema,
  updateExchangeRateActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** INR equivalents feed the dashboard and every detail page's "≈ ₹…" line. */
function done<T>(value: T): T {
  revalidatePath('/admin/exchange-rates');
  revalidatePath('/dashboard');
  return value;
}

export const createExchangeRateAction = action(exchangeRateFormSchema, async (ctx, input) => {
  const { filled } = await createExchangeRate(ctx, input);
  return done({ filled });
});

export const updateExchangeRateAction = action(
  updateExchangeRateActionSchema,
  async (ctx, { id, data }) => {
    const { stale } = await updateExchangeRate(ctx, id, data);
    return done({ stale });
  },
);

export const recalculateExchangeRateAction = action(
  exchangeRateIdActionSchema,
  async (ctx, { id }) => done(await recalculateExchangeRate(ctx, id)),
);

export const deleteExchangeRateAction = action(exchangeRateIdActionSchema, async (ctx, { id }) => {
  await softDeleteExchangeRate(ctx, id);
  return done({ id });
});
