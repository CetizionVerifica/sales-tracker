'use client';

import { Download, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

/** A panel's ⓘ definition (the M12 metric definition) and its CSV export. */
export function PanelActions({
  title,
  definition,
  exportHref,
}: {
  title: string;
  definition: string;
  exportHref?: string;
}) {
  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button
            size="icon"
            variant="ghost"
            className="size-8"
            aria-label={`How ${title} is counted`}
          >
            <Info className="size-4" strokeWidth={1.75} aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 text-[13px]">{definition}</PopoverContent>
      </Popover>
      {exportHref && (
        <Button asChild size="sm" variant="ghost">
          <a href={exportHref} download aria-label={`Export ${title} as CSV`}>
            <Download className="size-4" strokeWidth={1.75} aria-hidden />
            CSV
          </a>
        </Button>
      )}
    </>
  );
}

/** An ⓘ next to a KPI label. */
export function InfoTip({ label, definition }: { label: string; definition: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground rounded-full"
          aria-label={`How ${label.toLowerCase()} is counted`}
        >
          <Info className="size-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-72 text-[13px]">{definition}</PopoverContent>
    </Popover>
  );
}
