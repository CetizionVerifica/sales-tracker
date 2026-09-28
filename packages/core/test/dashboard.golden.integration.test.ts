import { readFileSync, writeFileSync } from 'node:fs';
import { resetDb } from '@sales-tracker/db/test-utils';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import type { Dashboard, DashboardInput } from '../schemas/dashboard.ts';
import { getDashboard } from '../services/dashboard.service.ts';
import { DEV_USERS, seed } from '../system/seed.ts';

/*
 * M12 AC1, the PLAN.md "done when": the dashboard's numbers match the seeded fixtures. The
 * clock is pinned (only `Date`), so the seed's relative dates, the current quarter and every
 * number are the same on any day. Regenerate after a deliberate seed change with
 * UPDATE_GOLDEN=1, and review the diff line by line against the seed.
 */

const NOW = new Date('2026-09-28T06:30:00.000Z'); // 12:00 IST, Q2 FY 2026–27
const FIXTURE = new URL('./fixtures/dashboard.golden.json', import.meta.url);

/** Stable JSON: money as rupee strings, rates to four decimals, dates as days. */
function plain(value: unknown): unknown {
  if (typeof value === 'bigint') return `₹${(Number(value) / 100).toFixed(2)}`;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'number' && !Number.isInteger(value)) return Number(value.toFixed(4));
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        // Ids differ per run (a conversion row's `key` is a sector, service or user id);
        // labels and names identify the rows.
        .filter(([key]) => !/Id$/.test(key) && !['id', 'key', 'user'].includes(key))
        .map(([key, v]) => [key, plain(v)]),
    );
  }
  return value;
}

describe('AC1: the dashboard on the development seed (golden)', () => {
  const actual: Record<string, unknown> = {};

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    await resetDb(getDb());
    await seed({
      adminEmail: 'admin@example.com',
      adminPassword: 'admin-dev-password',
      devUsers: true,
    });

    const users = await getDb().user.findMany({
      where: { email: { in: [...DEV_USERS.map((u) => u.email), 'admin@example.com'] } },
      select: { id: true, email: true, role: true, active: true },
    });
    const ctxOf = (email: string): Ctx => {
      const u = users.find((row) => row.email === email)!;
      return { user: { id: u.id, role: u.role, active: u.active }, source: 'web' };
    };
    const idOf = (email: string) => users.find((row) => row.email === email)!.id;
    const views: [string, Ctx, DashboardInput][] = [
      ['admin · company · this quarter', ctxOf('admin@example.com'), {}],
      ['admin · company · by service', ctxOf('admin@example.com'), { dimension: 'service' }],
      ['admin · company · by source', ctxOf('admin@example.com'), { dimension: 'source' }],
      ['admin · company · by owner', ctxOf('admin@example.com'), { dimension: 'owner' }],
      ['admin · Sita Sales', ctxOf('admin@example.com'), { ownerId: idOf('sales2@example.com') }],
      ['admin · this financial year', ctxOf('admin@example.com'), { preset: 'thisFinancialYear' }],
      ['sales · this quarter', ctxOf('sales@example.com'), {}],
      ['sales2 · this quarter', ctxOf('sales2@example.com'), {}],
      ['pm · this quarter', ctxOf('pm@example.com'), {}],
    ];
    for (const [name, ctx, input] of views) {
      const result: Dashboard = await getDashboard(ctx, input);
      actual[name] = plain(result);
    }
  });

  afterAll(async () => {
    vi.useRealTimers();
    await disconnectAll();
  });

  it('every view matches the fixture', () => {
    if (process.env.UPDATE_GOLDEN) {
      writeFileSync(FIXTURE, `${JSON.stringify(actual, null, 2)}\n`);
    }
    const expected = JSON.parse(readFileSync(FIXTURE, 'utf8')) as unknown;
    expect(actual).toEqual(expected);
  });

  it('every panel has data on the seed', () => {
    const company = actual['admin · company · this quarter'] as {
      funnel: { count: number }[];
      ageing: { buckets: { count: number }[] };
      conversion: { rows: unknown[] };
      topClients: unknown[];
      missingFx: { count: number };
    };
    expect(company.funnel[0]!.count).toBeGreaterThan(0);
    expect(company.ageing.buckets.every((b) => b.count > 0)).toBe(true);
    expect(company.conversion.rows.length).toBeGreaterThan(0);
    expect(company.topClients.length).toBeGreaterThan(0);
    expect(company.missingFx.count).toBe(0); // the seed has USD rates for every month
    const pm = actual['pm · this quarter'] as { delivered: unknown[]; billing: unknown[] };
    expect(pm.delivered.length).toBeGreaterThan(0);
    expect(pm.billing.length).toBeGreaterThan(0);
  });
});
