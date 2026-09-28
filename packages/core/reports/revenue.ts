import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportPeriod } from '../schemas/report.ts';
import { chartMonths } from '../schemas/report.ts';
import { purchaseOrderServiceSql, sectorSql } from './filters.ts';
import { moneySentence, sharePct } from './headlines.ts';
import type { ReportScope } from './scope.ts';

/**
 * R6 — revenue (M12b). Invoiced by `invoiceDate`, collected (PAID) by `paidAt`, PO booked
 * (order intake) by the PO's `receivedDate`. "Revenue" alone always means invoiced. Outstanding
 * at a month's end is reconstructed from `invoiceDate`/`paidAt` (no separate history table):
 * an invoice counts as outstanding then if it existed by that date and either was never paid
 * or was paid after it — correct for an invoice paid the following month (AC6), since the app
 * has no partial payments (CLAUDE.md's invoice status machine) to complicate the point-in-time
 * total. `months` is newest first, matching the detail table; reverse it for a chronological
 * chart.
 */

export interface RevenueMonth {
  month: string; // YYYY-MM
  invoiceCount: number;
  invoicedMinor: bigint;
  collectedMinor: bigint;
  outstandingMinor: bigint;
  poBookedMinor: bigint;
  topClient: string | null;
}

export interface RevenueReport {
  headline: string;
  months: RevenueMonth[]; // newest first
  invoicedMinor: bigint;
  previousInvoicedMinor: bigint;
  collectionRatePct: number | null;
  definition: string;
}

const DEFINITION =
  'Invoiced: invoice amounts by invoice date. Collected: invoice amounts with status Paid, ' +
  'by the date paid. PO booked: PO amounts by received date (order intake). Outstanding at ' +
  'month end: invoiced by that date and not yet paid by then. "Revenue" always means invoiced.';

