import { listClients, listSectors } from '@sales-tracker/core';
import { listClientsSchema } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import { ListToolbar } from '@/components/data-table/ListToolbar';
import { Button } from '@/components/ui/button';
import { requireUser } from '@/lib/auth';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { ClientsTable } from './ClientsTable';

export const metadata = { title: 'Clients · Sales Tracker' };

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  const params = parseListParams(await searchParams, listClientsSchema);
  const [result, sectors] = await Promise.all([
    listClients(ctx, params),
    listSectors(ctx, { page: 1, pageSize: 100, status: 'live' }),
  ]);

  return (
    <section className="flex flex-col gap-4">
      <ListToolbar
        searchPlaceholder="Search clients"
        filters={[
          {
            param: 'sectorId',
            label: 'Sectors',
            options: sectors.items.map((s) => ({ value: s.id, label: s.name })),
          },
          { param: 'status', label: 'Statuses', options: [{ value: 'deleted', label: 'Deleted' }] },
        ]}
      >
        <Button asChild size="sm">
          <Link href="/admin/clients/new">New client</Link>
        </Button>
      </ListToolbar>
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
      />
    </section>
  );
}
