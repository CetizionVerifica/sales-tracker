import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * A bordered panel with an optional 16px title, description and actions (UI guide §2:
 * `bg-card`, border, --radius, no shadow). Used on dashboards and detail pages alike.
 */
export function Panel({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  const headingId = id ? `${id}-heading` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className={cn('bg-card text-card-foreground rounded-[var(--radius)] border', className)}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-start justify-between gap-3 border-b px-4 py-3">
          <div className="flex flex-col gap-0.5">
            {title && (
              <h2 id={headingId} className="text-base leading-6 font-semibold">
                {title}
              </h2>
            )}
            {description && <p className="text-muted-foreground text-[13px]">{description}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
