'use client';

import {
  REPORT_PRESET_LABELS,
  REPORT_PRESETS,
  type ReportPreset,
} from '@sales-tracker/core/schemas';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { DateRangeFilter } from '@/components/data/DateRangeFilter';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const EVERYONE = '__all__';

/**
 * Period, and for admins owner or manager (UI guide 4.4 header actions). Everything lives in
 * the URL, so a view can be shared and survives a refresh. One row above every panel.
 */
export function DashboardControls({
  preset,
  owners,
  managers,
  ownerId,
  managerId,
}: {
  preset: ReportPreset;
  /** Admins only. */
  owners: { id: string; name: string }[] | null;
  managers: { id: string; name: string }[] | null;
  ownerId: string | null;
  managerId: string | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function set(changes: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
        Period
        <Select
          value={preset}
          onValueChange={(value) =>
            set(value === 'custom' ? { preset: value } : { preset: value, from: null, to: null })
          }
        >
          <SelectTrigger className="w-[170px]" aria-label="Period">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {REPORT_PRESETS.map((p) => (
              <SelectItem key={p} value={p}>
                {REPORT_PRESET_LABELS[p]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {preset === 'custom' && <DateRangeFilter />}
      {owners && (
        <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
          Owner
          <Select
            value={ownerId ?? EVERYONE}
            onValueChange={(value) =>
              set({ ownerId: value === EVERYONE ? null : value, managerId: null, dimension: null })
            }
          >
            <SelectTrigger className="w-[170px]" aria-label="Owner">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERYONE}>All owners</SelectItem>
              {owners.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      {managers && (
        <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
          Projects of
          <Select
            value={managerId ?? EVERYONE}
            onValueChange={(value) =>
              set({ managerId: value === EVERYONE ? null : value, ownerId: null, dimension: null })
            }
          >
            <SelectTrigger className="w-[170px]" aria-label="Project manager">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={EVERYONE}>Company view</SelectItem>
              {managers.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
    </div>
  );
}
