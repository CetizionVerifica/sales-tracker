'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Input } from '@/components/ui/input';

/**
 * From/to calendar days written to the URL. The audit log converts them to IST instants;
 * enquiry lists compare them with @db.Date columns directly.
 */
export function DateRangeFilter({
  label,
  fromParam = 'from',
  toParam = 'to',
}: {
  /** Names the range when a page has several (e.g. "Received"). */
  label?: string;
  fromParam?: string;
  toParam?: string;
} = {}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function update(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 text-[13px]">
      <label className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        {label ? `${label} from` : 'From'}
        <Input
          type="date"
          aria-label={label ? `${label} from` : 'From date'}
          className="w-36 sm:w-40"
          defaultValue={searchParams.get(fromParam) ?? ''}
          onChange={(event) => update(fromParam, event.target.value)}
        />
      </label>
      <label className="flex min-w-0 items-center gap-1 whitespace-nowrap">
        {label ? 'to' : 'To'}
        <Input
          type="date"
          aria-label={label ? `${label} to` : 'To date'}
          className="w-36 sm:w-40"
          defaultValue={searchParams.get(toParam) ?? ''}
          onChange={(event) => update(toParam, event.target.value)}
        />
      </label>
    </div>
  );
}
