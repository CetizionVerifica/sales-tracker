import { afterAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../../clients.ts';
import { ForbiddenError } from '../../errors.ts';
import { getSalesReport } from '../../reports/index.ts';
import { bareEnquiry, reportsWorld, type ReportsWorld } from './fixtures.ts';

// M12b AC8: a sales user sees only their own records and cannot remove the owner filter; a
// project manager gets 403 on the report functions.

let w: ReportsWorld;

const load = async () => {
  w = await reportsWorld();
  await bareEnquiry(w, w.sales, { clientId: w.clients.Acme!, receivedDate: '2026-01-05' });
  await bareEnquiry(w, w.sales2, { clientId: w.clients.Globex!, receivedDate: '2026-01-06' });
  return w;
};
afterAll(disconnectAll);

describe('reports RBAC', () => {
  it('an admin sees the whole company by default', async () => {
    await load();
    const report = await getSalesReport(w.admin, {
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(report.scope.kind).toBe('company');
    expect(report.scope.ownerId).toBeNull();
    expect(report.enquiryVolume.total).toBe(2); // both sales' and sales2's
  });

  it('an admin can narrow to one Sales user by ownerId', async () => {
    const report = await getSalesReport(w.admin, {
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
      ownerId: w.sales.user.id,
    });
    expect(report.scope.kind).toBe('personal');
    expect(report.enquiryVolume.total).toBe(1);
  });

  it('a Sales user is forced to their own records and cannot pick another owner', async () => {
    const report = await getSalesReport(w.sales, {
      preset: 'custom',
      from: '2026-01-01',
      to: '2026-01-31',
    });
    expect(report.scope.kind).toBe('personal');
    expect(report.scope.ownerId).toBe(w.sales.user.id);
    expect(report.enquiryVolume.total).toBe(1); // never sees sales2's enquiry

    await expect(
      getSalesReport(w.sales, {
        preset: 'custom',
        from: '2026-01-01',
        to: '2026-01-31',
        ownerId: w.sales2.user.id,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it('a project manager is denied entirely', async () => {
    await expect(
      getSalesReport(w.pm, { preset: 'custom', from: '2026-01-01', to: '2026-01-31' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
