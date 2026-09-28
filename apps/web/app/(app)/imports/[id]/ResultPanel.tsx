'use client';

import Link from 'next/link';
import { Panel } from '@/components/charts/Panel';
import { ConfirmDialog } from '@/components/feedback/ConfirmDialog';
import type { ImportCounts, ImportRowView } from '@sales-tracker/core';
import { undoImportBatchAction } from '../actions';

/** Committed / undone / expired: what happened, links to the created records, and Undo. */
export function ResultPanel({
  batchId,
  status,
  counts,
  rows,
  canUndo,
}: {
  batchId: string;
  status: 'COMMITTED' | 'UNDONE' | 'EXPIRED';
  counts: ImportCounts | null;
  rows: ImportRowView[];
  canUndo: boolean;
}) {
  const created = rows.filter((r) => r.resultRecordIds);

  return (
    <Panel
      title="Result"
      actions={
        canUndo && status === 'COMMITTED' ? (
          <ConfirmDialog
            label="Undo import"
            title="Undo this import?"
            description="Every enquiry (and any client) it created is soft-deleted. You can do this for 7 days after the import."
            confirmLabel="Undo import"
            success="Import undone"
            variant="destructive"
            run={() => undoImportBatchAction({ id: batchId })}
          />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-4">
        {status === 'COMMITTED' && (
          <p>
            {counts?.created ?? created.length} enquir{(counts?.created ?? created.length) === 1 ? 'y' : 'ies'} created.
            {counts?.skippedDuplicates ? ` ${counts.skippedDuplicates} duplicate row(s) were skipped.` : ''}
          </p>
        )}
        {status === 'UNDONE' && <p>This import was undone. Nothing it created remains.</p>}
        {status === 'EXPIRED' && <p>This draft was never finished and has expired.</p>}

        {created.length > 0 && status === 'COMMITTED' && (
          <ul className="flex flex-col gap-1 text-sm">
            {created.map((row) => (
              <li key={row.id}>
                <Link className="text-primary hover:underline" href={`/enquiries/${row.resultRecordIds!.enquiryId}`}>
                  {(row.transformed?.client as string) || `Row ${row.rowNumber}`}
                </Link>
                <span className="text-muted-foreground">
                  {' '}
                  — received <span suppressHydrationWarning>{(row.transformed?.receivedDate as string) ?? ''}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Panel>
  );
}
