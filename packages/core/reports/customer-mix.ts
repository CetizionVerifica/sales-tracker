import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportPeriod } from '../schemas/report.ts';
import { chartMonths } from '../schemas/report.ts';
import { toCalendarDateString } from '../schemas/common.ts';
import { enquiryServiceSql, purchaseOrderServiceSql, sectorSql } from './filters.ts';
import { sharePct } from './headlines.ts';
import type { ReportScope } from './scope.ts';

/**
 * R5 — customer analysis (M12b). "New" and "repeat" are facts about a client's whole history,
 * checked company-wide regardless of who owns the record (a client's first enquiry might sit
 * in another rep's pipeline): a Sales-scoped report still only *lists* the viewer's own
 * enquiries/POs (via `enquiriesIn`/`purchaseOrdersIn`), but whether one of them is a client's
 * first is decided globally, so a personal-scope view never mislabels a client as new when
 * someone else enquired them earlier.
 */

const TABLE_LIMIT = 10;

export interface CustomerMixMonth {
  month: string; // YYYY-MM
  firstOrders: number;
  repeatOrders: number;
  repeatValueMinor: bigint;
}

export interface NewEnquiryRow {
  enquiryId: string;
  clientId: string;
  clientName: string;
  sector: string;
  services: string;
  receivedDate: string;
  owner: string;
  status: string;
}

export interface RepeatOrderRow {
  purchaseOrderId: string;
  clientId: string;
  clientName: string;
  poNumber: string;
  services: string;
  valueMinor: bigint;
  receivedDate: string;
  previousOrders: number;
}

export interface CustomerMixReport {
  headline: string;
  months: CustomerMixMonth[];
  newCustomers: number;
  repeatOrders: number;
  repeatSharePct: number | null;
  newEnquiries: NewEnquiryRow[];
  repeatOrdersList: RepeatOrderRow[];
  definition: string;
}

const DEFINITION =
  'New customer: a client whose first-ever enquiry falls in the period. New enquiry: any ' +
  'enquiry in the period from a new customer. Repeat order: a PO in the period from a client ' +
  'with at least one earlier PO. First order: a PO in the period that is the client’s first ' +
  'ever. "First-ever" is checked across the whole company, not just your own records.';

