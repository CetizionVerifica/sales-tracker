'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Panel } from '@/components/charts/Panel';
import { cn } from '@/lib/utils';
import { TodayRow } from './TodayRow';
import type { TodayRowView } from './today-view';

type Item = { row: TodayRowView; leaving: boolean };

/** Keeps rows that dropped out of the new list, marked leaving, where they were. */
function mergeLeaving(items: Item[], rows: TodayRowView[]): Item[] {
  const keys = new Set(rows.map((row) => row.key));
  const next: Item[] = rows.map((row) => ({ row, leaving: false }));
  items.forEach((item, index) => {
    if (keys.has(item.row.key) || item.leaving) return;
    next.splice(Math.min(index, next.length), 0, { row: item.row, leaving: true });
  });
  return next;
}

/**
 * One My Today panel (UI guide 4.4). When an action completes and the page refreshes, a
 * row that no longer qualifies collapses out (150 ms, none with reduced motion) instead of
 * vanishing; the action's own toast confirms what happened.
 */
export function TodaySection({
  id,
  title,
  attention,
  total,
  rows,
  today,
  contacts,
  emptyText,
  footer,
}: {
  id: string;
  title: string;
  attention: boolean;
  /** The exact count, which may exceed the rows shown (Decision 7). */
  total: number;
  rows: TodayRowView[];
  today: string;
  contacts: Record<string, { id: string; name: string }[]>;
  emptyText: string;
  footer?: ReactNode;
}) {
  const [prevRows, setPrevRows] = useState(rows);
  const [items, setItems] = useState<Item[]>(() => rows.map((row) => ({ row, leaving: false })));
  // Adjust state while rendering when the server sends new rows (React's "previous props").
  if (rows !== prevRows) {
    setPrevRows(rows);
    setItems(mergeLeaving(items, rows));
  }
  useEffect(() => {
    if (!items.some((item) => item.leaving)) return;
    const timer = setTimeout(() => setItems((current) => current.filter((i) => !i.leaving)), 150);
    return () => clearTimeout(timer);
  }, [items]);

  return (
    <Panel
      id={id}
      title={
        <span className="flex items-center gap-2">
          {title}
          <span
            className={cn(
              'num rounded-[var(--radius-control)] px-1.5 text-[13px] leading-5 font-semibold',
              attention && total > 0
                ? 'bg-attention-soft text-attention-foreground'
                : 'bg-muted text-muted-foreground',
            )}
          >
            {total}
          </span>
        </span>
      }
      bodyClassName="p-0"
    >
      {items.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-sm">{emptyText}</p>
      ) : (
        <ul className="divide-y">
          {items.map(({ row, leaving }) => (
            <li
              key={row.key}
              className={cn(
                'grid transition-[grid-template-rows,opacity] duration-150 ease-out motion-reduce:transition-none',
                leaving ? 'grid-rows-[0fr] opacity-0' : 'grid-rows-[1fr] opacity-100',
              )}
              // Leaving rows are gone for screen readers and the keyboard while they fold.
              aria-hidden={leaving || undefined}
              inert={leaving || undefined}
            >
              <div className="overflow-hidden">
                <TodayRow row={row} today={today} contacts={contacts[row.client.id] ?? []} />
              </div>
            </li>
          ))}
        </ul>
      )}
      {footer && <div className="text-muted-foreground border-t px-4 py-3 text-[13px]">{footer}</div>}
    </Panel>
  );
}
