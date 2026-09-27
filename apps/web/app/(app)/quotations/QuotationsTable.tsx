'use client';

import type { QuotationStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { restoreQuotationAction } from './actions';

export interface QuotationRow {
  id: string;
  number: string;
  quotationDate: string;
  enquiryId: string;
  enquiryNumber: string;
  client: string;
  services: string;
  /** Minor units as a string: no BigInt reaches the browser. */
  amountMinor: string;
  currency: string;
  status: QuotationStatusValue;
  nextFollowUpDate: string | null;
  open: boolean;
  owner: string;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
}

const column = createColumnHelper<QuotationRow>();

// Guide §5 column order: identifier → client → descriptors → status → money → dates →
// owner → ⋯. Defined at module level: inline renderers remount on refresh (M3 bug).
function columnsFor(today: string) {
  return [
    column.accessor('number', {
      header: 'Number',
      meta: { fixed: true },
      cell: ({ row: { original } }) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <Link className="font-medium hover:underline" href={`/quotations/${original.id}`}>
            {original.number}
          </Link>
          {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
        </span>
      ),
    }),
    column.accessor('client', { header: 'Client' }),
    column.accessor('enquiryNumber', {
      header: 'Enquiry',
      cell: ({ row: { original } }) => (
        <Link
          className="whitespace-nowrap hover:underline"
          href={`/enquiries/${original.enquiryId}`}
        >
          {original.enquiryNumber}
        </Link>
      ),
    }),
    column.accessor('services', {
      header: 'Services',
      cell: (c) => (
        <span className="block max-w-56 truncate" title={c.getValue()}>
          {c.getValue()}
        </span>
      ),
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (c) => <StatusBadge entity="quotation" status={c.getValue()} />,
    }),
    column.accessor('amountMinor', {
      id: 'amount',
      header: 'Amount',
      meta: { align: 'right', label: 'Amount' },
      cell: ({ row: { original } }) => (
        <Money amountMinor={original.amountMinor} currency={original.currency} />
      ),
    }),
    column.accessor('quotationDate', {
      header: 'Date',
      cell: (c) => <DateDisplay value={c.getValue()} />,
    }),
    column.accessor('nextFollowUpDate', {
      header: 'Next follow-up',
      cell: ({ row: { original } }) =>
        original.open ? (
          <RelativeDue date={original.nextFollowUpDate} today={today} />
        ) : (
          <DateDisplay value={null} />
        ),
    }),
    column.accessor('owner', {
      header: 'Owner',
      cell: (c) => <UserAvatar name={c.getValue()} />,
    }),
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
            description="The quotation comes back into the list."
            success="Quotation restored"
            run={() => restoreQuotationAction({ id: original.id })}
          />
        ) : null,
    }),
  ];
}

export function QuotationsTable(props: {
  rows: QuotationRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  today: string;
  filtered: boolean;
}) {
  const { rows, today, filtered, ...paging } = props;
  return (
    <DataTable
      id="quotations"
      columns={columnsFor(today)}
      data={rows}
      getRowId={(q) => q.id}
      rowHref={(q) => (q.deleted ? null : `/quotations/${q.id}`)}
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
      empty={
        filtered ? (
          <EmptyState
            message="No quotations match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/quotations">
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState message="No quotations yet. Convert an enquiry to send the first one." />
        )
      }
      mobileCard={(q) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/quotations/${q.id}`}>
              {q.number}
            </Link>
            <StatusBadge entity="quotation" status={q.status} />
          </div>
          <p>{q.client}</p>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
            <Money amountMinor={q.amountMinor} currency={q.currency} />
            {q.open ? (
              <RelativeDue date={q.nextFollowUpDate} today={today} />
            ) : (
              <DateDisplay value={q.quotationDate} />
            )}
          </div>
        </div>
      )}
      {...paging}
    />
  );
}