async function invoicedIn(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<bigint> {
  const ownerSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const dimensionSql = invoiceDimensionSql(filter);
  const [row] = await db.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(i."amountInrMinor"), 0)::bigint AS total
    FROM invoice i
    JOIN client c ON c.id = i."clientId" AND c."deletedAt" IS NULL
    JOIN purchase_order po ON po.id = i."purchaseOrderId" AND po."deletedAt" IS NULL
    JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
    JOIN quotation q ON q.id = pr."quotationId"
    WHERE i."deletedAt" IS NULL
      AND i."invoiceDate" BETWEEN ${period.from}::date AND ${period.to}::date
      ${ownerSql} ${dimensionSql}`;
  return row?.total ?? 0n;
}

/** Invoice has a direct `serviceId` column (M10 Decision 4), so no EXISTS join is needed. */
function invoiceDimensionSql(filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>) {
  const serviceSql = filter.serviceId
    ? Prisma.sql`AND i."serviceId" = ${filter.serviceId}`
    : Prisma.empty;
  return Prisma.sql`${sectorSql(filter.sectorId)} ${serviceSql}`;
}

export async function revenue(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  previous: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<RevenueReport> {
  const months = chartMonths(period);
  const rangeFrom = months[0]!;
  const monthEnds = months.map(
    (m) => new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1) - 86_400_000),
  );
  const rangeTo = monthEnds.at(-1)!;
  const monthEndStrings = monthEnds.map((d) => d.toISOString().slice(0, 10));

  const ownerInvoiceSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const ownerPoSql = s.ownerId ? Prisma.sql`AND q2."ownerId" = ${s.ownerId}` : Prisma.empty;
  const invoiceDimSql = invoiceDimensionSql(filter);
  const poDimSql = Prisma.sql`${sectorSql(filter.sectorId)} ${purchaseOrderServiceSql(filter.serviceId, Prisma.sql`po.id`)}`;

  type InvoicedMonthRow = { month: string; invoiceCount: bigint; invoiced: bigint };
  type CollectedMonthRow = { month: string; collected: bigint };
  type TopClientRow = { month: string; clientName: string; invoiced: bigint };
  type OutstandingRow = { monthEnd: Date; outstanding: bigint };
  type PoBookedRow = { month: string; total: bigint };

  const [
    invoicedMonthRows,
    collectedMonthRows,
    topClientRows,
    outstandingRows,
    poBookedRows,
    invoicedTotal,
    previousInvoiced,
  ] = await Promise.all([
    db.$queryRaw<InvoicedMonthRow[]>`
        SELECT to_char(i."invoiceDate", 'YYYY-MM') AS month,
               COUNT(*) AS "invoiceCount",
               COALESCE(SUM(i."amountInrMinor"), 0)::bigint AS invoiced
        FROM invoice i
        JOIN client c ON c.id = i."clientId" AND c."deletedAt" IS NULL
        JOIN purchase_order po ON po.id = i."purchaseOrderId" AND po."deletedAt" IS NULL
        JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
        JOIN quotation q ON q.id = pr."quotationId"
        WHERE i."deletedAt" IS NULL
          AND i."invoiceDate" BETWEEN ${rangeFrom}::date AND ${rangeTo}::date
          ${ownerInvoiceSql} ${invoiceDimSql}
        GROUP BY 1`,
    // Collected buckets by `paidAt`, a *different* date from `invoiceDate` (AC6: an invoice
    // paid the following month must not count as collected in the month it was invoiced).
    db.$queryRaw<CollectedMonthRow[]>`
        SELECT to_char(i."paidAt", 'YYYY-MM') AS month,
               COALESCE(SUM(i."amountInrMinor"), 0)::bigint AS collected
        FROM invoice i
        JOIN client c ON c.id = i."clientId" AND c."deletedAt" IS NULL
        JOIN purchase_order po ON po.id = i."purchaseOrderId" AND po."deletedAt" IS NULL
        JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
        JOIN quotation q ON q.id = pr."quotationId"
        WHERE i."deletedAt" IS NULL AND i.status = 'PAID'
          AND i."paidAt" BETWEEN ${rangeFrom}::date AND ${rangeTo}::date
          ${ownerInvoiceSql} ${invoiceDimSql}
        GROUP BY 1`,
    db.$queryRaw<TopClientRow[]>`
        SELECT month, "clientName", invoiced FROM (
          SELECT to_char(i."invoiceDate", 'YYYY-MM') AS month, c.name AS "clientName",
                 SUM(i."amountInrMinor")::bigint AS invoiced,
                 ROW_NUMBER() OVER (
                   PARTITION BY to_char(i."invoiceDate", 'YYYY-MM')
                   ORDER BY SUM(i."amountInrMinor") DESC, c.name
                 ) AS rn
          FROM invoice i
          JOIN client c ON c.id = i."clientId" AND c."deletedAt" IS NULL
          JOIN purchase_order po ON po.id = i."purchaseOrderId" AND po."deletedAt" IS NULL
          JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
          JOIN quotation q ON q.id = pr."quotationId"
          WHERE i."deletedAt" IS NULL
            AND i."invoiceDate" BETWEEN ${rangeFrom}::date AND ${rangeTo}::date
            ${ownerInvoiceSql} ${invoiceDimSql}
          GROUP BY 1, 2
        ) ranked WHERE rn = 1`,
    db.$queryRaw<OutstandingRow[]>`
        SELECT me AS "monthEnd", COALESCE(sums.outstanding, 0) AS outstanding
        FROM unnest(${monthEndStrings}::date[]) AS me
        LEFT JOIN LATERAL (
          SELECT SUM(i."amountInrMinor")::bigint AS outstanding
          FROM invoice i
          JOIN client c ON c.id = i."clientId" AND c."deletedAt" IS NULL
          JOIN purchase_order po ON po.id = i."purchaseOrderId" AND po."deletedAt" IS NULL
          JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
          JOIN quotation q ON q.id = pr."quotationId"
          WHERE i."deletedAt" IS NULL
            AND i."invoiceDate" <= me
            AND (i."paidAt" IS NULL OR i."paidAt" > me)
            ${ownerInvoiceSql} ${invoiceDimSql}
        ) sums ON true`,
    db.$queryRaw<PoBookedRow[]>`
        SELECT to_char(po."receivedDate", 'YYYY-MM') AS month,
               COALESCE(SUM(po."amountInrMinor"), 0)::bigint AS total
        FROM purchase_order po
        JOIN client c ON c.id = po."clientId" AND c."deletedAt" IS NULL
        JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
        JOIN quotation q2 ON q2.id = pr."quotationId"
        WHERE po."deletedAt" IS NULL
          AND po."receivedDate" BETWEEN ${rangeFrom}::date AND ${rangeTo}::date
          ${ownerPoSql} ${poDimSql}
        GROUP BY 1`,
    invoicedIn(db, s, period, filter),
    invoicedIn(db, s, previous, filter),
  ]);

  const invoicedByMonth = new Map(invoicedMonthRows.map((r) => [r.month, r]));
  const collectedByMonth = new Map(collectedMonthRows.map((r) => [r.month, r.collected]));
  const topClientByMonth = new Map(topClientRows.map((r) => [r.month, r.clientName]));
  const outstandingByMonthEnd = new Map(
    outstandingRows.map((r) => [r.monthEnd.toISOString().slice(0, 10), r.outstanding]),
  );
  const poBookedByMonth = new Map(poBookedRows.map((r) => [r.month, r.total]));

  const monthsOut: RevenueMonth[] = months.map((m, i) => {
    const key = `${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`;
    const row = invoicedByMonth.get(key);
    const monthEndKey = monthEnds[i]!.toISOString().slice(0, 10);
    return {
      month: key,
      invoiceCount: row ? Number(row.invoiceCount) : 0,
      invoicedMinor: row?.invoiced ?? 0n,
      collectedMinor: collectedByMonth.get(key) ?? 0n,
      outstandingMinor: outstandingByMonthEnd.get(monthEndKey) ?? 0n,
      poBookedMinor: poBookedByMonth.get(key) ?? 0n,
      topClient: topClientByMonth.get(key) ?? null,
    };
  });
  monthsOut.reverse(); // newest first, per the detail table

  const collectedInPeriod = monthsOut
    // Only months inside the report's own period contribute to the headline's collection
    // rate; `months` may extend earlier to fill the chart's 6-month minimum.
    .filter((m) => {
      const start = new Date(`${m.month}-01T00:00:00.000Z`);
      return start >= new Date(Date.UTC(period.from.getUTCFullYear(), period.from.getUTCMonth()));
    })
    .reduce((n, m) => n + m.collectedMinor, 0n);

  const collectionRatePct = invoicedTotal > 0n ? sharePct(collectedInPeriod, invoicedTotal) : null;
  const headline =
    moneySentence({
      label: 'Invoiced',
      amountMinor: invoicedTotal,
      periodLabel: period.label,
      previousMinor: previousInvoiced,
      previousLabel: previous.label,
    }) + (collectionRatePct === null ? '' : ` Collection rate: ${collectionRatePct}%.`);

  return {
    headline,
    months: monthsOut,
    invoicedMinor: invoicedTotal,
    previousInvoicedMinor: previousInvoiced,
    collectionRatePct,
    definition: DEFINITION,
  };
}
