import { can, listClients, listSectorOptions } from '@sales-tracker/core';
import { listClientsSchema } from '@sales-tracker/core/schemas';
import { FilterBar, type FilterDef } from '@/components/data/FilterBar';
import { NoAccess } from '@/components/feedback/NoAccess';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireUser } from '@/lib/auth';
import { filterKeys, parseListParams, type SearchParams } from '@/lib/list-params';
import { ClientsDirectoryTable } from './ClientsDirectoryTable';

export const metadata = { title: 'Clients · Sales Tracker' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'client')) return <NoAccess />;
  const isAdmin = can(ctx.user, 'list', 'user');
  const raw = await searchParams;
  const params = parseListParams(raw, listClientsSchema);
  // Deleted clients are for admins only (M5 spec: timeline of a deleted client).
  if (!isAdmin) params.status = 'live';

  const [result, sectors] = await Promise.all([listClients(ctx, params), listSectorOptions(ctx)]);

  const filters: FilterDef[] = [
    {
      param: 'sectorId',
      label: 'Sectors',
      options: sectors.map((s) => ({ value: s.id, label: s.name })),
    },
    ...(isAdmin
      ? [{ param: 'status', label: 'Records', options: [{ value: 'deleted', label: 'Deleted' }] }]
      : []),
  ];

  return (
    <>
      <PageHeader
        title="Clients"
        description="Every client with its pipeline, contacts and timeline"
      />
      <FilterBar searchPlaceholder="Search clients" filters={filters} />
      <ClientsDirectoryTable
        rows={result.items.map((c) => ({
          id: c.id,
          name: c.name,
          sector: c.sector.name,
          gstin: c.gstin,
          deleted: c.deletedAt !== null,
        }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
        sort={params.sort}
        dir={params.dir}
        filtered={filterKeys(raw).length > 0}
      />
    </>
  );
}