export async function customerMix(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<CustomerMixReport> {
  const ownerEnquirySql = s.ownerId ? Prisma.sql`AND e."ownerId" = ${s.ownerId}` : Prisma.empty;
  const ownerPoSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  // Dimension filters narrow which rows are *listed*, never the global first-enquiry/first-PO
  // ranking (Decision 1) — applied only in each query's outer WHERE, as the owner filter is.
  const enquiryDimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${enquiryServiceSql(filter.serviceId)}`;
  const poDimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${purchaseOrderServiceSql(filter.serviceId, Prisma.sql`r.id`)}`;

  type NewEnquiryDbRow = {
    id: string;
    clientId: string;
    clientName: string;
    sector: string;
    services: string | null;
    receivedDate: Date;
    owner: string;
    status: string;
  };
  type RankedPoRow = {
    id: string;
    clientId: string;
    clientName: string;
    poNumber: string;
    services: string | null;
    amountInrMinor: bigint | null;
    receivedDate: Date;
    previousOrders: bigint;
  };
  type MonthRow = { month: string; firstOrders: bigint; repeatOrders: bigint; repeatValue: bigint };

  const [newEnquiries, rankedPos, months] = await Promise.all([
    db.$queryRaw<NewEnquiryDbRow[]>`
      WITH client_first_enquiry AS (
        SELECT "clientId", MIN("receivedDate") AS first_date
        FROM enquiry WHERE "deletedAt" IS NULL GROUP BY 1
      )
      SELECT e.id, e."clientId", c.name AS "clientName", sec.name AS sector,
             (SELECT string_agg(sv.name, ', ' ORDER BY sv.name)
              FROM enquiry_service es JOIN service sv ON sv.id = es."serviceId"
              WHERE es."enquiryId" = e.id) AS services,
             e."receivedDate", u.name AS owner, e.status::text AS status
      FROM enquiry e
      JOIN client c ON c.id = e."clientId" AND c."deletedAt" IS NULL
      JOIN sector sec ON sec.id = e."sectorId"
      JOIN "user" u ON u.id = e."ownerId"
      JOIN client_first_enquiry cfe ON cfe."clientId" = e."clientId"
      WHERE e."deletedAt" IS NULL
        AND e."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        AND cfe.first_date BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownerEnquirySql} ${enquiryDimensionSql}
      ORDER BY e."receivedDate" DESC, e."createdAt" DESC
      LIMIT ${TABLE_LIMIT}`,
    db.$queryRaw<RankedPoRow[]>`
      WITH ranked AS (
        SELECT po.id, po."clientId", po."poNumber", po."amountInrMinor", po."receivedDate",
               po."projectId",
               ROW_NUMBER() OVER (
                 PARTITION BY po."clientId"
                 ORDER BY po."receivedDate", po."createdAt", po.id
               ) - 1 AS previous_orders
        FROM purchase_order po
        WHERE po."deletedAt" IS NULL
      )
      SELECT r.id, r."clientId", c.name AS "clientName", r."poNumber",
             (SELECT string_agg(sv.name, ', ' ORDER BY sv.name)
              FROM purchase_order_service pos JOIN service sv ON sv.id = pos."serviceId"
              WHERE pos."purchaseOrderId" = r.id) AS services,
             r."amountInrMinor", r."receivedDate", r.previous_orders AS "previousOrders"
      FROM ranked r
      JOIN client c ON c.id = r."clientId" AND c."deletedAt" IS NULL
      JOIN project pr ON pr.id = r."projectId" AND pr."deletedAt" IS NULL
      JOIN quotation q ON q.id = pr."quotationId"
      WHERE r."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownerPoSql} ${poDimensionSql}
      ORDER BY r."receivedDate" DESC, r.id DESC`,
    db.$queryRaw<MonthRow[]>`
      WITH ranked AS (
        SELECT po.id, po."clientId", po."amountInrMinor", po."receivedDate", po."projectId",
               ROW_NUMBER() OVER (
                 PARTITION BY po."clientId"
                 ORDER BY po."receivedDate", po."createdAt", po.id
               ) AS rn
        FROM purchase_order po
        WHERE po."deletedAt" IS NULL
      )
      SELECT to_char(r."receivedDate", 'YYYY-MM') AS month,
             COUNT(*) FILTER (WHERE r.rn = 1) AS "firstOrders",
             COUNT(*) FILTER (WHERE r.rn > 1) AS "repeatOrders",
             COALESCE(SUM(r."amountInrMinor") FILTER (WHERE r.rn > 1), 0)::bigint AS "repeatValue"
      FROM ranked r
      JOIN client c ON c.id = r."clientId" AND c."deletedAt" IS NULL
      JOIN project pr ON pr.id = r."projectId" AND pr."deletedAt" IS NULL
      JOIN quotation q ON q.id = pr."quotationId"
      WHERE r."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownerPoSql} ${poDimensionSql}
      GROUP BY 1`,
  ]);

  const chartMonthKeys = chartMonths(period).map((m) => toCalendarDateString(m).slice(0, 7));
  const monthByKey = new Map(months.map((m) => [m.month, m]));
  const monthsOut: CustomerMixMonth[] = chartMonthKeys.map((key) => {
    const row = monthByKey.get(key);
    return {
      month: key,
      firstOrders: row ? Number(row.firstOrders) : 0,
      repeatOrders: row ? Number(row.repeatOrders) : 0,
      repeatValueMinor: row?.repeatValue ?? 0n,
    };
  });

  const newCustomers = new Set(newEnquiries.map((r) => r.clientId)).size;
  const repeatPos = rankedPos.filter((r) => r.previousOrders > 0n);
  const repeatOrdersCount = repeatPos.length;
  const totalValueMinor = rankedPos.reduce((n, r) => n + (r.amountInrMinor ?? 0n), 0n);
  const repeatValueMinor = repeatPos.reduce((n, r) => n + (r.amountInrMinor ?? 0n), 0n);
  const repeatSharePct = totalValueMinor > 0n ? sharePct(repeatValueMinor, totalValueMinor) : null;

  const headline =
    newCustomers === 0 && repeatOrdersCount === 0
      ? `No new or repeat business ${period.label}.`
      : `${newCustomers} new ${newCustomers === 1 ? 'customer' : 'customers'} and ${repeatOrdersCount} repeat ${repeatOrdersCount === 1 ? 'order' : 'orders'} ${period.label}` +
        (repeatSharePct === null ? '.' : `; repeat business is ${repeatSharePct}% of PO value.`);

  return {
    headline,
    months: monthsOut,
    newCustomers,
    repeatOrders: repeatOrdersCount,
    repeatSharePct,
    newEnquiries: newEnquiries.map((r) => ({
      enquiryId: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      sector: r.sector,
      services: r.services ?? '',
      receivedDate: toCalendarDateString(r.receivedDate),
      owner: r.owner,
      status: r.status,
    })),
    repeatOrdersList: repeatPos.slice(0, TABLE_LIMIT).map((r) => ({
      purchaseOrderId: r.id,
      clientId: r.clientId,
      clientName: r.clientName,
      poNumber: r.poNumber,
      services: r.services ?? '',
      valueMinor: r.amountInrMinor ?? 0n,
      receivedDate: toCalendarDateString(r.receivedDate),
      previousOrders: Number(r.previousOrders),
    })),
    definition: DEFINITION,
  };
}
