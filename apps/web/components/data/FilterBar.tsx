'use client';

import { ChevronDown } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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
  /** Several values at once, written comma-separated (`status=IN_PROGRESS,LOST`). */
  multi?: boolean;
}

const ALL = '__all__';

/** Checkbox dropdown for a multi-value filter; values keep the options' order. */
function MultiFilter({
  filter,
  value,
  onChange,
}: {
  filter: FilterDef;
  value: string | null;
  onChange: (value: string | undefined) => void;
}) {
  const selected = new Set(value ? value.split(',') : []);
  const chosen = filter.options.filter((option) => selected.has(option.value));
  const summary =
    chosen.length === 0
      ? `All ${filter.label.toLowerCase()}`
      : chosen.length === 1
        ? chosen[0]!.label
        : `${filter.label}: ${chosen.length}`;

  function toggle(optionValue: string, checked: boolean) {
    const next = filter.options
      .map((option) => option.value)
      .filter((v) => (v === optionValue ? checked : selected.has(v)));
    onChange(next.length ? next.join(',') : undefined);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          className="w-44 justify-between font-normal"
          aria-label={filter.label}
        >
          <span className="truncate">{summary}</span>
          <ChevronDown className="opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {filter.options.map((option) => (
          <DropdownMenuCheckboxItem
            key={option.value}
            checked={selected.has(option.value)}
            onSelect={(event) => event.preventDefault()} // keep the menu open for more picks
            onCheckedChange={(checked) => toggle(option.value, checked === true)}
          >
            {option.label}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Params that are view state, not filters (Clear keeps them). */
const NOT_FILTERS = new Set(['page', 'pageSize', 'sort', 'dir']);

/**
 * Search box and filters that write to the URL, so views are shareable and survive refresh
 * (UI guide §4.1). The page resets to 1 on change; Clear removes every filter. `children`
 * holds extra filters (date ranges) on the same bar.
 */
export function FilterBar({
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
            className="w-full sm:w-64"
          />
        </form>
      )}
      {filters.map((filter) =>
        filter.multi ? (
          <MultiFilter
            key={filter.param}
            filter={filter}
            value={searchParams.get(filter.param)}
            onChange={(value) => update(filter.param, value)}
          />
        ) : (
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
        ),
      )}
      {children}
      {[...searchParams.keys()].some((key) => !NOT_FILTERS.has(key)) && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            const params = new URLSearchParams();
            for (const key of NOT_FILTERS) {
              const value = searchParams.get(key);
              if (value && key !== 'page') params.set(key, value);
            }
            const query = params.toString();
            router.push(query ? `${pathname}?${query}` : pathname);
          }}
        >
          Clear
        </Button>
      )}
    </div>
  );
}
