'use client';

import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
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
    cell: ({ row: { original } }) =>
      original.deleted ? (
        <span className="text-muted-foreground">
          {original.name} <Badge variant="destructive">Deleted</Badge>
        </span>
      ) : (
        <Link
          className="font-medium underline-offset-4 hover:underline"
          href={`/admin/clients/${original.id}`}
        >
          {original.name}
        </Link>
      ),
  }),
  column.accessor('sector', { header: 'Sector' }),
  column.accessor('gstin', { header: 'GSTIN', cell: (c) => c.getValue() ?? '—' }),
  column.accessor('createdAt', { header: 'Created', cell: (c) => formatDateTime(c.getValue()) }),
  column.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original } }) => (
      <div className="flex justify-end gap-2">
        {original.deleted ? (
          <ConfirmButton
            label="Restore"
            title={`Restore “${original.name}”?`}
            description="The client becomes available again."
            success="Client restored"
            run={() => restoreClientAction({ id: original.id })}
          />
        ) : (
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/clients/${original.id}`}>Open</Link>
          </Button>
        )}
      </div>
    ),
  }),
];

export function ClientsTable(props: {
  rows: ClientRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
}) {
  const { rows, ...paging } = props;
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(c) => c.id}
      sortable={['name', 'createdAt']}
      emptyText="No clients match these filters."
      {...paging}
    />
  );
}
