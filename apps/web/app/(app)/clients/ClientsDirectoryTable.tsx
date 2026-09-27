'use client';

import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';

export interface ClientDirectoryRow {
  id: string;
  name: string;
  sector: string;
  gstin: string | null;
  deleted: boolean;
}

const column = createColumnHelper<ClientDirectoryRow>();

// Module level: inline cell renderers remount on every refresh (M3 bug).
const columns = [
  column.accessor('name', {
    header: 'Name',
    cell: ({ row: { original } }) => (
      <Link
        className="font-medium underline-offset-4 hover:underline"
        href={`/clients/${original.id}`}
      >
        {original.name}
        {original.deleted && (
          <Badge variant="destructive" className="ml-2">
            Deleted
          </Badge>
        )}
      </Link>
    ),
  }),
  column.accessor('sector', { header: 'Sector' }),
  column.accessor('gstin', { header: 'GSTIN', cell: (c) => c.getValue() ?? '—' }),
];

/** Read-only client list for every role (M5 Decision 8); editing stays under /admin. */
export function ClientsDirectoryTable(props: {
  rows: ClientDirectoryRow[];
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
      sortable={['name']}
      emptyText="No clients match these filters."
      {...paging}
    />
  );
}
