'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';

/** From/to calendar days (IST) written to the URL; the server converts them to instants. */
export function DateRangeFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function update(key: 'from' | 'to', value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex items-center gap-2 text-sm">
      <label className="flex items-center gap-1">
        From
        <Input
          type="date"
          aria-label="From date"
          className="w-40"
          defaultValue={searchParams.get('from') ?? ''}
          onChange={(event) => update('from', event.target.value)}
        />
      </label>
      <label className="flex items-center gap-1">
        To
        <Input
          type="date"
          aria-label="To date"
          className="w-40"
          defaultValue={searchParams.get('to') ?? ''}
          onChange={(event) => update('to', event.target.value)}
        />
      </label>
    </div>
  );
}
