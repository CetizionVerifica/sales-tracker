'use client';

import { formatInrShort, formatMoney } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AXIS, BAR, ChartFrame, GRID, TooltipCard } from './chart-kit';

/*
 * The dashboard's charts (M12, UI guide 4.4). Money arrives as paise strings (a bigint
 * cannot cross to the client). One measure per chart, one axis; the funnel uses the
 * pipeline ramp, everything else --chart-1 / --chart-2 (a validated pair).
 */

const inr = (paise: string) => formatMoney(BigInt(paise), 'INR');
const short = (paise: string) => formatInrShort(BigInt(paise));
/** Recharts wants numbers for scales; paise fit a double far past any company's totals. */
const num = (paise: string) => Number(paise) / 100;
const pct = (rate: number | null) => (rate === null ? '—' : `${Math.round(rate * 100)}%`);

const RADIUS_UP = [...BAR.radiusVertical] as [number, number, number, number];
const RADIUS_RIGHT = [...BAR.radiusHorizontal] as [number, number, number, number];

/** A bar's click: Recharts passes the bar item, with the datum on `payload`. */
function useOpen() {
  const router = useRouter();
  return (entry: unknown) => {
    const item = entry as { href?: string | null; payload?: { href?: string | null } };
    const href = item.payload?.href ?? item.href;
    if (href) router.push(href);
  };
}

// ─── Funnel ─────────────────────────────────────────────────────────────────────────

export interface FunnelDatum {
  stage: string;
  label: string;
  count: number;
  conversion: number | null;
  value: string | null;
  color: string;
  href: string | null;
}

export function FunnelChart({ data }: { data: FunnelDatum[] }) {
  const open = useOpen();
  return (
    <ChartFrame
      title="Pipeline funnel: enquiries received in the period, by the furthest stage reached"
      columns={[
        { label: 'Stage' },
        { label: 'Enquiries', numeric: true },
        { label: 'From previous', numeric: true },
        { label: 'Value', numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.stage,
        href: d.href,
        cells: [d.label, d.count, pct(d.conversion), d.value ? inr(d.value) : '—'],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 48 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis type="number" allowDecimals={false} {...AXIS} />
            <YAxis type="category" dataKey="label" width={104} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as FunnelDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'enquiries', value: String(d.count) },
                      ...(d.conversion === null
                        ? []
                        : [{ label: 'of the previous stage', value: pct(d.conversion) }]),
                      ...(d.value ? [{ label: 'value', value: inr(d.value) }] : []),
                    ]}
                  />
                );
              }}
            />
            <Bar dataKey="count" maxBarSize={BAR.maxBarSize} radius={RADIUS_RIGHT} onClick={open}>
              {data.map((d) => (
                <Cell key={d.stage} fill={d.color} cursor={d.href ? 'pointer' : 'default'} />
              ))}
              <LabelList dataKey="count" position="right" fill="var(--foreground)" fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── Receivables ageing ────────────────────────────────────────────────────────────

export interface AgeingDatum {
  bucket: string;
  label: string;
  /** The axis tick: full labels collide at one-third width. */
  short: string;
  count: number;
  value: string;
  href: string | null;
}

