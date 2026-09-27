import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * One sentence saying what goes here, plus the action that fills it (UI guide §6).
 * Filtered-empty: "No enquiries match these filters." with a Clear filters action.
 */
export function EmptyState({
  message,
  action,
  className,
}: {
  message: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col items-center gap-3 px-4 py-10 text-center', className)}>
      <p className="text-muted-foreground">{message}</p>
      {action}
    </div>
  );
}
