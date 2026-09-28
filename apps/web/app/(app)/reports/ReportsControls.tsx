'use client';

import {
  REPORT_GRANULARITIES,
  REPORT_PRESET_LABELS,
  REPORT_PRESETS,
  type ReportGranularity,
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
const AUTO = '__auto__';
const GRANULARITY_LABELS: Record<ReportGranularity, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
};

/**
 * Period, granularity, owner, sector and service (M12b filter bar). Everything lives in the
 * URL, so a view can be shared and survives a refresh. Sector/service narrow every report that
 * has that dimension: for R3 (grouped by sector) or R4 (grouped by service), the matching
 * filter degenerates to a single bar, which is expected, not a bug.
 */
export function ReportsControls({
  preset,
  granularity,
  owners,
  ownerId,
  sectors,
  sectorId,
  services,
  serviceId,
}: {
  preset: ReportPreset;
  granularity: ReportGranularity | null;
  /** Admins only. */
  owners: { id: string; name: string }[] | null;
  ownerId: string | null;
  sectors: { id: string; name: string }[];
  sectorId: string | null;
  services: { id: string; name: string }[];
  serviceId: string | null;
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
      <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
        Granularity
        <Select
          value={granularity ?? AUTO}
          onValueChange={(value) => set({ granularity: value === AUTO ? null : value })}
        >
          <SelectTrigger className="w-[130px]" aria-label="Granularity">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={AUTO}>Auto</SelectItem>
            {REPORT_GRANULARITIES.map((g) => (
              <SelectItem key={g} value={g}>
                {GRANULARITY_LABELS[g]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {owners && (
        <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
          Owner
          <Select
            value={ownerId ?? EVERYONE}
            onValueChange={(value) => set({ ownerId: value === EVERYONE ? null : value })}
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
      <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
        Sector
        <Select
          value={sectorId ?? EVERYONE}
          onValueChange={(value) => set({ sectorId: value === EVERYONE ? null : value })}
        >
          <SelectTrigger className="w-[150px]" aria-label="Sector">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERYONE}>All sectors</SelectItem>
            {sectors.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      <label className="text-muted-foreground flex items-center gap-2 text-[13px]">
        Service
        <Select
          value={serviceId ?? EVERYONE}
          onValueChange={(value) => set({ serviceId: value === EVERYONE ? null : value })}
        >
          <SelectTrigger className="w-[150px]" aria-label="Service">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={EVERYONE}>All services</SelectItem>
            {services.map((s) => (
              <SelectItem key={s.id} value={s.id}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
    </div>
  );
}
