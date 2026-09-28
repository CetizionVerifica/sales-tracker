import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { customerMix } from '../../reports/customer-mix.ts';
import { enquiryStatus } from '../../reports/enquiry-status.ts';
import { enquiryVolume } from '../../reports/enquiry-volume.ts';
import { revenue } from '../../reports/revenue.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { sectorPos } from '../../reports/sector-pos.ts';
import { serviceSales } from '../../reports/service-sales.ts';
import { previousPeriod, reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { createClient } from '../../services/client.service.ts';
import { billedDeal, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b: sectorId/serviceId narrow every report that has that dimension.

let w: ReportsWorld;
let sectorA: string;
let sectorB: string;
let clientA: string;
let clientB: string;

beforeAll(async () => {
  w = await reportsWorld();
  sectorA = w.sectors[0]!;
  sectorB = w.sectors[1]!;
  clientA = (await createClient(w.admin, { name: 'Dim client A', sectorId: sectorA })).id;
  clientB = (await createClient(w.admin, { name: 'Dim client B', sectorId: sectorB })).id;

  // Client A: sector A, service `inspection`, invoiced too.
  await billedDeal(w, w.admin, {
    clientId: clientA,
    sectorId: sectorA,
    serviceIds: [w.inspection],
    receivedDate: '2026-01-05',
    amount: '1,00,000',
    invoiceDate: '2026-01-06',
  });
  // Client B: sector B, service `audit`, invoiced too.
  await billedDeal(w, w.admin, {
    clientId: clientB,
    sectorId: sectorB,
    serviceIds: [w.audit],
    receivedDate: '2026-01-08',
    amount: '60,000',
    invoiceDate: '2026-01-09',
  });
});
afterAll(disconnectAll);

const period = () =>
  resolvePeriod(
    reportFilterSchema.parse({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }),
    new Date('2026-01-15T00:00:00.000Z'),
  );

describe('dimension filters narrow every report that has that dimension', () => {
  it('R1 enquiry volume: sectorId and serviceId each narrow to one deal', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const p = period();
    const bySector = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      sectorId: sectorA,
    });
    const byService = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      serviceId: w.audit,
    });
    const sectorReport = await enquiryVolume(db, scope, bySector, p, previousPeriod(p));
    const serviceReport = await enquiryVolume(db, scope, byService, p, previousPeriod(p));
    expect(sectorReport.total).toBe(1);
    expect(serviceReport.total).toBe(1);
  });

  it('R2 enquiry status: sectorId narrows the cohort', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await enquiryStatus(db, scope, period(), { sectorId: sectorB });
    expect(report.cohortSize).toBe(1);
  });

  it('R3 sector-wise POs: serviceId narrows to POs carrying that service', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const p = period();
    const report = await sectorPos(db, scope, p, previousPeriod(p), { serviceId: w.inspection });
    expect(report.totalCount).toBe(1);
    expect(report.data.some((r) => r.name === 'Sector 2')).toBe(false);
  });

  it('R4 service sales: sectorId narrows to that sector’s clients', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await serviceSales(db, scope, period(), { sectorId: sectorA });
    const services = report.data.map((r) => r.key);
    expect(services).toContain(w.inspection);
    expect(services).not.toContain(w.audit);
  });

  it('R5 customer mix: serviceId narrows new enquiries', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await customerMix(db, scope, period(), { serviceId: w.inspection });
    expect(report.newEnquiries.every((r) => r.clientId === clientA)).toBe(true);
    expect(report.newEnquiries.some((r) => r.clientId === clientB)).toBe(false);
  });

  it('R6 revenue: serviceId (a direct Invoice column) narrows invoiced', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const p = period();
    const report = await revenue(db, scope, p, previousPeriod(p), { serviceId: w.audit });
    expect(report.invoicedMinor).toBe(60_000_00n);
  });
});
