import { resetDb } from '@sales-tracker/db/test-utils';
import { expect } from 'vitest';
import { getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError } from '../errors.ts';
import type { CreateProjectInput } from '../schemas/project.ts';
import { createClient } from '../services/client.service.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import { createProject } from '../services/project.service.ts';
import { changeQuotationStatus, createQuotation } from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { createService } from '../services/service.service.ts';
import { updateSettings } from '../services/settings.service.ts';
import { ensureCompanySettings } from '../system/seed.ts';
import { actor, createTestUser, ctxFor } from './helpers.ts';

export const fieldOf = (e: unknown) => (e instanceof DomainError ? e.field : undefined);

export async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

/** Audit rows for one entity, oldest first. */
export const auditOf = (entityType: string, entityId: string) =>
  getDb().auditLog.findMany({
    where: { entityType, entityId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });

/** Audit rows written in the same request as `row`. */
export const sameRequest = (row: { requestId: string | null }) =>
  getDb().auditLog.findMany({ where: { requestId: row.requestId ?? 'none' } });

export const FAR_FUTURE = '2099-01-01';

export interface ProjectWorld {
  admin: Ctx;
  sales: Ctx;
  sales2: Ctx;
  pm: Ctx;
  pm2: Ctx;
  pharma: string;
  inspection: string;
  audit: string;
  certification: string;
  acme: string;
}

/** A clean database with users, masters, settings and one client. */
export async function projectWorld(): Promise<ProjectWorld> {
  await resetDb(getDb());
  const user = async (email: string, role: 'ADMIN' | 'SALES' | 'PROJECT_MANAGER') =>
    ctxFor(actor(role, { id: (await createTestUser(email, role)).id }));
  const admin = await user('admin@example.test', 'ADMIN');
  const sales = await user('sales@example.test', 'SALES');
  const sales2 = await user('sales2@example.test', 'SALES');
  const pm = await user('pm@example.test', 'PROJECT_MANAGER');
  const pm2 = await user('pm2@example.test', 'PROJECT_MANAGER');

  await ensureCompanySettings();
  await updateSettings(admin, {
    companyName: 'Test Co',
    defaultInvoiceDueDays: 30,
    enabledCurrencies: ['INR', 'USD'],
  });
  const pharma = (await createSector(admin, { name: 'Pharma' })).id;
  const inspection = (await createService(admin, { name: 'Inspection' })).id;
  const audit = (await createService(admin, { name: 'Audit' })).id;
  const certification = (await createService(admin, { name: 'Certification' })).id;
  const acme = (await createClient(admin, { name: 'Acme Pharma', sectorId: pharma })).id;
  return { admin, sales, sales2, pm, pm2, pharma, inspection, audit, certification, acme };
}

/** A PO_RECEIVED quotation owned by `ctx`, on a fresh converted enquiry. */
export async function wonQuotation(w: ProjectWorld, ctx: Ctx = w.sales, clientId = w.acme) {
  const enquiry = await createEnquiry(ctx, {
    clientId,
    sectorId: w.pharma,
    serviceIds: [w.inspection, w.audit],
    receivedDate: '2026-03-10',
    proposalSentDate: '2026-03-12',
    source: 'EMAIL',
  });
  await convertEnquiry(ctx, { id: enquiry.id });
  const quotation = await createQuotation(ctx, {
    enquiryId: enquiry.id,
    quotationDate: '2026-03-12',
    amount: '1,25,000.50',
    currency: 'INR',
    sectorId: w.pharma,
    serviceIds: [w.inspection, w.audit],
    nextFollowUpDate: '2026-03-20',
  });
  await changeQuotationStatus(ctx, {
    id: quotation.id,
    to: 'PO_RECEIVED',
    poReceivedDate: '2026-04-01',
  });
  return { enquiry, quotation };
}

export const projectInput = (
  w: ProjectWorld,
  quotationId: string,
  overrides: Partial<CreateProjectInput> = {},
): CreateProjectInput => ({
  quotationId,
  name: 'Acme — Inspection, Audit',
  managerId: w.pm.user.id,
  serviceIds: [w.inspection, w.audit],
  revenue: '1,25,000.50',
  currency: 'INR',
  ...overrides,
});

/** A NOT_STARTED project on a new won quotation, managed by `pm` unless overridden. */
export async function newProject(
  w: ProjectWorld,
  overrides: Partial<CreateProjectInput> = {},
  owner: Ctx = w.sales,
  clientId = w.acme,
) {
  const { enquiry, quotation } = await wonQuotation(w, owner, clientId);
  const project = await createProject(owner, projectInput(w, quotation.id, overrides));
  expect(project.status).toBe('NOT_STARTED');
  return { enquiry, quotation, project };
}
