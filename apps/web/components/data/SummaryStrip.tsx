import Link from 'next/link';
import { cn } from '@/lib/utils';

export interface SummaryChip {
  label: string;
  count: number;
  /** The list filtered to this chip. */
  href: string;
  active?: boolean;
  /** Only for due-today / overdue counts (the saffron rule). */
  attention?: boolean;
}

/** Up to four compact stat chips that filter the list below (UI guide §4.1). */
export function SummaryStrip({ chips }: { chips: SummaryChip[] }) {
  return (
    <ul className="flex flex-wrap gap-2" aria-label="Summary">
      {chips.slice(0, 4).map((chip) => (
        <li key={chip.label}>
          <Link
            href={chip.href}
            aria-current={chip.active ? 'true' : undefined}
            className={cn(
              'bg-card hover:bg-accent inline-flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-1.5 text-[13px]',
              chip.active && 'border-primary bg-secondary',
              chip.attention && chip.count > 0 && 'bg-attention-soft text-attention-foreground',
            )}
          >
            <span>{chip.label}</span>
            <span className="num font-semibold">{chip.count}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
