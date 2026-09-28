import { cn } from '@/lib/utils';
import { InfoTip } from './PanelActions';

export interface Delta {
  /** "▲ 18%" / "▼ 4 pts"; null for no previous value. */
  text: string;
  direction: 'up' | 'down' | 'flat';
}

/**
 * A KPI tile (UI guide 4.4): label (13px muted) with its definition, value (28px), and a
 * delta against the previous period, or "As of today" for a snapshot. `full` is the exact
 * value behind an abbreviated one.
 */
export function KpiTile({
  label,
  definition,
  value,
  full,
  sub,
  delta,
  comparedWith,
}: {
  label: string;
  definition: string;
  value: string;
  full?: string;
  sub?: string;
  delta?: Delta | null;
  comparedWith?: string;
}) {
  return (
    <div className="bg-card flex flex-col gap-1 rounded-[var(--radius)] border p-4">
      <span className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
        {label}
        <InfoTip label={label} definition={definition} />
      </span>
      <span className="num text-[28px] leading-[34px] font-semibold" title={full}>
        {value}
        {full && <span className="sr-only"> ({full})</span>}
      </span>
      <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-[13px]">
        {sub && <span>{sub}</span>}
        {delta === undefined ? (
          <span>As of today</span>
        ) : delta === null ? (
          <span>No comparison for {comparedWith}</span>
        ) : (
          <span>
            <span
              className={cn(
                delta.direction === 'up' && 'text-success',
                delta.direction === 'down' && 'text-destructive',
              )}
            >
              {delta.text}
            </span>{' '}
            vs {comparedWith}
          </span>
        )}
      </span>
    </div>
  );
}

/** % change of a money value; null when there was nothing before. */
export function percentDelta(now: bigint, before: bigint): Delta | null {
  if (before === 0n) return null;
  const change = Number(((now - before) * 1000n) / before) / 10;
  if (change === 0) return { text: 'No change', direction: 'flat' };
  return {
    text: `${change > 0 ? '▲' : '▼'} ${Math.abs(Math.round(change))}%`,
    direction: change > 0 ? 'up' : 'down',
  };
}

/** Change of a rate in percentage points; null when either side has no rate. */
export function pointsDelta(now: number | null, before: number | null): Delta | null {
  if (now === null || before === null) return null;
  const points = Math.round((now - before) * 100);
  if (points === 0) return { text: 'No change', direction: 'flat' };
  return {
    text: `${points > 0 ? '▲' : '▼'} ${Math.abs(points)} pts`,
    direction: points > 0 ? 'up' : 'down',
  };
}
