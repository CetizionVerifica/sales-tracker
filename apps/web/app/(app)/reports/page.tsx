import {
  can,
  getSalesReport,
  listSectorOptions,
  listServiceOptions,
  listUsers,
  ForbiddenError,
  NotFoundError,
} from '@sales-tracker/core';
import {
  formatInrShort,
  formatMoney,
  reportFilterSchema,
  toCalendarDateString,
} from '@sales-tracker/core/schemas';
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
import type { SearchParams } from '@/lib/list-params';
import {
  CustomerMixChart,
  EnquiryStatusBar,
  EnquiryVolumeChart,
  RankedBarChart,
  RevenueChart,
  type CustomerMixDatum,
  type EnquiryStatusDatum,
  type EnquiryVolumeDatum,
  type RankedBarDatum,
  type RevenueDatum,
} from './Charts';
import { InfoTip } from '../dashboard/PanelActions';
import { KpiTile, percentDelta } from '../dashboard/KpiTile';
import { ReportExportActions } from './ExportMenu';
import { ReportsControls } from './ReportsControls';

export const metadata = { title: 'Sales reports · Sales Tracker' };

const day = toCalendarDateString;
const STATUS_COLOR = {
  converted: 'var(--success)',
  lost: 'var(--destructive)',
  underPipeline: 'var(--neutral)',
};
const STATUS_LABEL = {
  converted: 'Converted into PO',
  lost: 'Lost',
  underPipeline: 'Under pipeline',
};
/**
 * The enquiries list only filters by `Enquiry.status`, which doesn't distinguish "converted
 * into a PO" from any other CONVERTED enquiry, or split "under pipeline" into its two causes
 * (M12b R2's bucket rules use the quotation chain, not just the enquiry's own status) — these
 * are the closest approximations the list page can filter to.
 */
const STATUS_QUERY = {
  converted: 'CONVERTED',
  lost: 'LOST',
  underPipeline: 'IN_PROGRESS,CONVERTED',
};
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

/** Query string helper; empty values drop out. */
const qs = (params: Record<string, string | null | undefined>) =>
  new URLSearchParams(
    Object.entries(params).filter((entry): entry is [string, string] => Boolean(entry[1])),
  ).toString();

