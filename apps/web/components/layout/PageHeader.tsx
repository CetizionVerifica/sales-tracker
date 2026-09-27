import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Breadcrumbs, type Crumb } from './Breadcrumbs';

/**
 * Every page's header (UI guide §3): optional breadcrumbs, one 22px title with an optional
 * badge beside it, a one-line muted description, and the page's actions on the right
 * (secondary first, the one primary last).
 */
export function PageHeader({
  title,
  description,
  actions,
  breadcrumbs,
  badge,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  breadcrumbs?: Crumb[];
  badge?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn('flex flex-col gap-2', className)}>
      {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-[22px] leading-7 font-semibold break-words">{title}</h1>
            {badge}
          </div>
          {description && <p className="text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
    </header>
  );
}
