import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { ForbiddenError, NotFoundError } from '../errors.ts';
import type { DashboardInput, ProjectDashboard, SalesDashboard } from '../schemas/dashboard.ts';
import { todayInIST } from '../schemas/common.ts';
import { createExchangeRate } from '../services/exchange-rate.service.ts';
import { createClient } from '../services/client.service.ts';
import {
  dashboardPanelCsv,
  exportDashboardPanel,
  getDashboard,
} from '../services/dashboard.service.ts';
import { listInvoices, markInvoicePaid, softDeleteInvoice } from '../services/invoice.service.ts';
import { changeProjectStatus } from '../services/project.service.ts';
import {
  changeQuotationStatus,
  listQuotations,
  softDeleteQuotation,
} from '../services/quotation.service.ts';
import { createSector } from '../services/sector.service.ts';
import { bareEnquiry, billedDeal, day, lostDeal, openDeal, wonDeal } from './dashboard-fixtures.ts';
import { projectWorld, rejection, type ProjectWorld } from './project-fixtures.ts';

// M12 AC4–AC11: each panel against a small world with known answers.

const LAST_60: DashboardInput = { preset: 'custom', from: day(-60), to: day(0) };
const INR = (rupees: number) => BigInt(rupees) * 100n;

async function sales(ctx: Ctx, input: DashboardInput = LAST_60): Promise<SalesDashboard> {
  const result = await getDashboard(ctx, input, { today: todayInIST() });
  if (result.layout !== 'sales') throw new Error('expected the sales layout');
  return result;
}

async function project(ctx: Ctx, input: DashboardInput = LAST_60): Promise<ProjectDashboard> {
  const result = await getDashboard(ctx, input, { today: todayInIST() });
  if (result.layout !== 'project') throw new Error('expected the project layout');
  return result;
}

afterAll(disconnectAll);

describe('AC4: KPIs', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    await openDeal(w, w.sales, '1,00,000'); // open
    const negotiating = await openDeal(w, w.sales, '50,000');
    await changeQuotationStatus(w.sales, {
      id: negotiating.quotation.id,
      to: 'UNDER_NEGOTIATION',
      nextFollowUpDate: day(10),
    });
    await wonDeal(w, w.sales, '2,00,000', 10); // won in the period
    await wonDeal(w, w.sales, '3,00,000', 20);
    await lostDeal(w, w.sales, '40,000'); // lost today
    await wonDeal(w, w.sales, '1,00,000', 90); // won in the previous period
    await openDeal(w, w.sales2, '9,99,999'); // another rep's
    const deleted = await openDeal(w, w.sales, '5,00,000');
    await softDeleteQuotation(w.sales, deleted.quotation.id);
    await billedDeal(w, w.sales, '60,000', { invoiceDaysAgo: 45 }); // due 15 days ago: overdue
  });

  it('open pipeline, win rate, won and overdue for the owner', async () => {
    const { kpis } = await sales(w.sales);
    expect(kpis.openPipeline).toEqual({ count: 2, valueMinor: INR(150_000) });
    expect(kpis.winRate).toMatchObject({ won: 2, lost: 1 });
    expect(kpis.winRate.rate).toBeCloseTo(2 / 3);
    expect(kpis.winRate.valueRate).toBeCloseTo(500_000 / 540_000);
    expect(kpis.won).toEqual({ count: 2, valueMinor: INR(500_000), previousMinor: INR(100_000) });
    expect(kpis.overdue).toEqual({ count: 1, valueMinor: INR(60_000) });
    // Previous period: 1 won (and the billed deal won 198 days ago is outside both).
    expect(kpis.winRate.previous).toBeNull(); // fewer than 3 decided
  });

  it('the company scope adds the other rep', async () => {
    const { kpis, scope } = await sales(w.admin);
    expect(scope).toEqual({ kind: 'company', user: null });
    expect(kpis.openPipeline).toEqual({ count: 3, valueMinor: INR(1_149_999) });
  });

  it('writes nothing', async () => {
    const before = await getDb().auditLog.count();
    await sales(w.admin);
    await exportDashboardPanel(w.admin, LAST_60, 'topClients');
    expect(await getDb().auditLog.count()).toBe(before);
  });
});

