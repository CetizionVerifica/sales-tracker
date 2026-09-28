import { Prisma } from '@sales-tracker/db';
import { monthsIn, type ReportGranularity, type ReportPeriod } from '../schemas/report.ts';

/*
 * R1's default granularity and the zero-filled bucket series every day/week/month chart
 * needs. Every report field bucketed here (`receivedDate`, `invoiceDate`, `paidAt`, …) is a
 * `@db.Date` column: a timezone-naive calendar day that already stands for the IST day by the
 * app's own storage convention (`calendarDateSchema`), so `date_trunc` needs no `AT TIME
 * ZONE` conversion — unlike a `timestamptz` column such as `statusChangedAt` (M12's own
 * pipeline queries only convert those). Postgres truncates 'week' to Monday natively, which
 * is the ISO week this module wants.
 */

const DAY_MS = 86_400_000;

/** ≤ 31 days → day; ≤ 6 months → week; longer → month (M12b R1). */
export function defaultGranularity(period: { from: Date; to: Date }): ReportGranularity {
  const days = Math.round((period.to.getTime() - period.from.getTime()) / DAY_MS) + 1;
  if (days <= 31) return 'day';
  if (monthsIn(period).length <= 6) return 'week';
  return 'month';
}

export function resolveGranularity(
  filter: { granularity?: ReportGranularity | undefined },
  period: ReportPeriod,
): ReportGranularity {
  return filter.granularity ?? defaultGranularity(period);
}

/** The `date_trunc` unit and step for a granularity; validated against a fixed enum, so
 * interpolating either as raw SQL (not a bind parameter) is safe. */
const UNIT: Record<ReportGranularity, string> = { day: 'day', week: 'week', month: 'month' };
const STEP: Record<ReportGranularity, string> = { day: '1 day', week: '1 week', month: '1 month' };

/**
 * Every bucket start date touching `[from, to]` at `granularity`, so a period with no
 * enquiries in a bucket still shows it as zero (M12b AC1) rather than skipping it.
 */
export function bucketSeriesSql(from: Date, to: Date, granularity: ReportGranularity) {
  const unit = Prisma.raw(`'${UNIT[granularity]}'`);
  const step = Prisma.raw(`interval '${STEP[granularity]}'`);
  return Prisma.sql`SELECT generate_series(
    date_trunc(${unit}, ${from}::date),
    date_trunc(${unit}, ${to}::date),
    ${step}
  )::date AS bucket`;
}

/** `date_trunc(granularity, column)::date`, for grouping a date column into buckets. */
export function truncatedSql(column: Prisma.Sql, granularity: ReportGranularity) {
  const unit = Prisma.raw(`'${UNIT[granularity]}'`);
  return Prisma.sql`date_trunc(${unit}, ${column})::date`;
}

// ─── M12b: sector/service dimension filters ─────────────────────────────────────────
//
// `sectorId`/`serviceId` narrow every report that has that dimension (M12b filter bar).
// Every query joins the client as `c`, so the sector filter is always the same fragment. The
// service filter differs by what carries the service: an enquiry's `EnquiryService` join, a
// PO's `PurchaseOrderService` join (POs can have several services — an `EXISTS` matches a PO
// with that service among others, it doesn't restrict to PO-only-that-service), a PO line's
// own `serviceId` (R4 groups by it directly), or an invoice's own `serviceId` column.

/** `AND c."sectorId" = …`, for any query that joins `client c`. */
export function sectorSql(sectorId: string | null | undefined) {
  return sectorId ? Prisma.sql`AND c."sectorId" = ${sectorId}` : Prisma.empty;
}

/** `AND EXISTS (… enquiry_service …)`, for a query with an enquiry aliased `e`. */
export function enquiryServiceSql(serviceId: string | null | undefined) {
  return serviceId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM enquiry_service es
        WHERE es."enquiryId" = e.id AND es."serviceId" = ${serviceId}
      )`
    : Prisma.empty;
}

/** `AND EXISTS (… purchase_order_service …)` against `poId` (the PO row's `id` column,
 * however that query aliases it). */
export function purchaseOrderServiceSql(serviceId: string | null | undefined, poId: Prisma.Sql) {
  return serviceId
    ? Prisma.sql`AND EXISTS (
        SELECT 1 FROM purchase_order_service pos
        WHERE pos."purchaseOrderId" = ${poId} AND pos."serviceId" = ${serviceId}
      )`
    : Prisma.empty;
}
