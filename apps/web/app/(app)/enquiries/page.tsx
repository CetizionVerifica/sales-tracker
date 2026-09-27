import {
  can,
  enquiryResource,
  listClientOptions,
  listEnquiries,
  listEnquiryOwnerOptions,
  listSectorOptions,
  listServiceOptions,
} from '@sales-tracker/core';
import { listEnquiriesSchema } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { DateRangeFilter } from '@/components/audit/DateRangeFilter';
import { ListToolbar, type FilterDef } from '@/components/data-table/ListToolbar';
import { Forbidden } from '@/components/Forbidden';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { SOURCE_LABELS, STATUS_LABELS, toOptions } from '@/lib/enquiry-labels';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { EnquiriesTable } from './EnquiriesTable';

export const metadata = { title: 'Enquiries · Sales Tracker' };

const asOptions = (rows: { id: string; name: string }[]) =>
  rows.map((row) => ({ value: row.id, label: row.name }));

export default async function EnquiriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'enquiry')) return <Forbidden />;
  const params = parseListParams(await searchParams, listEnquiriesSchema);
  const isAdmin = can(ctx.user, 'list', 'user');

  const [result, clients, sectors, services, owners] = await Promise.all([
    listEnquiries(ctx, params),
    listClientOptions(ctx),
    listSectorOptions(ctx),
    listServiceOptions(ctx),
    isAdmin ? listEnquiryOwnerOptions(ctx) : null,
  ]);

  const filters: FilterDef[] = [
    { param: 'status', label: 'Statuses', options: toOptions(STATUS_LABELS), multi: true },
    { param: 'source', label: 'Sources', options: toOptions(SOURCE_LABELS), multi: true },
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

  return (
    <section className="flex flex-col gap-4 py-8">
      <h1 className="text-2xl font-semibold">Enquiries</h1>
      <ListToolbar searchPlaceholder="Search number, client, details" filters={filters}>
        {can(ctx.user, 'create', 'enquiry') && (
          <Button asChild size="sm">
            <Link href="/enquiries/new">New enquiry</Link>
          </Button>
        )}
      </ListToolbar>
      <div className="flex flex-wrap gap-4">
        <DateRangeFilter label="Received" fromParam="receivedFrom" toParam="receivedTo" />
        <DateRangeFilter
          label="Proposal sent"
          fromParam="proposalSentFrom"
          toParam="proposalSentTo"
        />
      </div>
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
      />
    </section>
  );
}
