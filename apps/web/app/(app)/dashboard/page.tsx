import { getDashboard, listUsers, NotFoundError, ForbiddenError, can } from '@sales-tracker/core';
import {
  dashboardInputSchema,
  formatInrShort,
  formatMoney,
  toCalendarDateString,
  type ProjectDashboard,
  type SalesDashboard,
} from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { Panel } from '@/components/charts/Panel';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { EmptyState } from '@/components/feedback/EmptyState';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { requireUser } from '@/lib/auth';
import { formatDate } from '@/lib/format';
import {
  AGEING_LABELS,
  AGEING_SHORT_LABELS,
  DEFINITIONS,
  DIMENSION_LABELS,
  FUNNEL_STAGE_COLORS,
  FUNNEL_STAGE_LABELS,
} from '@/lib/dashboard-labels';
import type { SearchParams } from '@/lib/list-params';
import { PROJECT_STATUS_LABELS } from '@/lib/project-labels';
import { cn } from '@/lib/utils';
import { AgeingChart, ConversionChart, FunnelChart, QuotedWonChart, StatusChart } from './Charts';
import { DashboardControls } from './DashboardControls';
import { KpiTile, percentDelta, pointsDelta } from './KpiTile';
import { MobileCards } from './MobileCards';
import { PanelActions } from './PanelActions';

export const metadata = { title: 'Dashboard · Sales Tracker' };

const day = toCalendarDateString;
const monthLabel = new Intl.DateTimeFormat('en-IN', {
  month: 'short',
  year: '2-digit',
  timeZone: 'UTC',
});
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/** Query string helper; empty values drop out. */
const qs = (params: Record<string, string | null | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();

/**
 * The dashboard (M12, UI guide 4.4): one page at each role's scope. Numbers follow the
 * binding definitions in docs/modules/M12-dashboard.md, shown in each panel's ⓘ.
 */
export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).flatMap(([k, v]) => (typeof v === 'string' && v ? [[k, v]] : [])),
  );
  const parsed = dashboardInputSchema.safeParse(flat);
  // A bad URL falls back to the default view rather than an error page.
  const input = parsed.success ? parsed.data : dashboardInputSchema.parse({});
  const isAdmin = can(ctx.user, 'list', 'user');

  let dashboard;
  try {
    dashboard = await getDashboard(ctx, input);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) return <NoAccess />;
    throw error;
  }
  const [owners, managers] = isAdmin
    ? await Promise.all([
        listUsers(ctx, { role: 'SALES', status: 'active', sort: 'name', pageSize: 100 }),
        listUsers(ctx, { role: 'PROJECT_MANAGER', status: 'active', sort: 'name', pageSize: 100 }),
      ])
    : [null, null];

  const periodQuery = {
    preset: input.preset,
    from: input.preset === 'custom' && input.from ? day(input.from) : null,
    to: input.preset === 'custom' && input.to ? day(input.to) : null,
  };
  const scopeQuery = { ownerId: input.ownerId ?? null, managerId: input.managerId ?? null };
  const exportHref = (panel: string) =>
    `/api/dashboard/export?${qs({ panel, ...periodQuery, ...scopeQuery, dimension: input.dimension })}`;

  const who = dashboard.scope.user?.name;
  const description = `${dashboard.period.label} (${formatDate(dashboard.period.from)} to ${formatDate(
    dashboard.period.to,
  )}) compared with ${dashboard.previous.label}${who ? ` · ${who}` : ''}`;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Dashboard" description={description} />
      <DashboardControls
        preset={input.preset}
        owners={owners ? owners.items.map((u) => ({ id: u.id, name: u.name })) : null}
        managers={managers ? managers.items.map((u) => ({ id: u.id, name: u.name })) : null}
        ownerId={input.ownerId ?? null}
        managerId={input.managerId ?? null}
      />
      {dashboard.missingFx.count > 0 && (
        <p className="text-muted-foreground text-[13px]" role="note">
          {dashboard.missingFx.count} {dashboard.missingFx.currencies.join(', ')}{' '}
          {dashboard.missingFx.count === 1 ? 'record has' : 'records have'} no exchange rate yet, so{' '}
          {dashboard.missingFx.count === 1 ? 'it is' : 'they are'} counted but left out of INR
          totals.
          {isAdmin && (
            <>
              {' '}
              <Link href="/admin/exchange-rates" className="underline">
                Add rates
              </Link>
            </>
          )}
        </p>
      )}
      {dashboard.layout === 'sales' ? (
        <SalesView
          dashboard={dashboard}
          exportHref={exportHref}
          periodQuery={periodQuery}
          scopeQuery={scopeQuery}
          isAdmin={isAdmin}
        />
      ) : (
        <ProjectView dashboard={dashboard} exportHref={exportHref} />
      )}
    </div>
  );
}

