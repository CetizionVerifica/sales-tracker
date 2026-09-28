import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportPeriod } from '../schemas/report.ts';
import { formatInrShort } from '../schemas/money.ts';
import { purchaseOrderServiceSql, sectorSql } from './filters.ts';
import { deltaPhrase, sharePct } from './headlines.ts';
import type { ReportScope } from './scope.ts';

/**
 * R3 — sector-wise POs: POs with `receivedDate` in the period, grouped by the client's
 * sector (M12b). The top 6 sectors by INR value are shown individually; the rest — and any
 * sector marked `isOther` in master data, regardless of its own rank — are grouped into
 * "Other sectors". Ranking is always by value; the count/value chart toggle only changes
 * which number is drawn, not the grouping.
 */

const TOP_SECTORS = 6;
export const OTHER_SECTOR_KEY = 'other';

export interface SectorPosRow {
  key: string; // sector id, or OTHER_SECTOR_KEY
  name: string;
  count: number;
  valueMinor: bigint;
  sharePct: number;
}

export interface SectorPosReport {
  headline: string;
  data: SectorPosRow[]; // sorted descending by value
  totalCount: number;
  totalValueMinor: bigint;
  previousTotalValueMinor: bigint;
  definition: string;
}

const DEFINITION =
  'POs with a received date in the period, grouped by the client’s sector, by count and ' +
  'INR value. The top 6 sectors are shown; the rest, and any sector marked "Other" in ' +
  'master data, are grouped as "Other sectors".';

async function totalValueIn(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<bigint> {
  const ownerSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const dimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${purchaseOrderServiceSql(filter.serviceId, Prisma.sql`po.id`)}`;
  const [row] = await db.$queryRaw<{ total: bigint }[]>`
    SELECT COALESCE(SUM(po."amountInrMinor"), 0)::bigint AS total
    FROM purchase_order po
    JOIN client c ON c.id = po."clientId"
    JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
    JOIN quotation q ON q.id = pr."quotationId"
    WHERE po."deletedAt" IS NULL AND c."deletedAt" IS NULL
      AND po."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
      ${ownerSql} ${dimensionSql}`;
  return row?.total ?? 0n;
}

export async function sectorPos(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  previous: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<SectorPosReport> {
  const ownerSql = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const dimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${purchaseOrderServiceSql(filter.serviceId, Prisma.sql`po.id`)}`;

  type Row = { sectorId: string; count: bigint; value: bigint };
  const [rows, sectors, previousTotal] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT c."sectorId" AS "sectorId", COUNT(*) AS count,
             COALESCE(SUM(po."amountInrMinor"), 0)::bigint AS value
      FROM purchase_order po
      JOIN client c ON c.id = po."clientId"
      JOIN project pr ON pr.id = po."projectId" AND pr."deletedAt" IS NULL
      JOIN quotation q ON q.id = pr."quotationId"
      WHERE po."deletedAt" IS NULL AND c."deletedAt" IS NULL
        AND po."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownerSql} ${dimensionSql}
      GROUP BY 1`,
    db.sector.findMany({ select: { id: true, name: true, isOther: true } }),
    totalValueIn(db, s, previous, filter),
  ]);

  const sectorById = new Map(sectors.map((sec) => [sec.id, sec]));
  const rankable: { id: string; name: string; count: number; valueMinor: bigint }[] = [];
  let otherCount = 0;
  let otherValue = 0n;

  for (const row of rows) {
    const sector = sectorById.get(row.sectorId);
    const name = sector?.name ?? 'Unknown sector';
    if (sector?.isOther) {
      otherCount += Number(row.count);
      otherValue += row.value;
    } else {
      rankable.push({ id: row.sectorId, name, count: Number(row.count), valueMinor: row.value });
    }
  }
  rankable.sort((a, b) => (b.valueMinor > a.valueMinor ? 1 : b.valueMinor < a.valueMinor ? -1 : 0));

  const top = rankable.slice(0, TOP_SECTORS);
  for (const rest of rankable.slice(TOP_SECTORS)) {
    otherCount += rest.count;
    otherValue += rest.valueMinor;
  }

  const totalCount = top.reduce((n, r) => n + r.count, 0) + otherCount;
  const totalValueMinor = top.reduce((n, r) => n + r.valueMinor, 0n) + otherValue;

  const data: SectorPosRow[] = top.map((r) => ({
    key: r.id,
    name: r.name,
    count: r.count,
    valueMinor: r.valueMinor,
    sharePct: sharePct(r.valueMinor, totalValueMinor),
  }));
  if (otherCount > 0 || otherValue > 0n) {
    data.push({
      key: OTHER_SECTOR_KEY,
      name: 'Other sectors',
      count: otherCount,
      valueMinor: otherValue,
      sharePct: sharePct(otherValue, totalValueMinor),
    });
  }
  data.sort((a, b) => (b.valueMinor > a.valueMinor ? 1 : b.valueMinor < a.valueMinor ? -1 : 0));

  const leader = data[0];
  const headline =
    totalCount === 0
      ? `No POs were received ${period.label}.`
      : `${leader!.name} led sales by sector at ${formatInrShort(leader!.valueMinor)} (${leader!.sharePct}% of PO value); total PO value is ${deltaPhrase(Number(totalValueMinor), Number(previousTotal), previous.label)}.`;

  return {
    headline,
    data,
    totalCount,
    totalValueMinor,
    previousTotalValueMinor: previousTotal,
    definition: DEFINITION,
  };
}
