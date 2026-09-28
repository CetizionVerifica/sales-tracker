import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { DashboardInput } from '../schemas/dashboard.ts';
import { getDashboard } from '../services/dashboard.service.ts';
import { billedDeal, day, lostDeal, openDeal, wonDeal } from './dashboard-fixtures.ts';
import { projectWorld, type ProjectWorld } from './project-fixtures.ts';
import { countQueries } from './query-counter.ts';

/*
 * M12 AC12: the dashboard costs a fixed number of queries whatever the data size (no query
 * per row or per group), and stays fast. The spec's "seed ×10" is approximated, as in M11,
 * by a world with 3 and then 30 records of each kind.
 */

const PERIOD: DashboardInput = { preset: 'custom', from: day(-90), to: day(0) };

async function addLoad(w: ProjectWorld, n: number) {
  for (let i = 0; i < n; i++) {
    await openDeal(w, w.sales, '10,000', { receivedDaysAgo: 30 });
    await wonDeal(w, w.sales, '20,000', 10, { receivedDaysAgo: 40 });
    await lostDeal(w, w.sales2, '5,000', { source: 'PHONE' });
    await billedDeal(w, w.sales, '30,000', { invoiceDaysAgo: 20 + (i % 100) });
  }
}

describe('AC12: dashboard performance', () => {
  let w: ProjectWorld;
  beforeAll(async () => {
    w = await projectWorld();
  });
  afterAll(disconnectAll);

  it('uses the same number of queries for 3 and 30 records of each kind, under 500 ms', async () => {
    await addLoad(w, 3);
    const views: DashboardInput[] = [
      PERIOD,
      { ...PERIOD, dimension: 'service' },
      { ...PERIOD, dimension: 'source' },
      { ...PERIOD, dimension: 'owner' },
    ];
    const small = [];
    for (const input of views)
      small.push((await countQueries(w.admin, () => getDashboard(w.admin, input))).queries);
    const pmSmall = (await countQueries(w.pm, () => getDashboard(w.pm, PERIOD))).queries;
    expect(Math.min(...small)).toBeGreaterThan(10);

    await addLoad(w, 27);
    const large = [];
    for (const input of views)
      large.push((await countQueries(w.admin, () => getDashboard(w.admin, input))).queries);
    expect(large).toEqual(small);
    expect((await countQueries(w.pm, () => getDashboard(w.pm, PERIOD))).queries).toBe(pmSmall);

    // The data really grew: 30 deals won 10 days ago (billed deals were won 198 days ago,
    // before the period) and 30 lost today.
    const company = await getDashboard(w.admin, PERIOD);
    if (company.layout !== 'sales') throw new Error('expected the sales layout');
    expect(company.kpis.winRate).toMatchObject({ won: 30, lost: 30 });

    // Warm, then time each layout.
    for (const ctx of [w.admin, w.sales, w.pm]) {
      await getDashboard(ctx, PERIOD);
      const started = performance.now();
      await getDashboard(ctx, PERIOD);
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});
