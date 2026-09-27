'use client';

import type { ProjectStatusValue } from '@sales-tracker/core/schemas';
import { createColumnHelper } from '@tanstack/react-table';
import Link from 'next/link';
import { DataTable } from '@/components/data/DataTable';
import { DateDisplay } from '@/components/display/DateDisplay';
import { Money } from '@/components/display/Money';
import { Progress } from '@/components/display/Progress';
import { RelativeDue } from '@/components/display/RelativeDue';
import { UserAvatar } from '@/components/display/UserAvatar';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge, StatusBadge } from '@/components/pipeline/StatusBadge';
import { restoreProjectAction } from './actions';

export interface ProjectRow {
  id: string;
  number: string;
  name: string;
  client: string;
  quotationId: string;
  quotationNumber: string;
  /** null = unassigned. */
  manager: string | null;
  status: ProjectStatusValue;
  completionPct: number;
  endDate: string | null;
  open: boolean;
  /** Minor units as a string: no BigInt reaches the browser. */
  revenueMinor: string;
  currency: string;
  updatedAt: string;
  deleted: boolean;
  canRestore: boolean;
}

const column = createColumnHelper<ProjectRow>();

function ManagerCell({ name }: { name: string | null }) {
  return name ? (
    <UserAvatar name={name} />
  ) : (
    <span className="text-muted-foreground text-[13px]">Unassigned</span>
  );
}

// Guide §5 column order: identifier → client → descriptors → status → money → dates →
// owner → ⋯. Defined at module level: inline renderers remount on refresh (M3 bug).
function columnsFor(today: string) {
  return [
    column.accessor('number', {
      header: 'Number',
      meta: { fixed: true },
      cell: ({ row: { original } }) => (
        <span className="inline-flex items-center gap-2 whitespace-nowrap">
          <Link className="font-medium hover:underline" href={`/projects/${original.id}`}>
            {original.number}
          </Link>
          {original.deleted && <MarkBadge tone="destructive">Deleted</MarkBadge>}
        </span>
      ),
    }),
    column.accessor('client', { header: 'Client' }),
    column.accessor('name', {
      header: 'Name',
      cell: (c) => (
        <span className="block max-w-56 truncate" title={c.getValue()}>
          {c.getValue()}
        </span>
      ),
    }),
    column.accessor('quotationNumber', {
      header: 'Quotation',
      cell: ({ row: { original } }) => (
        <Link
          className="whitespace-nowrap hover:underline"
          href={`/quotations/${original.quotationId}`}
        >
          {original.quotationNumber}
        </Link>
      ),
    }),
    column.accessor('status', {
      header: 'Status',
      cell: (c) => <StatusBadge entity="project" status={c.getValue()} />,
    }),
    column.accessor('completionPct', {
      header: 'Completion',
      cell: (c) => <Progress value={c.getValue()} />,
    }),
    column.accessor('revenueMinor', {
      id: 'revenue',
      header: 'Revenue',
      meta: { align: 'right', label: 'Revenue' },
      cell: ({ row: { original } }) => (
        <Money amountMinor={original.revenueMinor} currency={original.currency} />
      ),
    }),
    column.accessor('endDate', {
      header: 'Planned end',
      cell: ({ row: { original } }) => (
        <RelativeDue date={original.endDate} today={today} active={original.open} />
      ),
    }),
    column.accessor('manager', {
      header: 'Manager',
      cell: (c) => <ManagerCell name={c.getValue()} />,
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
            description="The project comes back into the list, if its quotation has no other project."
            success="Project restored"
            run={() => restoreProjectAction({ id: original.id })}
          />
        ) : null,
    }),
  ];
}

export function ProjectsTable(props: {
  rows: ProjectRow[];
  total: number;
  page: number;
  pageSize: number;
  sort?: string;
  dir?: 'asc' | 'desc';
  today: string;
  filtered: boolean;
  /** Sales and admins start projects from quotations; PMs are assigned them. */
  canCreate: boolean;
}) {
  const { rows, today, filtered, canCreate, ...paging } = props;
  return (
    <DataTable
      id="projects"
      columns={columnsFor(today)}
      data={rows}
      getRowId={(p) => p.id}
      rowHref={(p) => (p.deleted ? null : `/projects/${p.id}`)}
      sortable={[
        'number',
        'client',
        'name',
        'status',
        'completionPct',
        'revenue',
        'endDate',
        'manager',
        'updatedAt',
      ]}
      empty={
        filtered ? (
          <EmptyState
            message="No projects match these filters."
            action={
              <Link className="text-primary text-sm hover:underline" href="/projects">
                Clear filters
              </Link>
            }
          />
        ) : canCreate ? (
          <EmptyState message="No projects yet. Start one from a quotation with a PO received." />
        ) : (
          <EmptyState message="No projects are assigned to you yet." />
        )
      }
      mobileCard={(p) => (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <Link className="font-medium" href={`/projects/${p.id}`}>
              {p.number}
            </Link>
            <StatusBadge entity="project" status={p.status} />
          </div>
          <p>
            {p.client} · {p.name}
          </p>
          <div className="text-muted-foreground flex items-center justify-between gap-2 text-[13px]">
            <Progress value={p.completionPct} />
            <RelativeDue date={p.endDate} today={today} active={p.open} />
          </div>
        </div>
      )}
      {...paging}
    />
  );
}
