import { listClients, listSectorOptions, listSectors } from '@sales-tracker/core';
import { listClientsSchema } from '@sales-tracker/core/schemas';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { requireAdmin } from '@/lib/auth';
import { filterKeys, parseListParams, type SearchParams } from '@/lib/list-params';
import { NewClientButton } from './ClientForm';
import { ClientsTable } from './ClientsTable';

export const metadata = { title: 'Clients · Sales Tracker' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireAdmin();
  if (!ctx) return null; // non-admins: the layout shows No access
  const raw = await searchParams;
  const params = parseListParams(raw, listClientsSchema);
  const [result, sectors, sectorOptions] = await Promise.all([
    listClients(ctx, params),
    listSectors(ctx, { page: 1, pageSize: 100, status: 'live' }),
    listSectorOptions(ctx),
  ]);

  return (
    <>
      <PageHeader
        title="Client records"
        description="Add clients, correct their details and manage contacts"
        actions={<NewClientButton sectors={sectorOptions} />}
      />
      <FilterBar
        searchPlaceholder="Search clients"
        filters={[
          {
            param: 'sectorId',
            label: 'Sectors',
            options: sectors.items.map((s) => ({ value: s.id, label: s.name })),
          },
          { param: 'status', label: 'Statuses', options: [{ value: 'deleted', label: 'Deleted' }] },
        ]}
      />
      <ClientsTable
        rows={result.items.map((c) => ({
          id: c.id,
          name: c.name,
          sector: c.sector.name,
          gstin: c.gstin,
          deleted: c.deletedAt !== null,
          createdAt: c.createdAt.toISOString(),
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
