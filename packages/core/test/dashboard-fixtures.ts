import type { Ctx } from '../context.ts';
import type { EnquirySourceValue } from '../schemas/enquiry.ts';
import { toCalendarDateString, todayInIST } from '../schemas/common.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../services/enquiry.service.ts';
import { createInvoice, markInvoicePaid } from '../services/invoice.service.ts';
import { createProject } from '../services/project.service.ts';
import { createPurchaseOrder } from '../services/purchase-order.service.ts';
import { changeQuotationStatus, createQuotation } from '../services/quotation.service.ts';
import { invoiceInput } from './invoice-fixtures.ts';
import { projectInput, type ProjectWorld } from './project-fixtures.ts';
import { poInput } from './purchase-order-fixtures.ts';

/** A calendar day `n` days from today (IST) as `YYYY-MM-DD`; negative is in the past. */
export const day = (n: number) =>
  toCalendarDateString(new Date(todayInIST().getTime() + n * 86_400_000));

export interface DealOptions {
  clientId?: string;
  sectorId?: string;
  serviceIds?: string[];
  source?: EnquirySourceValue;
  /** Days ago the enquiry arrived (default 120, before any test period). */
  receivedDaysAgo?: number;
  /** Days ago the quotation is dated (default: the day after the enquiry). */
  quotedDaysAgo?: number;
  currency?: string;
}

/** A converted enquiry and a SENT quotation owned by `ctx`. */
export async function openDeal(w: ProjectWorld, ctx: Ctx, amount: string, o: DealOptions = {}) {
  const received = o.receivedDaysAgo ?? 120;
  const quoted = o.quotedDaysAgo ?? received - 1;
  const serviceIds = o.serviceIds ?? [w.inspection];
  const enquiry = await createEnquiry(ctx, {
    clientId: o.clientId ?? w.acme,
    sectorId: o.sectorId ?? w.pharma,
    serviceIds,
    receivedDate: day(-received),
    proposalSentDate: day(-received),
    source: o.source ?? 'EMAIL',
    ...(o.source === 'OTHER' || o.source === 'REFERRAL' || o.source === 'TENDER_PORTAL'
      ? { sourceDetail: 'Test' }
      : {}),
  });
  await convertEnquiry(ctx, { id: enquiry.id });
  const quotation = await createQuotation(ctx, {
    enquiryId: enquiry.id,
    quotationDate: day(-quoted),
    amount,
    currency: o.currency ?? 'INR',
    sectorId: o.sectorId ?? w.pharma,
    serviceIds,
    nextFollowUpDate: day(30),
  });
  return { enquiry, quotation };
}

/** A deal won `poDaysAgo` days ago (PO received). */
export async function wonDeal(
  w: ProjectWorld,
  ctx: Ctx,
  amount: string,
  poDaysAgo: number,
  o: DealOptions = {},
) {
  const deal = await openDeal(w, ctx, amount, o);
  await changeQuotationStatus(ctx, {
    id: deal.quotation.id,
    to: 'PO_RECEIVED',
    poReceivedDate: day(-poDaysAgo),
  });
  return deal;
}

/** A deal lost today (the decision date is the status change). */
export async function lostDeal(w: ProjectWorld, ctx: Ctx, amount: string, o: DealOptions = {}) {
  const deal = await openDeal(w, ctx, amount, o);
  await changeQuotationStatus(ctx, { id: deal.quotation.id, to: 'LOST', lostReason: 'Price' });
  return deal;
}

/** An enquiry that was never converted (in progress) or was lost. */
export async function bareEnquiry(
  w: ProjectWorld,
  ctx: Ctx,
  receivedDaysAgo: number,
  outcome: 'open' | 'lost' = 'open',
) {
  const enquiry = await createEnquiry(ctx, {
    clientId: w.acme,
    sectorId: w.pharma,
    serviceIds: [w.inspection],
    receivedDate: day(-receivedDaysAgo),
    source: 'EMAIL',
  });
  if (outcome === 'lost') await markEnquiryLost(ctx, { id: enquiry.id, lostReason: 'No budget' });
  return enquiry;
}

export interface BilledOptions extends DealOptions {
  managerId?: string;
  /** Days ago the invoice is dated (default 10). Due in +30 days (company default). */
  invoiceDaysAgo?: number;
  invoiceAmount?: string;
  /** Mark it paid this many days ago (not before the invoice date). */
  paidDaysAgo?: number;
  projectOverrides?: Parameters<typeof projectInput>[2];
}

/** A won deal with a project, a PO and one invoice, as the Sales owner. */
export async function billedDeal(w: ProjectWorld, ctx: Ctx, amount: string, o: BilledOptions = {}) {
  const received = o.receivedDaysAgo ?? 200;
  const deal = await wonDeal(w, ctx, amount, received - 2, { ...o, receivedDaysAgo: received });
  const project = await createProject(
    ctx,
    projectInput(w, deal.quotation.id, {
      revenue: amount,
      serviceIds: o.serviceIds ?? [w.inspection],
      ...(o.managerId !== undefined && { managerId: o.managerId }),
      ...o.projectOverrides,
    }),
  );
  const { purchaseOrder } = await createPurchaseOrder(
    ctx,
    poInput(w, project.id, {
      amount,
      receivedDate: day(-(received - 3)),
      serviceIds: o.serviceIds ?? [w.inspection],
    }),
  );
  const invoiceDaysAgo = o.invoiceDaysAgo ?? 10;
  const { invoice } = await createInvoice(
    ctx,
    invoiceInput(purchaseOrder.id, (o.serviceIds ?? [w.inspection])[0]!, {
      amount: o.invoiceAmount ?? amount,
      invoiceDate: day(-invoiceDaysAgo),
    }),
  );
  if (o.paidDaysAgo !== undefined) {
    await markInvoicePaid(ctx, { id: invoice.id, paidAt: day(-o.paidDaysAgo) });
  }
  return { ...deal, project, purchaseOrder, invoice };
}
