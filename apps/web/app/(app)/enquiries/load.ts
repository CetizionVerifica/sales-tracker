import { getEnquiry, NotFoundError, type Ctx } from '@sales-tracker/core';
import { notFound } from 'next/navigation';

/** getEnquiry, with "not found or not yours" shown as the 404 page (M4 Decision 7). */
export function loadEnquiryOr404(ctx: Ctx, id: string) {
  return getEnquiry(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
}
