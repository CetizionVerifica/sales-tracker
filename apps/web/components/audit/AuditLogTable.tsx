'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { DataTable } from '@/components/data/DataTable';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { DateDisplay } from '@/components/display/DateDisplay';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { AUDIT_ACTION_LABELS, AUDIT_SOURCE_LABELS, humanize } from '@/lib/audit-labels';
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
export function ChangeDetail({ row }: { row: AuditRowView }) {
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
              className={cn(changed && 'bg-accent font-medium')}
            >
              <td className="py-1 pr-2 align-top">{humanize(field)}</td>
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
        meta: { fixed: true },
        cell: (c) => <DateDisplay value={c.getValue()} withTime />,
      }),
      ...(showActor ? [column.accessor('actor', { header: 'Who' })] : []),
      column.accessor('action', {
        header: 'Action',
        cell: (c) => (
          <MarkBadge>{AUDIT_ACTION_LABELS[c.getValue()] ?? humanize(c.getValue())}</MarkBadge>
        ),
      }),
      column.accessor('entityType', { header: 'Record', cell: (c) => humanize(c.getValue()) }),
      column.accessor('changedFields', {
        header: 'Changed',
        cell: (c) => (
          <span className="block max-w-72 truncate" title={c.getValue().map(humanize).join(', ')}>
            {c.getValue().map(humanize).join(', ') || '—'}
          </span>
        ),
      }),
      column.accessor('source', {
        header: 'Source',
        cell: (c) => AUDIT_SOURCE_LABELS[c.getValue()] ?? humanize(c.getValue()),
      }),
      column.display({
        id: 'view',
        meta: { fixed: true },
        header: () => <span className="sr-only">Details</span>,
        cell: ({ row: { original } }) => (
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => setSelected(original)}>
              View
            </Button>
          </div>
        ),
      }),
    ],
    [showActor],
  );

  return (
    <>
      <DataTable
        id={showActor ? 'audit-log' : 'my-activity'}
        columns={columns}
        data={rows}
        getRowId={(r) => r.id}
        empty={<EmptyState message="No changes recorded for these filters." />}
        mobileCard={(r) => (
          <button
            type="button"
            className="flex w-full flex-col gap-1 text-left"
            onClick={() => setSelected(r)}
          >
            <span className="font-medium">
              {AUDIT_ACTION_LABELS[r.action] ?? humanize(r.action)}{' '}
              {humanize(r.entityType).toLowerCase()}
            </span>
            <span className="text-muted-foreground text-[13px]">
              {formatDateTime(r.createdAt)}
              {showActor ? ` · ${r.actor}` : ''}
            </span>
          </button>
        )}
        {...paging}
      />
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {AUDIT_ACTION_LABELS[selected.action] ?? humanize(selected.action)}{' '}
                  {humanize(selected.entityType).toLowerCase()}
                </SheetTitle>
                <SheetDescription>
                  {formatDateTime(selected.createdAt)} · {selected.actor} ·{' '}
                  {AUDIT_SOURCE_LABELS[selected.source] ?? selected.source} · id {selected.entityId}
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
