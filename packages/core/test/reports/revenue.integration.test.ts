import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { revenue } from '../../reports/revenue.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { previousPeriod, reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { createExchangeRate } from '../../services/exchange-rate.service.ts';
import { billedDeal, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC6: invoiced uses invoiceDate, collected uses paidAt; a USD invoice uses its stored
// amountInrMinor; outstanding at month end is correct for an invoice paid the following month.

let w: ReportsWorld;

beforeAll(async () => {
  w = await reportsWorld();
  await createExchangeRate(w.admin, { currency: 'USD', month: '2026-01', rate: '83' });

  // Invoiced in January, collected (paid) in January too.
  await billedDeal(w, w.sales, {
    clientId: w.clients.Acme!,
    receivedDate: '2026-01-02',
    amount: '1,00,000',
    invoiceDate: '2026-01-05',
    paidAt: '2026-01-10',
  });

  // Invoiced in January, paid the FOLLOWING month (February): outstanding at end of January,
  // no longer outstanding at end of February.
  await billedDeal(w, w.sales, {
    clientId: w.clients.Globex!,
    receivedDate: '2026-01-03',
    amount: '60,000',
    invoiceDate: '2026-01-20',
    paidAt: '2026-02-05',
  });

  // A USD invoice: its INR total must come from the stored amountInrMinor (at 83/USD), not a
  // live conversion.
  await billedDeal(w, w.sales, {
    clientId: w.clients.Initech!,
    receivedDate: '2026-01-04',
    currency: 'USD',
    amount: '1,000',
    invoiceDate: '2026-01-12',
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
  return revenue(db, scope, period, previousPeriod(period), {});
};

describe('revenue', () => {
  it('invoiced uses invoiceDate and includes the USD invoice at its stored INR value', async () => {
    const report = await loadReport();
    // 1,00,000 + 60,000 + (1,000 USD × 83) = 1,60,000 + 83,000 = 2,43,000
    expect(report.invoicedMinor).toBe(2_43_000_00n);
  });

  it('collected uses paidAt, not invoiceDate', async () => {
    const report = await loadReport();
    const jan = report.months.find((m) => m.month === '2026-01')!;
    // Only the Acme invoice was paid in January; Globex's payment lands in February.
    expect(jan.collectedMinor).toBe(1_00_000_00n);
  });

  it('outstanding at month end is correct for an invoice paid the following month', async () => {
    const report = await loadReport();
    const jan = report.months.find((m) => m.month === '2026-01')!;
    const feb = report.months.find((m) => m.month === '2026-02');
    // At end of January: Globex (unpaid then) + the USD invoice (never paid) are outstanding.
    expect(jan.outstandingMinor).toBe(60_000_00n + 83_000_00n);
    // At end of February (if the chart window reaches it): Globex has since been paid.
    if (feb) {
      expect(feb.outstandingMinor).toBe(83_000_00n);
    }
  });

  it('collection rate is collected over invoiced for the period', async () => {
    const report = await loadReport();
    expect(report.collectionRatePct).toBe(Math.round((1_00_000_00 / 2_43_000_00) * 100));
  });
});
