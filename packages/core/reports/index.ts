import { getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { todayInIST } from '../schemas/common.ts';
import {
  previousPeriod,
  reportFilterSchema,
  resolvePeriod,
  type ReportFilterInput,
  type ReportPeriod,
} from '../schemas/report.ts';
import { getCached, setCached } from './cache.ts';
import { customerMix, type CustomerMixReport } from './customer-mix.ts';
import { enquiryStatus, type EnquiryStatusReport } from './enquiry-status.ts';
import { enquiryVolume, type EnquiryVolumeReport } from './enquiry-volume.ts';
import { revenue, type RevenueReport } from './revenue.ts';
import { resolveReportScope, type ReportScopeKind } from './scope.ts';
import { sectorPos, type SectorPosReport } from './sector-pos.ts';
import { serviceSales, type ServiceSalesReport } from './service-sales.ts';

export type {
  CustomerMixReport,
  EnquiryStatusReport,
  EnquiryVolumeReport,
  RevenueReport,
  SectorPosReport,
  ServiceSalesReport,
};

export interface SalesReport {
  period: ReportPeriod;
  previous: ReportPeriod;
  scope: { kind: ReportScopeKind; ownerId: string | null };
  enquiryVolume: EnquiryVolumeReport;
  enquiryStatus: EnquiryStatusReport;
  sectorPos: SectorPosReport;
  serviceSales: ServiceSalesReport;
  customerMix: CustomerMixReport;
  revenue: RevenueReport;
}

/*
 * Reads are cached 5 minutes per filter and user scope (M12b), invalidated (via
 * `reports/cache.ts`) on writes to enquiries, POs or invoices; reads and this cache are not
 * audited (M12 Decision 8: exports and reads of data the user can already see aren't).
 */
export { invalidateReportsCache } from './cache.ts';

/** The six sales reports for one filter, at the viewer's scope (M12b). */
export async function getSalesReport(
  ctx: Ctx,
  input: ReportFilterInput = {},
  options: { today?: Date } = {},
): Promise<SalesReport> {
  const parsed = reportFilterSchema.parse(input);
  const scope = resolveReportScope(ctx, parsed);
  const today = options.today ?? todayInIST();
  const key = JSON.stringify({ scope: scope.kind, ownerId: scope.ownerId, today, ...parsed });
  const cached = getCached<SalesReport>(key);
  if (cached) return cached;

  const db = getDb();
  const period = resolvePeriod(parsed, today);
  const previous = previousPeriod(period);

  const [ev, es, sp, ss, cm, rv] = await Promise.all([
    enquiryVolume(db, scope, parsed, period, previous),
    enquiryStatus(db, scope, period, parsed),
    sectorPos(db, scope, period, previous, parsed),
    serviceSales(db, scope, period, parsed),
    customerMix(db, scope, period, parsed),
    revenue(db, scope, period, previous, parsed),
  ]);

  const value: SalesReport = {
    period,
    previous,
    scope: { kind: scope.kind, ownerId: scope.ownerId },
    enquiryVolume: ev,
    enquiryStatus: es,
    sectorPos: sp,
    serviceSales: ss,
    customerMix: cm,
    revenue: rv,
  };
  setCached(key, value);
  return value;
}
