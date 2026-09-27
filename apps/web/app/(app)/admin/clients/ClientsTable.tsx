'use client';

import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import { restoreClientAction } from './actions';

export interface ClientRow {
  id: string;
  name: string;
  sector: string;
  gstin: string | null;
  deleted: boolean;
  createdAt: string;
}

const column = createColumnHelper<ClientRow>();

const columns = [
  column.accessor('name', {
    header: 'Name',
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <span className="inline-flex items-center gap-2">
        <Link className="font-medium hover:underline" href={`/admin/clients/${original.id}`}>
          {original.name}
        </Link>
        {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
      </span>
    ),
  }),
  column.accessor('sector', { header: 'Sector' }),
  column.accessor('gstin', { header: 'GSTIN', cell: (c) => c.getValue() ?? '—' }),
  column.accessor('createdAt', {
    header: 'Created',
    cell: (c) => <DateDisplay value={c.getValue()} withTime />,
  }),
  column.display({
    id: 'actions',
    meta: { fixed: true },
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original } }) =>
      original.deleted ? (
        <div className="flex justify-end">
          <ConfirmDialog
            label="Restore"
            title={`Restore “${original.name}”?`}
            description="The client becomes available again."
            success="Client restored"
            run={() => restoreClientAction({ id: original.id })}
          />
        </div>
      ) : null,
  }),
];

export function ClientsTable(props: {
  rows: ClientRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filtered: boolean;
}) {
  const { rows, filtered, ...paging } = props;
  return (
    <DataTable
      id="admin-clients"
      columns={columns}
      data={rows}
      getRowId={(c) => c.id}
      rowHref={(c) => (c.deleted ? null : `/admin/clients/${c.id}`)}
      sortable={['name', 'createdAt']}
      empty={
        <EmptyState
          message={
            filtered ? 'No clients match these filters.' : 'No clients yet. Add the first one.'
          }
        />
      }
      mobileCard={(c) => (
        <div className="flex flex-col gap-1">
          <span className="font-medium">{c.name}</span>
          <span className="text-muted-foreground text-[13px]">{c.sector}</span>
        </div>
      )}
      {...paging}
    />
  );
}
