'use client';

import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
  type RowData,
  type VisibilityState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Columns3, Rows3 } from 'lucide-react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { EmptyState } from '../feedback/EmptyState';
import { Pagination } from './Pagination';

declare module '@tanstack/react-table' {
  // TanStack's documented way to type column meta; the type parameters are required.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Money and numbers: right-aligned, tabular (UI guide §5). */
    align?: 'right';
    /** Name in the column visibility menu (defaults to the header text). */
    label?: string;
    /** Cannot be hidden (the identifier and the row menu). */
    fixed?: boolean;
  }
}

type Density = 'comfortable' | 'compact';

/** Reads and writes a per-browser preference; storage can be unavailable (private mode). */
function usePreference<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initial);
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(key);
      if (stored !== null) setValue(JSON.parse(stored) as T);
    } catch {
      // keep the default
    }
  }, [key]);
  return [
    value,
    (next: T) => {
      setValue(next);
      try {
        window.localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // not persisted; fine
      }
    },
  ];
}

interface DataTableProps<T> {
  /** Names this table's saved column and density choices. */
  id: string;
  // TanStack column value types differ per column; `any` is its documented pattern here.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  columns: ColumnDef<T, any>[];
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  /** Column ids the server can sort by (matches the list schema's `sort` enum). */
  sortable?: string[];
  sort?: string;
  dir?: 'asc' | 'desc';
  getRowId: (row: T) => string;
  /** Where clicking a row goes (the identifier cell stays a real link for keyboards). */
  rowHref?: (row: T) => string | null;
  /** Below 768px lists become stacked cards (UI guide §8). */
  mobileCard?: (row: T) => ReactNode;
  /** Shown when there are no rows: one sentence and the action that fills the list. */
  empty?: ReactNode;
}

/**
 * The one table (UI guide §5): server-driven pagination and sorting in the URL, sticky
 * muted header, 44px rows with a compact 36px option, hover fill, right-aligned numbers,
 * a column menu remembered per browser, row click to the detail page, cards on mobile.
 */
export function DataTable<T>(props: DataTableProps<T>) {
  const { id, columns, data, total, page, pageSize, sortable = [], sort, dir, getRowId } = props;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [density, setDensity] = usePreference<Density>(`table:${id}:density`, 'comfortable');
  const [visibility, setVisibility] = usePreference<VisibilityState>(`table:${id}:columns`, {});

  const table = useReactTable({
    data,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    manualPagination: true,
    manualSorting: true,
    rowCount: total,
    state: { columnVisibility: visibility },
    onColumnVisibilityChange: (updater) =>
      setVisibility(typeof updater === 'function' ? updater(visibility) : updater),
  });

  function navigate(changes: Record<string, string | undefined>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  function toggleSort(columnId: string) {
    const nextDir = sort === columnId && dir !== 'desc' ? 'desc' : 'asc';
    navigate({ sort: columnId, dir: nextDir, page: undefined });
  }

  function openRow(event: MouseEvent, row: T) {
    const href = props.rowHref?.(row);
    // Links, buttons and menus inside the row keep their own behaviour.
    if (!href || (event.target as HTMLElement).closest('a,button,input,[role="menuitem"]')) {
      return;
    }
    router.push(href);
  }

  const rows = table.getRowModel().rows;
  const hideable = table.getAllLeafColumns().filter((c) => !c.columnDef.meta?.fixed);
  const empty = props.empty ?? <EmptyState message="Nothing to show." />;

  return (
    <div className="flex flex-col gap-3">
      {/* Below 768px the table becomes cards (UI guide §8): switched by CSS, not JS, so the
          server-rendered page never flashes the wide table on a phone. */}
      <div className={cn('justify-end gap-2', props.mobileCard ? 'hidden md:flex' : 'flex')}>
        <Button
          variant="outline"
          size="sm"
          aria-label={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
          title={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
          onClick={() => setDensity(density === 'compact' ? 'comfortable' : 'compact')}
        >
          <Rows3 aria-hidden />
          {density === 'compact' ? 'Comfortable' : 'Compact'}
        </Button>
        {hideable.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <Columns3 aria-hidden />
                Columns
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {hideable.map((column) => (
                <DropdownMenuCheckboxItem
                  key={column.id}
                  checked={column.getIsVisible()}
                  onSelect={(event) => event.preventDefault()}
                  onCheckedChange={(checked) => column.toggleVisibility(checked === true)}
                >
                  {column.columnDef.meta?.label ??
                    (typeof column.columnDef.header === 'string'
                      ? column.columnDef.header
                      : column.id)}
                </DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {/* One empty state for both layouts, so it is never rendered twice. */}
      {rows.length === 0 && <div className="bg-card rounded-[var(--radius)] border">{empty}</div>}

      {props.mobileCard && rows.length > 0 && (
        <ul className="flex flex-col gap-2 md:hidden">
          {rows.map((row) => (
            <li
              key={row.id}
              className="bg-card hover:bg-accent cursor-pointer rounded-[var(--radius)] border p-3"
              onClick={(event) => openRow(event, row.original)}
            >
              {props.mobileCard!(row.original)}
            </li>
          ))}
        </ul>
      )}
      {rows.length > 0 && (
        // `relative` makes this the containing block for absolutely positioned cell content
        // (the `sr-only` labels): otherwise they escape the scroll box and widen the page.
        <div
          className={cn(
            'bg-card relative max-h-[70vh] overflow-auto rounded-[var(--radius)] border',
            props.mobileCard && 'hidden md:block',
          )}
        >
          <table className="w-full caption-bottom">
            <thead className="bg-muted sticky top-0 z-10">
              {table.getHeaderGroups().map((group) => (
                <tr key={group.id} className="border-b">
                  {group.headers.map((header) => {
                    const canSort = sortable.includes(header.column.id);
                    const active = sort === header.column.id;
                    const label = flexRender(header.column.columnDef.header, header.getContext());
                    const Icon = !active ? ArrowUpDown : dir === 'desc' ? ArrowDown : ArrowUp;
                    const right = header.column.columnDef.meta?.align === 'right';
                    return (
                      <th
                        key={header.id}
                        scope="col"
                        aria-sort={
                          active ? (dir === 'desc' ? 'descending' : 'ascending') : undefined
                        }
                        className={cn(
                          'h-10 px-3 text-left text-[13px] font-medium whitespace-nowrap',
                          right && 'text-right',
                        )}
                      >
                        {canSort ? (
                          <button
                            type="button"
                            className={cn(
                              'group inline-flex items-center gap-1',
                              right && 'flex-row-reverse',
                            )}
                            onClick={() => toggleSort(header.column.id)}
                          >
                            {label}
                            <Icon
                              className={cn(
                                'size-3.5',
                                active ? 'opacity-100' : 'opacity-0 group-hover:opacity-60',
                              )}
                              aria-hidden
                            />
                          </button>
                        ) : (
                          label
                        )}
                      </th>
                    );
                  })}
                </tr>
              ))}
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={cn(
                    'hover:bg-accent border-b last:border-0',
                    props.rowHref?.(row.original) && 'cursor-pointer',
                  )}
                  onClick={(event) => openRow(event, row.original)}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td
                      key={cell.id}
                      className={cn(
                        'px-3 align-middle',
                        density === 'compact' ? 'h-9' : 'h-11',
                        cell.column.columnDef.meta?.align === 'right' && 'num text-right',
                      )}
                    >
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Pagination total={total} page={page} pageSize={pageSize} onNavigate={navigate} />
    </div>
  );
}
