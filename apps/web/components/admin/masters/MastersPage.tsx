import { listSectors, listServices, type Ctx } from '@sales-tracker/core';
import { listMastersSchema } from '@sales-tracker/core/schemas';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { filterKeys, parseListParams, type SearchParams } from '@/lib/list-params';
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
    <>
      <PageHeader
        title={MASTER_LABEL[kind].many}
        description={
          kind === 'sector'
            ? 'Industries clients belong to; used to group reports'
            : 'What the company sells; enquiries and quotations pick from these'
        }
        actions={<MasterDialog kind={kind} />}
      />
      <FilterBar
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
      />
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
        filtered={filterKeys(searchParams).length > 0}
      />
    </>
  );
}
