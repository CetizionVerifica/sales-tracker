'use client';

import { formatInrShort, formatMoney } from '@sales-tracker/core/schemas';
import { useRouter } from 'next/navigation';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ComposedChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { AXIS, BAR, ChartFrame, GRID, TooltipCard } from '../dashboard/chart-kit';

/*
 * The Reports page's charts (M12b, UI guide 4.4). Money arrives as paise strings (a bigint
 * cannot cross to the client). Chart colours follow the M12b chart rules: R1 --chart-1 with a
 * faint --chart-4 previous-period line; R2 --success/--neutral/--destructive; R3/R4
 * --chart-1 with "Other…" in --neutral; R5 --chart-1/--chart-2; R6 --chart-1 columns +
 * --chart-2 line.
 */

const inr = (paise: string) => formatMoney(BigInt(paise), 'INR');
const short = (paise: string) => formatInrShort(BigInt(paise));
const num = (paise: string) => Number(paise) / 100;

const RADIUS_UP = [...BAR.radiusVertical] as [number, number, number, number];
const RADIUS_RIGHT = [...BAR.radiusHorizontal] as [number, number, number, number];

function useOpen() {
  const router = useRouter();
  return (href: string | null | undefined) => {
    if (href) router.push(href);
  };
}

// ─── R1: enquiries received ─────────────────────────────────────────────────────────

export interface EnquiryVolumeDatum {
  bucket: string;
  label: string;
  count: number;
  href: string | null;
}

export function EnquiryVolumeChart({ data }: { data: EnquiryVolumeDatum[] }) {
  const open = useOpen();
  return (
    <ChartFrame
      title="Enquiries received over time"
      columns={[{ label: 'Period' }, { label: 'Enquiries', numeric: true }]}
      rows={data.map((d) => ({ key: d.bucket, href: d.href, cells: [d.label, d.count] }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis allowDecimals={false} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as EnquiryVolumeDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[{ label: 'enquiries', value: String(d.count) }]}
                  />
                );
              }}
            />
            <Bar
              dataKey="count"
              fill="var(--chart-1)"
              radius={RADIUS_UP}
              maxBarSize={BAR.maxBarSize}
              onClick={(entry) => open((entry as unknown as EnquiryVolumeDatum).href)}
              cursor="pointer"
            />
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── R2: enquiry status ─────────────────────────────────────────────────────────────

export interface EnquiryStatusDatum {
  bucket: string;
  label: string;
  count: number;
  pct: number;
  color: string;
  href: string | null;
}

export function EnquiryStatusBar({ data }: { data: EnquiryStatusDatum[] }) {
  const open = useOpen();
  return (
    <ChartFrame
      title="Enquiry status: share converted, lost and still under pipeline"
      height={132}
      columns={[
        { label: 'Status' },
        { label: 'Count', numeric: true },
        { label: 'Share', numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.bucket,
        href: d.href,
        cells: [d.label, d.count, `${d.pct}%`],
      }))}
      chart={
        <div className="flex flex-col gap-3">
          <div className="flex h-6 w-full overflow-hidden rounded-[var(--radius-control)]">
            {data.map((d) => (
              <button
                key={d.bucket}
                type="button"
                aria-label={`${d.label}: ${d.count} enquiries, ${d.pct}% of the period${d.href ? ' — open the filtered list' : ''}`}
                title={`${d.label}: ${d.count} (${d.pct}%)`}
                style={{ width: `${Math.max(d.pct, d.pct > 0 ? 2 : 0)}%`, background: d.color }}
                className="h-full first:rounded-l-[var(--radius-control)] last:rounded-r-[var(--radius-control)]"
                onClick={() => open(d.href)}
              />
            ))}
          </div>
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[13px]">
            {data.map((d) => (
              <li key={d.bucket} className="flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: d.color }}
                />
                {d.label}: <span className="num font-medium">{d.count}</span> ({d.pct}%)
              </li>
            ))}
          </ul>
        </div>
      }
    />
  );
}

// ─── R3 / R4: horizontal ranked bars (sectors, services) ────────────────────────────

export interface RankedBarDatum {
  key: string;
  label: string;
  valueMinor: string;
  count: number;
  sharePct: number;
  isOther: boolean;
  href: string | null;
}

