import { Prisma } from '@sales-tracker/db';
import type { Db } from '../../clients.ts';
import { ForbiddenError } from '../../errors.ts';
import type {
  ClientRevenueRow,
  Conversion,
  ConversionRow,
  DashboardDimension,
  FunnelRow,
  MonthRow,
  SalesKpis,
  Tally,
  WinRate,
} from '../../schemas/dashboard.ts';
import { ENQUIRY_SOURCE_LABELS, ENQUIRY_SOURCES } from '../../schemas/enquiry.ts';
import { chartMonths, istStartOf, type ReportPeriod } from '../../schemas/report.ts';
import { toCalendarDateString } from '../../schemas/common.ts';
import { ACTIVE_QUOTATION_STATUSES } from '../../status/quotation.ts';
import { UNPAID_INVOICE_STATUSES } from '../../status/invoice.ts';
import { lostIn, wonIn } from '../quotation-queries.ts';
import { enquiriesIn, invoicesIn, quotationsIn, type ResolvedScope } from './scope.ts';

/*
 * Pipeline panels (M12 "Metric definitions"). Money is `amountInrMinor`: records without an
 * INR value yet add nothing to a sum but still count (Decision 1, AC10). Aggregation is in
 * the database; only grouped results are merged here.
 */

const DAY_MS = 86_400_000;
type Span = { from: Date; to: Date };

const sum = (value: bigint | null | undefined) => value ?? 0n;
export const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : null);
const bigRatio = (part: bigint, whole: bigint) =>
  whole > 0n ? Number((part * 1_000_000n) / whole) / 1_000_000 : null;

async function tally(db: Db, where: Prisma.QuotationWhereInput): Promise<Tally> {
  const row = await db.quotation.aggregate({
    where,
    _count: { _all: true },
    _sum: { amountInrMinor: true },
  });
  return { count: row._count._all, valueMinor: sum(row._sum.amountInrMinor) };
}

function winRate(won: Tally, lost: Tally): WinRate {
  const rate = won.count + lost.count >= 3 ? ratio(won.count, won.count + lost.count) : null;
  return {
    won: won.count,
    lost: lost.count,
    rate,
    valueRate: rate === null ? null : bigRatio(won.valueMinor, won.valueMinor + lost.valueMinor),
  };
}

/**
 * Open pipeline: quotations SENT or UNDER_NEGOTIATION now. Win rate: won ÷ (won + lost)
 * among quotations decided in the period, "—" under 3. Won: the quotation amount of those
 * won. Overdue receivables: invoices OVERDUE now.
 */
export async function salesKpis(
  db: Db,
  s: ResolvedScope,
  period: Span,
  previous: Span,
): Promise<SalesKpis> {
  const q = quotationsIn(s);
  const [open, won, lost, prevWon, prevLost, overdue] = await Promise.all([
    tally(db, { AND: [q, { status: { in: [...ACTIVE_QUOTATION_STATUSES] } }] }),
    tally(db, { AND: [q, wonIn(period)] }),
    tally(db, { AND: [q, lostIn(period)] }),
    tally(db, { AND: [q, wonIn(previous)] }),
    tally(db, { AND: [q, lostIn(previous)] }),
    db.invoice.aggregate({
      where: { AND: [invoicesIn(s), { status: 'OVERDUE' }] },
      _count: { _all: true },
      _sum: { amountInrMinor: true },
    }),
  ]);
  return {
    openPipeline: open,
    winRate: { ...winRate(won, lost), previous: winRate(prevWon, prevLost).rate },
    won: { ...won, previousMinor: prevWon.valueMinor },
    overdue: { count: overdue._count._all, valueMinor: sum(overdue._sum.amountInrMinor) },
  };
}

/**
 * Funnel over the cohort of enquiries received in the period; stages are cumulative.
 * Proposal sent: has a proposal sent date. Quoted: a live quotation. Won: a quotation with
 * the PO received. Invoiced: a live invoice under a won quotation's live project. Paid:
 * invoiced, and every live invoice under it paid.
 */
