import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { enquiryVolume } from '../../reports/enquiry-volume.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { previousPeriod, reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { bareEnquiry, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC1: enquiries bucket correctly by day, week and month; zero buckets show as 0; weeks
// start Monday.

let w: ReportsWorld;

beforeAll(async () => {
  w = await reportsWorld();
  // January 2026: Thu 1 Jan .. Sat 31 Jan. The last day of the month, to prove no off-by-one
  // (the M12b AC1 "23:30 IST" scenario: a receivedDate on a month's last day must bucket into
  // that month, not spill into February).
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-05' });
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-05' });
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-31' });
  // Outside the test period (February): must not be counted.
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-02-01' });
});
afterAll(disconnectAll);

const filter = (extra: Record<string, unknown> = {}) =>
  reportFilterSchema.parse({ preset: 'custom', from: '2026-01-01', to: '2026-01-31', ...extra });

describe('enquiryVolume', () => {
  it('buckets by day, including the last day of the month, and zero-fills gaps', async () => {
    const db = getDb();
    const parsed = filter({ granularity: 'day' });
    const scope = resolveReportScope(w.admin, parsed);
    const period = resolvePeriod(parsed, new Date('2026-01-15T00:00:00.000Z'));
    const previous = previousPeriod(period);
    const report = await enquiryVolume(db, scope, parsed, period, previous);

    expect(report.granularity).toBe('day');
    expect(report.data).toHaveLength(31); // every day in January, none skipped
    const byDate = new Map(report.data.map((d) => [d.bucket, d.count]));
    expect(byDate.get('2026-01-05')).toBe(2);
    expect(byDate.get('2026-01-31')).toBe(1); // the last day counts in January, not February
    expect(byDate.get('2026-01-06')).toBe(0); // a zero-enquiry day still appears
    expect(report.total).toBe(3);
  });

  it('buckets by week, starting Monday', async () => {
    const db = getDb();
    const parsed = filter({ granularity: 'week' });
    const scope = resolveReportScope(w.admin, parsed);
    const period = resolvePeriod(parsed, new Date('2026-01-15T00:00:00.000Z'));
    const previous = previousPeriod(period);
    const report = await enquiryVolume(db, scope, parsed, period, previous);

    // 5 Jan 2026 is a Monday; 31 Jan is a Saturday in the week starting 26 Jan.
    for (const bucket of report.data) {
      const dow = new Date(`${bucket.bucket}T00:00:00.000Z`).getUTCDay();
      expect(dow).toBe(1); // Monday
    }
    const total = report.data.reduce((n, b) => n + b.count, 0);
    expect(total).toBe(3);
  });

  it('buckets by month for a longer period', async () => {
    const db = getDb();
    const parsed = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-03-31',
      granularity: 'month',
    });
    const scope = resolveReportScope(w.admin, parsed);
    const period = resolvePeriod(parsed, new Date('2026-02-15T00:00:00.000Z'));
    const previous = previousPeriod(period);
    const report = await enquiryVolume(db, scope, parsed, period, previous);
    expect(report.data.map((d) => d.bucket)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01']);
    const byMonth = new Map(report.data.map((d) => [d.bucket, d.count]));
    expect(byMonth.get('2026-01-01')).toBe(3);
    expect(byMonth.get('2026-02-01')).toBe(1);
    expect(byMonth.get('2026-03-01')).toBe(0);
  });

  it('defaults granularity by period length: <=31 days day, <=6 months week, longer month', async () => {
    const db = getDb();
    const scope = resolveReportScope(w.admin, filter());
    const short = filter();
    const shortPeriod = resolvePeriod(short, new Date('2026-01-15T00:00:00.000Z'));
    const shortReport = await enquiryVolume(
      db,
      scope,
      short,
      shortPeriod,
      previousPeriod(shortPeriod),
    );
    expect(shortReport.granularity).toBe('day');

    const medium = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-04-30',
    });
    const mediumPeriod = resolvePeriod(medium, new Date('2026-02-15T00:00:00.000Z'));
    const mediumReport = await enquiryVolume(
      db,
      scope,
      medium,
      mediumPeriod,
      previousPeriod(mediumPeriod),
    );
    expect(mediumReport.granularity).toBe('week');

    const long = reportFilterSchema.parse({
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-12-31',
    });
    const longPeriod = resolvePeriod(long, new Date('2026-06-15T00:00:00.000Z'));
    const longReport = await enquiryVolume(db, scope, long, longPeriod, previousPeriod(longPeriod));
    expect(longReport.granularity).toBe('month');
  });

  it('scopes to the owner for a Sales viewer', async () => {
    const db = getDb();
    await bareEnquiry(w, w.sales2, { clientId: w.clients.Globex!, receivedDate: '2026-01-10' });
    const parsed = filter();
    const scope = resolveReportScope(w.sales, parsed);
    const period = resolvePeriod(parsed, new Date('2026-01-15T00:00:00.000Z'));
    const report = await enquiryVolume(db, scope, parsed, period, previousPeriod(period));
    expect(report.total).toBe(3); // sales2's enquiry is excluded
  });

  it('headline reflects the total and change vs the previous period', async () => {
    const db = getDb();
    const parsed = filter();
    const scope = resolveReportScope(w.admin, parsed);
    const period = resolvePeriod(parsed, new Date('2026-01-15T00:00:00.000Z'));
    const report = await enquiryVolume(db, scope, parsed, period, previousPeriod(period));
    expect(report.headline).toMatch(/^\d+ enquiries 1 Jan – 31 Jan 2026, up from none in/);
  });
});
