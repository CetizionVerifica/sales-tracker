import { can, listImportBatches } from '@sales-tracker/core';
import { IMPORT_BATCH_STATUSES, listImportBatchesSchema } from '@sales-tracker/core/schemas';
import Link from 'next/link';
import type { FilterDef } from '@/components/data/FilterBar';
import { FilterBar } from '@/components/data/FilterBar';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/button';
import { NoAccess } from '@/components/feedback/NoAccess';
import { requireUser } from '@/lib/auth';
import { filterKeys, parseListParams, type SearchParams } from '@/lib/list-params';
import { statusStyle } from '@/lib/status-styles';
import { ImportsTable } from './ImportsTable';

export const metadata = { title: 'Imports · Sales Tracker' };

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const ctx = await requireUser();
  if (!can(ctx.user, 'list', 'importBatch')) return <NoAccess />;
  const raw = await searchParams;
  const params = parseListParams(raw, listImportBatchesSchema);

  const result = await listImportBatches(ctx, params);

  const filters: FilterDef[] = [
    {
      param: 'status',
      label: 'Statuses',
      options: IMPORT_BATCH_STATUSES.map((status) => ({
        value: status,
        label: statusStyle('importBatch', status).label,
      })),
      multi: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="Imports"
        description="Bring in enquiries in bulk from a spreadsheet."
        actions={
          <Button asChild>
            <Link href="/imports/new">Upload a file</Link>
          </Button>
        }
      />
      <FilterBar searchPlaceholder="Search file name" filters={filters} />
      <ImportsTable
        rows={result.items.map((b) => ({
          id: b.id,
          fileName: b.fileName,
          status: b.status,
          ready: b.counts?.ready ?? 0,
          error: b.counts?.error ?? 0,
          createdBy: b.createdBy.name,
          createdAt: b.createdAt.toISOString(),
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