export async function funnel(db: Db, s: ResolvedScope, period: Span): Promise<FunnelRow[]> {
  const cohort: Prisma.EnquiryWhereInput = {
    AND: [enquiriesIn(s), { receivedDate: { gte: period.from, lte: period.to } }],
  };
  const liveQuote = { deletedAt: null };
  const invoicesUnder = (invoices: Prisma.InvoiceWhereInput) => ({
    deletedAt: null,
    status: 'PO_RECEIVED' as const,
    projects: {
      some: {
        deletedAt: null,
        purchaseOrders: { some: { deletedAt: null, invoices: { some: invoices } } },
      },
    },
  });
  const liveInvoice = { deletedAt: null };
  const unpaidInvoice = { deletedAt: null, status: { in: [...UNPAID_INVOICE_STATUSES] } };
  const count = (extra: Prisma.EnquiryWhereInput) =>
    db.enquiry.count({ where: { AND: [cohort, extra] } });

  const [enquiries, proposal, quoted, won, invoiced, paid, quotedIds, wonValue] = await Promise.all(
    [
      count({}),
      count({ proposalSentDate: { not: null } }),
      count({ quotations: { some: liveQuote } }),
      count({ quotations: { some: { ...liveQuote, status: 'PO_RECEIVED' } } }),
      count({ quotations: { some: invoicesUnder(liveInvoice) } }),
      count({
        AND: [
          { quotations: { some: invoicesUnder(liveInvoice) } },
          { quotations: { none: invoicesUnder(unpaidInvoice) } },
        ],
      }),
      db.enquiry.findMany({
        where: { AND: [cohort, { quotations: { some: liveQuote } }] },
        select: { id: true },
      }),
      db.quotation.aggregate({
        where: { deletedAt: null, status: 'PO_RECEIVED', enquiry: cohort },
        _sum: { amountInrMinor: true },
      }),
    ],
  );

  // Quoted value: the latest live quotation per enquiry (quotation date, then created).
  const ids = quotedIds.map((row) => row.id);
  const [latest] = ids.length
    ? await db.$queryRaw<{ total: bigint }[]>`
        SELECT COALESCE(SUM(l."amountInrMinor"), 0)::bigint AS total FROM (
          SELECT DISTINCT ON (q."enquiryId") q."amountInrMinor"
          FROM quotation q
          WHERE q."deletedAt" IS NULL AND q."enquiryId" = ANY(${ids}::text[])
          ORDER BY q."enquiryId", q."quotationDate" DESC, q."createdAt" DESC, q.id DESC
        ) l`
    : [{ total: 0n }];

  const counts: [FunnelRow['stage'], number, bigint | null][] = [
    ['enquiries', enquiries, null],
    ['proposalSent', proposal, null],
    ['quoted', quoted, latest?.total ?? 0n],
    ['won', won, sum(wonValue._sum.amountInrMinor)],
    ['invoiced', invoiced, null],
    ['paid', paid, null],
  ];
  return counts.map(([stage, n, valueMinor], i) => ({
    stage,
    count: n,
    conversion: i === 0 ? null : ratio(n, counts[i - 1]![1]),
    valueMinor,
  }));
}

/**
 * Win rate on quotations decided in the period, by the quotation's sector, each of its
 * services, its owner (admins), or its enquiry's source. Under 3 decided: "—", sorted last.
 */
