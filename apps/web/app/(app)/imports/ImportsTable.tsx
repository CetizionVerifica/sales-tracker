'use client';

import type { ImportBatchStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { UserAvatar } from '@/components/display/UserAvatar';
import { EmptyState } from '@/components/feedback/EmptyState';
import { StatusBadge } from '@/components/pipeline/StatusBadge';

export interface ImportBatchRow {
  id: string;
  fileName: string;
  status: ImportBatchStatusValue;
  ready: number;
  error: number;
  createdBy: string;
  createdAt: string;
}

const column = createColumnHelper<ImportBatchRow>();

// Defined once at module level: inline cell renderers remount on every refresh (UI guide,
// per the same fix noted in EnquiriesTable).
const columns = [
  column.accessor('fileName', {
    header: 'File',
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <Link className="font-medium hover:underline" href={`/imports/${original.id}`}>
        {original.fileName}
      </Link>
    ),
  }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => <StatusBadge entity="importBatch" status={c.getValue()} />,
  }),
  column.display({
    id: 'rows',
    header: 'Rows',
    cell: ({ row: { original } }) =>
      original.ready || original.error ? (
        <span className="text-[13px]">
          {original.ready} ready
          {original.error > 0 && <span className="text-destructive">, {original.error} error</span>}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }),
  column.accessor('createdBy', {
    header: 'Uploaded by',
    cell: (c) => <UserAvatar name={c.getValue()} showName />,
  }),
  column.accessor('createdAt', {
    header: 'Uploaded',
    cell: (c) => <DateDisplay value={c.getValue()} withTime />,
  }),
];

export function ImportsTable(props: {
  rows: ImportBatchRow[];
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
      id="imports"
      columns={columns}
      data={rows}
      getRowId={(r) => r.id}
      rowHref={(r) => `/imports/${r.id}`}
      sortable={['fileName', 'status', 'createdAt']}
      empty={
        filtered ? (
          <EmptyState
            message="No imports match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/imports">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            message="No imports yet. Upload a spreadsheet to bring in enquiries in bulk."
            action={
              <Link className="text-primary text-sm hover:underline" href="/imports/new">
                Upload a file
              </Link>
            }
          />
        )
      }
      mobileCard={(r) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/imports/${r.id}`}>
              {r.fileName}
            </Link>
            <StatusBadge entity="importBatch" status={r.status} />
          </div>
          <p className="text-muted-foreground text-[13px]">
            Uploaded by {r.createdBy}, <DateDisplay value={r.createdAt} />
          </p>
        </div>
      )}
      {...paging}
    />
  );
}
