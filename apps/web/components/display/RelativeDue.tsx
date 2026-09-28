import { relativeDue } from '@/lib/display';
import { cn } from '@/lib/utils';
import { DateDisplay } from './DateDisplay';

/**
 * A due date with its relative wording ("3 days overdue"). Due-today and overdue get the
 * saffron attention mark (UI guide: the only saffron in the app), but only while the
 * record is still open: pass `active={false}` for a closed record.
 */
export function RelativeDue({
  date,
  today,
  active = true,
  className,
}: {
  date: Date | string | null | undefined;
  today?: string;
  active?: boolean;
  className?: string;
}) {
  if (!date) return <DateDisplay value={null} className={className} />;
  const due = relativeDue(date, today);
  const attention = active && due.attention;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-2', className)}>
      <DateDisplay value={date} />
      {active && (
        <span
          className={cn(
            'rounded-[var(--radius-control)] px-1.5 text-[13px] leading-[18px] whitespace-nowrap',
            attention ? 'bg-attention-soft text-attention-foreground' : 'text-muted-foreground',
          )}
        >
          {due.text}
        </span>
      )}
    </span>
  );
}
