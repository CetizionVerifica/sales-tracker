'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

export interface RecordTab {
  id: string;
  label: string;
  content: ReactNode;
}

/**
 * The same tabs on every pipeline record, in this order: Overview | Timeline | Documents |
 * Audit (UI guide §4.2). The open tab lives in the URL (`?tab=timeline`), so it survives
 * refresh and can be shared.
 */
export function RecordTabs({ tabs, defaultTab }: { tabs: RecordTab[]; defaultTab?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const requested = searchParams.get('tab');
  const fallback = defaultTab ?? tabs[0]!.id;
  const value = tabs.some((t) => t.id === requested) ? requested! : fallback;

  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const params = new URLSearchParams(searchParams.toString());
        if (next === fallback) params.delete('tab');
        else params.set('tab', next);
        const query = params.toString();
        router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
      }}
      className="gap-4"
    >
      <TabsList className="w-full justify-start overflow-x-auto sm:w-auto">
        {tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="flex flex-col gap-4">
          {tab.content}
        </TabsContent>
      ))}
    </Tabs>
  );
}
