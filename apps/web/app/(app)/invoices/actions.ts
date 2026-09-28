'use server';

import {
  createInvoice,
  listPurchaseOrders,
  markInvoicePaid,
  markInvoiceUnpaid,
  restoreInvoice,
  softDeleteInvoice,
  updateInvoice,
} from '@sales-tracker/core';
import {
  createInvoiceFormSchema,
  invoiceIdActionSchema,
  markInvoicePaidSchema,
  markInvoiceUnpaidSchema,
  searchInvoicePurchaseOrdersSchema,
  updateInvoiceActionSchema,
} from '@sales-tracker/core/schemas';
import { revalidatePath } from 'next/cache';
import { action } from '@/lib/action';

/**
 * Results carry ids only, so no BigInt crosses the action boundary. An invoice write also
 * changes its PO's status and billing, so the PO and project pages are refreshed too.
 */
function done<T>(
  value: T,
  invoice: {
    id: string;
    clientId: string;
    purchaseOrder: { id: string; project: { id: string } };
  },
): T {
  revalidatePath('/invoices');
  revalidatePath(`/invoices/${invoice.id}`);
  revalidatePath('/purchase-orders');
  revalidatePath(`/purchase-orders/${invoice.purchaseOrder.id}`);
  revalidatePath(`/projects/${invoice.purchaseOrder.project.id}`);
  revalidatePath(`/clients/${invoice.clientId}`);
  return value;
}

// The amount stays as typed: the service converts it in the PO's currency (Decision 3).
export const createInvoiceAction = action(createInvoiceFormSchema, async (ctx, input) => {
  const { invoice, billing } = await createInvoice(ctx, input);
  return done({ id: invoice.id, warning: billing.warning }, invoice);
});

export const updateInvoiceAction = action(updateInvoiceActionSchema, async (ctx, { id, data }) => {
  const invoice = await updateInvoice(ctx, id, data);
  return done({ id }, invoice);
});

export const markInvoicePaidAction = action(markInvoicePaidSchema, async (ctx, input) => {
  const invoice = await markInvoicePaid(ctx, input);
  return done({ id: invoice.id }, invoice);
});

export const markInvoiceUnpaidAction = action(markInvoiceUnpaidSchema, async (ctx, input) => {
  const invoice = await markInvoiceUnpaid(ctx, input);
  return done({ id: invoice.id }, invoice);
});

export const deleteInvoiceAction = action(invoiceIdActionSchema, async (ctx, { id }) => {
  const invoice = await softDeleteInvoice(ctx, id);
  return done({ id }, invoice);
});

export const restoreInvoiceAction = action(invoiceIdActionSchema, async (ctx, { id }) => {
  const invoice = await restoreInvoice(ctx, id);
  return done({ id }, invoice);
});

/** Live POs the user can read, for the new-invoice picker (M10). */
export const searchInvoicePurchaseOrdersAction = action(
  searchInvoicePurchaseOrdersSchema,
  async (ctx, { q }) => {
    const { items } = await listPurchaseOrders(ctx, { q: q || undefined, pageSize: 20 });
    return items.map((po) => ({
      id: po.id,
      poNumber: po.poNumber,
      client: po.client.name,
      project: po.project.number,
    }));
  },
);
