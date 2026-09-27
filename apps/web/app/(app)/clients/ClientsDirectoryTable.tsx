'use client';

import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';

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
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <span className="inline-flex items-center gap-2">
        <Link className="font-medium hover:underline" href={`/clients/${original.id}`}>
          {original.name}
        </Link>
        {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
      </span>
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
  filtered: boolean;
}) {
  const { rows, filtered, ...paging } = props;
  return (
    <DataTable
      id="clients"
      columns={columns}
      data={rows}
      getRowId={(c) => c.id}
      rowHref={(c) => `/clients/${c.id}`}
      sortable={['name']}
      empty={
        <EmptyState
          message={
            filtered
              ? 'No clients match these filters.'
              : 'No clients yet. They are added with their first enquiry.'
          }
          action={
            filtered ? (
              <Link className="text-primary text-sm hover:underline" href="/clients">
                Clear filters
              </Link>
            ) : undefined
          }
        />
      }
      mobileCard={(c) => (
        <div className="flex flex-col gap-1">
          <Link className="font-medium" href={`/clients/${c.id}`}>
            {c.name}
          </Link>
          <p className="text-muted-foreground text-[13px]">
            {c.sector}
            {c.gstin ? ` · ${c.gstin}` : ''}
          </p>
        </div>
      )}
      {...paging}
    />
  );
}
