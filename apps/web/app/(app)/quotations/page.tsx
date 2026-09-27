import {
  can,
  getSettings,
  listClientOptions,
  listEnquiryOwnerOptions,
  listQuotations,
  listSectorOptions,
  listServiceOptions,
  quotationResource,
} from '@sales-tracker/core';
import { formatMoney, listQuotationsSchema, todayInIST } from '@sales-tracker/core/schemas';
import { DateRangeFilter } from '@/components/audit/DateRangeFilter';
import { ListToolbar, type FilterDef } from '@/components/data-table/ListToolbar';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { toOptions } from '@/lib/enquiry-labels';
import { parseListParams, type SearchParams } from '@/lib/list-params';
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
  if (!can(ctx.user, 'list', 'quotation')) return <Forbidden />;
  const params = parseListParams(await searchParams, listQuotationsSchema);
  const isAdmin = can(ctx.user, 'list', 'user');

  const [result, clients, sectors, services, settings, owners] = await Promise.all([
    listQuotations(ctx, params),
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    getSettings(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);
  const today = todayInIST().getTime();

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
    <section className="flex flex-col gap-4 py-8">
      <h1 className="text-2xl font-semibold">Quotations</h1>
      <ListToolbar searchPlaceholder="Search number, enquiry, client, notes" filters={filters} />
      <div className="flex flex-wrap gap-4">
        <DateRangeFilter label="Quoted" fromParam="quotationFrom" toParam="quotationTo" />
        <DateRangeFilter
          label="Next follow-up"
          fromParam="nextFollowUpFrom"
          toParam="nextFollowUpTo"
        />
      </div>
      {params.sort === 'amount' && (
        <p className="text-muted-foreground text-sm">
          Amounts in different currencies are sorted by face value, not converted.
        </p>
      )}
      <QuotationsTable
        rows={result.items.map((q) => {
          const next = q.nextFollowUpDate?.getTime();
          const due =
            isOpenQuotation(q.status) && next !== undefined
              ? next < today
                ? 'missed'
                : next === today
                  ? 'today'
                  : null
              : null;
          return {
            id: q.id,
            number: q.number,
            quotationDate: q.quotationDate.toISOString(),
            enquiryId: q.enquiry.id,
            enquiryNumber: q.enquiry.number,
            client: q.client.name,
            services: q.services.map((s) => s.name).join(', '),
            amount: formatMoney(q.amountMinor, q.currency),
            status: q.status,
            nextFollowUpDate: q.nextFollowUpDate?.toISOString() ?? null,
            due,
            owner: q.owner.name,
            updatedAt: q.updatedAt.toISOString(),
            deleted: q.deletedAt !== null,
            canRestore: can(ctx.user, 'delete', quotationResource(q)),
          } as const;
        })}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
      />
    </section>
  );
}
