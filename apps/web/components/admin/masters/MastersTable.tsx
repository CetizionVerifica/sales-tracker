'use client';

import { createColumnHelper } from '@tanstack/react-table';
import { useMemo } from 'react';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';
import { deleteMasterAction, restoreMasterAction } from './actions';
import { MasterDialog } from './MasterDialog';

export interface MasterRowView {
  id: string;
  name: string;
  active: boolean;
  deleted: boolean;
  updatedAt: string;
}

const column = createColumnHelper<MasterRowView>();

export function MastersTable({
  kind,
  rows,
  ...paging
}: {
  kind: 'sector' | 'service';
  rows: MasterRowView[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}) {
  // Memoised so cells (and their dialogs) survive refreshes; see UsersTable.
  const columns = useMemo(
    () => [
      column.accessor('name', { header: 'Name' }),
      column.display({
        id: 'status',
        header: 'Status',
        cell: ({ row: { original } }) =>
          original.deleted ? (
            <Badge variant="destructive">Deleted</Badge>
          ) : original.active ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline">Inactive</Badge>
          ),
      }),
      column.accessor('updatedAt', {
        header: 'Updated',
        cell: (c) => formatDateTime(c.getValue()),
      }),
      column.display({
        id: 'actions',
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row: { original } }) => (
          <div className="flex justify-end gap-2">
            {original.deleted ? (
              <ConfirmButton
                label="Restore"
                title={`Restore “${original.name}”?`}
                description="It becomes available again."
                success={`“${original.name}” restored`}
                run={() => restoreMasterAction({ kind, id: original.id })}
              />
            ) : (
              <>
                <MasterDialog kind={kind} row={original} />
                <ConfirmButton
                  label="Delete"
                  variant="destructive"
                  title={`Delete “${original.name}”?`}
                  description="Existing records keep showing it. You can restore it from the Deleted filter."
                  success={`“${original.name}” deleted`}
                  run={() => deleteMasterAction({ kind, id: original.id })}
                />
              </>
            )}
          </div>
        ),
      }),
    ],
    [kind],
  );

  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      sortable={['name']}
      emptyText="Nothing here yet."
      {...paging}
    />
  );
}
