'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { pageWindow } from '@/lib/pagination';

const PAGE_SIZES = ['25', '50', '100'];

/** "Showing 1–25 of 312", page size, and ‹ 1 2 3 … › (UI guide §4.1). */
export function Pagination({
  total,
  page,
  pageSize,
  onNavigate,
}: {
  total: number;
  page: number;
  pageSize: number;
  onNavigate: (changes: Record<string, string | undefined>) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const first = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, total);
  const go = (p: number) => onNavigate({ page: p === 1 ? undefined : String(p) });

  return (
    <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-muted-foreground num text-[13px]">
        Showing {first}–{last} of {total}
      </span>
      <div className="flex items-center gap-2">
        <Select
          value={String(pageSize)}
          onValueChange={(size) =>
            onNavigate({ pageSize: size === '25' ? undefined : size, page: undefined })
          }
        >
          <SelectTrigger size="sm" className="w-20" aria-label="Rows per page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PAGE_SIZES.map((size) => (
              <SelectItem key={size} value={size}>
                {size}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => go(page - 1)}
        >
          <ChevronLeft aria-hidden />
        </Button>
        {pageWindow(page, pages).map((p, i) =>
          p === 'gap' ? (
            <span key={`gap-${i}`} className="text-muted-foreground px-1" aria-hidden>
              …
            </span>
          ) : (
            <Button
              key={p}
              variant={p === page ? 'secondary' : 'ghost'}
              size="sm"
              className="num min-w-8"
              aria-label={`Page ${p}`}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => go(p)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          variant="outline"
          size="icon"
          className="size-8"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => go(page + 1)}
        >
          <ChevronRight aria-hidden />
        </Button>
      </div>
    </nav>
  );
}
