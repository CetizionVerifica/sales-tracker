'use client';

import Link from 'next/link';
import { useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/*
 * Shared chart chrome for the dashboard (UI guide 4.4, dataviz method): recessive axes and
 * gridlines in tokens, a popover-style tooltip where the value leads, and a table view of
 * every chart so no value or drill-down link is hover-only.
 */

export const AXIS = {
  tick: { fill: 'var(--muted-foreground)', fontSize: 12 },
  axisLine: false,
  tickLine: false,
} as const;

export const GRID = { stroke: 'var(--border)', strokeWidth: 1 } as const;

/** Thin bars with a 4px rounded data end, square at the baseline. */
export const BAR = {
  maxBarSize: 24,
  radiusVertical: [4, 4, 0, 0],
  radiusHorizontal: [0, 4, 4, 0],
} as const;

export interface TooltipRow {
  label: string;
  value: string;
  /** A short line key in the series colour (never the text colour). */
  color?: string;
}

/** The tooltip body: title, then each value (strong) with its series name (muted). */
export function TooltipCard({ title, rows }: { title: string; rows: TooltipRow[] }) {
  return (
    <div className="bg-popover text-popover-foreground rounded-[var(--radius-control)] border px-3 py-2 text-[13px] shadow-md">
      <p className="text-muted-foreground mb-1">{title}</p>
      {rows.map((row) => (
        <p key={row.label} className="flex items-center gap-2">
          {row.color && (
            <span
              aria-hidden
              className="h-0.5 w-3 rounded-full"
              style={{ background: row.color }}
            />
          )}
          <span className="num font-semibold">{row.value}</span>
          <span className="text-muted-foreground">{row.label}</span>
        </p>
      ))}
    </div>
  );
}

export interface TableColumn {
  label: string;
  numeric?: boolean;
}

export interface TableRow {
  key: string;
  cells: ReactNode[];
  /** The drill-down for the row's first cell. */
  href?: string | null;
}

/**
 * A chart with a Chart | Table switch. The table is the accessible and keyboard path to
 * every value and drill-down link (dataviz: tooltips enhance, never gate).
 */
export function ChartFrame({
  title,
  chart,
  columns,
  rows,
  height = 240,
}: {
  /** Names the chart for screen readers ("Receivables by days overdue"). */
  title: string;
  chart: ReactNode;
  columns: TableColumn[];
  rows: TableRow[];
  height?: number;
}) {
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end" role="group" aria-label={`${title}: view`}>
        {(['chart', 'table'] as const).map((option) => (
          <button
            key={option}
            type="button"
            aria-pressed={view === option}
            onClick={() => setView(option)}
            className={cn(
              'rounded-[var(--radius-control)] px-2 py-0.5 text-[12px]',
              view === option
                ? 'bg-secondary text-secondary-foreground'
                : 'text-muted-foreground hover:bg-accent',
            )}
          >
            {option === 'chart' ? 'Chart' : 'Table'}
          </button>
        ))}
      </div>
      {view === 'chart' ? (
        <div role="img" aria-label={`${title}. Switch to Table for the values.`} style={{ height }}>
          {chart}
        </div>
      ) : (
        <table className="w-full text-[13px]">
          <caption className="sr-only">{title}</caption>
          <thead>
            <tr className="text-muted-foreground border-b text-left">
              {columns.map((c) => (
                <th
                  key={c.label}
                  scope="col"
                  className={cn('py-1.5 font-medium', c.numeric && 'text-right')}
                >
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b last:border-b-0">
                {row.cells.map((cell, i) => (
                  <td key={i} className={cn('py-1.5', columns[i]?.numeric && 'num text-right')}>
                    {i === 0 && row.href ? (
                      <Link href={row.href} className="hover:underline">
                        {cell}
                      </Link>
                    ) : (
                      cell
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
