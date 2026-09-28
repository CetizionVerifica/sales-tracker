'use server';

import {
  createPurchaseOrder,
  listProjects,
  restorePurchaseOrder,
  softDeletePurchaseOrder,
  updatePurchaseOrder,
} from '@sales-tracker/core';
import {
  createPurchaseOrderFormSchema,
  purchaseOrderIdActionSchema,
  searchPoProjectsSchema,
  updatePurchaseOrderActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/** Results carry ids only, so no BigInt crosses the action boundary. */
function done<T>(value: T, po: { id: string; projectId: string; clientId: string }): T {
  revalidatePath('/purchase-orders');
  revalidatePath(`/purchase-orders/${po.id}`);
  revalidatePath(`/projects/${po.projectId}`);
  revalidatePath(`/clients/${po.clientId}`);
  return value;
}

// The form schemas validate without converting the amount, so the service parses the same
// input again and does the conversion to minor units itself.
export const createPurchaseOrderAction = action(
  createPurchaseOrderFormSchema,
  async (ctx, input) => {
    const { purchaseOrder, coverage } = await createPurchaseOrder(ctx, input);
    return done({ id: purchaseOrder.id, warning: coverage.warning }, purchaseOrder);
  },
);

export const updatePurchaseOrderAction = action(
  updatePurchaseOrderActionSchema,
  async (ctx, { id, data }) => {
    const purchaseOrder = await updatePurchaseOrder(ctx, id, data);
    // Below the invoiced total saves, with a warning (M10 Decision 9).
    return done({ id, warning: purchaseOrder.warning }, purchaseOrder);
  },
);

export const deletePurchaseOrderAction = action(
  purchaseOrderIdActionSchema,
  async (ctx, { id }) => {
    const purchaseOrder = await softDeletePurchaseOrder(ctx, id);
    return done({ id }, purchaseOrder);
  },
);

export const restorePurchaseOrderAction = action(
  purchaseOrderIdActionSchema,
  async (ctx, { id }) => {
    const purchaseOrder = await restorePurchaseOrder(ctx, id);
    return done({ id }, purchaseOrder);
  },
);

/** Projects that take POs: live, not cancelled, readable by the user (the new-PO picker). */
export const searchPoProjectsAction = action(searchPoProjectsSchema, async (ctx, { q }) => {
  const { items } = await listProjects(ctx, {
    q: q || undefined,
    status: ['NOT_STARTED', 'IN_PROGRESS', 'ON_HOLD', 'COMPLETED'],
    pageSize: 20,
  });
  return items.map((p) => ({ id: p.id, number: p.number, name: p.name, client: p.client.name }));
});
