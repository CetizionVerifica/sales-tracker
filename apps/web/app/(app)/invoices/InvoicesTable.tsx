'use client';

import type { DocumentState, InvoiceStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { RelativeDue } from '@/components/display/RelativeDue';
import { DocumentStateLabel } from '@/components/documents/DocumentStateLabel';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { restoreInvoiceAction } from './actions';
import { MarkPaidDialog } from '@/components/invoices/PaymentDialogs';

export interface InvoiceRow {
  id: string;
  invoiceNumber: string;
  client: string;
  purchaseOrderId: string;
  poNumber: string;
  projectId: string;
  projectNumber: string;
  invoiceDate: string;
  dueDate: string;
  /** Minor units as a string: no BigInt reaches the browser. */
  amountMinor: string;
  currency: string;
  status: InvoiceStatusValue;
  documentState: DocumentState;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
  canMarkPaid: boolean;
  /** YYYY-MM-DD, the Mark paid dialog's bounds. */
  invoiceDay: string;
  today: string;
}

const column = createColumnHelper<InvoiceRow>();

// Guide §5 column order: identifier → client → descriptors → status → money → dates → ⋯.
// Defined at module level: inline renderers remount on refresh (M3 bug).
const columns = [
  column.accessor('invoiceNumber', {
    header: 'Invoice number',
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <Link className="font-medium hover:underline" href={`/invoices/${original.id}`}>
          {original.invoiceNumber}
        </Link>
        {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
      </span>
    ),
  }),
  column.accessor('client', { header: 'Client' }),
  column.accessor('poNumber', {
    header: 'PO',
    enableSorting: false,
    cell: ({ row: { original } }) => (
      <Link
        className="whitespace-nowrap hover:underline"
        href={`/purchase-orders/${original.purchaseOrderId}`}
      >
        PO {original.poNumber}
      </Link>
    ),
  }),
  column.accessor('projectNumber', {
    header: 'Project',
    enableSorting: false,
    cell: ({ row: { original } }) => (
      <Link className="whitespace-nowrap hover:underline" href={`/projects/${original.projectId}`}>
        {original.projectNumber}
      </Link>
    ),
  }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => <StatusBadge entity="invoice" status={c.getValue()} />,
  }),
  column.accessor('amountMinor', {
    id: 'amount',
    header: 'Amount',
    meta: { align: 'right', label: 'Amount' },
    cell: ({ row: { original } }) => (
      <Money amountMinor={original.amountMinor} currency={original.currency} />
    ),
  }),
  column.accessor('invoiceDate', {
    header: 'Invoice date',
    cell: (c) => <DateDisplay value={c.getValue()} />,
  }),
  column.accessor('dueDate', {
    header: 'Due',
    cell: ({ row: { original } }) => (
      <RelativeDue
        date={original.dueDate}
        today={original.today}
        active={original.status !== 'PAID' && !original.deleted}
      />
    ),
  }),
  column.accessor('documentState', {
    header: 'Document',
    cell: (c) => <DocumentStateLabel state={c.getValue()} />,
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
      original.deleted ? (
        original.canRestore ? (
          <ConfirmDialog
            label="Restore"
            title={`Restore invoice ${original.invoiceNumber}?`}
            description="The invoice comes back onto its PO, if no other invoice has this number."
            success="Invoice restored"
            run={() => restoreInvoiceAction({ id: original.id })}
          />
        ) : null
      ) : original.canMarkPaid ? (
        <MarkPaidDialog
          id={original.id}
          label={`invoice ${original.invoiceNumber}`}
          invoiceDate={original.invoiceDay}
          today={original.today}
          variant="outline"
        />
      ) : null,
  }),
];

export function InvoicesTable(props: {
  rows: InvoiceRow[];
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
      id="invoices"
      columns={columns}
      data={rows}
      getRowId={(invoice) => invoice.id}
      rowHref={(invoice) => (invoice.deleted ? null : `/invoices/${invoice.id}`)}
      sortable={[
        'invoiceNumber',
        'client',
        'status',
        'amount',
        'invoiceDate',
        'dueDate',
        'updatedAt',
      ]}
      empty={
        filtered ? (
          <EmptyState
            message="No invoices match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/invoices">
                Clear filters
              </Link>
            }
          />
        ) : canCreate ? (
          <EmptyState message="No invoices yet. Record one on its PO when it is raised." />
        ) : (
          <EmptyState message="No invoices you can see yet." />
        )
      }
      mobileCard={(invoice) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/invoices/${invoice.id}`}>
              Invoice {invoice.invoiceNumber}
            </Link>
            <StatusBadge entity="invoice" status={invoice.status} />
          </div>
          <p>
            {invoice.client} · PO {invoice.poNumber}
          </p>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
            <Money amountMinor={invoice.amountMinor} currency={invoice.currency} />
            <RelativeDue
              date={invoice.dueDate}
              today={invoice.today}
              active={invoice.status !== 'PAID' && !invoice.deleted}
            />
          </div>
          <DocumentStateLabel state={invoice.documentState} />
        </div>
      )}
      {...paging}
    />
  );
}
