import { cn } from '@/lib/utils';

/** A thin completion bar with its number (M8 completion %). Tokens only. */
export function Progress({
  value,
  label = 'Completion',
  className,
}: {
  /** 0–100. */
  value: number;
  label?: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex items-center gap-2', className)}>
      <span
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={value}
        className="bg-secondary h-1.5 w-16 overflow-hidden rounded-full"
      >
        <span className="bg-stage-project block h-full" style={{ width: `${value}%` }} />
      </span>
      <span className="text-[13px] tabular-nums">{value}%</span>
    </span>
  );
}