export function AgeingChart({ data }: { data: AgeingDatum[] }) {
  const open = useOpen();
  const rows = data.map((d) => ({ ...d, amount: num(d.value) }));
  return (
    <ChartFrame
      title="Receivables by days past due, as of today"
      columns={[
        { label: 'Days past due' },
        { label: 'Invoices', numeric: true },
        { label: 'Outstanding', numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.bucket,
        href: d.href,
        cells: [d.label, d.count, inr(d.value)],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} margin={{ top: 20, left: 0, right: 8 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="short" {...AXIS} interval={0} />
            <YAxis
              {...AXIS}
              width={56}
              tickFormatter={(v: number) => short(String(Math.round(v * 100)))}
            />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as AgeingDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'outstanding', value: inr(d.value) },
                      { label: d.count === 1 ? 'invoice' : 'invoices', value: String(d.count) },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="amount"
              fill="var(--chart-1)"
              maxBarSize={BAR.maxBarSize}
              radius={RADIUS_UP}
              cursor="pointer"
              onClick={open}
            >
              <LabelList
                dataKey="value"
                position="top"
                fill="var(--muted-foreground)"
                fontSize={11}
                formatter={(v: unknown) => (typeof v === 'string' && v !== '0' ? short(v) : '')}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── Conversion by dimension ────────────────────────────────────────────────────────

export interface ConversionDatum {
  key: string;
  label: string;
  won: number;
  lost: number;
  rate: number | null;
  href: string | null;
}

export function ConversionChart({
  data,
  dimension,
}: {
  data: ConversionDatum[];
  dimension: string;
}) {
  const open = useOpen();
  const rows = data.map((d) => ({ ...d, percent: d.rate === null ? 0 : Math.round(d.rate * 100) }));
  const height = Math.max(160, rows.length * 36 + 40);
  return (
    <ChartFrame
      title={`Win rate by ${dimension} on quotations decided in the period`}
      height={height}
      columns={[
        { label: dimension[0]!.toUpperCase() + dimension.slice(1) },
        { label: 'Won', numeric: true },
        { label: 'Lost', numeric: true },
        { label: 'Win rate', numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.key,
        href: d.href,
        cells: [d.label, d.won, d.lost, pct(d.rate)],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 132 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis
              type="number"
              domain={[0, 100]}
              {...AXIS}
              tickFormatter={(v: number) => `${v}%`}
            />
            <YAxis type="category" dataKey="label" width={120} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as ConversionDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'win rate', value: pct(d.rate) },
                      { label: 'won', value: String(d.won) },
                      { label: 'lost', value: String(d.lost) },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="percent"
              fill="var(--chart-1)"
              maxBarSize={BAR.maxBarSize}
              radius={RADIUS_RIGHT}
              onClick={open}
              cursor="pointer"
            >
              <LabelList
                position="right"
                fill="var(--foreground)"
                fontSize={12}
                valueAccessor={(entry: { payload: ConversionDatum }) =>
                  `${pct(entry.payload.rate)} · ${entry.payload.won} won, ${entry.payload.lost} lost`
                }
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── Quoted vs won by month ─────────────────────────────────────────────────────────

export interface MonthDatum {
  month: string;
  label: string;
  quoted: string;
  won: string;
  lost: string;
  href: string | null;
}

const SERIES = [
  { key: 'quoted', label: 'Quoted', color: 'var(--chart-1)' },
  { key: 'won', label: 'Won', color: 'var(--chart-2)' },
] as const;

export function QuotedWonChart({ data }: { data: MonthDatum[] }) {
  const rows = data.map((d) => ({ ...d, quotedRupees: num(d.quoted), wonRupees: num(d.won) }));
  return (
    <div className="flex flex-col gap-2">
      <ul className="text-muted-foreground flex gap-4 text-[12px]" aria-label="Legend">
        {SERIES.map((s) => (
          <li key={s.key} className="flex items-center gap-1.5">
            <span aria-hidden className="size-2.5 rounded-[2px]" style={{ background: s.color }} />
            {s.label}
          </li>
        ))}
      </ul>
      <ChartFrame
        title="Quoted and won value by month"
        columns={[
          { label: 'Month' },
          { label: 'Quoted', numeric: true },
          { label: 'Won', numeric: true },
          { label: 'Lost', numeric: true },
        ]}
        rows={data.map((d) => ({
          key: d.month,
          href: d.href,
          cells: [d.label, inr(d.quoted), inr(d.won), inr(d.lost)],
        }))}
        chart={
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} barGap={2} margin={{ top: 8, left: 0, right: 8 }}>
              <CartesianGrid {...GRID} vertical={false} />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis
                {...AXIS}
                width={56}
                tickFormatter={(v: number) => short(String(Math.round(v * 100)))}
              />
              <Tooltip
                cursor={{ fill: 'var(--accent)' }}
                content={({ active, payload }) => {
                  const d = payload?.[0]?.payload as MonthDatum | undefined;
                  if (!active || !d) return null;
                  return (
                    <TooltipCard
                      title={d.label}
                      rows={[
                        { label: 'quoted', value: inr(d.quoted), color: SERIES[0].color },
                        { label: 'won', value: inr(d.won), color: SERIES[1].color },
                        ...(d.lost !== '0' ? [{ label: 'lost', value: inr(d.lost) }] : []),
                      ]}
                    />
                  );
                }}
              />
              <Bar
                dataKey="quotedRupees"
                name="Quoted"
                fill={SERIES[0].color}
                maxBarSize={16}
                radius={RADIUS_UP}
              />
              <Bar
                dataKey="wonRupees"
                name="Won"
                fill={SERIES[1].color}
                maxBarSize={16}
                radius={RADIUS_UP}
              />
            </BarChart>
          </ResponsiveContainer>
        }
      />
    </div>
  );
}

// ─── Projects by status (PM layout) ─────────────────────────────────────────────────

export interface StatusDatum {
  status: string;
  label: string;
  count: number;
  href: string;
}

export function StatusChart({ data }: { data: StatusDatum[] }) {
  const open = useOpen();
  return (
    <ChartFrame
      title="Projects by status"
      height={Math.max(140, data.length * 36 + 40)}
      columns={[{ label: 'Status' }, { label: 'Projects', numeric: true }]}
      rows={data.map((d) => ({ key: d.status, href: d.href, cells: [d.label, d.count] }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} layout="vertical" margin={{ left: 8, right: 40 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis type="number" allowDecimals={false} {...AXIS} />
            <YAxis type="category" dataKey="label" width={96} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as StatusDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[{ label: 'projects', value: String(d.count) }]}
                  />
                );
              }}
            />
            <Bar
              dataKey="count"
              fill="var(--chart-1)"
              maxBarSize={BAR.maxBarSize}
              radius={RADIUS_RIGHT}
              cursor="pointer"
              onClick={open}
            >
              <LabelList dataKey="count" position="right" fill="var(--foreground)" fontSize={12} />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}
