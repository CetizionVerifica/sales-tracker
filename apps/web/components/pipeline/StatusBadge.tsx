import { statusStyle, TONE_CLASSES, type StatusEntity } from '@/lib/status-styles';
import { cn } from '@/lib/utils';

/** One badge for every pipeline status: soft fill, strong text, 6px dot (UI guide §5). */
export function StatusBadge({
  entity,
  status,
  className,
}: {
  entity: StatusEntity;
  status: string;
  className?: string;
}) {
  const { tone, label } = statusStyle(entity, status);
  const classes = TONE_CLASSES[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2 py-0.5 text-xs leading-4 font-medium whitespace-nowrap',
        classes.badge,
        className,
      )}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', classes.dot)} aria-hidden />
      {label}
    </span>
  );
}

/** A plain soft badge for non-status marks ("Deleted"). */
export function MarkBadge({
  tone = 'neutral',
  children,
}: {
  tone?: keyof typeof TONE_CLASSES;
  children: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--radius-control)] px-2 py-0.5 text-xs leading-4 font-medium',
        TONE_CLASSES[tone].badge,
      )}
    >
      {children}
    </span>
  );
}