export async function conversion(
  db: Db,
  s: ResolvedScope,
  period: Span,
  dimension: DashboardDimension,
): Promise<Conversion> {
  if (dimension === 'owner' && s.viewer.role !== 'ADMIN') {
    throw new ForbiddenError('read', 'dashboard');
  }
  const q = quotationsIn(s);
  const won: Prisma.QuotationWhereInput = { AND: [q, wonIn(period)] };
  const lost: Prisma.QuotationWhereInput = { AND: [q, lostIn(period)] };

  // key → [won, lost]
  const tallies = new Map<string, [number, number]>();
  const add = (key: string, index: 0 | 1, n: number) => {
    const entry = tallies.get(key) ?? [0, 0];
    entry[index] += n;
    tallies.set(key, entry);
  };

  let labels = new Map<string, string>();
  if (dimension === 'sector' || dimension === 'owner') {
    const by = dimension === 'sector' ? 'sectorId' : 'ownerId';
    const [w, l] = await Promise.all(
      [won, lost].map((where) => db.quotation.groupBy({ by: [by], where, _count: { _all: true } })),
    );
    for (const row of w!) add(row[by], 0, row._count._all);
    for (const row of l!) add(row[by], 1, row._count._all);
    const ids = [...tallies.keys()];
    labels =
      dimension === 'sector'
        ? new Map(
            (
              await db.sector.findMany({
                where: { id: { in: ids }, deletedAt: undefined },
                select: { id: true, name: true },
              })
            ).map((r) => [r.id, r.name]),
          )
        : new Map(
            (
              await db.user.findMany({
                where: { id: { in: ids } },
                select: { id: true, name: true },
              })
            ).map((r) => [r.id, r.name]),
          );
  } else if (dimension === 'service') {
    const [w, l] = await Promise.all(
      [won, lost].map((where) =>
        db.quotationService.groupBy({
          by: ['serviceId'],
          where: { quotation: where },
          _count: { _all: true },
        }),
      ),
    );
    for (const row of w!) add(row.serviceId, 0, row._count._all);
    for (const row of l!) add(row.serviceId, 1, row._count._all);
    labels = new Map(
      (
        await db.service.findMany({
          where: { id: { in: [...tallies.keys()] }, deletedAt: undefined },
          select: { id: true, name: true },
        })
      ).map((r) => [r.id, r.name]),
    );
  } else {
    // Enquiry source: an enum, so a fixed number of counts.
    const counts = await Promise.all(
      ENQUIRY_SOURCES.flatMap((source) =>
        [won, lost].map((where) =>
          db.quotation.count({ where: { AND: [where, { enquiry: { source } }] } }),
        ),
      ),
    );
    ENQUIRY_SOURCES.forEach((source, i) => {
      if (counts[i * 2]! + counts[i * 2 + 1]! === 0) return;
      add(source, 0, counts[i * 2]!);
      add(source, 1, counts[i * 2 + 1]!);
    });
    labels = new Map(Object.entries(ENQUIRY_SOURCE_LABELS));
  }

  const rows: ConversionRow[] = [...tallies].map(([key, [w, l]]) => ({
    key,
    label: labels.get(key) ?? key,
    ...winRate({ count: w, valueMinor: 0n }, { count: l, valueMinor: 0n }),
    valueRate: null,
  }));
  rows.sort(
    (a, b) =>
      Number(a.rate === null) - Number(b.rate === null) ||
      b.won + b.lost - (a.won + a.lost) ||
      a.label.localeCompare(b.label),
  );
  return { dimension, rows };
}

const monthKey = (day: Date) => toCalendarDateString(day).slice(0, 7);

/**
 * Quoted (by quotation date) and won (by PO received date) per month, over the period's
 * months or the six ending with a shorter period. Lost value by the IST day of the loss.
 */
export async function quotedVsWon(
  db: Db,
  s: ResolvedScope,
  period: ReportPeriod,
): Promise<MonthRow[]> {
  const months = chartMonths(period);
  const first = months[0]!;
  const last = months.at(-1)!;
  const end = new Date(Date.UTC(last.getUTCFullYear(), last.getUTCMonth() + 1, 1) - DAY_MS);
  const from = toCalendarDateString(first);
  const to = toCalendarDateString(end);
  // Company and personal scopes only: an admin sees all quotations and a Sales user their
  // own (scopeQuotations), which the owner filter below expresses in SQL.
  const owner = s.ownerId ? Prisma.sql`AND q."ownerId" = ${s.ownerId}` : Prisma.empty;
  const live = Prisma.sql`q."deletedAt" IS NULL AND c."deletedAt" IS NULL ${owner}`;
  const lostFrom = istStartOf(first).toISOString();
  const lostTo = istStartOf(new Date(end.getTime() + DAY_MS)).toISOString();

  type Row = { month: string; total: bigint };
  const [quoted, won, lost] = await Promise.all([
    db.$queryRaw<Row[]>`
      SELECT to_char(q."quotationDate", 'YYYY-MM') AS month,
             COALESCE(SUM(q."amountInrMinor"), 0)::bigint AS total
      FROM quotation q JOIN client c ON c.id = q."clientId"
      WHERE ${live} AND q."quotationDate" BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1`,
    db.$queryRaw<Row[]>`
      SELECT to_char(q."poReceivedDate", 'YYYY-MM') AS month,
             COALESCE(SUM(q."amountInrMinor"), 0)::bigint AS total
      FROM quotation q JOIN client c ON c.id = q."clientId"
      WHERE ${live} AND q.status = 'PO_RECEIVED'
        AND q."poReceivedDate" BETWEEN ${from}::date AND ${to}::date
      GROUP BY 1`,
    db.$queryRaw<Row[]>`
      SELECT to_char((q."statusChangedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS month,
             COALESCE(SUM(q."amountInrMinor"), 0)::bigint AS total
      FROM quotation q JOIN client c ON c.id = q."clientId"
      WHERE ${live} AND q.status = 'LOST'
        AND q."statusChangedAt" AT TIME ZONE 'UTC' >= ${lostFrom}::timestamptz
        AND q."statusChangedAt" AT TIME ZONE 'UTC' < ${lostTo}::timestamptz
      GROUP BY 1`,
  ]);
  const byMonth = (rows: Row[]) => new Map(rows.map((r) => [r.month, r.total]));
  const [q, w, l] = [byMonth(quoted), byMonth(won), byMonth(lost)];
  return months.map((month) => {
    const key = monthKey(month);
    return {
      month: key,
      quotedMinor: q.get(key) ?? 0n,
      wonMinor: w.get(key) ?? 0n,
      lostMinor: l.get(key) ?? 0n,
    };
  });
}