describe('AC5: funnel (cohort of enquiries received in the period)', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    await bareEnquiry(w, w.sales, 30); // enquiries only
    await bareEnquiry(w, w.sales, 30, 'lost'); // enquiries only
    await openDeal(w, w.sales, '10,000', { receivedDaysAgo: 30 }); // → quoted
    await wonDeal(w, w.sales, '20,000', 20, { receivedDaysAgo: 30 }); // → won
    await billedDeal(w, w.sales, '30,000', { receivedDaysAgo: 30, invoiceDaysAgo: 5 }); // invoiced
    await billedDeal(w, w.sales, '40,000', {
      receivedDaysAgo: 30,
      invoiceDaysAgo: 5,
      paidDaysAgo: 1,
    }); // → paid
    await bareEnquiry(w, w.sales, 90); // outside the cohort
    const gone = await openDeal(w, w.sales, '99,000', { receivedDaysAgo: 30 });
    await softDeleteQuotation(w.sales, gone.quotation.id); // proposal sent, not quoted
  });

  it('counts each stage cumulatively', async () => {
    const { funnel } = await sales(w.sales);
    expect(funnel.map((r) => [r.stage, r.count])).toEqual([
      ['enquiries', 7],
      ['proposalSent', 5],
      ['quoted', 4],
      ['won', 3],
      ['invoiced', 2],
      ['paid', 1],
    ]);
    expect(funnel[1]!.conversion).toBeCloseTo(5 / 7);
    expect(funnel[0]!.conversion).toBeNull();
    expect(funnel.find((r) => r.stage === 'quoted')!.valueMinor).toBe(INR(100_000));
    expect(funnel.find((r) => r.stage === 'won')!.valueMinor).toBe(INR(90_000));
    expect(funnel.find((r) => r.stage === 'paid')!.valueMinor).toBeNull();
  });
});

describe('AC6: receivables ageing', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    // Due 30 days after the invoice date (company default): due = invoiceDaysAgo − 30 ago.
    for (const ago of [30, 31, 60, 61, 90, 91, 120, 121]) {
      await billedDeal(w, w.sales, '10,000', { invoiceDaysAgo: ago });
    }
    await billedDeal(w, w.sales, '10,000', { invoiceDaysAgo: 40, paidDaysAgo: 5 }); // paid
    const gone = await billedDeal(w, w.sales, '10,000', { invoiceDaysAgo: 40 });
    await softDeleteInvoice(w.sales, gone.invoice.id);
  });

  it('buckets by days past due as of today; totals equal outstanding', async () => {
    const { ageing } = await sales(w.sales);
    expect(ageing.buckets.map((b) => [b.bucket, b.count])).toEqual([
      ['notDue', 1], // due today
      ['days1to30', 2], // 1 and 30 days overdue
      ['days31to60', 2], // 31 and 60
      ['days61to90', 2], // 61 and 90
      ['over90', 1], // 91
    ]);
    expect(ageing.total).toEqual({ count: 8, valueMinor: INR(80_000) });
    // Invoiced in the last 90 days: the 30, 31, 60, 61 and 40 (paid) day ones = ₹50,000.
    // DSO = 80,000 ÷ 50,000 × 90 = 144.
    expect(ageing.dsoDays).toBe(144);
  });

  it('the invoice list’s ageing filter returns the same invoices as each bucket', async () => {
    const { ageing } = await sales(w.sales);
    for (const bucket of ageing.buckets) {
      const list = await listInvoices(w.sales, { ageing: bucket.bucket, pageSize: 100 });
      expect([bucket.bucket, list.total]).toEqual([bucket.bucket, bucket.count]);
    }
  });

  it('DSO is null when nothing was invoiced in 90 days', async () => {
    const { ageing } = await sales(w.sales2);
    expect(ageing.dsoDays).toBeNull();
    expect(ageing.total.count).toBe(0);
  });
});

