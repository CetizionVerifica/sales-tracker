import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { OTHER_SERVICE_KEY, serviceSales } from '../../reports/service-sales.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { createClient } from '../../services/client.service.ts';
import { createProject } from '../../services/project.service.ts';
import { createPurchaseOrder } from '../../services/purchase-order.service.ts';
import { changeQuotationStatus } from '../../services/quotation.service.ts';
import { createSector } from '../../services/sector.service.ts';
import { dealWithPo, openDeal, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC4: service totals come from PO lines; a multi-service PO contributes to each of its
// services by line amount; the total across services equals total PO value for the period;
// estimated splits set `estimated: true`.

let w: ReportsWorld;

beforeAll(async () => {
  w = await reportsWorld();
  const sector = (await createSector(w.admin, { name: 'ServSector' })).id;
  const client = await createClient(w.admin, { name: 'Multi-service client', sectorId: sector });

  // A single-service PO: the full amount is one line (never "estimated").
  await dealWithPo(w, w.admin, {
    clientId: client.id,
    sectorId: sector,
    receivedDate: '2026-01-10',
    serviceIds: [w.services[0]!],
    amount: '1,00,000',
  });

  // A multi-service PO with an explicit user split.
  const deal = await openDeal(w, w.admin, {
    clientId: client.id,
    sectorId: sector,
    receivedDate: '2026-01-11',
    serviceIds: [w.services[1]!, w.services[2]!],
    amount: '2,00,000',
  });
  await changeQuotationStatus(w.admin, {
    id: deal.quotation.id,
    to: 'PO_RECEIVED',
    poReceivedDate: '2026-01-11',
  });
  const project = await createProject(w.admin, {
    quotationId: deal.quotation.id,
    name: 'Multi-service project',
    revenue: '2,00,000',
    currency: 'INR',
    serviceIds: [w.services[1]!, w.services[2]!],
    managerId: w.pm.user.id,
  });
  await createPurchaseOrder(w.admin, {
    projectId: project.id,
    poNumber: 'MULTI-1',
    receivedDate: '2026-01-11',
    amount: '2,00,000',
    currency: 'INR',
    serviceIds: [w.services[1]!, w.services[2]!],
    lines: [
      { serviceId: w.services[1]!, amount: '1,50,000' },
      { serviceId: w.services[2]!, amount: '50,000' },
    ],
  });
});
afterAll(disconnectAll);

const loadReport = async () => {
  const db = getDb();
  const scope = resolveReportScope(w.admin, {});
  const filter = reportFilterSchema.parse({
    preset: 'custom',
    from: '2026-01-01',
    to: '2026-01-31',
  });
  const period = resolvePeriod(filter, new Date('2026-01-15T00:00:00.000Z'));
  return serviceSales(db, scope, period, {});
};

describe('serviceSales', () => {
  it('a multi-service PO contributes to each service by its line amount, not the full PO', async () => {
    const report = await loadReport();
    const byService = new Map(report.data.map((r) => [r.key, r]));
    expect(byService.get(w.services[0]!)?.valueMinor).toBe(1_00_000_00n);
    expect(byService.get(w.services[1]!)?.valueMinor).toBe(1_50_000_00n);
    expect(byService.get(w.services[2]!)?.valueMinor).toBe(50_000_00n);
  });

  it('the total across services equals total PO value for the period', async () => {
    const report = await loadReport();
    expect(report.totalValueMinor).toBe(1_00_000_00n + 1_50_000_00n + 50_000_00n);
  });

  it('an explicit user split is not marked estimated', async () => {
    const report = await loadReport();
    expect(report.estimated).toBe(false);
  });

  it('a PO created without an explicit split is marked estimated', async () => {
    const sector = (await createSector(w.admin, { name: 'EstSector' })).id;
    const client = await createClient(w.admin, { name: 'Estimated client', sectorId: sector });
    // No `lines`: falls back to an equal split, flagged allocationEstimated.
    await dealWithPo(w, w.admin, {
      clientId: client.id,
      sectorId: sector,
      receivedDate: '2026-01-15',
      serviceIds: [w.services[3]!, w.services[4]!],
      amount: '2,00,000',
    });
    const report = await loadReport();
    expect(report.estimated).toBe(true);
  });

  it('shows the top 7 services individually; the rest group as "Other services"', async () => {
    const sector = (await createSector(w.admin, { name: 'TopSector' })).id;
    const client = await createClient(w.admin, { name: 'Top services client', sectorId: sector });
    // 8 single-service POs in February: one more than the 7-service cap.
    for (let i = 0; i < w.services.length; i++) {
      await dealWithPo(w, w.admin, {
        clientId: client.id,
        sectorId: sector,
        receivedDate: '2026-02-05',
        serviceIds: [w.services[i]!],
        amount: `${(i + 1) * 10_000}`,
      });
    }
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const custom = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-02-01',
      to: '2026-02-28',
    });
    const period = resolvePeriod(custom, new Date('2026-02-15T00:00:00.000Z'));
    const report = await serviceSales(db, scope, period, {});

    const rankable = report.data.filter((r) => r.key !== OTHER_SERVICE_KEY);
    expect(rankable).toHaveLength(7);
    const other = report.data.find((r) => r.key === OTHER_SERVICE_KEY);
    expect(other).toBeDefined();
    // The 8 services are worth 10k..80k; the smallest (10k) falls into "Other services".
    expect(other!.valueMinor).toBe(10_000_00n);
  });
});
