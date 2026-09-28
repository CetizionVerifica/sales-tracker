import { getPurchaseOrder, NotFoundError, type Ctx } from '@sales-tracker/core';
import { notFound } from 'next/navigation';

/** getPurchaseOrder, with "not found or not yours" shown as the 404 page (M4 Decision 7). */
export function loadPurchaseOrderOr404(ctx: Ctx, id: string) {
  return getPurchaseOrder(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
}
