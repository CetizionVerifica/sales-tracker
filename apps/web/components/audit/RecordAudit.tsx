'use client';

import { useState } from 'react';
import { DateDisplay } from '@/components/display/DateDisplay';
import { EmptyState } from '@/components/feedback/EmptyState';
import { MarkBadge } from '@/components/pipeline/StatusBadge';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { AUDIT_ACTION_LABELS, AUDIT_SOURCE_LABELS, humanize } from '@/lib/audit-labels';
import { formatDateTime } from '@/lib/format';
import { ChangeDetail, type AuditRowView } from './AuditLogTable';

/**
 * A record's Audit tab: its changes, newest first, each opening before/after. Non-admins
 * see only the changes they made (M2 scope), and the note says so.
 */
export function RecordAudit({ rows, ownOnly }: { rows: AuditRowView[]; ownOnly: boolean }) {
  const [selected, setSelected] = useState<AuditRowView | null>(null);
  return (
    <div className="bg-card rounded-[var(--radius)] border">
      {ownOnly && (
        <p className="text-muted-foreground border-b px-4 py-2 text-[13px]">
          Showing the changes you made. Admins see everyone’s.
        </p>
      )}
      {rows.length === 0 ? (
        <EmptyState message="No changes recorded yet." />
      ) : (
        <ul className="divide-y">
          {rows.map((row) => (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => setSelected(row)}
                className="hover:bg-accent flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left"
              >
                <MarkBadge>{AUDIT_ACTION_LABELS[row.action] ?? humanize(row.action)}</MarkBadge>
                <span className="min-w-0 flex-1 truncate">
                  {row.changedFields.length > 0
                    ? row.changedFields.map(humanize).join(', ')
                    : humanize(row.entityType)}
                </span>
                <span className="text-muted-foreground text-[13px]">
                  {row.actor} · <DateDisplay value={row.createdAt} withTime />
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
          {selected && (
            <>
              <SheetHeader>
                <SheetTitle>
                  {AUDIT_ACTION_LABELS[selected.action] ?? humanize(selected.action)}{' '}
                  {humanize(selected.entityType).toLowerCase()}
                </SheetTitle>
                <SheetDescription>
                  {formatDateTime(selected.createdAt)} · {selected.actor} ·{' '}
                  {AUDIT_SOURCE_LABELS[selected.source] ?? selected.source}
                </SheetDescription>
              </SheetHeader>
              <div className="px-4 pb-6">
                <ChangeDetail row={selected} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
