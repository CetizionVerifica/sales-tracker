import { formatDate, formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * `7 Oct 2026` (a calendar day) or `7 Oct 2026, 3:20 pm` (an instant, in Asia/Kolkata).
 * An empty value shows an em dash.
 */
export function DateDisplay({
  value,
  withTime = false,
  className,
}: {
  value: Date | string | null | undefined;
  withTime?: boolean;
  className?: string;
}) {
  if (!value) return <span className={cn('text-muted-foreground', className)}>—</span>;
  const iso = typeof value === 'string' ? value : value.toISOString();
  return (
    <time dateTime={iso} className={cn('num whitespace-nowrap', className)}>
      {withTime ? formatDateTime(value) : formatDate(value)}
    </time>
  );
}
