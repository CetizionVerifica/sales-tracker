'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

export interface AuditRowView {
  id: string;
  createdAt: string;
  actor: string;
  action: string;
  source: string;
  entityType: string;
  entityId: string;
  changedFields: string[];
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

const column = createColumnHelper<AuditRowView>();

function show(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)) return formatDateTime(value);
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

/** Before/after of one change, every field, with the changed ones highlighted. */
function ChangeDetail({ row }: { row: AuditRowView }) {
  const fields = [...new Set([...Object.keys(row.before ?? {}), ...Object.keys(row.after ?? {})])];
  return (
    <table className="w-full text-sm" aria-label="Changes">
      <thead>
        <tr className="text-muted-foreground text-left">
          <th className="py-1 pr-2 font-medium">Field</th>
          <th className="py-1 pr-2 font-medium">Before</th>
          <th className="py-1 font-medium">After</th>
        </tr>
      </thead>
      <tbody>
        {fields.map((field) => {
          const changed = row.changedFields.includes(field);
          return (
            <tr
              key={field}
              data-changed={changed || undefined}
              className={cn(changed && 'bg-amber-50 font-medium')}
            >
              <td className="py-1 pr-2 align-top">{field}</td>
              <td className="py-1 pr-2 align-top break-all">
                {row.before ? show(row.before[field]) : '—'}
              </td>
              <td className="py-1 align-top break-all">
                {row.after ? show(row.after[field]) : '—'}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AuditLogTable({
  rows,
  showActor,
  ...paging
}: {
  rows: AuditRowView[];
  showActor: boolean;
  total: number;
  page: number;
  pageSize: number;
}) {
  const [selected, setSelected] = useState<AuditRowView | null>(null);

  // Memoised so cells keep their identity across refreshes; see UsersTable.
  const columns = useMemo(
    () => [
      column.accessor('createdAt', {
        header: 'When (IST)',
        cell: (c) => formatDateTime(c.getValue()),
      }),
      ...(showActor ? [column.accessor('actor', { header: 'Who' })] : []),
      column.accessor('action', {
        header: 'Action',
        cell: (c) => <Badge variant="outline">{c.getValue()}</Badge>,
      }),
      column.accessor('entityType', { header: 'Record' }),
      column.accessor('changedFields', {
        header: 'Changed',
        cell: (c) => c.getValue().join(', ') || '—',
      }),
      column.accessor('source', { header: 'Source' }),
      column.display({
        id: 'view',
        header: () => <span className="sr-only">Details</span>,
        cell: ({ row: { original } }) => (
          <Button size="sm" variant="outline" onClick={() => setSelected(original)}>
            View
          </Button>
        ),
      }),
    ],
    [showActor],
  );

  return (
    <>
      <DataTable
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        emptyText="No changes recorded for these filters."
        {...paging}
      />
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {selected.action} {selected.entityType}
                </SheetTitle>
                <SheetDescription>
                  {formatDateTime(selected.createdAt)} · {selected.actor} · {selected.source} · id{' '}
                  {selected.entityId}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <ChangeDetail row={selected} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
