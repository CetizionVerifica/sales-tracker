import {
  can,
  ForbiddenError,
  getDistinctImportValues,
  getImportBatch,
  listClientOptions,
  listEnquiryOwnerOptions,
  listImportRows,
  listSectorOptions,
  listServiceOptions,
  NotFoundError,
} from '@sales-tracker/core';
import type { ColumnMappingEntry, SheetConfig, ValueMappingEntry } from '@sales-tracker/core/schemas';
import { notFound } from 'next/navigation';
import { PageHeader } from '@/components/layout/PageHeader';
import { Panel } from '@/components/charts/Panel';
import { Skeleton } from '@/components/ui/skeleton';
import { StatusBadge } from '@/components/pipeline/StatusBadge';
import { requireUser } from '@/lib/auth';
import { IMPORT_STATUS_DESCRIPTION } from '@/lib/import-labels';
import { AutoRefresh } from './AutoRefresh';
import { MappingPanel } from './MappingPanel';
import { ResultPanel } from './ResultPanel';
import { ReviewPanel } from './ReviewPanel';
import { ValuesPanel } from './ValuesPanel';

export const metadata = { title: 'Import · Sales Tracker' };

const POLLING_STATUSES = new Set(['UPLOADED', 'PARSING', 'COMMITTING']);
const REVIEWABLE_STATUSES = new Set(['MAPPING', 'READY']);
const RESULT_STATUSES = new Set(['COMMITTED', 'UNDONE', 'EXPIRED']);
const ROWS_PAGE_SIZE = 500;

export default async function ImportBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const ctx = await requireUser();
  const { id } = await params;
  const batch = await getImportBatch(ctx, id).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof ForbiddenError) notFound();
    throw error;
  });

  const polling = POLLING_STATUSES.has(batch.status);
  const reviewable = REVIEWABLE_STATUSES.has(batch.status);
  const isResult = RESULT_STATUSES.has(batch.status);

  const [distinctValues, rowsPage, clients, sectors, services, owners] = await Promise.all([
    reviewable ? getDistinctImportValues(ctx, batch.id) : Promise.resolve([]),
    reviewable || isResult
      ? listImportRows(ctx, { batchId: batch.id, page: 1, pageSize: ROWS_PAGE_SIZE })
      : Promise.resolve(null),
    reviewable ? listClientOptions(ctx) : Promise.resolve([]),
    reviewable ? listSectorOptions(ctx) : Promise.resolve([]),
    reviewable ? listServiceOptions(ctx) : Promise.resolve([]),
    reviewable && ctx.user.role === 'ADMIN' ? listEnquiryOwnerOptions(ctx) : Promise.resolve([]),
  ]);

  const rows = rowsPage?.items ?? [];
  const mapping = batch.mapping as { columns: ColumnMappingEntry[]; values: ValueMappingEntry[] } | null;
  const canUndo = ctx.user.role === 'ADMIN' || batch.createdBy.id === ctx.user.id;
  const canCreateClient = can(ctx.user, 'create', 'client');

  // Sample raw values per column (keyed by column index, as MappingPanel expects).
  const samples: Record<number, string[]> = {};
  if (mapping) {
    for (const column of mapping.columns) {
      samples[column.column] = rows
        .slice(0, 3)
        .map((row) => String(row.original[column.header] ?? '').trim())
        .filter(Boolean);
    }
  }

  return (
    <>
      <AutoRefresh active={polling} />
      <PageHeader
        breadcrumbs={[{ label: 'Imports', href: '/imports' }, { label: batch.fileName }]}
        title={batch.fileName}
        badge={<StatusBadge entity="importBatch" status={batch.status} />}
        description={IMPORT_STATUS_DESCRIPTION[batch.status]}
      />

      {polling && (
        <Panel>
          <div role="status" className="flex flex-col gap-3">
            <p className="text-sm font-medium">{IMPORT_STATUS_DESCRIPTION[batch.status]}</p>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-9" />
            ))}
          </div>
        </Panel>
      )}

      {batch.status === 'FAILED' && (
        <Panel>
          <p role="alert" className="text-sm">
            {batch.errorMessage ?? 'This file could not be read.'}
          </p>
        </Panel>
      )}

      {reviewable && mapping && (
        <div className="flex flex-col gap-4">
          <MappingPanel
            batchId={batch.id}
            sheetConfig={batch.sheetConfig as SheetConfig}
            columns={mapping.columns}
            samples={samples}
          />
          {batch.status === 'READY' && distinctValues.length > 0 && (
            <ValuesPanel
              batchId={batch.id}
              distinctValues={distinctValues}
              savedMappings={mapping.values}
              clients={clients}
              sectors={sectors}
              services={services}
              owners={owners}
              canCreateClient={canCreateClient}
            />
          )}
          {batch.status === 'READY' && (
            <ReviewPanel
              batchId={batch.id}
              fileName={batch.fileName}
              rows={rows}
              totalRows={rowsPage?.total ?? rows.length}
              columns={mapping.columns}
              canCommit={(batch.counts?.error ?? 0) === 0}
              errorCount={batch.counts?.error ?? 0}
              committableCount={(batch.counts?.ready ?? 0) + (batch.counts?.warning ?? 0)}
            />
          )}
        </div>
      )}

      {isResult && (
        <ResultPanel
          batchId={batch.id}
          status={batch.status as 'COMMITTED' | 'UNDONE' | 'EXPIRED'}
          counts={batch.counts}
          rows={rows}
          canUndo={canUndo}
        />
      )}
    </>
  );
}