export function RankedBarChart({
  data,
  title,
  countLabel,
}: {
  data: RankedBarDatum[];
  title: string;
  countLabel: string;
}) {
  const open = useOpen();
  const chartData = data.map((d) => ({ ...d, value: num(d.valueMinor) }));
  return (
    <ChartFrame
      title={title}
      columns={[
        { label: 'Name' },
        { label: 'Value', numeric: true },
        { label: countLabel, numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.key,
        href: d.href,
        cells: [d.label, inr(d.valueMinor), d.count],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} layout="vertical" margin={{ left: 8, right: 56 }}>
            <CartesianGrid {...GRID} horizontal={false} />
            <XAxis
              type="number"
              tickFormatter={(v: number) => short(String(Math.round(v * 100)))}
              {...AXIS}
            />
            <YAxis type="category" dataKey="label" width={110} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as (RankedBarDatum & { value: number }) | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'value', value: inr(d.valueMinor) },
                      { label: countLabel.toLowerCase(), value: String(d.count) },
                      { label: 'share', value: `${d.sharePct}%` },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="value"
              radius={RADIUS_RIGHT}
              maxBarSize={BAR.maxBarSize}
              onClick={(entry) => open((entry as unknown as RankedBarDatum).href)}
              cursor="pointer"
            >
              {chartData.map((d) => (
                <Cell key={d.key} fill={d.isOther ? 'var(--neutral)' : 'var(--chart-1)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── R5: new vs repeat customers, by month ──────────────────────────────────────────

export interface CustomerMixDatum {
  month: string;
  label: string;
  firstOrders: number;
  repeatOrders: number;
  repeatValueMinor: string;
  href: string | null;
}

export function CustomerMixChart({ data }: { data: CustomerMixDatum[] }) {
  const open = useOpen();
  return (
    <ChartFrame
      title="New vs repeat orders by month"
      columns={[
        { label: 'Month' },
        { label: 'First orders', numeric: true },
        { label: 'Repeat orders', numeric: true },
        { label: 'Repeat value', numeric: true },
      ]}
      rows={data.map((d) => ({
        key: d.month,
        href: d.href,
        cells: [d.label, d.firstOrders, d.repeatOrders, inr(d.repeatValueMinor)],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis allowDecimals={false} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as CustomerMixDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      {
                        label: 'first orders',
                        value: String(d.firstOrders),
                        color: 'var(--chart-1)',
                      },
                      {
                        label: 'repeat orders',
                        value: String(d.repeatOrders),
                        color: 'var(--chart-2)',
                      },
                      { label: 'repeat value', value: inr(d.repeatValueMinor) },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey="firstOrders"
              stackId="orders"
              fill="var(--chart-1)"
              maxBarSize={BAR.maxBarSize}
              onClick={(entry) => open((entry as unknown as CustomerMixDatum).href)}
              cursor="pointer"
            />
            <Bar
              dataKey="repeatOrders"
              stackId="orders"
              fill="var(--chart-2)"
              radius={RADIUS_UP}
              maxBarSize={BAR.maxBarSize}
              onClick={(entry) => open((entry as unknown as CustomerMixDatum).href)}
              cursor="pointer"
            />
          </BarChart>
        </ResponsiveContainer>
      }
    />
  );
}

// ─── R6: monthly revenue (invoiced columns + collected line) ───────────────────────

export interface RevenueDatum {
  month: string;
  label: string;
  invoicedMinor: string;
  collectedMinor: string;
  href: string | null;
}

export function RevenueChart({ data }: { data: RevenueDatum[] }) {
  const open = useOpen();
  const chartData = [...data].reverse(); // the DTO is newest-first; charts read chronologically
  return (
    <ChartFrame
      title="Monthly revenue: invoiced and collected"
      columns={[
        { label: 'Month' },
        { label: 'Invoiced', numeric: true },
        { label: 'Collected', numeric: true },
      ]}
      rows={chartData.map((d) => ({
        key: d.month,
        href: d.href,
        cells: [d.label, inr(d.invoicedMinor), inr(d.collectedMinor)],
      }))}
      chart={
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 8 }}>
            <CartesianGrid {...GRID} vertical={false} />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis tickFormatter={(v: number) => short(String(Math.round(v * 100)))} {...AXIS} />
            <Tooltip
              cursor={{ fill: 'var(--accent)' }}
              content={({ active, payload }) => {
                const d = payload?.[0]?.payload as RevenueDatum | undefined;
                if (!active || !d) return null;
                return (
                  <TooltipCard
                    title={d.label}
                    rows={[
                      { label: 'invoiced', value: inr(d.invoicedMinor), color: 'var(--chart-1)' },
                      { label: 'collected', value: inr(d.collectedMinor), color: 'var(--chart-2)' },
                    ]}
                  />
                );
              }}
            />
            <Bar
              dataKey={(d: RevenueDatum) => num(d.invoicedMinor)}
              name="Invoiced"
              fill="var(--chart-1)"
              radius={RADIUS_UP}
              maxBarSize={BAR.maxBarSize}
              onClick={(entry) => open((entry as unknown as RevenueDatum).href)}
              cursor="pointer"
            />
            <Line
              type="monotone"
              dataKey={(d: RevenueDatum) => num(d.collectedMinor)}
              name="Collected"
              stroke="var(--chart-2)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      }
    />
  );
}
