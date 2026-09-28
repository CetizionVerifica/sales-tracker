import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { enquiryStatus } from '../../reports/enquiry-status.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { bareEnquiry, dealWithPo, openDeal, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC2: each enquiry in the cohort lands in exactly one bucket; bucket counts sum to the
// cohort size; percentages sum to 100; win rate excludes under-pipeline enquiries.

let w: ReportsWorld;

beforeAll(async () => {
  w = await reportsWorld();
  // Converted into a PO.
  await dealWithPo(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-05' });
  await dealWithPo(w, w.sales, { clientId: w.clients.Globex!, receivedDate: '2026-01-06' });
  // Lost outright (never converted).
  await bareEnquiry(
    w,
    w.sales,
    { clientId: w.clients.Initech!, receivedDate: '2026-01-07' },
    'lost',
  );
  // Under pipeline: still IN_PROGRESS.
  await bareEnquiry(w, w.sales, { clientId: w.clients.Umbrella!, receivedDate: '2026-01-08' });
  // Under pipeline: CONVERTED with a quotation still SENT.
  await openDeal(w, w.sales, { clientId: w.clients.Wayne!, receivedDate: '2026-01-09' });
});
afterAll(disconnectAll);

const period = () =>
  resolvePeriod(
    reportFilterSchema.parse({ preset: 'custom', from: '2026-01-01', to: '2026-01-31' }),
    new Date('2026-01-15T00:00:00.000Z'),
  );

describe('enquiryStatus', () => {
  it('partitions the cohort exactly: bucket counts sum to the cohort size', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await enquiryStatus(db, scope, period(), {});

    expect(report.cohortSize).toBe(5);
    const total = report.buckets.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(report.cohortSize);

    const by = new Map(report.buckets.map((b) => [b.bucket, b.count]));
    expect(by.get('converted')).toBe(2);
    expect(by.get('lost')).toBe(1);
    expect(by.get('underPipeline')).toBe(2);
    expect(report.pipelineDetail).toEqual({ enquiryInProgress: 1, quotationActive: 1 });
  });

  it('percentages sum to exactly 100 (rounding handled)', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await enquiryStatus(db, scope, period(), {});
    const totalPct = report.buckets.reduce((n, b) => n + b.pct, 0);
    expect(totalPct).toBe(100);
  });

  it('win rate excludes under-pipeline enquiries', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await enquiryStatus(db, scope, period(), {});
    // 2 converted, 1 lost, 2 under pipeline: win rate = 2 / (2 + 1).
    expect(report.winRate).toBeCloseTo(2 / 3, 10);
  });

  it('win rate is null with no decided enquiries', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, {});
    const report = await enquiryStatus(
      db,
      scope,
      resolvePeriod(
        reportFilterSchema.parse({ preset: 'custom', from: '2026-06-01', to: '2026-06-30' }),
        new Date('2026-06-15T00:00:00.000Z'),
      ),
      {},
    );
    expect(report.cohortSize).toBe(0);
    expect(report.winRate).toBeNull();
  });
});
