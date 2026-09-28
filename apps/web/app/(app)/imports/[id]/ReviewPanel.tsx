'use client';

import type { ColumnMappingEntry, ImportRowStatusValue } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Panel } from '@/components/charts/Panel';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { DateDisplay } from '@/components/display/DateDisplay';
import { StatusBadge } from '@/components/pipeline/StatusBadge';
import { applyResult } from '@/lib/apply-result';
import { cn } from '@/lib/utils';
import type { ImportRowView } from '@sales-tracker/core';
import { commitImportBatchAction, setImportRowsExcludedAction } from '../actions';
import { RowEditDialog } from './RowEditDialog';

const FILTERS: { status: ImportRowStatusValue | 'ALL'; label: string }[] = [
  { status: 'ALL', label: 'All' },
  { status: 'ERROR', label: 'Errors' },
  { status: 'WARNING', label: 'Warnings' },
  { status: 'DUPLICATE', label: 'Duplicates' },
  { status: 'READY', label: 'Ready' },
  { status: 'EXCLUDED', label: 'Excluded' },
];

export function ReviewPanel({
  batchId,
  fileName,
  rows,
  totalRows,
  columns,
  canCommit,
  errorCount,
  committableCount,
}: {
  batchId: string;
  fileName: string;
  rows: ImportRowView[];
  totalRows: number;
  columns: ColumnMappingEntry[];
  canCommit: boolean;
  errorCount: number;
  committableCount: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [filter, setFilter] = useState<ImportRowStatusValue | 'ALL'>('ALL');
  const [editing, setEditing] = useState<ImportRowView | null>(null);

  const visible = filter === 'ALL' ? rows : rows.filter((r) => r.status === filter);
  const errorRowIds = rows.filter((r) => r.status === 'ERROR').map((r) => r.id);

  function toggleExcluded(rowId: string, excluded: boolean) {
    startTransition(async () => {
      const result = await setImportRowsExcludedAction({ rowIds: [rowId], excluded });
      if (applyResult(result, undefined, excluded ? 'Row excluded' : 'Row included')) {
        router.refresh();
      }
    });
  }

  function excludeAllErrors() {
    startTransition(async () => {
      const result = await setImportRowsExcludedAction({ rowIds: errorRowIds, excluded: true });
      if (applyResult(result, undefined, 'Error rows excluded')) router.refresh();
    });
  }

  return (
    <Panel
      title="Review"
      description={
        totalRows > rows.length
          ? `Showing the first ${rows.length} of ${totalRows} rows.`
          : `${rows.length} row${rows.length === 1 ? '' : 's'}.`
      }
      actions={
        <div className="flex items-center gap-2">
          {errorRowIds.length > 0 && (
            <Button variant="outline" size="sm" disabled={pending} onClick={excludeAllErrors}>
              Exclude all errors
            </Button>
          )}
          <ConfirmDialog
            label="Import"
            title={`Import ${committableCount} record${committableCount === 1 ? '' : 's'} from ${fileName}?`}
            description="You can undo this for 7 days after it completes."
            confirmLabel="Import"
            success="Import started"
            run={() => commitImportBatchAction({ id: batchId })}
            variant="default"
            disabled={!canCommit}
          />
        </div>
      }
    >
      {!canCommit && errorCount > 0 && (
        <p className="text-destructive mb-3 text-[13px]" role="alert">
          Fix or exclude every row with an error before importing.
        </p>
      )}
      <div className="mb-3 flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.status}
            type="button"
            onClick={() => setFilter(f.status)}
            className={cn(
              'rounded-[var(--radius-control)] border px-2.5 py-1 text-[13px]',
              filter === f.status ? 'border-primary bg-secondary' : 'bg-card hover:bg-accent',
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-[var(--radius)] border">
        <table className="w-full caption-bottom text-sm">
          <thead className="bg-muted">
            <tr className="border-b">
              <th scope="col" className="num h-9 px-3 text-right text-[13px] font-medium">
                Row
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                Client
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                Sector
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                Services
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                Received
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                Status
              </th>
              <th scope="col" className="h-9 px-3 text-left text-[13px] font-medium">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted-foreground px-3 py-6 text-center">
                  No rows match this filter.
                </td>
              </tr>
            )}
            {visible.map((row) => {
              const client = (row.transformed?.client as string) || '—';
              const sector = (row.transformed?.sector as string) || '—';
              const services = ((row.transformed?.services as string[]) ?? []).join(', ') || '—';
              const receivedDate = (row.transformed?.receivedDate as string) || null;
              const messages = row.messages.map((m) => m.message).join('; ');
              return (
                <tr key={row.id} className="hover:bg-accent border-b last:border-0">
                  <td className="num px-3 py-2 text-right">{row.rowNumber}</td>
                  <td className="max-w-40 truncate px-3 py-2" title={client}>
                    {client}
                  </td>
                  <td className="max-w-32 truncate px-3 py-2" title={sector}>
                    {sector}
                  </td>
                  <td className="max-w-40 truncate px-3 py-2" title={services}>
                    {services}
                  </td>
                  <td className="px-3 py-2">
                    <DateDisplay value={receivedDate} />
                  </td>
                  <td className="px-3 py-2">
                    <span title={messages || undefined}>
                      <StatusBadge entity="importRow" status={row.status} />
                    </span>
                  </td>
                  <td className="px-3 py-2 text-right whitespace-nowrap">
                    {row.status !== 'EXCLUDED' ? (
                      <>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(row)}>
                          Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          disabled={pending}
                          onClick={() => toggleExcluded(row.id, true)}
                        >
                          Exclude
                        </Button>
                      </>
                    ) : (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={pending}
                        onClick={() => toggleExcluded(row.id, false)}
                      >
                        Include
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <RowEditDialog
          rowId={editing.id}
          rowNumber={editing.rowNumber}
          original={editing.original}
          columns={columns}
          open={editing !== null}
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </Panel>
  );
}
