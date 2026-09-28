'use client';

import { ChevronsUpDown, Loader2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { searchPoProjectsAction } from '../actions';

type ProjectOption = { id: string; number: string; name: string; client: string };

const DEBOUNCE_MS = 200;

/**
 * The first field of a new PO opened without a project: live, non-cancelled projects the
 * user can read, searched on the server by number, name and client. Choosing one reloads
 * the page with that project's draft.
 */
export function ProjectPicker({ current }: { current?: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<ProjectOption[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    if (!open) return;
    const request = ++latest.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const result = await searchPoProjectsAction({ q: query });
      if (request !== latest.current) return; // a newer query is on its way
      setOptions(result.ok ? result.data : []);
      setLoading(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [open, query]);

  return (
    <div className="flex flex-col gap-2">
      <span id="po-project-label" className="text-sm font-medium">
        Project
      </span>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby="po-project-label"
            className="w-full justify-between font-normal sm:w-96"
          >
            <span className="truncate">{current ?? 'Choose a project'}</span>
            <ChevronsUpDown className="text-muted-foreground" aria-hidden />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[var(--radix-popover-trigger-width)] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              value={query}
              onValueChange={setQuery}
              placeholder="Search number, name or client…"
              aria-label="Search projects"
            />
            <CommandList>
              {loading && (
                <div className="text-muted-foreground flex items-center gap-2 px-3 py-2 text-[13px]">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  Searching…
                </div>
              )}
              {!loading && <CommandEmpty>No projects that take POs match.</CommandEmpty>}
              {options.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.id}
                  onSelect={() => {
                    setOpen(false);
                    router.push(`/purchase-orders/new?projectId=${option.id}`);
                  }}
                >
                  <span className="font-medium">{option.number}</span>
                  <span className="truncate">{option.name}</span>
                  <span className="text-muted-foreground ml-auto truncate text-[13px]">
                    {option.client}
                  </span>
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <p className="text-muted-foreground text-[13px]">
        A PO is recorded on its project. Cancelled projects take no new POs.
      </p>
    </div>
  );
}
