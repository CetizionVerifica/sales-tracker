import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../../clients.ts';
import { customerMix } from '../../reports/customer-mix.ts';
import { resolveReportScope } from '../../reports/scope.ts';
import { reportFilterSchema, resolvePeriod } from '../../schemas/report.ts';
import { bareEnquiry, dealWithPo, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC5: a client's first PO counts as a first order; their second PO (even in the same
// month) counts as a repeat order. A client whose first enquiry was before the period is not a
// new customer even if they enquired again in the period. "First-ever" is checked company-wide
// (Decision 1), not just the viewer's own records.

let w: ReportsWorld;

beforeAll(async () => {
  w = await reportsWorld();

  // Acme: first-ever enquiry in January (the test period) → a new customer, with a new enquiry
  // row. Two POs in January: the first is a first order, the second a repeat, same month.
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-03' });
  await dealWithPo(w, w.sales, {
    clientId: w.clients.Acme!,
    receivedDate: '2026-01-05',
    amount: '1,00,000',
  });
  await dealWithPo(w, w.sales, {
    clientId: w.clients.Acme!,
    receivedDate: '2026-01-20',
    amount: '40,000',
  });

  // Globex: enquired long before the period (not a new customer), enquires again in the
  // period — that later enquiry must not count as "new".
  await bareEnquiry(w, w.sales, { clientId: w.clients.Globex!, receivedDate: '2025-06-01' });
  await bareEnquiry(w, w.sales, { clientId: w.clients.Globex!, receivedDate: '2026-01-08' });

  // Initech: its first-ever enquiry was logged by a DIFFERENT Sales owner (sales2), outside
  // this viewer's scope — a Sales-scoped view of `sales` must still not call it new, because
  // the fact is checked company-wide.
  await bareEnquiry(w, w.sales2, { clientId: w.clients.Initech!, receivedDate: '2025-01-01' });
  await bareEnquiry(w, w.sales, { clientId: w.clients.Initech!, receivedDate: '2026-01-09' });
});
afterAll(disconnectAll);

const loadReport = async (scopeCtx = w.admin) => {
  const db = getDb();
  const scope = resolveReportScope(scopeCtx, {});
  const filter = reportFilterSchema.parse({
    preset: 'custom',
    from: '2026-01-01',
    to: '2026-01-31',
  });
  const period = resolvePeriod(filter, new Date('2026-01-15T00:00:00.000Z'));
  return customerMix(db, scope, period, {});
};

describe('customerMix', () => {
  it('a first PO is a first order; the second, same month, is a repeat order', async () => {
    const report = await loadReport();
    const acmeOrders = report.repeatOrdersList.filter((r) => r.clientId === w.clients.Acme);
    expect(acmeOrders).toHaveLength(1);
    expect(acmeOrders[0]!.valueMinor).toBe(40_000_00n);
    expect(acmeOrders[0]!.previousOrders).toBe(1);

    const month = report.months.find((m) => m.month === '2026-01')!;
    expect(month.firstOrders).toBeGreaterThanOrEqual(1);
    expect(month.repeatOrders).toBeGreaterThanOrEqual(1);
  });

  it('a client whose first enquiry predates the period is not a new customer', async () => {
    const report = await loadReport();
    expect(report.newEnquiries.some((r) => r.clientId === w.clients.Globex)).toBe(false);
  });

  it('a new customer is counted, with every one of their period enquiries listed', async () => {
    const report = await loadReport();
    // Acme has 3 enquiries in January (one bare, one per dealWithPo call); its first-ever
    // enquiry (3 Jan) is in the period, so all 3 count as "new enquiries" (M12b: "Any enquiry
    // in the period from a new customer").
    const acmeRows = report.newEnquiries.filter((r) => r.clientId === w.clients.Acme);
    expect(acmeRows.map((r) => r.receivedDate).sort()).toEqual([
      '2026-01-03',
      '2026-01-05',
      '2026-01-20',
    ]);
    expect(report.newCustomers).toBeGreaterThanOrEqual(1);
  });

  it('"first-ever" is checked company-wide, not just the viewer’s own records', async () => {
    const report = await loadReport(w.sales); // sales owns Initech's 2026 enquiry, not its 2025 one
    expect(report.newEnquiries.some((r) => r.clientId === w.clients.Initech)).toBe(false);
  });

  it('repeat share of PO value is the repeat total over the whole PO total', async () => {
    const report = await loadReport();
    expect(report.repeatSharePct).not.toBeNull();
    expect(report.repeatSharePct).toBeGreaterThan(0);
    expect(report.repeatSharePct).toBeLessThanOrEqual(100);
  });
});
