'use client';

import type { EnquirySourceValue, EnquiryStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { SOURCE_LABELS, STATUS_BADGE, STATUS_LABELS } from '@/lib/enquiry-labels';
import { formatDate, formatDateTime } from '@/lib/format';
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

// Defined once at module level: inline cell renderers remount on every refresh (M3 bug).
const columns = [
  column.accessor('number', {
    header: 'Number',
    cell: ({ row: { original } }) =>
      original.deleted ? (
        <span className="text-muted-foreground">
          {original.number} <Badge variant="destructive">Deleted</Badge>
        </span>
      ) : (
        <Link
          className="font-medium whitespace-nowrap underline-offset-4 hover:underline"
          href={`/enquiries/${original.id}`}
        >
          {original.number}
        </Link>
      ),
  }),
  column.accessor('receivedDate', {
    header: 'Received',
    cell: (c) => <span className="whitespace-nowrap">{formatDate(c.getValue())}</span>,
  }),
  column.accessor('client', { header: 'Client' }),
  column.accessor('sector', { header: 'Sector' }),
  column.accessor('services', { header: 'Services' }),
  column.accessor('source', { header: 'Source', cell: (c) => SOURCE_LABELS[c.getValue()] }),
  column.accessor('owner', { header: 'Owner' }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => <Badge variant={STATUS_BADGE[c.getValue()]}>{STATUS_LABELS[c.getValue()]}</Badge>,
  }),
  column.accessor('proposalSentDate', {
    header: 'Proposal sent',
    cell: (c) => <span className="whitespace-nowrap">{formatDate(c.getValue())}</span>,
  }),
  column.accessor('updatedAt', {
    header: 'Updated',
    cell: (c) => formatDateTime(c.getValue()),
  }),
  column.display({
    id: 'actions',
    header: () => <span className="sr-only">Actions</span>,
    cell: ({ row: { original } }) =>
      original.deleted && original.canRestore ? (
        <ConfirmButton
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
}) {
  const { rows, ...paging } = props;
  return (
    <DataTable
      columns={columns}
      data={rows}
      getRowId={(e) => e.id}
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
      emptyText="No enquiries match these filters."
      {...paging}
    />
  );
}
