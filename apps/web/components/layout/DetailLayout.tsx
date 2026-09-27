import type { ReactNode } from 'react';

/**
 * Detail page body (UI guide §4.2): flexible main column with the tabs, 320px side panel
 * of key facts. On mobile the side panel moves above the tabs (§8).
 */
export function DetailLayout({ main, side }: { main: ReactNode; side: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="order-2 min-w-0 lg:order-1">{main}</div>
      <aside className="order-1 flex flex-col gap-4 lg:order-2" aria-label="Key facts">
        {side}
      </aside>
    </div>
  );
}