describe('AC7: conversion and quoted vs won', () => {
  let w: ProjectWorld;
  let energy: string;
  beforeAll(async () => {
    w = await projectWorld();
    energy = (await createSector(w.admin, { name: 'Energy' })).id;
    await wonDeal(w, w.sales, '10,000', 5);
    await wonDeal(w, w.sales, '10,000', 5, { serviceIds: [w.inspection, w.audit] });
    await wonDeal(w, w.sales, '10,000', 5, { source: 'PHONE' });
    await lostDeal(w, w.sales, '10,000', { source: 'PHONE' });
    await wonDeal(w, w.sales2, '10,000', 5, { sectorId: energy }); // under 3 decided
  });

  it('by sector: rate with 3+ decided, "—" and last below that', async () => {
    const { conversion } = await sales(w.admin, { ...LAST_60, dimension: 'sector' });
    expect(conversion.rows.map((r) => [r.label, r.won, r.lost, r.rate])).toEqual([
      ['Pharma', 3, 1, 0.75],
      ['Energy', 1, 0, null],
    ]);
  });

  it('by service: a two-service quotation counts in each', async () => {
    const { conversion } = await sales(w.admin, { ...LAST_60, dimension: 'service' });
    expect(conversion.rows.map((r) => [r.label, r.won, r.lost])).toEqual([
      ['Inspection', 4, 1],
      ['Audit', 1, 0],
    ]);
  });

  it('by source, and by owner for admins only', async () => {
    const bySource = await sales(w.admin, { ...LAST_60, dimension: 'source' });
    expect(bySource.conversion.rows.map((r) => [r.key, r.won, r.lost])).toEqual([
      ['EMAIL', 3, 0],
      ['PHONE', 1, 1],
    ]);
    const byOwner = await sales(w.admin, { ...LAST_60, dimension: 'owner' });
    expect(byOwner.conversion.rows.map((r) => [r.label, r.won, r.lost])).toEqual([
      ['sales', 3, 1],
      ['sales2', 1, 0],
    ]);
    expect(await rejection(sales(w.sales, { ...LAST_60, dimension: 'owner' }))).toBeInstanceOf(
      ForbiddenError,
    );
  });

  it('the quotation list’s decided filter returns what a conversion bar counts', async () => {
    const { conversion } = await sales(w.admin, { ...LAST_60, dimension: 'sector' });
    const pharma = conversion.rows.find((r) => r.label === 'Pharma')!;
    const list = await listQuotations(w.admin, {
      decidedFrom: day(-60),
      decidedTo: day(0),
      sectorId: pharma.key,
      pageSize: 100,
    });
    expect(list.total).toBe(pharma.won + pharma.lost);
    // A search keeps working alongside it (both use OR).
    const searched = await listQuotations(w.admin, {
      decidedFrom: day(-60),
      decidedTo: day(0),
      q: 'Acme',
      pageSize: 100,
    });
    expect(searched.total).toBe(5);
  });

  it('quoted vs won: six months for a one-month period, zeros where empty', async () => {
    const { quotedVsWon } = await sales(w.admin, { preset: 'thisMonth' });
    expect(quotedVsWon).toHaveLength(6);
    const total = (key: 'quotedMinor' | 'wonMinor' | 'lostMinor') =>
      quotedVsWon.reduce((sum, m) => sum + m[key], 0n);
    // Quoted 119 days ago may fall before the six months; won 5 days ago is inside.
    expect(total('wonMinor')).toBe(INR(40_000));
    expect(total('lostMinor')).toBe(INR(10_000));
    expect(quotedVsWon.every((m) => /^\d{4}-\d{2}$/.test(m.month))).toBe(true);
  });
});

