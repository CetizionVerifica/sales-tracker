import { Prisma } from '@sales-tracker/db';
import type { Db } from '../clients.ts';
import type { ReportFilter, ReportPeriod } from '../schemas/report.ts';
import { enquiryServiceSql, sectorSql } from './filters.ts';
import type { ReportScope } from './scope.ts';

/**
 * R2 — enquiry status. Cohort: enquiries received in the period. Each falls in exactly one
 * bucket (M12b Metric definitions):
 *  - `converted`: a quotation reached PO_RECEIVED, or a linked project has a PO.
 *  - `lost`: the enquiry itself is LOST (an alternative to ever converting, not a post-
 *    conversion state — CLAUDE.md's enquiry status machine only reaches LOST from
 *    IN_PROGRESS, so a LOST enquiry never has a quotation to check).
 *  - `underPipeline`: everything else — IN_PROGRESS, or CONVERTED with its quotation still
 *    SENT/UNDER_NEGOTIATION or (an edge case the spec's parenthetical doesn't name) LOST at
 *    the quotation level; the tooltip splits it into "Enquiry in progress" (enquiry still
 *    IN_PROGRESS) and "Quotation sent / negotiating" (everything else here).
 * The SQL computes all three in one pass so the counts are guaranteed to partition the cohort
 * exactly (AC2), rather than relying on separate queries to add up.
 */

export const ENQUIRY_STATUS_BUCKETS = ['converted', 'lost', 'underPipeline'] as const;
export type EnquiryStatusBucket = (typeof ENQUIRY_STATUS_BUCKETS)[number];

export interface EnquiryStatusBucketRow {
  bucket: EnquiryStatusBucket;
  count: number;
  /** Rounded so the three displayed values sum to 100 (largest-remainder). */
  pct: number;
}

export interface EnquiryStatusReport {
  headline: string;
  cohortSize: number;
  buckets: EnquiryStatusBucketRow[];
  pipelineDetail: { enquiryInProgress: number; quotationActive: number };
  /** converted ÷ (converted + lost); null under 1 decided enquiry ("Win rate on decided
   * enquiries" — enquiry-level and cohort-based, distinct from the M12 dashboard's). */
  winRate: number | null;
  definition: string;
}

const DEFINITION =
  'Enquiries received in the period, split into converted into a PO, lost, or still under ' +
  'pipeline. Win rate on decided enquiries = converted ÷ (converted + lost), excluding ' +
  'enquiries still open.';

/** Whole percentages that sum to exactly 100 (largest-remainder method, ties by input order). */
function roundToHundred(counts: number[], total: number): number[] {
  if (total === 0) return counts.map(() => 0);
  const raw = counts.map((n) => (n / total) * 100);
  const floors = raw.map(Math.floor);
  let remainder = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((v, i) => ({ i, frac: v - Math.floor(v) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const result = [...floors];
  for (let k = 0; k < order.length && remainder > 0; k++, remainder--) result[order[k]!.i]! += 1;
  return result;
}

export async function enquiryStatus(
  db: Db,
  s: ReportScope,
  period: ReportPeriod,
  filter: Pick<ReportFilter, 'sectorId' | 'serviceId'>,
): Promise<EnquiryStatusReport> {
  const ownerSql = s.ownerId ? Prisma.sql`AND e."ownerId" = ${s.ownerId}` : Prisma.empty;
  const dimensionSql = Prisma.sql`${sectorSql(filter.sectorId)} ${enquiryServiceSql(filter.serviceId)}`;

  type Row = { bucket: string; count: bigint };
  const rows = await db.$queryRaw<Row[]>`
    WITH cohort AS (
      SELECT
        e.id,
        e.status,
        EXISTS (
          SELECT 1 FROM quotation q
          WHERE q."enquiryId" = e.id AND q."deletedAt" IS NULL AND q.status = 'PO_RECEIVED'
        ) OR EXISTS (
          SELECT 1 FROM quotation q
          JOIN project p ON p."quotationId" = q.id AND p."deletedAt" IS NULL
          JOIN purchase_order po ON po."projectId" = p.id AND po."deletedAt" IS NULL
          WHERE q."enquiryId" = e.id AND q."deletedAt" IS NULL
        ) AS converted,
        EXISTS (
          SELECT 1 FROM quotation q
          WHERE q."enquiryId" = e.id AND q."deletedAt" IS NULL
            AND q.status IN ('SENT', 'UNDER_NEGOTIATION')
        ) AS quotation_active
      FROM enquiry e
      JOIN client c ON c.id = e."clientId"
      WHERE e."deletedAt" IS NULL AND c."deletedAt" IS NULL
        AND e."receivedDate" BETWEEN ${period.from}::date AND ${period.to}::date
        ${ownerSql} ${dimensionSql}
    )
    SELECT
      CASE
        WHEN converted THEN 'converted'
        WHEN status = 'LOST' THEN 'lost'
        WHEN status = 'IN_PROGRESS' THEN 'inProgress'
        ELSE 'quotationActive'
      END AS bucket,
      COUNT(*) AS count
    FROM cohort
    GROUP BY 1`;

  const by = new Map(rows.map((r) => [r.bucket, Number(r.count)]));
  const converted = by.get('converted') ?? 0;
  const lost = by.get('lost') ?? 0;
  const enquiryInProgress = by.get('inProgress') ?? 0;
  const quotationActive = by.get('quotationActive') ?? 0;
  const underPipeline = enquiryInProgress + quotationActive;
  const cohortSize = converted + lost + underPipeline;

  const [convertedPct, lostPct, underPipelinePct] = roundToHundred(
    [converted, lost, underPipeline],
    cohortSize,
  );

  const decided = converted + lost;
  const winRate = decided > 0 ? converted / decided : null;

  const headline =
    cohortSize === 0
      ? `No enquiries were received ${period.label}.`
      : `${cohortSize} ${cohortSize === 1 ? 'enquiry was' : 'enquiries were'} received ${period.label}: ${convertedPct}% converted into a PO, ${lostPct}% lost, ${underPipelinePct}% still in the pipeline.`;

  return {
    headline,
    cohortSize,
    buckets: [
      { bucket: 'converted', count: converted, pct: convertedPct! },
      { bucket: 'lost', count: lost, pct: lostPct! },
      { bucket: 'underPipeline', count: underPipeline, pct: underPipelinePct! },
    ],
    pipelineDetail: { enquiryInProgress, quotationActive },
    winRate,
    definition: DEFINITION,
  };
}
