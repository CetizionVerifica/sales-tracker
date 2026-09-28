import { resetDb } from '@sales-tracker/db/test-utils';
import { getDb } from '../../clients.ts';
import type { Ctx } from '../../context.ts';
import { createClient } from '../../services/client.service.ts';
import { convertEnquiry, createEnquiry, markEnquiryLost } from '../../services/enquiry.service.ts';
import { createInvoice, markInvoicePaid } from '../../services/invoice.service.ts';
import { createProject } from '../../services/project.service.ts';
import { createPurchaseOrder } from '../../services/purchase-order.service.ts';
import { changeQuotationStatus, createQuotation } from '../../services/quotation.service.ts';
import { createSector } from '../../services/sector.service.ts';
import { createService } from '../../services/service.service.ts';
import { updateSettings } from '../../services/settings.service.ts';
import { ensureCompanySettings } from '../../system/seed.ts';
import { actor, createTestUser, ctxFor } from '../helpers.ts';

/*
 * A fixed, historical "world" for the M12b sales reports (independent of the wall-clock day
 * the tests run, unlike `test/dashboard-fixtures.ts`'s `day(n)` helper): every date is a
 * literal 2026 calendar date well before any plausible "today", so `receivedDate <= today`
 * checks never fail and report periods can be exact 'custom' ranges.
 */

export interface ReportsWorld {
  admin: Ctx;
  sales: Ctx;
  /** A second Sales owner, for cross-owner scoping and "first enquiry" checks (Decision 1). */
  sales2: Ctx;
  pm: Ctx;
  pharma: string;
  /** Marked `isOther`, so it always groups into "Other sectors" regardless of its rank (R3). */
  otherSector: string;
  sectors: string[]; // 6 rankable sectors, index 0 highest by fixture design
  inspection: string;
  audit: string;
  services: string[]; // 7 rankable services, plus one extra folded into "Other services"
  clients: Record<string, string>;
}

let counter = 0;
const uniquePoNumber = () => `PO-${++counter}`;
const uniqueInvoiceNumber = () => `INV-${++counter}`;

export async function reportsWorld(): Promise<ReportsWorld> {
  await resetDb(getDb());
  const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
    ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
  const admin = await user('admin@example.test', 'ADMIN');
  const sales = await user('sales@example.test', 'SALES');
  const sales2 = await user('sales2@example.test', 'SALES');
  const pm = await user('pm@example.test', 'PROJECT_MANAGER');

  await ensureCompanySettings();
  await updateSettings(admin, {
    companyName: 'Test Co',
    defaultInvoiceDueDays: 30,
    enabledCurrencies: ['INR', 'USD'],
  });

  const sectors: string[] = [];
  for (let i = 1; i <= 6; i++) {
    sectors.push((await createSector(admin, { name: `Sector ${i}` })).id);
  }
  const pharma = sectors[0]!;
  const otherSector = (await createSector(admin, { name: 'Misc', isOther: true })).id;

  const services: string[] = [];
  for (let i = 1; i <= 8; i++) {
    services.push((await createService(admin, { name: `Service ${i}` })).id);
  }
  const inspection = services[0]!;
  const audit = services[1]!;

  const clientNames = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Wayne', 'Stark'];
  const clients: Record<string, string> = {};
  for (const name of clientNames) {
    clients[name] = (await createClient(admin, { name, sectorId: pharma })).id;
  }

  return {
    admin,
    sales,
    sales2,
    pm,
    pharma,
    otherSector,
    sectors,
    inspection,
    audit,
    services,
    clients,
  };
}

export interface DealInput {
  clientId: string;
  sectorId?: string;
  serviceIds?: string[];
  receivedDate: string;
  currency?: string;
  amount?: string;
}

/** A converted enquiry with a SENT quotation, owned by `ctx`. */
export async function openDeal(w: ReportsWorld, ctx: Ctx, input: DealInput) {
  const serviceIds = input.serviceIds ?? [w.inspection];
  const enquiry = await createEnquiry(ctx, {
    clientId: input.clientId,
    sectorId: input.sectorId ?? w.pharma,
    serviceIds,
    receivedDate: input.receivedDate,
    proposalSentDate: input.receivedDate,
    source: 'EMAIL',
  });
  await convertEnquiry(ctx, { id: enquiry.id });
  const quotation = await createQuotation(ctx, {
    enquiryId: enquiry.id,
    quotationDate: input.receivedDate,
    amount: input.amount ?? '1,00,000',
    currency: input.currency ?? 'INR',
    sectorId: input.sectorId ?? w.pharma,
    serviceIds,
    nextFollowUpDate: '2026-12-31',
  });
  return { enquiry, quotation };
}

/** A won deal (PO_RECEIVED) with a project and one PO on `receivedDate`. */
export async function dealWithPo(
  w: ReportsWorld,
  ctx: Ctx,
  input: DealInput & { poReceivedDate?: string },
) {
  const deal = await openDeal(w, ctx, input);
  await changeQuotationStatus(ctx, {
    id: deal.quotation.id,
    to: 'PO_RECEIVED',
    poReceivedDate: input.poReceivedDate ?? input.receivedDate,
  });
  const serviceIds = input.serviceIds ?? [w.inspection];
  const project = await createProject(ctx, {
    quotationId: deal.quotation.id,
    name: `Project for ${input.clientId}`,
    revenue: input.amount ?? '1,00,000',
    currency: input.currency ?? 'INR',
    serviceIds,
    managerId: w.pm.user.id,
  });
  const { purchaseOrder } = await createPurchaseOrder(ctx, {
    projectId: project.id,
    poNumber: uniquePoNumber(),
    receivedDate: input.receivedDate,
    amount: input.amount ?? '1,00,000',
    currency: input.currency ?? 'INR',
    serviceIds,
  });
  return { ...deal, project, purchaseOrder };
}

/** A won deal, a PO and one invoice on it. */
export async function billedDeal(
  w: ReportsWorld,
  ctx: Ctx,
  input: DealInput & {
    poReceivedDate?: string;
    invoiceDate?: string;
    invoiceAmount?: string;
    paidAt?: string;
  },
) {
  const deal = await dealWithPo(w, ctx, input);
  const serviceIds = input.serviceIds ?? [w.inspection];
  const { invoice } = await createInvoice(ctx, {
    purchaseOrderId: deal.purchaseOrder.id,
    invoiceNumber: uniqueInvoiceNumber(),
    invoiceDate: input.invoiceDate ?? input.receivedDate,
    serviceId: serviceIds[0]!,
    amount: input.invoiceAmount ?? input.amount ?? '1,00,000',
  });
  if (input.paidAt) await markInvoicePaid(ctx, { id: invoice.id, paidAt: input.paidAt });
  return { ...deal, invoice };
}

/** An enquiry with no quotation (still "in progress"), or marked lost. */
export async function bareEnquiry(
  w: ReportsWorld,
  ctx: Ctx,
  input: DealInput,
  outcome: 'open' | 'lost' = 'open',
) {
  const enquiry = await createEnquiry(ctx, {
    clientId: input.clientId,
    sectorId: input.sectorId ?? w.pharma,
    serviceIds: input.serviceIds ?? [w.inspection],
    receivedDate: input.receivedDate,
    source: 'EMAIL',
  });
  if (outcome === 'lost') {
    await markEnquiryLost(ctx, { id: enquiry.id, lostReason: 'No budget' });
  }
  return enquiry;
}
