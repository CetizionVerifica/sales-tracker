'use client';

import type { EnquirySourceValue, EnquiryStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { UserAvatar } from '@/components/display/UserAvatar';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { SOURCE_LABELS } from '@/lib/enquiry-labels';
import { restoreEnquiryAction } from './actions';

export interface EnquiryRow {
  id: string;
  number: string;
  receivedDate: string;
  client: string;
  sector: string;
  services: string;
  source: EnquirySourceValue;
  owner: string;
  status: EnquiryStatusValue;
  proposalSentDate: string | null;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
}

const column = createColumnHelper<EnquiryRow>();

// Guide §5 column order: identifier → client → descriptors → status → dates → owner → ⋯.
// Defined once at module level: inline cell renderers remount on every refresh (M3 bug).
const columns = [
  column.accessor('number', {
    header: 'Number',
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <Link className="font-medium hover:underline" href={`/enquiries/${original.id}`}>
          {original.number}
        </Link>
        {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
      </span>
    ),
  }),
  column.accessor('client', { header: 'Client' }),
  column.accessor('sector', { header: 'Sector' }),
  column.accessor('services', {
    header: 'Services',
    cell: (c) => (
      <span className="block max-w-56 truncate" title={c.getValue()}>
        {c.getValue()}
      </span>
    ),
  }),
  column.accessor('source', { header: 'Source', cell: (c) => SOURCE_LABELS[c.getValue()] }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => <StatusBadge entity="enquiry" status={c.getValue()} />,
  }),
  column.accessor('receivedDate', {
    header: 'Received',
    cell: (c) => <DateDisplay value={c.getValue()} />,
  }),
  column.accessor('proposalSentDate', {
    header: 'Proposal sent',
    cell: (c) => <DateDisplay value={c.getValue()} />,
  }),
  column.accessor('owner', { header: 'Owner', cell: (c) => <UserAvatar name={c.getValue()} /> }),
  column.accessor('updatedAt', {
    header: 'Updated',
    cell: (c) => <DateDisplay value={c.getValue()} withTime />,
  }),
  column.display({
    id: 'actions',
    meta: { fixed: true },
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original } }) =>
      original.deleted && original.canRestore ? (
        <ConfirmDialog
          label="Restore"
          title={`Restore ${original.number}?`}
          description="The enquiry comes back into the list."
          success="Enquiry restored"
          run={() => restoreEnquiryAction({ id: original.id })}
        />
      ) : null,
  }),
];

export function EnquiriesTable(props: {
  rows: EnquiryRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  filtered: boolean;
  canCreate: boolean;
}) {
  const { rows, filtered, canCreate, ...paging } = props;
  return (
    <DataTable
      id="enquiries"
      columns={columns}
      data={rows}
      getRowId={(e) => e.id}
      rowHref={(e) => (e.deleted ? null : `/enquiries/${e.id}`)}
      sortable={[
        'number',
        'receivedDate',
        'client',
        'source',
        'owner',
        'status',
        'proposalSentDate',
        'updatedAt',
      ]}
      empty={
        filtered ? (
          <EmptyState
            message="No enquiries match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/enquiries">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            message="No enquiries yet. Add the first one when a client gets in touch."
            action={
              canCreate ? (
                <Link className="text-primary text-sm hover:underline" href="/enquiries/new">
                  New enquiry
                </Link>
              ) : undefined
            }
          />
        )
      }
      mobileCard={(e) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/enquiries/${e.id}`}>
              {e.number}
            </Link>
            <StatusBadge entity="enquiry" status={e.status} />
          </div>
          <p>{e.client}</p>
          <p className="text-muted-foreground text-[13px]">
            Received <DateDisplay value={e.receivedDate} />
          </p>
        </div>
      )}
      {...paging}
    />
  );
}
