import { expect } from 'vitest';
import type { Ctx } from '../context.ts';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import type { CreateInvoiceInput } from '../schemas/invoice.ts';
import type { CreateProjectInput } from '../schemas/project.ts';
import type { CreatePurchaseOrderInput } from '../schemas/purchase-order.ts';
import { createInvoice } from '../services/invoice.service.ts';
import { newPurchaseOrder, type PoWorld } from './purchase-order-fixtures.ts';

export { poWorld as invoiceWorld } from './purchase-order-fixtures.ts';

/** A calendar day `n` days from today (IST), as `YYYY-MM-DD`; negative is in the past. */
export const daysFromToday = (n: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() + n * 86_400_000));

let counter = 0;

/** An invoice number no other test has used. */
export const uniqueInvoiceNumber = () => `INV/${Date.now().toString(36)}/${++counter}`;

export const invoiceInput = (
  purchaseOrderId: string,
  serviceId: string,
  overrides: Partial<CreateInvoiceInput> = {},
): CreateInvoiceInput => ({
  purchaseOrderId,
  invoiceNumber: uniqueInvoiceNumber(),
  invoiceDate: daysFromToday(0),
  serviceId,
  amount: '50,000',
  ...overrides,
});

/**
 * A PO (₹1,00,000 unless overridden, on a project managed by `pm`, owned by `sales`) with
 * one invoice raised by its Sales owner, dated today with the company default due date
 * (+30 days) unless overridden.
 */
export async function newInvoice(
  w: PoWorld,
  overrides: Partial<CreateInvoiceInput> = {},
  options: {
    po?: Partial<CreatePurchaseOrderInput>;
    projectOverrides?: Partial<CreateProjectInput>;
    owner?: Ctx;
    creator?: Ctx;
  } = {},
) {
  const owner = options.owner ?? w.sales;
  const po = await newPurchaseOrder(w, options.po, {
    projectOverrides: options.projectOverrides,
    owner,
  });
  const { invoice, billing } = await createInvoice(
    options.creator ?? owner,
    invoiceInput(po.purchaseOrder.id, w.inspection, overrides),
  );
  expect(invoice.purchaseOrderId).toBe(po.purchaseOrder.id);
  return { ...po, invoice, billing };
}
