import type { Prisma } from '@sales-tracker/db';
import type { Db } from '../../clients.ts';
import {
  AGEING_BUCKETS,
  type Ageing,
  type BillingRow,
  type DeliveredRow,
  type MissingFx,
  type ProjectKpis,
} from '../../schemas/dashboard.ts';
import { UNPAID_INVOICE_STATUSES } from '../../status/invoice.ts';
import { ACTIVE_PROJECT_STATUSES } from '../../status/project.ts';
import { projectLabel } from '../follow-up-targets.ts';
import { ageingBucketWhere } from '../invoice-queries.ts';
import { invoicesIn, projectsIn, quotationsIn, type ResolvedScope } from './scope.ts';

/*
 * Receivables ageing (both layouts) and the project manager layout (M12 "Metric
 * definitions"). Money is `amountInrMinor`.
 */

const DAY_MS = 86_400_000;
type Span = { from: Date; to: Date };
const sum = (value: bigint | null | undefined) => value ?? 0n;
const daysBefore = (today: Date, n: number) => new Date(today.getTime() - n * DAY_MS);

/**
 * Unpaid invoices by days past their due date as of today (a snapshot). DSO = outstanding
 * ÷ invoiced in the last 90 days × 90, whole days, null with nothing invoiced.
 */
export async function ageing(db: Db, s: ResolvedScope, today: Date): Promise<Ageing> {
  const unpaid: Prisma.InvoiceWhereInput = {
    AND: [invoicesIn(s), { status: { in: [...UNPAID_INVOICE_STATUSES] } }],
  };
  const [buckets, invoiced90] = await Promise.all([
    Promise.all(
      AGEING_BUCKETS.map(async (bucket) => {
        const row = await db.invoice.aggregate({
          where: { AND: [unpaid, ageingBucketWhere(bucket, today)] },
          _count: { _all: true },
          _sum: { amountInrMinor: true },
        });
        return { bucket, count: row._count._all, valueMinor: sum(row._sum.amountInrMinor) };
      }),
    ),
    db.invoice.aggregate({
      where: { AND: [invoicesIn(s), { invoiceDate: { gte: daysBefore(today, 89), lte: today } }] },
      _sum: { amountInrMinor: true },
    }),
  ]);
  const total = {
    count: buckets.reduce((n, b) => n + b.count, 0),
    valueMinor: buckets.reduce((v, b) => v + b.valueMinor, 0n),
  };
  const invoiced = sum(invoiced90._sum.amountInrMinor);
  // Whole days, rounded half up, in integer arithmetic.
  const dsoDays =
    invoiced > 0n ? Number((total.valueMinor * 90n * 2n + invoiced) / (invoiced * 2n)) : null;
  return { buckets, total, dsoDays };
}

/**
 * Active projects and those behind schedule (snapshots); invoiced on their projects in the
 * period and the previous one; overdue receivables on their projects.
 */
export async function projectKpis(
  db: Db,
  s: ResolvedScope,
  period: Span,
  previous: Span,
  today: Date,
): Promise<ProjectKpis> {
  const p = projectsIn(s);
  const inv = invoicesIn(s);
  const active = { status: { in: [...ACTIVE_PROJECT_STATUSES] } };
  const invoicedIn = (span: Span) =>
    db.invoice.aggregate({
      where: { AND: [inv, { invoiceDate: { gte: span.from, lte: span.to } }] },
      _count: { _all: true },
      _sum: { amountInrMinor: true },
    });
  const [activeProjects, behindSchedule, now, before, overdue] = await Promise.all([
    db.project.count({ where: { AND: [p, active] } }),
    db.project.count({ where: { AND: [p, active, { endDate: { lt: today } }] } }),
    invoicedIn(period),
    invoicedIn(previous),
    db.invoice.aggregate({
      where: { AND: [inv, { status: 'OVERDUE' }] },
      _count: { _all: true },
      _sum: { amountInrMinor: true },
    }),
  ]);
  return {
    activeProjects,
    behindSchedule,
    invoiced: {
      count: now._count._all,
      valueMinor: sum(now._sum.amountInrMinor),
      previousMinor: sum(before._sum.amountInrMinor),
    },
    overdue: { count: overdue._count._all, valueMinor: sum(overdue._sum.amountInrMinor) },
  };
}