function SalesView({
  dashboard,
  exportHref,
  periodQuery,
  scopeQuery,
  isAdmin,
}: {
  dashboard: SalesDashboard;
  exportHref: (panel: string) => string;
  periodQuery: Record<string, string | null>;
  scopeQuery: { ownerId: string | null; managerId: string | null };
  isAdmin: boolean;
}) {
  const { kpis, period, previous } = dashboard;
  const from = day(period.from);
  const to = day(period.to);
  const owner = isAdmin ? scopeQuery.ownerId : null;

  const conversionHref = (key: string) => {
    const by = dashboard.conversion.dimension;
    if (by === 'source') return null; // the quotation list has no source filter
    const field = by === 'sector' ? 'sectorId' : by === 'service' ? 'serviceId' : 'ownerId';
    return `/quotations?${qs({ decidedFrom: from, decidedTo: to, [field]: key, ownerId: field === 'ownerId' ? key : owner })}`;
  };

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Open pipeline"
          definition={DEFINITIONS.openPipeline}
          value={formatInrShort(kpis.openPipeline.valueMinor)}
          full={formatMoney(kpis.openPipeline.valueMinor, 'INR')}
          sub={`${kpis.openPipeline.count} ${kpis.openPipeline.count === 1 ? 'quotation' : 'quotations'}`}
        />
        <KpiTile
          label="Win rate"
          definition={DEFINITIONS.winRate}
          value={pct(kpis.winRate.rate)}
          sub={`${kpis.winRate.won} won, ${kpis.winRate.lost} lost`}
          delta={pointsDelta(kpis.winRate.rate, kpis.winRate.previous)}
          comparedWith={previous.label}
        />
        <KpiTile
          label="Won this period"
          definition={DEFINITIONS.won}
          value={formatInrShort(kpis.won.valueMinor)}
          full={formatMoney(kpis.won.valueMinor, 'INR')}
          sub={`${kpis.won.count} ${kpis.won.count === 1 ? 'quotation' : 'quotations'}`}
          delta={percentDelta(kpis.won.valueMinor, kpis.won.previousMinor)}
          comparedWith={previous.label}
        />
        <KpiTile
          label="Overdue receivables"
          definition={DEFINITIONS.overdue}
          value={formatInrShort(kpis.overdue.valueMinor)}
          full={formatMoney(kpis.overdue.valueMinor, 'INR')}
          sub={`${kpis.overdue.count} ${kpis.overdue.count === 1 ? 'invoice' : 'invoices'}`}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel
          id="panel-funnel"
          className="lg:col-span-8"
          title="Pipeline funnel"
          description={`Enquiries received in ${period.label}`}
          actions={
            <PanelActions
              title="the pipeline funnel"
              definition={DEFINITIONS.funnel}
              exportHref={exportHref('funnel')}
            />
          }
        >
          {dashboard.funnel[0]!.count === 0 ? (
            <EmptyState message="No enquiries were received in this period." />
          ) : (
            <FunnelChart
              data={dashboard.funnel.map((row) => ({
                stage: row.stage,
                label: FUNNEL_STAGE_LABELS[row.stage],
                count: row.count,
                conversion: row.conversion,
                value: row.valueMinor === null ? null : row.valueMinor.toString(),
                color: FUNNEL_STAGE_COLORS[row.stage],
                href:
                  row.stage === 'enquiries'
                    ? `/enquiries?${qs({ receivedFrom: from, receivedTo: to, ownerId: owner })}`
                    : null,
              }))}
            />
          )}
        </Panel>
        <Panel
          id="panel-ageing"
          className="lg:col-span-4"
          title="Receivables ageing"
          description={`As of today · DSO ${dashboard.ageing.dsoDays === null ? '—' : `${dashboard.ageing.dsoDays} days`}`}
          actions={
            <PanelActions
              title="receivables ageing"
              definition={DEFINITIONS.ageing}
              exportHref={exportHref('ageing')}
            />
          }
        >
          {dashboard.ageing.total.count === 0 ? (
            <EmptyState message="Nothing is outstanding." />
          ) : (
            <AgeingChart
              data={dashboard.ageing.buckets.map((b) => ({
                bucket: b.bucket,
                label: AGEING_LABELS[b.bucket],
                short: AGEING_SHORT_LABELS[b.bucket],
                count: b.count,
                value: b.valueMinor.toString(),
                href: `/invoices?${qs({ ageing: b.bucket, ownerId: owner })}`,
              }))}
            />
          )}
        </Panel>

        <Panel
          id="panel-conversion"
          className="lg:col-span-6"
          title="Conversion"
          description={`By ${DIMENSION_LABELS[dashboard.conversion.dimension].toLowerCase()} · quotations decided in ${period.label}`}
          actions={
            <PanelActions
              title="conversion"
              definition={DEFINITIONS.conversion}
              exportHref={exportHref('conversion')}
            />
          }
        >
          <div className="mb-3 flex flex-wrap gap-1" role="group" aria-label="Group by">
            {(['sector', 'service', 'owner', 'source'] as const)
              .filter((d) => d !== 'owner' || isAdmin)
              .map((d) => {
                const active = d === dashboard.conversion.dimension;
                return (
                  <Link
                    key={d}
                    href={`/dashboard?${qs({ ...periodQuery, ...scopeQuery, dimension: d })}#panel-conversion`}
                    aria-current={active ? 'true' : undefined}
                    className={cn(
                      'rounded-[var(--radius-control)] border px-2.5 py-1 text-[13px]',
                      active ? 'border-primary bg-secondary' : 'bg-card hover:bg-accent',
                    )}
                  >
                    {DIMENSION_LABELS[d]}
                  </Link>
                );
              })}
          </div>
          {dashboard.conversion.rows.length === 0 ? (
            <EmptyState message="No quotations were decided in this period." />
          ) : (
            <ConversionChart
              dimension={DIMENSION_LABELS[dashboard.conversion.dimension].toLowerCase()}
              data={dashboard.conversion.rows.map((r) => ({
                key: r.key,
                label: r.label,
                won: r.won,
                lost: r.lost,
                rate: r.rate,
                href: conversionHref(r.key),
              }))}
            />
          )}
        </Panel>
        <Panel
          id="panel-quoted-won"
          className="lg:col-span-6"
          title="Quoted vs won"
          description="By month, INR"
          actions={
            <PanelActions
              title="quoted vs won"
              definition={DEFINITIONS.quotedVsWon}
              exportHref={exportHref('quotedVsWon')}
            />
          }
        >
          <QuotedWonChart
            data={dashboard.quotedVsWon.map((m) => {
              const start = new Date(`${m.month}-01T00:00:00.000Z`);
              const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
              return {
                month: m.month,
                label: monthLabel.format(start),
                quoted: m.quotedMinor.toString(),
                won: m.wonMinor.toString(),
                lost: m.lostMinor.toString(),
                href: `/quotations?${qs({ quotationFrom: day(start), quotationTo: day(end), ownerId: owner })}`,
              };
            })}
          />
        </Panel>

        <Panel
          id="panel-top-clients"
          className="lg:col-span-12"
          title="Top clients by revenue"
          description={`Invoiced in ${period.label}; outstanding and pipeline as of today`}
          actions={
            <PanelActions
              title="top clients"
              definition={DEFINITIONS.topClients}
              exportHref={exportHref('topClients')}
            />
          }
          bodyClassName="p-0"
        >
          {dashboard.topClients.length === 0 ? (
            <EmptyState message="No client has revenue or pipeline in this period." />
          ) : (
            <>
              <MobileCards
                cards={dashboard.topClients.map((c) => ({
                  key: c.clientId,
                  title: c.name,
                  href: `/clients/${c.clientId}`,
                  fields: [
                    [
                      'Invoiced (incl. tax)',
                      <Money key="i" amountMinor={c.invoicedMinor} currency="INR" />,
                    ],
                    ['Collected', <Money key="c" amountMinor={c.collectedMinor} currency="INR" />],
                    [
                      'Outstanding now',
                      <Money key="o" amountMinor={c.outstandingMinor} currency="INR" />,
                    ],
                    ['Won', <Money key="w" amountMinor={c.wonMinor} currency="INR" />],
                    [
                      'Open pipeline now',
                      <Money key="p" amountMinor={c.pipelineMinor} currency="INR" />,
                    ],
                  ],
                }))}
              />
              <Table className="hidden xl:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Invoiced (incl. tax)</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Outstanding now</TableHead>
                    <TableHead className="text-right">Won</TableHead>
                    <TableHead className="text-right">Open pipeline now</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.topClients.map((c) => (
                    <TableRow key={c.clientId}>
                      <TableCell>
                        <Link
                          href={`/clients/${c.clientId}`}
                          className="font-medium hover:underline"
                        >
                          {c.name}
                        </Link>
                      </TableCell>
                      {[
                        c.invoicedMinor,
                        c.collectedMinor,
                        c.outstandingMinor,
                        c.wonMinor,
                        c.pipelineMinor,
                      ].map((v, i) => (
                        <TableCell key={i} className="text-right">
                          <Money amountMinor={v} currency="INR" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}

function ProjectView({
  dashboard,
  exportHref,
}: {
  dashboard: ProjectDashboard;
  exportHref: (panel: string) => string;
}) {
  const { kpis, period, previous } = dashboard;
  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Active projects"
          definition={DEFINITIONS.activeProjects}
          value={String(kpis.activeProjects)}
        />
        <KpiTile
          label="Behind schedule"
          definition={DEFINITIONS.behindSchedule}
          value={String(kpis.behindSchedule)}
        />
        <KpiTile
          label="Invoiced this period"
          definition={DEFINITIONS.invoiced}
          value={formatInrShort(kpis.invoiced.valueMinor)}
          full={formatMoney(kpis.invoiced.valueMinor, 'INR')}
          sub={`${kpis.invoiced.count} ${kpis.invoiced.count === 1 ? 'invoice' : 'invoices'}`}
          delta={percentDelta(kpis.invoiced.valueMinor, kpis.invoiced.previousMinor)}
          comparedWith={previous.label}
        />
        <KpiTile
          label="Overdue receivables"
          definition={DEFINITIONS.overdue}
          value={formatInrShort(kpis.overdue.valueMinor)}
          full={formatMoney(kpis.overdue.valueMinor, 'INR')}
          sub={`${kpis.overdue.count} ${kpis.overdue.count === 1 ? 'invoice' : 'invoices'}`}
        />
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel
          id="panel-status"
          className="lg:col-span-6"
          title="Projects by status"
          description="As of today"
          actions={
            <PanelActions
              title="projects by status"
              definition={DEFINITIONS.projectsByStatus}
              exportHref={exportHref('projectsByStatus')}
            />
          }
        >
          {dashboard.projectsByStatus.length === 0 ? (
            <EmptyState message="No projects are assigned to you yet." />
          ) : (
            <StatusChart
              data={dashboard.projectsByStatus.map((r) => ({
                status: r.status,
                label:
                  PROJECT_STATUS_LABELS[r.status as keyof typeof PROJECT_STATUS_LABELS] ?? r.status,
                count: r.count,
                href: `/projects?status=${r.status}`,
              }))}
            />
          )}
        </Panel>
        <Panel
          id="panel-ageing"
          className="lg:col-span-6"
          title="Receivables ageing"
          description={`As of today · DSO ${dashboard.ageing.dsoDays === null ? '—' : `${dashboard.ageing.dsoDays} days`}`}
          actions={
            <PanelActions
              title="receivables ageing"
              definition={DEFINITIONS.ageing}
              exportHref={exportHref('ageing')}
            />
          }
        >
          {dashboard.ageing.total.count === 0 ? (
            <EmptyState message="Nothing is outstanding on your projects." />
          ) : (
            <AgeingChart
              data={dashboard.ageing.buckets.map((b) => ({
                bucket: b.bucket,
                label: AGEING_LABELS[b.bucket],
                short: AGEING_SHORT_LABELS[b.bucket],
                count: b.count,
                value: b.valueMinor.toString(),
                href: `/invoices?ageing=${b.bucket}`,
              }))}
            />
          )}
        </Panel>
        <Panel
          id="panel-delivered"
          className="lg:col-span-12"
          title="Delivered"
          description={`Completed in ${period.label}`}
          actions={
            <PanelActions
              title="delivered projects"
              definition={DEFINITIONS.delivered}
              exportHref={exportHref('delivered')}
            />
          }
          bodyClassName="p-0"
        >
          {dashboard.delivered.length === 0 ? (
            <EmptyState message="No projects were completed in this period." />
          ) : (
            <>
              <MobileCards
                cards={dashboard.delivered.map((r) => ({
                  key: r.projectId,
                  title: r.label,
                  href: `/projects/${r.projectId}`,
                  fields: [
                    ['Client', r.client],
                    ['Planned end', <DateDisplay key="e" value={r.endDate} />],
                    ['Completed', <DateDisplay key="c" value={r.completedDate} />],
                    [
                      'Days late',
                      r.daysLate === null ? '—' : r.daysLate <= 0 ? 'On time' : String(r.daysLate),
                    ],
                  ],
                }))}
              />
              <Table className="hidden xl:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead>Planned end</TableHead>
                    <TableHead>Completed</TableHead>
                    <TableHead className="text-right">Days late</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.delivered.map((r) => (
                    <TableRow key={r.projectId}>
                      <TableCell>
                        <Link
                          href={`/projects/${r.projectId}`}
                          className="font-medium hover:underline"
                        >
                          {r.label}
                        </Link>
                      </TableCell>
                      <TableCell>{r.client}</TableCell>
                      <TableCell>
                        <DateDisplay value={r.endDate} />
                      </TableCell>
                      <TableCell>
                        <DateDisplay value={r.completedDate} />
                      </TableCell>
                      <TableCell className="num text-right">
                        {r.daysLate === null ? '—' : r.daysLate <= 0 ? 'On time' : r.daysLate}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Panel>
        <Panel
          id="panel-billing"
          className="lg:col-span-12"
          title="Billing by project"
          description="Active projects and those completed in the period, INR"
          actions={
            <PanelActions
              title="billing by project"
              definition={DEFINITIONS.billing}
              exportHref={exportHref('billing')}
            />
          }
          bodyClassName="p-0"
        >
          {dashboard.billing.length === 0 ? (
            <EmptyState message="No active projects." />
          ) : (
            <>
              <MobileCards
                cards={dashboard.billing.map((r) => ({
                  key: r.projectId,
                  title: r.label,
                  href: `/projects/${r.projectId}`,
                  fields: [
                    ['Client', r.client],
                    [
                      'Revenue',
                      r.revenueMinor === null ? (
                        '—'
                      ) : (
                        <Money key="r" amountMinor={r.revenueMinor} currency="INR" />
                      ),
                    ],
                    ['Invoiced', <Money key="i" amountMinor={r.invoicedMinor} currency="INR" />],
                    ['Paid', <Money key="p" amountMinor={r.paidMinor} currency="INR" />],
                    [
                      'Outstanding',
                      <Money key="o" amountMinor={r.outstandingMinor} currency="INR" />,
                    ],
                  ],
                }))}
              />
              <Table className="hidden xl:table">
                <TableHeader>
                  <TableRow>
                    <TableHead>Project</TableHead>
                    <TableHead>Client</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead className="text-right">Invoiced</TableHead>
                    <TableHead className="text-right">Paid</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {dashboard.billing.map((r) => (
                    <TableRow key={r.projectId}>
                      <TableCell>
                        <Link
                          href={`/projects/${r.projectId}`}
                          className="font-medium hover:underline"
                        >
                          {r.label}
                        </Link>
                      </TableCell>
                      <TableCell>{r.client}</TableCell>
                      <TableCell className="text-right">
                        {r.revenueMinor === null ? (
                          '—'
                        ) : (
                          <Money amountMinor={r.revenueMinor} currency="INR" />
                        )}
                      </TableCell>
                      {[r.invoicedMinor, r.paidMinor, r.outstandingMinor].map((v, i) => (
                        <TableCell key={i} className="text-right">
                          <Money amountMinor={v} currency="INR" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
