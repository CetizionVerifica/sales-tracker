import { listSectors, listServices, type Ctx } from '@sales-tracker/core';
import { listMastersSchema } from '@sales-tracker/core/schemas';
import { ListToolbar } from '@/components/data-table/ListToolbar';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { MasterDialog } from './MasterDialog';
import { MastersTable } from './MastersTable';

export type MasterKind = 'sector' | 'service';

const LIST = { sector: listSectors, service: listServices };
export const MASTER_LABEL: Record<MasterKind, { one: string; many: string }> = {
  sector: { one: 'Sector', many: 'Sectors' },
  service: { one: 'Service', many: 'Services' },
};

/** Shared list page for sectors and services (same lifecycle, M3 Decision 1). */
export async function MastersPage({
  ctx,
  kind,
  searchParams,
}: {
  ctx: Ctx;
  kind: MasterKind;
  searchParams: SearchParams;
}) {
  const params = parseListParams(searchParams, listMastersSchema);
  const result = await LIST[kind](ctx, params);

  return (
    <section className="flex flex-col gap-4">
      <ListToolbar
        searchPlaceholder={`Search ${MASTER_LABEL[kind].many.toLowerCase()}`}
        filters={[
          {
            param: 'status',
            label: 'Statuses',
            options: [
              { value: 'active', label: 'Active' },
              { value: 'inactive', label: 'Inactive' },
              { value: 'deleted', label: 'Deleted' },
            ],
          },
        ]}
      >
        <MasterDialog kind={kind} />
      </ListToolbar>
      <MastersTable
        kind={kind}
        rows={result.items.map((row) => ({
          id: row.id,
          name: row.name,
          active: row.active,
          deleted: row.deletedAt !== null,
          updatedAt: row.updatedAt.toISOString(),
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