/**
 * The sales reports page (M12b, UI guide 4.4): six management questions on one screen,
 * following the M12b dashboard template. Numbers follow the binding definitions in
 * docs/modules/M12b-sales-reports.md, shown in each panel's ⓘ.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  const raw = await searchParams;
  const flat = Object.fromEntries(
    Object.entries(raw).flatMap(([k, v]) => (typeof v === 'string' && v ? [[k, v]] : [])),
  );
  const parsed = reportFilterSchema.safeParse(flat);
  const input = parsed.success ? parsed.data : reportFilterSchema.parse({});
  const isAdmin = can(ctx.user, 'list', 'user');

  let report;
  try {
    report = await getSalesReport(ctx, input);
  } catch (error) {
    if (error instanceof NotFoundError) notFound();
    if (error instanceof ForbiddenError) return <NoAccess />;
    throw error;
  }

  const [owners, sectors, services] = await Promise.all([
    isAdmin
      ? listUsers(ctx, { role: 'SALES', status: 'active', sort: 'name', pageSize: 100 })
      : Promise.resolve(null),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
  ]);

  const periodQuery = {
    preset: input.preset,
    from: input.preset === 'custom' && input.from ? day(input.from) : null,
    to: input.preset === 'custom' && input.to ? day(input.to) : null,
  };
  const query = qs({
    ...periodQuery,
    granularity: input.granularity ?? null,
    ownerId: input.ownerId ?? null,
    sectorId: input.sectorId ?? null,
    serviceId: input.serviceId ?? null,
  });

  const description = `${day(report.period.from)} – ${day(report.period.to)} compared with ${day(report.previous.from)} – ${day(report.previous.to)}`;

  const v1 = report.enquiryVolume;
  const v2 = report.enquiryStatus;
  const v3 = report.sectorPos;
  const v4 = report.serviceSales;
  const v5 = report.customerMix;
  const v6 = report.revenue;

  return (
    <div className="flex flex-col gap-4">
      <div className="hidden print:block">
        <p className="text-[13px] font-semibold">Sales Tracker — Sales reports</p>
        <p className="text-muted-foreground text-[12px]">
          {report.period.label} · generated {formatDate(new Date())}
        </p>
      </div>
      <PageHeader
        title="Sales reports"
        description={description}
        actions={<ReportExportActions query={query} />}
      />
      <div className="print:hidden">
        <ReportsControls
          preset={input.preset}
          granularity={v1.granularity}
          owners={owners ? owners.items.map((u) => ({ id: u.id, name: u.name })) : null}
          ownerId={input.ownerId ?? null}
          sectors={sectors}
          sectorId={input.sectorId ?? null}
          services={services}
          serviceId={input.serviceId ?? null}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiTile
          label="Enquiries"
          definition={v1.definition}
          value={String(v1.total)}
          delta={
            v1.previousTotal === null
              ? null
              : percentDelta(BigInt(v1.total), BigInt(v1.previousTotal))
          }
          comparedWith={report.previous.label}
        />
        <KpiTile
          label="Win rate on decided"
          definition={v2.definition}
          value={pct(v2.winRate)}
          sub={`${v2.buckets[0]!.count} won, ${v2.buckets[1]!.count} lost`}
        />
        <KpiTile
          label="POs received"
          definition={v3.definition}
          value={formatInrShort(v3.totalValueMinor)}
          full={formatMoney(v3.totalValueMinor, 'INR')}
          sub={`${v3.totalCount} POs`}
          delta={percentDelta(v3.totalValueMinor, v3.previousTotalValueMinor)}
          comparedWith={report.previous.label}
        />
        <KpiTile
          label="Invoiced revenue"
          definition={v6.definition}
          value={formatInrShort(v6.invoicedMinor)}
          full={formatMoney(v6.invoicedMinor, 'INR')}
          delta={percentDelta(v6.invoicedMinor, v6.previousInvoicedMinor)}
          comparedWith={report.previous.label}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
        <Panel
          id="panel-r1"
          className="lg:col-span-8 break-inside-avoid"
          title="Enquiries received"
          description={v1.headline}
          actions={<InfoTip label="enquiries received" definition={v1.definition} />}
        >
          {v1.total === 0 ? (
            <EmptyState message="No enquiries were received in this period." />
          ) : (
            <EnquiryVolumeChart
              data={v1.data.map((b): EnquiryVolumeDatum => ({
                bucket: b.bucket,
                label: formatDate(new Date(`${b.bucket}T00:00:00.000Z`)),
                count: b.count,
                href: `/enquiries?${qs({ receivedFrom: b.bucket, receivedTo: b.bucket, ownerId: report.scope.ownerId })}`,
              }))}
            />
          )}
        </Panel>

        <Panel
          id="panel-r2"
          className="lg:col-span-4 break-inside-avoid"
          title="Enquiry status"
          description={v2.headline}
          actions={<InfoTip label="enquiry status" definition={v2.definition} />}
        >
          {v2.cohortSize === 0 ? (
            <EmptyState message="No enquiries were received in this period." />
          ) : (
            <EnquiryStatusBar
              data={v2.buckets.map((b): EnquiryStatusDatum => ({
                bucket: b.bucket,
                label: STATUS_LABEL[b.bucket],
                count: b.count,
                pct: b.pct,
                color: STATUS_COLOR[b.bucket],
                href: `/enquiries?${qs({
                  status: STATUS_QUERY[b.bucket],
                  receivedFrom: day(report.period.from),
                  receivedTo: day(report.period.to),
                  ownerId: report.scope.ownerId,
                })}`,
              }))}
            />
          )}
        </Panel>

        <Panel
          id="panel-r3"
          className="lg:col-span-6 break-inside-avoid"
          title="POs by sector"
          description={v3.headline}
          actions={<InfoTip label="POs by sector" definition={v3.definition} />}
        >
          {v3.data.length === 0 ? (
            <EmptyState message="No POs were received in this period." />
          ) : (
            <RankedBarChart
              title="POs by sector"
              countLabel="POs"
              data={v3.data.map((r): RankedBarDatum => ({
                key: r.key,
                label: r.name,
                valueMinor: r.valueMinor.toString(),
                count: r.count,
                sharePct: r.sharePct,
                isOther: r.key === 'other',
                href:
                  r.key === 'other'
                    ? null
                    : `/purchase-orders?${qs({ receivedFrom: day(report.period.from), receivedTo: day(report.period.to), sectorId: r.key })}`,
              }))}
            />
          )}
        </Panel>

        <Panel
          id="panel-r4"
          className="lg:col-span-6 break-inside-avoid"
          title="Top services"
          description={v4.headline}
          actions={<InfoTip label="top services" definition={v4.definition} />}
        >
          {v4.data.length === 0 ? (
            <EmptyState message="No PO value was recorded in this period." />
          ) : (
            <>
              <RankedBarChart
                title="Top services by PO value"
                countLabel="POs"
                data={v4.data.map((r): RankedBarDatum => ({
                  key: r.key,
                  label: r.name,
                  valueMinor: r.valueMinor.toString(),
                  count: r.poCount,
                  sharePct: r.sharePct,
                  isOther: r.key === 'other',
                  href:
                    r.key === 'other'
                      ? null
                      : `/purchase-orders?${qs({ receivedFrom: day(report.period.from), receivedTo: day(report.period.to), serviceId: r.key })}`,
                }))}
              />
              {v4.estimated && (
                <p className="text-muted-foreground mt-2 text-[12px]">
                  Some multi-service POs use an estimated equal split.
                </p>
              )}
            </>
          )}
        </Panel>

        <Panel
          id="panel-r5"
          className="lg:col-span-12 break-inside-avoid"
          title="New and repeat customers"
          description={v5.headline}
          actions={<InfoTip label="new and repeat customers" definition={v5.definition} />}
        >
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
            <div className="xl:col-span-1">
              <CustomerMixChart
                data={v5.months.map((m): CustomerMixDatum => ({
                  month: m.month,
                  label: formatDate(new Date(`${m.month}-01T00:00:00.000Z`)),
                  firstOrders: m.firstOrders,
                  repeatOrders: m.repeatOrders,
                  repeatValueMinor: m.repeatValueMinor.toString(),
                  href: null,
                }))}
              />
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-medium">New enquiries from new customers</h3>
              {v5.newEnquiries.length === 0 ? (
                <EmptyState message="No new customers enquired in this period." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>Sector</TableHead>
                      <TableHead>Received</TableHead>
                      <TableHead>Owner</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {v5.newEnquiries.map((r) => (
                      <TableRow key={r.enquiryId}>
                        <TableCell>{r.clientName}</TableCell>
                        <TableCell>{r.sector}</TableCell>
                        <TableCell>
                          <DateDisplay value={r.receivedDate} />
                        </TableCell>
                        <TableCell>{r.owner}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] font-medium">Repeat orders</h3>
              {v5.repeatOrdersList.length === 0 ? (
                <EmptyState message="No repeat orders in this period." />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Client</TableHead>
                      <TableHead>PO</TableHead>
                      <TableHead className="text-right">Value</TableHead>
                      <TableHead className="text-right">Previous orders</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {v5.repeatOrdersList.map((r) => (
                      <TableRow key={r.purchaseOrderId}>
                        <TableCell>{r.clientName}</TableCell>
                        <TableCell>{r.poNumber}</TableCell>
                        <TableCell className="num text-right">
                          <Money amountMinor={r.valueMinor} currency="INR" />
                        </TableCell>
                        <TableCell className="num text-right">{r.previousOrders}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          </div>
        </Panel>

        <Panel
          id="panel-r6"
          className="lg:col-span-12 break-inside-avoid"
          title="Monthly revenue"
          description={v6.headline}
          actions={<InfoTip label="monthly revenue" definition={v6.definition} />}
        >
          {v6.months.every((m) => m.invoiceCount === 0) ? (
            <EmptyState message="No invoices were raised in this period." />
          ) : (
            <>
              <RevenueChart
                data={v6.months.map((m): RevenueDatum => ({
                  month: m.month,
                  label: formatDate(new Date(`${m.month}-01T00:00:00.000Z`)),
                  invoicedMinor: m.invoicedMinor.toString(),
                  collectedMinor: m.collectedMinor.toString(),
                  href: `/invoices?${qs({ invoiceFrom: `${m.month}-01`, invoiceTo: `${m.month}-28`, ownerId: report.scope.ownerId })}`,
                }))}
              />
              <Table className="mt-4">
                <TableHeader>
                  <TableRow>
                    <TableHead>Month</TableHead>
                    <TableHead className="text-right">Invoices</TableHead>
                    <TableHead className="text-right">Invoiced</TableHead>
                    <TableHead className="text-right">Collected</TableHead>
                    <TableHead className="text-right">Outstanding</TableHead>
                    <TableHead className="text-right">PO booked</TableHead>
                    <TableHead>Top client</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {v6.months.map((m) => (
                    <TableRow key={m.month}>
                      <TableCell>
                        <DateDisplay value={`${m.month}-01`} />
                      </TableCell>
                      <TableCell className="num text-right">{m.invoiceCount}</TableCell>
                      <TableCell className="num text-right">
                        <Money amountMinor={m.invoicedMinor} currency="INR" />
                      </TableCell>
                      <TableCell className="num text-right">
                        <Money amountMinor={m.collectedMinor} currency="INR" />
                      </TableCell>
                      <TableCell className="num text-right">
                        <Money amountMinor={m.outstandingMinor} currency="INR" />
                      </TableCell>
                      <TableCell className="num text-right">
                        <Money amountMinor={m.poBookedMinor} currency="INR" />
                      </TableCell>
                      <TableCell>{m.topClient ?? '—'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}
