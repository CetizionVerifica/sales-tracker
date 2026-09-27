'use client';

import type { QuotationStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { ConfirmButton } from '@/components/ConfirmButton';
import { DataTable } from '@/components/data-table/DataTable';
import { Badge } from '@/components/ui/badge';
import { formatDate, formatDateTime } from '@/lib/format';
import { QUOTATION_STATUS_BADGE, QUOTATION_STATUS_LABELS } from '@/lib/quotation-labels';
import { restoreQuotationAction } from './actions';

export interface QuotationRow {
  id: string;
  number: string;
  quotationDate: string;
  enquiryId: string;
  enquiryNumber: string;
  client: string;
  services: string;
  /** Formatted in its own currency on the server; no BigInt reaches the browser. */
  amount: string;
  status: QuotationStatusValue;
  nextFollowUpDate: string | null;
  /** Open quotations only: whether the next follow-up is missed or due today. */
  due: 'missed' | 'today' | null;
  owner: string;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
}

const DUE_CLASS = { missed: 'text-destructive font-medium', today: 'text-amber-600 font-medium' };

const column = createColumnHelper<QuotationRow>();

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
          href={`/quotations/${original.id}`}
        >
          {original.number}
        </Link>
      ),
  }),
  column.accessor('quotationDate', {
    header: 'Date',
    cell: (c) => <span className="whitespace-nowrap">{formatDate(c.getValue())}</span>,
  }),
  column.accessor('enquiryNumber', {
    header: 'Enquiry',
    cell: ({ row: { original } }) => (
      <Link
        className="whitespace-nowrap underline-offset-4 hover:underline"
        href={`/enquiries/${original.enquiryId}`}
      >
        {original.enquiryNumber}
      </Link>
    ),
  }),
  column.accessor('client', { header: 'Client' }),
  column.accessor('services', { header: 'Services' }),
  column.accessor('amount', {
    header: 'Amount',
    cell: (c) => <span className="whitespace-nowrap tabular-nums">{c.getValue()}</span>,
  }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => (
      <Badge variant={QUOTATION_STATUS_BADGE[c.getValue()]}>
        {QUOTATION_STATUS_LABELS[c.getValue()]}
      </Badge>
    ),
  }),
  column.accessor('nextFollowUpDate', {
    header: 'Next follow-up',
    cell: ({ row: { original } }) => (
      <span
        className={`whitespace-nowrap ${original.due ? DUE_CLASS[original.due] : ''}`}
        title={
          original.due === 'missed' ? 'Missed' : original.due === 'today' ? 'Due today' : undefined
        }
      >
        {original.due || original.status === 'SENT' || original.status === 'UNDER_NEGOTIATION'
          ? formatDate(original.nextFollowUpDate)
          : '—'}
      </span>
    ),
  }),
  column.accessor('owner', { header: 'Owner' }),
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
          description="The quotation comes back into the list."
          success="Quotation restored"
          run={() => restoreQuotationAction({ id: original.id })}
        />
      ) : null,
  }),
];

export function QuotationsTable(props: {
  rows: QuotationRow[];
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
      getRowId={(q) => q.id}
      sortable={[
        'number',
        'quotationDate',
        'client',
        'amount',
        'status',
        'nextFollowUpDate',
        'owner',
        'updatedAt',
      ]}
      emptyText="No quotations match these filters."
      {...paging}
    />
  );
}
