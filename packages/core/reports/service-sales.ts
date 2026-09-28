import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportPeriod } from '../schemas/report.ts';
import { formatInrShort } from '../schemas/money.ts';
import { sectorSql } from './filters.ts';
import { sharePct } from './headlines.ts';
import type { ReportScope } from './scope.ts';

/**
 * R4 — service-wise sales: PO line value (M12b schema change 1) with the PO's `receivedDate`
 * in the period, grouped by service and ranked by value. The top 7 are shown; the rest are
 * grouped as "Other services". `estimated` is true when any line behind these numbers came
 * from an unconfirmed equal split (a pre-M12b PO, or a caller that skipped the form's split),
 * so the UI can foot-note it (M12b: "Estimated service split (R4)").
 */

const TOP_SERVICES = 7;
export const OTHER_SERVICE_KEY = 'other';

export interface ServiceSalesRow {
  key: string; // service id, or OTHER_SERVICE_KEY
  name: string;
  valueMinor: bigint;
  poCount: number;
  sharePct: number;
}

export interface ServiceSalesReport {
  headline: string;
  data: ServiceSalesRow[]; // sorted descending by value
  totalValueMinor: bigint;
  estimated: boolean;
  definition: string;
}

const DEFINITION =
  'PO line value (a PO’s amount split across its services) with a received date in the ' +
  'period, ranked by value. The top 7 services are shown; the rest are grouped as "Other ' +
  'services". Some figures use an estimated equal split where nobody confirmed one.';

export async function serviceSales(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<ServiceSalesReport> {
  const ownerSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const serviceSql = filter.serviceId
    ? Prisma.sql`AND pol."serviceId" = ${filter.serviceId}`
    : Prisma.empty;
  const dimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${serviceSql}`;

  type Row = { serviceId: string; value: bigint; poCount: bigint; anyEstimated: boolean };
  const rows = await db.$queryRaw<Row[]>`
    SELECT pol."serviceId" AS "serviceId",
           COALESCE(SUM(pol."amountInrMinor"), 0)::bigint AS value,
           COUNT(DISTINCT pol."purchaseOrderId") AS "poCount",
           BOOL_OR(pol."allocationEstimated") AS "anyEstimated"
    FROM purchase_order_line pol
    JOIN purchase_order po ON po.id = pol."purchaseOrderId"
    JOIN client c ON c.id = po."clientId"
    JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
    JOIN quotation q ON q.id = pr."quotationId"
    WHERE po."deletedAt" IS NULL AND c."deletedAt" IS NULL
      AND po."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
      ${ownerSql} ${dimensionSql}
    GROUP BY 1`;

  const serviceIds = rows.map((r) => r.serviceId);
  const services = serviceIds.length
    ? await db.service.findMany({
        where: { id: { in: serviceIds } },
        select: { id: true, name: true },
      })
    : [];
  const nameById = new Map(services.map((sv) => [sv.id, sv.name]));

  const ranked = rows
    .map((r) => ({
      id: r.serviceId,
      name: nameById.get(r.serviceId) ?? 'Unknown service',
      valueMinor: r.value,
      poCount: Number(r.poCount),
    }))
    .sort((a, b) => (b.valueMinor > a.valueMinor ? 1 : b.valueMinor < a.valueMinor ? -1 : 0));

  const top = ranked.slice(0, TOP_SERVICES);
  const rest = ranked.slice(TOP_SERVICES);
  const otherValue = rest.reduce((n, r) => n + r.valueMinor, 0n);
  const otherPoCount = rest.reduce((n, r) => n + r.poCount, 0);

  const totalValueMinor = ranked.reduce((n, r) => n + r.valueMinor, 0n);
  const estimated = rows.some((r) => r.anyEstimated);

  const data: ServiceSalesRow[] = top.map((r) => ({
    key: r.id,
    name: r.name,
    valueMinor: r.valueMinor,
    poCount: r.poCount,
    sharePct: sharePct(r.valueMinor, totalValueMinor),
  }));
  if (rest.length > 0) {
    data.push({
      key: OTHER_SERVICE_KEY,
      name: 'Other services',
      valueMinor: otherValue,
      poCount: otherPoCount,
      sharePct: sharePct(otherValue, totalValueMinor),
    });
  }

  const leader = data[0];
  const headline =
    totalValueMinor === 0n
      ? `No PO value was recorded ${period.label}.`
      : `${leader!.name} was the top service at ${formatInrShort(leader!.valueMinor)} (${leader!.sharePct}% of sales).`;

  return { headline, data, totalValueMinor, estimated, definition: DEFINITION };
}
