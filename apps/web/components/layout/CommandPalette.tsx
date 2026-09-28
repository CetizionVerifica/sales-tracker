'use client';

import type { SearchResult } from '@sales-tracker/core';
import {
  Briefcase,
  Building2,
  CornerDownLeft,
  FileCheck,
  FileText,
  Inbox,
  Loader2,
} from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { searchRecordsAction } from './actions';
import type { NavGroup } from './nav';
import { OPEN_PALETTE_EVENT } from './TopBar';

export interface PaletteAction {
  label: string;
  href: string;
}

const RECORD_HREF: Record<SearchResult['type'], (id: string) => string> = {
  ENQUIRY: (id) => `/enquiries/${id}`,
  QUOTATION: (id) => `/quotations/${id}`,
  PROJECT: (id) => `/projects/${id}`,
  PURCHASE_ORDER: (id) => `/purchase-orders/${id}`,
  CLIENT: (id) => `/clients/${id}`,
};

const RECORD_ICON = {
  ENQUIRY: Inbox,
  QUOTATION: FileText,
  PROJECT: Briefcase,
  PURCHASE_ORDER: FileCheck,
  CLIENT: Building2,
};
const RECORD_GROUP = {
  ENQUIRY: 'Enquiries',
  QUOTATION: 'Quotations',
  PROJECT: 'Projects',
  PURCHASE_ORDER: 'Purchase orders',
  CLIENT: 'Clients',
};

/** Result groups in pipeline order, clients last. */
const RECORD_ORDER = ['ENQUIRY', 'QUOTATION', 'PROJECT', 'PURCHASE_ORDER', 'CLIENT'] as const;

const DEBOUNCE_MS = 200;

/**
 * ⌘K / Ctrl+K (UI guide §3): jump to any record the user can read by number or client
 * name, open a page, or run an action ("New enquiry"). Search runs on the server through
 * core's searchRecords, so results follow the same RBAC as the lists.
 */
export function CommandPalette({
  groups,
  actions,
}: {
  groups: NavGroup[];
  actions: PaletteAction[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_PALETTE_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_PALETTE_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    const request = ++latest.current;
    setLoading(true);
    const timer = setTimeout(async () => {
      const result = await searchRecordsAction({ q });
      if (request !== latest.current) return; // a newer query is on its way
      setResults(result.ok ? result.data : []);
      setLoading(false);
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const needle = query.trim().toLowerCase();
  const pages = useMemo(
    () =>
      groups.flatMap((group) => group.items).filter((i) => i.label.toLowerCase().includes(needle)),
    [groups, needle],
  );
  const matchingActions = actions.filter((a) => a.label.toLowerCase().includes(needle));
  const byType = (type: SearchResult['type']) => results.filter((r) => r.type === type);

  function go(href: string) {
    setOpen(false);
    setQuery('');
    router.push(href);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="overflow-hidden p-0" showCloseButton={false}>
        <DialogHeader className="sr-only">
          <DialogTitle>Search</DialogTitle>
          <DialogDescription>Jump to a record or page, or run an action.</DialogDescription>
        </DialogHeader>
        <Command shouldFilter={false} className="[&_[cmdk-group-heading]]:text-muted-foreground">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search by number or client, or type a page or action…"
            aria-label="Search"
          />
          <CommandList className="max-h-[60vh]">
            {loading && (
              <div className="text-muted-foreground flex items-center gap-2 px-4 py-3 text-[13px]">
                <Loader2 className="size-4 animate-spin" aria-hidden />
                Searching…
              </div>
            )}
            {!loading && (
              <CommandEmpty>
                {needle.length < 2
                  ? 'Type at least two characters to search records.'
                  : 'No matches.'}
              </CommandEmpty>
            )}
            {RECORD_ORDER.map((type) => {
              const items = byType(type);
              if (items.length === 0) return null;
              const Icon = RECORD_ICON[type];
              return (
                <CommandGroup key={type} heading={RECORD_GROUP[type]}>
                  {items.map((item) => (
                    <CommandItem
                      key={`${type}:${item.id}`}
                      value={`${type}:${item.id}`}
                      onSelect={() => go(RECORD_HREF[type](item.id))}
                    >
                      <Icon aria-hidden />
                      <span className="font-medium">{item.label}</span>
                      <span className="text-muted-foreground truncate">{item.detail}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              );
            })}
            {matchingActions.length > 0 && (
              <CommandGroup heading="Actions">
                {matchingActions.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`action:${item.href}`}
                    onSelect={() => go(item.href)}
                  >
                    <CornerDownLeft aria-hidden />
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {pages.length > 0 && (
              <CommandGroup heading="Pages">
                {pages.map((item) => (
                  <CommandItem
                    key={item.href}
                    value={`page:${item.href}`}
                    onSelect={() => go(item.href)}
                  >
                    {item.label}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
