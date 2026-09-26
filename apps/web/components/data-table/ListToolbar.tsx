'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface FilterDef {
  param: string;
  label: string;
  options: { value: string; label: string }[];
}

const ALL = '__all__';

/** Search box and filters that write to the URL (page resets to 1 on change). */
export function ListToolbar({
  searchPlaceholder,
  filters = [],
  children,
}: {
  searchPlaceholder?: string;
  filters?: FilterDef[];
  children?: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function update(key: string, value: string | undefined) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(key, value);
    else params.delete(key);
    params.delete('page');
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {searchPlaceholder && (
        <form
          role="search"
          onSubmit={(event) => {
            event.preventDefault();
            const q = new FormData(event.currentTarget).get('q');
            update('q', typeof q === 'string' ? q.trim() : undefined);
          }}
        >
          <Input
            name="q"
            aria-label="Search"
            placeholder={searchPlaceholder}
            defaultValue={searchParams.get('q') ?? ''}
            className="w-64"
          />
        </form>
      )}
      {filters.map((filter) => (
        <Select
          key={filter.param}
          value={searchParams.get(filter.param) ?? ALL}
          onValueChange={(value) => update(filter.param, value === ALL ? undefined : value)}
        >
          <SelectTrigger className="w-44" aria-label={filter.label}>
            <SelectValue placeholder={filter.label} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{`All ${filter.label.toLowerCase()}`}</SelectItem>
            {filter.options.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ))}
      <div className="ml-auto flex gap-2">{children}</div>
    </div>
  );
}