/**
 * Clients by invoiced (invoice date in the period), with collected (paid in the period),
 * outstanding now, won in the period and open pipeline now. `limit` null: every client with
 * any value (the export).
 */
export async function topClients(
  db: Db,
  s: ResolvedScope,
  period: Span,
  limit: number | null,
): Promise<ClientRevenueRow[]> {
  const inv = invoicesIn(s);
  const q = quotationsIn(s);
  const inPeriod = { gte: period.from, lte: period.to };
  const group = {
    by: ['clientId'] as const,
    _sum: { amountInrMinor: true } as const,
  };
  const [invoiced, collected, outstanding, won, pipeline] = await Promise.all([
    db.invoice.groupBy({
      ...group,
      by: ['clientId'],
      where: { AND: [inv, { invoiceDate: inPeriod }] },
    }),
    db.invoice.groupBy({
      ...group,
      by: ['clientId'],
      where: { AND: [inv, { status: 'PAID', paidAt: inPeriod }] },
    }),
    db.invoice.groupBy({
      ...group,
      by: ['clientId'],
      where: { AND: [inv, { status: { in: [...UNPAID_INVOICE_STATUSES] } }] },
    }),
    db.quotation.groupBy({ ...group, by: ['clientId'], where: { AND: [q, wonIn(period)] } }),
    db.quotation.groupBy({
      ...group,
      by: ['clientId'],
      where: { AND: [q, { status: { in: [...ACTIVE_QUOTATION_STATUSES] } }] },
    }),
  ]);

  const rows = new Map<string, ClientRevenueRow>();
  const put = (
    groups: { clientId: string; _sum: { amountInrMinor: bigint | null } }[],
    field: keyof Omit<ClientRevenueRow, 'clientId' | 'name'>,
  ) => {
    for (const g of groups) {
      const row =
        rows.get(g.clientId) ??
        ({
          clientId: g.clientId,
          name: '',
          invoicedMinor: 0n,
          collectedMinor: 0n,
          outstandingMinor: 0n,
          wonMinor: 0n,
          pipelineMinor: 0n,
        } satisfies ClientRevenueRow);
      row[field] += sum(g._sum.amountInrMinor);
      rows.set(g.clientId, row);
    }
  };
  put(invoiced, 'invoicedMinor');
  put(collected, 'collectedMinor');
  put(outstanding, 'outstandingMinor');
  put(won, 'wonMinor');
  put(pipeline, 'pipelineMinor');

  const clients = await db.client.findMany({
    where: { id: { in: [...rows.keys()] } },
    select: { id: true, name: true },
  });
  for (const client of clients) rows.get(client.id)!.name = client.name;

  const sorted = [...rows.values()]
    .filter((row) => row.name) // a client deleted since grouping
    .sort(
      (a, b) =>
        (b.invoicedMinor > a.invoicedMinor ? 1 : b.invoicedMinor < a.invoicedMinor ? -1 : 0) ||
        a.name.localeCompare(b.name),
    );
  return limit === null ? sorted : sorted.slice(0, limit);
}
