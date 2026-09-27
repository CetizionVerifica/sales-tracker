import {
  can,
  getSettings,
  listClientOptions,
  quotationStatusCounts,
  listEnquiryOwnerOptions,
  listQuotations,
  listSectorOptions,
  listServiceOptions,
  quotationResource,
} from '@sales-tracker/core';
import { listQuotationsSchema } from '@sales-tracker/core/schemas';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { istToday } from '@/lib/display';
import { requireUser } from '@/lib/auth';
import { toOptions } from '@/lib/enquiry-labels';
import { filterKeys, isOnlyFilter, parseListParams, type SearchParams } from '@/lib/list-params';
import { isOpenQuotation, QUOTATION_STATUS_LABELS } from '@/lib/quotation-labels';
import { QuotationsTable } from './QuotationsTable';

export const metadata = { title: 'Quotations · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

/**
 * Quotations start from a converted enquiry, so there is no "New quotation" button here
 * (M6 Decision 1).
 */
export default async function QuotationsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'quotation')) return <NoAccess />;
  const params = parseListParams(await searchParams, listQuotationsSchema);
  const isAdmin = can(ctx.user, 'list', 'user');

  const [result, counts, clients, sectors, services, settings, owners] = await Promise.all([
    listQuotations(ctx, params),
    quotationStatusCounts(ctx),
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    getSettings(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const today = istToday();
  const raw = await searchParams;
  const filtered = filterKeys(raw).length > 0;
  const only = (key: string, value: string) => isOnlyFilter(raw, key, value);

  const filters: FilterDef[] = [
    {
      param: 'status',
      label: 'Statuses',
      options: toOptions(QUOTATION_STATUS_LABELS),
      multi: true,
    },
    {
      param: 'followUpDue',
      label: 'Follow-up',
      options: [{ value: 'true', label: 'Follow-up due' }],
    },
    // Sales always see only their own quotations; the owner filter is for admins.
    ...(owners ? [{ param: 'ownerId', label: 'Owners', options: asOptions(owners) }] : []),
    { param: 'clientId', label: 'Clients', options: asOptions(clients) },
    { param: 'sectorId', label: 'Sectors', options: asOptions(sectors) },
    { param: 'serviceId', label: 'Services', options: asOptions(services) },
    {
      param: 'currency',
      label: 'Currencies',
      multi: true,
      options: settings.enabledCurrencies.map((code) => ({ value: code, label: code })),
    },
    {
      param: 'recordStatus',
      label: 'Records',
      options: [{ value: 'deleted', label: 'Deleted' }],
    },
  ];

  return (
    <>
      <PageHeader
        title="Quotations"
        description="Chase every quotation until the client negotiates, sends a PO, or declines"
      />
      <SummaryStrip
        chips={[
          {
            label: 'Follow-up due',
            count: counts.followUpDue,
            href: '/quotations?followUpDue=true',
            active: only('followUpDue', 'true'),
            attention: true,
          },
          {
            label: 'Sent',
            count: counts.SENT,
            href: '/quotations?status=SENT',
            active: only('status', 'SENT'),
          },
          {
            label: 'Under negotiation',
            count: counts.UNDER_NEGOTIATION,
            href: '/quotations?status=UNDER_NEGOTIATION',
            active: only('status', 'UNDER_NEGOTIATION'),
          },
          {
            label: 'PO received',
            count: counts.PO_RECEIVED,
            href: '/quotations?status=PO_RECEIVED',
            active: only('status', 'PO_RECEIVED'),
          },
        ]}
      />
      <FilterBar searchPlaceholder="Search number, enquiry, client, notes" filters={filters}>
        <DateRangeFilter label="Quoted" fromParam="quotationFrom" toParam="quotationTo" />
        <DateRangeFilter
          label="Next follow-up"
          fromParam="nextFollowUpFrom"
          toParam="nextFollowUpTo"
        />
      </FilterBar>
      {params.sort === 'amount' && (
        <p className="text-muted-foreground text-[13px]">
          Amounts in different currencies are sorted by face value, not converted.
        </p>
      )}
      <QuotationsTable
        rows={result.items.map((q) => ({
          id: q.id,
          number: q.number,
          quotationDate: q.quotationDate.toISOString(),
          enquiryId: q.enquiry.id,
          enquiryNumber: q.enquiry.number,
          client: q.client.name,
          services: q.services.map((s) => s.name).join(', '),
          amountMinor: q.amountMinor.toString(),
          currency: q.currency,
          status: q.status,
          nextFollowUpDate: q.nextFollowUpDate?.toISOString() ?? null,
          open: isOpenQuotation(q.status),
          owner: q.owner.name,
          updatedAt: q.updatedAt.toISOString(),
          deleted: q.deletedAt !== null,
          canRestore: can(ctx.user, 'delete', quotationResource(q)),
        }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        today={today}
        filtered={filtered}
      />
    </>
  );
}
