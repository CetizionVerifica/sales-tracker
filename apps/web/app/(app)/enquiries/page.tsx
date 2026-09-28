import {
  can,
  enquiryResource,
  enquiryStatusCounts,
  listClientOptions,
  listEnquiries,
  listEnquiryOwnerOptions,
  listSectorOptions,
  listServiceOptions,
} from '@sales-tracker/core';
import { listEnquiriesSchema } from '@sales-tracker/core/schemas';
import { SummaryStrip } from '@/components/data/SummaryStrip';
import { PageHeader } from '@/components/layout/PageHeader';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { NoAccess } from '@/components/feedback/NoAccess';
import { requireUser } from '@/lib/auth';
import { SOURCE_LABELS, STATUS_LABELS, toOptions } from '@/lib/enquiry-labels';
import { filterKeys, isOnlyFilter, parseListParams, type SearchParams } from '@/lib/list-params';
import { EnquiriesTable } from './EnquiriesTable';
import { NewEnquiryButton } from './EnquirySheets';
import { loadEnquiryFormOptions } from './form-options';
import { istToday } from '@/lib/display';

export const metadata = { title: 'Enquiries · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'enquiry')) return <NoAccess />;
  const raw = await searchParams;
  const params = parseListParams(raw, listEnquiriesSchema);
  const canCreate = can(ctx.user, 'create', 'enquiry');
  const isAdmin = can(ctx.user, 'list', 'user');

  const [result, counts, clients, sectors, services, owners, formOptions] = await Promise.all([
    listEnquiries(ctx, params),
    enquiryStatusCounts(ctx),
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
    canCreate ? loadEnquiryFormOptions(ctx) : null,
  ]);

  const filters: FilterDef[] = [
    { param: 'status', label: 'Statuses', options: toOptions(STATUS_LABELS), multi: true },
    { param: 'source', label: 'Sources', options: toOptions(SOURCE_LABELS), multi: true },
    // M11: in progress with no next step planned, untouched for the company's stale days.
    {
      param: 'stale',
      label: 'Activity',
      options: [{ value: 'true', label: 'Stale' }],
    },
    // Sales always see only their own enquiries; the owner filter is for admins.
    ...(owners ? [{ param: 'ownerId', label: 'Owners', options: asOptions(owners) }] : []),
    { param: 'clientId', label: 'Clients', options: asOptions(clients) },
    { param: 'sectorId', label: 'Sectors', options: asOptions(sectors) },
    { param: 'serviceId', label: 'Services', options: asOptions(services) },
    {
      param: 'recordStatus',
      label: 'Records',
      options: [{ value: 'deleted', label: 'Deleted' }],
    },
  ];

  const chip = (status: 'IN_PROGRESS' | 'CONVERTED' | 'LOST', label: string) => ({
    label,
    count: counts[status],
    href: `/enquiries?status=${status}`,
    active: isOnlyFilter(raw, 'status', status),
  });

  return (
    <>
      <PageHeader
        title="Enquiries"
        description="Track every enquiry from first contact to conversion"
        actions={formOptions && <NewEnquiryButton options={formOptions} today={istToday()} />}
      />
      <SummaryStrip
        chips={[
          chip('IN_PROGRESS', 'In progress'),
          chip('CONVERTED', 'Converted'),
          chip('LOST', 'Lost'),
        ]}
      />
      <FilterBar searchPlaceholder="Search number, client, details" filters={filters}>
        <DateRangeFilter label="Received" fromParam="receivedFrom" toParam="receivedTo" />
        <DateRangeFilter
          label="Proposal sent"
          fromParam="proposalSentFrom"
          toParam="proposalSentTo"
        />
      </FilterBar>
      <EnquiriesTable
        rows={result.items.map((e) => ({
          id: e.id,
          number: e.number,
          receivedDate: e.receivedDate.toISOString(),
          client: e.client.name,
          sector: e.sector.name,
          services: e.services.map((s) => s.name).join(', '),
          source: e.source,
          owner: e.owner.name,
          status: e.status,
          proposalSentDate: e.proposalSentDate?.toISOString() ?? null,
          updatedAt: e.updatedAt.toISOString(),
          deleted: e.deletedAt !== null,
          canRestore: can(ctx.user, 'delete', enquiryResource(e)),
        }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        filtered={filterKeys(raw).length > 0}
        canCreate={canCreate}
      />
    </>
  );
}
