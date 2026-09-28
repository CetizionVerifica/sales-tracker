import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportGranularity, ReportPeriod } from '../schemas/report.ts';
import { toCalendarDateString } from '../schemas/common.ts';
import { countSentence } from './headlines.ts';
import {
  bucketSeriesSql,
  enquiryServiceSql,
  resolveGranularity,
  sectorSql,
  truncatedSql,
} from './filters.ts';
import { enquiriesIn, type ReportScope } from './scope.ts';

/**
 * R1 — total enquiries: count of enquiries by `receivedDate`, bucketed by day, week or month
 * (M12b Metric definitions). `receivedDate` is a `@db.Date` column that already stands for
 * the IST calendar day it was stored for (CLAUDE.md rule 6, `calendarDateSchema`), so bucketing
 * it needs no timezone conversion — only a `timestamptz` column would. Zero-enquiry buckets
 * are shown as zero (AC1), not skipped.
 */

export interface EnquiryVolumeBucket {
  bucket: string; // YYYY-MM-DD, the bucket's start date
  count: number;
}

export interface EnquiryVolumeReport {
  headline: string;
  granularity: ReportGranularity;
  data: EnquiryVolumeBucket[];
  total: number;
  previousTotal: number | null;
  definition: string;
}

const DEFINITION =
  'Count of enquiries by the date they were received, bucketed by day, week or month. ' +
  'Zero-enquiry buckets are shown as zero. Weeks start Monday.';

async function totalIn(
  db: Db,
  s: ReportScope,
  from: Date,
  to: Date,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<number> {
  return db.enquiry.count({
    where: {
      AND: [
        enquiriesIn(s),
        { receivedDate: { gte: from, lte: to } },
        filter.sectorId ? { sectorId: filter.sectorId } : {},
        filter.serviceId ? { services: { some: { serviceId: filter.serviceId } } } : {},
      ],
    },
  });
}

export async function enquiryVolume(
  db: Db,
  s: ReportScope,
  filter: ReportFilter,
  period: ReportPeriod,
  previous: ReportPeriod,
): Promise<EnquiryVolumeReport> {
  const granularity = resolveGranularity(filter, period);
  // A raw query can't take Prisma's typed WhereInput; report scope reduces to just an owner
  // filter for the only two roles that reach here (PMs are denied in resolveReportScope, and
  // scopeEnquiries's own ADMIN/SALES cases are exactly {} or { ownerId }).
  const ownerSql = s.ownerId ? Prisma.sql`AND e."ownerId" = ${s.ownerId}` : Prisma.empty;
  const dimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${enquiryServiceSql(filter.serviceId)}`;

  type Row = { bucket: Date; count: bigint };
  const [rows, total, previousTotal] = await Promise.all([
    db.$queryRaw<Row[]>`
      WITH buckets AS (${bucketSeriesSql(period.from, period.to, granularity)}),
      counts AS (
        SELECT ${truncatedSql(Prisma.sql`e."receivedDate"`, granularity)} AS bucket,
               COUNT(*) AS count
        FROM enquiry e
        JOIN client c ON c.id = e."clientId"
        WHERE e."deletedAt" IS NULL AND c."deletedAt" IS NULL
          AND e."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
          ${ownerSql} ${dimensionSql}
        GROUP BY 1
      )
      SELECT b.bucket, COALESCE(c.count, 0) AS count
      FROM buckets b LEFT JOIN counts c ON c.bucket = b.bucket
      ORDER BY b.bucket`,
    totalIn(db, s, period.from, period.to, filter),
    totalIn(db, s, previous.from, previous.to, filter),
  ]);

  return {
    headline: countSentence({
      noun: 'enquiry',
      pluralNoun: 'enquiries',
      count: total,
      periodLabel: period.label,
      previous: previousTotal,
      previousLabel: previous.label,
    }),
    granularity,
    data: rows.map((r) => ({ bucket: toCalendarDateString(r.bucket), count: Number(r.count) })),
    total,
    previousTotal,
    definition: DEFINITION,
  };
}