export async function projectsByStatus(db: Db, s: ResolvedScope) {
  const rows = await db.project.groupBy({
    by: ['status'],
    where: projectsIn(s),
    _count: { _all: true },
  });
  return rows.map((row) => ({ status: row.status as string, count: row._count._all }));
}

/** Projects completed in the period: planned end vs the day they completed. */
export async function delivered(db: Db, s: ResolvedScope, period: Span): Promise<DeliveredRow[]> {
  const rows = await db.project.findMany({
    where: {
      AND: [
        projectsIn(s),
        { status: 'COMPLETED', completedDate: { gte: period.from, lte: period.to } },
      ],
    },
    select: {
      id: true,
      number: true,
      name: true,
      endDate: true,
      completedDate: true,
      client: { select: { name: true } },
    },
    orderBy: [{ completedDate: 'desc' }, { number: 'asc' }],
  });
  return rows.map((row) => ({
    projectId: row.id,
    label: projectLabel(row),
    client: row.client.name,
    endDate: row.endDate,
    completedDate: row.completedDate!,
    daysLate: row.endDate
      ? Math.round((row.completedDate!.getTime() - row.endDate.getTime()) / DAY_MS)
      : null,
  }));
}

/**
 * Active projects and those completed in the period: revenue, and their live invoices
 * invoiced, paid and outstanding, all in INR.
 */
export async function billing(db: Db, s: ResolvedScope, period: Span): Promise<BillingRow[]> {
  const projects = await db.project.findMany({
    where: {
      AND: [
        projectsIn(s),
        {
          OR: [
            { status: { in: [...ACTIVE_PROJECT_STATUSES] } },
            { status: 'COMPLETED', completedDate: { gte: period.from, lte: period.to } },
          ],
        },
      ],
    },
    select: {
      id: true,
      number: true,
      name: true,
      status: true,
      amountInrMinor: true,
      client: { select: { name: true } },
    },
    orderBy: { number: 'asc' },
  });
  const ids = projects.map((p) => p.id);
  const pos = await db.purchaseOrder.findMany({
    where: { projectId: { in: ids } },
    select: { id: true, projectId: true },
  });
  const projectOf = new Map(pos.map((po) => [po.id, po.projectId]));
  const groups = await db.invoice.groupBy({
    by: ['purchaseOrderId', 'status'],
    where: { AND: [invoicesIn(s), { purchaseOrderId: { in: [...projectOf.keys()] } }] },
    _sum: { amountInrMinor: true },
  });
  const totals = new Map(ids.map((id) => [id, { invoiced: 0n, paid: 0n, outstanding: 0n }]));
  for (const g of groups) {
    const t = totals.get(projectOf.get(g.purchaseOrderId)!)!;
    const value = sum(g._sum.amountInrMinor);
    t.invoiced += value;
    if (g.status === 'PAID') t.paid += value;
    else t.outstanding += value;
  }
  return projects.map((p) => {
    const t = totals.get(p.id)!;
    return {
      projectId: p.id,
      label: projectLabel(p),
      client: p.client.name,
      status: p.status,
      revenueMinor: p.amountInrMinor,
      invoicedMinor: t.invoiced,
      paidMinor: t.paid,
      outstandingMinor: t.outstanding,
    };
  });
}

/** Records in scope still waiting for a rate (non-INR with no INR value). */
export async function missingFx(
  db: Db,
  s: ResolvedScope,
  layout: 'sales' | 'project',
): Promise<MissingFx> {
  const noValue = { currency: { not: 'INR' }, amountInrMinor: null };
  const groups = await Promise.all([
    db.invoice.groupBy({
      by: ['currency'],
      where: { AND: [invoicesIn(s), noValue] },
      _count: { _all: true },
    }),
    layout === 'sales'
      ? db.quotation.groupBy({
          by: ['currency'],
          where: { AND: [quotationsIn(s), noValue] },
          _count: { _all: true },
        })
      : db.project.groupBy({
          by: ['currency'],
          where: { AND: [projectsIn(s), noValue] },
          _count: { _all: true },
        }),
  ]);
  const rows = groups.flat();
  return {
    count: rows.reduce((n, g) => n + g._count._all, 0),
    currencies: [...new Set(rows.map((g) => g.currency))].sort(),
  };
}