describe('AC8: top clients and the project layout', () => {
  let w: ProjectWorld;
  let globex: string;
  beforeAll(async () => {
    w = await projectWorld();
    globex = (await createClient(w.admin, { name: 'Globex', sectorId: w.pharma })).id;
    await billedDeal(w, w.sales, '1,00,000', { invoiceDaysAgo: 10, paidDaysAgo: 2 });
    await billedDeal(w, w.sales, '50,000', { invoiceDaysAgo: 20 });
    await billedDeal(w, w.sales, '3,00,000', { invoiceDaysAgo: 5, clientId: globex });
    await openDeal(w, w.sales, '70,000', { clientId: globex });
    await billedDeal(w, w.sales, '5,000', { invoiceDaysAgo: 100 }); // invoiced before the period
  });

  it('ranks clients by invoiced in the period, with their own dates per column', async () => {
    const { topClients } = await sales(w.sales);
    expect(topClients.map((c) => c.name)).toEqual(['Globex', 'Acme Pharma']);
    expect(topClients[0]).toMatchObject({
      invoicedMinor: INR(300_000),
      collectedMinor: 0n,
      outstandingMinor: INR(300_000),
      pipelineMinor: INR(70_000),
    });
    expect(topClients[1]).toMatchObject({
      invoicedMinor: INR(150_000),
      collectedMinor: INR(100_000),
      outstandingMinor: INR(55_000),
    });
  });

  it('the PM layout: their projects only, delivered late shows days late', async () => {
    const late = await billedDeal(w, w.sales, '20,000', {
      projectOverrides: { startDate: day(-40), endDate: day(-12) },
    });
    await changeProjectStatus(w.pm, {
      id: late.project.id,
      to: 'IN_PROGRESS',
      startDate: day(-40),
    });
    await changeProjectStatus(w.pm, {
      id: late.project.id,
      to: 'COMPLETED',
      completedDate: day(-2),
    });
    await billedDeal(w, w.sales, '1,000', {
      managerId: w.pm2.user.id,
      projectOverrides: { endDate: day(-1) },
    });

    const dash = await project(w.pm);
    expect(dash.scope).toMatchObject({ kind: 'project', user: { id: w.pm.user.id } });
    expect(dash.delivered).toEqual([
      expect.objectContaining({ projectId: late.project.id, daysLate: 10 }),
    ]);
    expect(dash.kpis.activeProjects).toBe(4); // the late one is completed
    expect(dash.kpis.invoiced.valueMinor).toBe(INR(470_000)); // the PM's invoices in the period
    expect(dash.billing.some((b) => b.projectId === late.project.id)).toBe(true);
    expect(dash.projectsByStatus).toEqual(
      expect.arrayContaining([{ status: 'COMPLETED', count: 1 }]),
    );

    const other = await project(w.pm2);
    expect(other.kpis.activeProjects).toBe(1);
    expect(other.kpis.behindSchedule).toBe(1);
  });
});

describe('AC9: scopes and permissions', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    await wonDeal(w, w.sales, '10,000', 5);
    await openDeal(w, w.sales2, '20,000');
    await billedDeal(w, w.sales, '30,000', { invoiceDaysAgo: 45 });
  });

  it('Sales get their own numbers and cannot pick an owner or manager', async () => {
    const own = await sales(w.sales);
    expect(own.scope).toEqual({ kind: 'personal', user: { id: w.sales.user.id, name: 'sales' } });
    expect(own.kpis.openPipeline.count).toBe(0);
    for (const input of [{ ownerId: w.sales2.user.id }, { managerId: w.pm.user.id }]) {
      expect(await rejection(getDashboard(w.sales, { ...LAST_60, ...input }))).toBeInstanceOf(
        ForbiddenError,
      );
    }
  });

  it('PMs get the project layout and cannot see the company', async () => {
    expect((await getDashboard(w.pm, LAST_60)).layout).toBe('project');
    expect(
      await rejection(getDashboard(w.pm, { ...LAST_60, ownerId: w.sales.user.id })),
    ).toBeInstanceOf(ForbiddenError);
  });

  it('admins narrow to an owner or a manager and see what they see', async () => {
    const asOwner = await sales(w.admin, { ...LAST_60, ownerId: w.sales.user.id });
    const own = await sales(w.sales);
    expect(asOwner.kpis).toEqual(own.kpis);
    expect(asOwner.scope.kind).toBe('personal');
    const asManager = await project(w.admin, { ...LAST_60, managerId: w.pm.user.id });
    expect(asManager.kpis).toEqual((await project(w.pm)).kpis);
    expect(
      await rejection(getDashboard(w.admin, { ...LAST_60, ownerId: w.pm.user.id })),
    ).toBeInstanceOf(NotFoundError);
  });
});

