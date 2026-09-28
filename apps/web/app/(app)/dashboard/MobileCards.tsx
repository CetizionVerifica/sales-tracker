import Link from 'next/link';
import type { ReactNode } from 'react';

export interface MobileCard {
  key: string;
  title: string;
  href: string;
  fields: [label: string, value: ReactNode][];
}

/**
 * A dashboard table below 1280px: one card per row, label and value pairs (UI guide §11:
 * lists become cards with CSS). Pair it with a table that is `hidden xl:table`. Not `md`:
 * a six-column money table overflows its panel at 768px, and at 1024px beside the sidebar.
 */
export function MobileCards({ cards }: { cards: MobileCard[] }) {
  return (
    <ul className="divide-y xl:hidden">
      {cards.map((card) => (
        <li key={card.key} className="flex flex-col gap-1 px-4 py-3 text-[13px]">
          <Link href={card.href} className="text-sm font-medium hover:underline">
            {card.title}
          </Link>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5">
            {card.fields.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right">{value}</dd>
              </div>
            ))}
          </dl>
        </li>
      ))}
    </ul>
  );
}
