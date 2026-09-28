'use client';

import { useState } from 'react';
import { RowActions } from '@/components/data/RowActions';
import { EmptyState } from '@/components/feedback/EmptyState';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { deleteExchangeRateAction, recalculateExchangeRateAction } from './actions';
import { RateDialog, type RateRowView } from './RateDialog';

const monthName = (month: string) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00.000Z`),
  );

/** Rates newest month first; edit, recalculate and delete from each row's ⋯ menu. */
export function RatesTable({
  rows,
  currencies,
  thisMonth,
}: {
  rows: RateRowView[];
  currencies: string[];
  thisMonth: string;
}) {
  const [editing, setEditing] = useState<RateRowView | null>(null);
  const [recalculating, setRecalculating] = useState<RateRowView | null>(null);
  const [deleting, setDeleting] = useState<RateRowView | null>(null);

  if (rows.length === 0) {
    return (
      <EmptyState message="No exchange rates yet. Records in other currencies have no INR value until you add their month's rate." />
    );
  }
  const actionsFor = (row: RateRowView) => [
    { label: 'Edit rate', onSelect: () => setEditing(row) },
    ...(row.staleCount > 0
      ? [{ label: 'Recalculate', onSelect: () => setRecalculating(row) }]
      : []),
    // A rate records use cannot be deleted (their INR values came from it).
    ...(row.recordCount === 0
      ? [{ label: 'Delete', onSelect: () => setDeleting(row), destructive: true }]
      : []),
  ];
  return (
    <>
      {/* Phones: cards (UI guide §11), so the ⋯ menu is never off-screen. */}
      <ul className="bg-card divide-y rounded-[var(--radius)] border md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="flex items-start justify-between gap-3 px-4 py-3">
            <div className="flex flex-col gap-0.5 text-[13px]">
              <span className="text-sm font-medium">
                {monthName(row.month)} · {row.currency}
              </span>
              <span>
                <span className="num">{row.rate}</span> INR per unit
              </span>
              <span className="text-muted-foreground">
                {row.recordCount} {row.recordCount === 1 ? 'record' : 'records'}
                {row.staleCount > 0 && `, ${row.staleCount} at an older rate`}
              </span>
            </div>
            <RowActions
              label={`${row.currency} ${monthName(row.month)}`}
              actions={actionsFor(row)}
            />
          </li>
        ))}
      </ul>
      <div className="bg-card hidden rounded-[var(--radius)] border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Month</TableHead>
              <TableHead>Currency</TableHead>
              <TableHead className="text-right">INR per unit</TableHead>
              <TableHead className="text-right">Records</TableHead>
              <TableHead>
                <span className="sr-only">Actions</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell>{monthName(row.month)}</TableCell>
                <TableCell>{row.currency}</TableCell>
                <TableCell className="num text-right">{row.rate}</TableCell>
                <TableCell className="num text-right">
                  {row.recordCount}
                  {row.staleCount > 0 && (
                    <span className="text-muted-foreground block text-[12px]">
                      {row.staleCount} at an older rate
                    </span>
                  )}
                </TableCell>
                <TableCell className="w-10 text-right">
                  <RowActions
                    label={`${row.currency} ${monthName(row.month)}`}
                    actions={actionsFor(row)}
                  />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {editing && (
        <RateDialog
          currencies={currencies}
          thisMonth={thisMonth}
          row={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
      {recalculating && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setRecalculating(null)}
          label="Recalculate"
          title={`Recalculate ${recalculating.currency} for ${monthName(recalculating.month)}?`}
          description={`${recalculating.staleCount} ${recalculating.staleCount === 1 ? 'record' : 'records'} will be converted again at ${recalculating.rate}. Dashboard totals for that month change.`}
          confirmLabel="Recalculate"
          success="Rate recalculated"
          run={() => recalculateExchangeRateAction({ id: recalculating.id })}
        />
      )}
      {deleting && (
        <ConfirmDialog
          open
          onOpenChange={(open) => !open && setDeleting(null)}
          label="Delete"
          title={`Delete the ${deleting.currency} rate for ${monthName(deleting.month)}?`}
          description="No records use it. Records added later for that month will have no INR value until a new rate is added."
          confirmLabel="Delete"
          success="Rate deleted"
          variant="destructive"
          run={() => deleteExchangeRateAction({ id: deleting.id })}
        />
      )}
    </>
  );
}
