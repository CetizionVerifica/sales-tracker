'use server';

import {
  changeQuotationStatus,
  createQuotation,
  restoreQuotation,
  softDeleteQuotation,
  updateQuotation,
} from '@sales-tracker/core';
import {
  changeQuotationStatusSchema,
  createQuotationFormSchema,
  quotationIdActionSchema,
  updateQuotationActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** Results carry ids only, so no BigInt crosses the action boundary. */
function done<T>(value: T, quotation?: { id: string; enquiryId: string }): T {
  revalidatePath('/quotations');
  if (quotation) {
    revalidatePath(`/quotations/${quotation.id}`);
    revalidatePath(`/enquiries/${quotation.enquiryId}`);
  }
  return value;
}

// The form schemas validate without converting the amount, so the service parses the same
// input again and does the conversion to minor units itself.
export const createQuotationAction = action(createQuotationFormSchema, async (ctx, input) => {
  const quotation = await createQuotation(ctx, input);
  return done({ id: quotation.id }, quotation);
});

export const updateQuotationAction = action(
  updateQuotationActionSchema,
  async (ctx, { id, data }) => {
    const quotation = await updateQuotation(ctx, id, data);
    return done({ id }, quotation);
  },
);

export const changeQuotationStatusAction = action(
  changeQuotationStatusSchema,
  async (ctx, input) => {
    const { quotation, projectDraft } = await changeQuotationStatus(ctx, input);
    return done({ id: quotation.id, projectDraft: projectDraft !== undefined }, quotation);
  },
);

export const deleteQuotationAction = action(quotationIdActionSchema, async (ctx, { id }) => {
  const quotation = await softDeleteQuotation(ctx, id);
  return done({ id }, quotation);
});

export const restoreQuotationAction = action(quotationIdActionSchema, async (ctx, { id }) => {
  const quotation = await restoreQuotation(ctx, id);
  return done({ id }, quotation);
});