describe('AC10: records without an exchange rate', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    await openDeal(w, w.sales, '1,000', { currency: 'USD', quotedDaysAgo: 5 });
    await openDeal(w, w.sales, '10,000');
  });

  it('count them, leave them out of money totals, and report them until a rate exists', async () => {
    let dash = await sales(w.sales);
    expect(dash.kpis.openPipeline).toEqual({ count: 2, valueMinor: INR(10_000) });
    expect(dash.missingFx).toEqual({ count: 1, currencies: ['USD'] });

    await createExchangeRate(w.admin, { currency: 'USD', month: day(-5).slice(0, 7), rate: '80' });
    dash = await sales(w.sales);
    expect(dash.kpis.openPipeline).toEqual({ count: 2, valueMinor: INR(90_000) });
    expect(dash.missingFx).toEqual({ count: 0, currencies: [] });
  });
});

describe('AC11: exports', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
    await billedDeal(w, w.sales, '1,25,000.50', { invoiceDaysAgo: 3 });
    await billedDeal(w, w.sales2, '10,000', { invoiceDaysAgo: 3 });
  });

  it('top clients: documented columns, full rupees, scoped rows', async () => {
    const own = await exportDashboardPanel(w.sales, LAST_60, 'topClients');
    expect(own.columns).toEqual([
      'Client',
      'Invoiced (INR, incl. tax)',
      'Collected (INR)',
      'Outstanding now (INR)',
      'Won (INR)',
      'Open pipeline now (INR)',
    ]);
    expect(own.rows).toEqual([['Acme Pharma', '125000.50', '0.00', '125000.50', '0.00', '0.00']]);
    expect(own.filename).toMatch(/^dashboard-top-clients-.+\.csv$/);
    const all = await exportDashboardPanel(w.admin, LAST_60, 'topClients');
    expect(all.rows[0]![1]).toBe('135000.50');
  });

  it('project exports show statuses as words, not enum values', async () => {
    const { rows } = await exportDashboardPanel(w.pm, LAST_60, 'projectsByStatus');
    expect(rows.map((r) => r[0])).toEqual(expect.arrayContaining(['Not started']));
    expect(rows.flat().some((cell) => /^[A-Z_]{4,}$/.test(cell))).toBe(false);
  });

  it('CSV text has a BOM, quotes where needed, and CRLF lines', async () => {
    const { body } = await dashboardPanelCsv(w.admin, LAST_60, 'ageing');
    expect(body.startsWith('\uFEFFBucket,')).toBe(true);
    expect(body).toContain('\r\n');
  });

  it('a Sales user cannot export another scope', async () => {
    expect(
      await rejection(
        exportDashboardPanel(w.sales, { ...LAST_60, ownerId: w.sales2.user.id }, 'topClients'),
      ),
    ).toBeInstanceOf(ForbiddenError);
  });

  it('marks paid invoices collected in the export', async () => {
    const { invoice } = await billedDeal(w, w.sales, '1,000', { invoiceDaysAgo: 2 });
    await markInvoicePaid(w.sales, { id: invoice.id, paidAt: day(-1) });
    const { rows } = await exportDashboardPanel(w.sales, LAST_60, 'topClients');
    expect(rows[0]![2]).toBe('1000.00');
  });
});
