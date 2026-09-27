import { can, listClients, listSectorOptions } from '@sales-tracker/core';
import { listClientsSchema } from '@sales-tracker/core/schemas';
import { ListToolbar, type FilterDef } from '@/components/data-table/ListToolbar';
import { Forbidden } from '@/components/Forbidden';
import { requireUser } from '@/lib/auth';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { ClientsDirectoryTable } from './ClientsDirectoryTable';

export const metadata = { title: 'Clients · Sales Tracker' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'client')) return <Forbidden />;
  const isAdmin = can(ctx.user, 'list', 'user');
  const params = parseListParams(await searchParams, listClientsSchema);
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
    <section className="flex flex-col gap-4 py-8">
      <h1 className="text-2xl font-semibold">Clients</h1>
      <ListToolbar searchPlaceholder="Search clients" filters={filters} />
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
      />
    </section>
  );
}
