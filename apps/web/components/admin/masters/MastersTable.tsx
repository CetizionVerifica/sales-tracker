'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { DataTable } from '@/components/data/DataTable';
import { RowActions } from '@/components/data/RowActions';
import { DateDisplay } from '@/components/display/DateDisplay';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { deleteMasterAction, restoreMasterAction } from './actions';
import { MasterDialog } from './MasterDialog';

export interface MasterRowView {
  id: string;
  name: string;
  active: boolean;
  deleted: boolean;
  updatedAt: string;
  /** Sectors only (M12b): grouped into "Other sectors" on the sales reports. */
  isOther?: boolean;
}

const column = createColumnHelper<MasterRowView>();

/** A sector's or service's ⋯ menu: edit, delete, or restore a deleted one. */
function MasterActions({ kind, row }: { kind: 'sector' | 'service'; row: MasterRowView }) {
  const [open, setOpen] = useState<'edit' | 'delete' | 'restore' | null>(null);
  const close = (next: boolean) => !next && setOpen(null);
  return (
    <div className="flex justify-end">
      <RowActions
        label={row.name}
        actions={
          row.deleted
            ? [{ label: 'Restore', onSelect: () => setOpen('restore') }]
            : [
                { label: `Edit ${kind}`, onSelect: () => setOpen('edit') },
                { label: 'Delete', onSelect: () => setOpen('delete'), destructive: true },
              ]
        }
      />
      {!row.deleted && (
        <MasterDialog kind={kind} row={row} open={open === 'edit'} onOpenChange={close} />
      )}
      <ConfirmDialog
        open={open === 'delete'}
        onOpenChange={close}
        variant="destructive"
        label="Delete"
        title={`Delete “${row.name}”?`}
        description="Existing records keep showing it. You can restore it from the Deleted filter."
        success={`“${row.name}” deleted`}
        run={() => deleteMasterAction({ kind, id: row.id })}
      />
      <ConfirmDialog
        open={open === 'restore'}
        onOpenChange={close}
        label="Restore"
        title={`Restore “${row.name}”?`}
        description="It becomes available again."
        success={`“${row.name}” restored`}
        run={() => restoreMasterAction({ kind, id: row.id })}
      />
    </div>
  );
}

export function MastersTable({
  kind,
  rows,
  filtered,
  ...paging
}: {
  kind: 'sector' | 'service';
  rows: MasterRowView[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filtered: boolean;
}) {
  // Memoised so cells (and their dialogs) survive refreshes; see UsersTable.
  const columns = useMemo(
    () => [
      column.accessor('name', { header: 'Name', meta: { fixed: true } }),
      column.display({
        id: 'status',
        header: 'Status',
        cell: ({ row: { original } }) =>
          original.deleted ? (
            <MarkBadge tone="destructive">Deleted</MarkBadge>
          ) : original.active ? (
            <MarkBadge tone="success">Active</MarkBadge>
          ) : (
            <MarkBadge>Inactive</MarkBadge>
          ),
      }),
      ...(kind === 'sector'
        ? [
            column.display({
              id: 'isOther',
              header: 'Other sectors',
              cell: ({ row: { original } }) =>
                original.isOther ? <MarkBadge>Grouped as “Other”</MarkBadge> : null,
            }),
          ]
        : []),
      column.accessor('updatedAt', {
        header: 'Updated',
        cell: (c) => <DateDisplay value={c.getValue()} withTime />,
      }),
      column.display({
        id: 'actions',
        meta: { fixed: true },
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original } }) => <MasterActions kind={kind} row={original} />,
      }),
    ],
    [kind],
  );

  return (
    <DataTable
      id={`masters-${kind}`}
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      sortable={['name']}
      empty={
        <EmptyState
          message={
            filtered ? `No ${kind}s match these filters.` : `No ${kind}s yet. Add the first one.`
          }
        />
      }
      mobileCard={(r) => (
        <div className="flex items-center justify-between gap-2">
          <span className="font-medium">{r.name}</span>
          <MasterActions kind={kind} row={r} />
        </div>
      )}
      {...paging}
    />
  );
}
