'use client';

import type { DocumentState, PurchaseOrderStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { DocumentStateLabel } from '@/components/documents/DocumentStateLabel';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { restorePurchaseOrderAction } from './actions';

export interface PurchaseOrderRow {
  id: string;
  poNumber: string;
  client: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  receivedDate: string;
  /** Minor units as a string: no BigInt reaches the browser. */
  amountMinor: string;
  currency: string;
  paymentTerms: string | null;
  status: PurchaseOrderStatusValue;
  documentState: DocumentState;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
}

const column = createColumnHelper<PurchaseOrderRow>();

// Guide §5 column order: identifier → client → descriptors → status → money → dates → ⋯.
// Defined at module level: inline renderers remount on refresh (M3 bug).
const columns = [
  column.accessor('poNumber', {
    header: 'PO number',
    meta: { fixed: true },
    cell: ({ row: { original } }) => (
      <span className="inline-flex items-center gap-2 whitespace-nowrap">
        <Link className="font-medium hover:underline" href={`/purchase-orders/${original.id}`}>
          {original.poNumber}
        </Link>
        {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
      </span>
    ),
  }),
  column.accessor('client', { header: 'Client' }),
  column.accessor('projectNumber', {
    id: 'project',
    header: 'Project',
    cell: ({ row: { original } }) => (
      <Link
        className="block max-w-56 truncate hover:underline"
        href={`/projects/${original.projectId}`}
        title={`${original.projectNumber} · ${original.projectName}`}
      >
        {original.projectNumber} · {original.projectName}
      </Link>
    ),
  }),
  column.accessor('paymentTerms', {
    header: 'Payment terms',
    cell: (c) =>
      c.getValue() ? (
        <span className="block max-w-48 truncate" title={c.getValue() ?? undefined}>
          {c.getValue()}
        </span>
      ) : (
        <span className="text-muted-foreground">—</span>
      ),
  }),
  column.accessor('status', {
    header: 'Status',
    cell: (c) => <StatusBadge entity="po" status={c.getValue()} />,
  }),
  column.accessor('amountMinor', {
    id: 'amount',
    header: 'Amount',
    meta: { align: 'right', label: 'Amount' },
    cell: ({ row: { original } }) => (
      <Money amountMinor={original.amountMinor} currency={original.currency} />
    ),
  }),
  column.accessor('receivedDate', {
    header: 'Received',
    cell: (c) => <DateDisplay value={c.getValue()} />,
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
      original.deleted && original.canRestore ? (
        <ConfirmDialog
          label="Restore"
          title={`Restore PO ${original.poNumber}?`}
          description="The PO comes back onto its project, if the client has no other PO with this number."
          success="Purchase order restored"
          run={() => restorePurchaseOrderAction({ id: original.id })}
        />
      ) : null,
  }),
];

export function PurchaseOrdersTable(props: {
  rows: PurchaseOrderRow[];
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
      id="purchase-orders"
      columns={columns}
      data={rows}
      getRowId={(po) => po.id}
      rowHref={(po) => (po.deleted ? null : `/purchase-orders/${po.id}`)}
      sortable={['poNumber', 'client', 'project', 'status', 'amount', 'receivedDate', 'updatedAt']}
      empty={
        filtered ? (
          <EmptyState
            message="No purchase orders match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/purchase-orders">
                Clear filters
              </Link>
            }
          />
        ) : canCreate ? (
          <EmptyState message="No purchase orders yet. Record one on its project when it arrives." />
        ) : (
          <EmptyState message="No purchase orders you can see yet." />
        )
      }
      mobileCard={(po) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/purchase-orders/${po.id}`}>
              PO {po.poNumber}
            </Link>
            <StatusBadge entity="po" status={po.status} />
          </div>
          <p>
            {po.client} · {po.projectNumber}
          </p>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
            <Money amountMinor={po.amountMinor} currency={po.currency} />
            <DateDisplay value={po.receivedDate} />
          </div>
          <DocumentStateLabel state={po.documentState} />
        </div>
      )}
      {...paging}
    />
  );
}
