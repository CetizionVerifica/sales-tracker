import { getQuotation, NotFoundError, type Ctx } from '@sales-tracker/core';
import { notFound } from 'next/navigation';

/** getQuotation, with "not found or not yours" shown as the 404 page (M4 Decision 7). */
export function loadQuotationOr404(ctx: Ctx, id: string) {
  return getQuotation(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
}
