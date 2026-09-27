import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export interface FieldItem {
  label: string;
  value: ReactNode;
  /** Spans both columns (long text). */
  wide?: boolean;
  hidden?: boolean;
}

/**
 * Read-only fields: label (13px muted) over value (14px) in a two-column grid (UI guide
 * §4.2). Never disabled inputs for reading.
 */
export function FieldGrid({
  items,
  columns = 2,
  className,
}: {
  items: FieldItem[];
  columns?: 1 | 2;
  className?: string;
}) {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-6 gap-y-4',
        columns === 2 && 'sm:grid-cols-2',
        className,
      )}
    >
      {items
        .filter((item) => !item.hidden)
        .map((item) => (
          <div
            key={item.label}
            className={cn('flex min-w-0 flex-col gap-0.5', item.wide && 'sm:col-span-2')}
          >
            <dt className="text-muted-foreground text-[13px] leading-[18px]">{item.label}</dt>
            <dd className="min-w-0 break-words">{item.value}</dd>
          </div>
        ))}
    </dl>
  );
}
