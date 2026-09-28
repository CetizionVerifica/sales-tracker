import { z } from 'zod';
import { calendarDateSchema } from './common.ts';

/*
 * Report periods (M12, shared with M12b). Quarters and years follow the Indian financial
 * year, April–March (M12 Decision 3): Q1 Apr–Jun, Q2 Jul–Sep, Q3 Oct–Dec, Q4 Jan–Mar.
 * Every date is a calendar day at UTC midnight, the IST day it stands for.
 */

export const REPORT_PRESETS = [
  'thisMonth',
  'lastMonth',
  'thisQuarter',
  'lastQuarter',
  'thisFinancialYear',
  'lastFinancialYear',
  'custom',
] as const;

export type ReportPreset = (typeof REPORT_PRESETS)[number];

export const REPORT_PRESET_LABELS: Record<ReportPreset, string> = {
  thisMonth: 'This month',
  lastMonth: 'Last month',
  thisQuarter: 'This quarter',
  lastQuarter: 'Last quarter',
  thisFinancialYear: 'This financial year',
  lastFinancialYear: 'Last financial year',
  custom: 'Custom',
};

const DAY_MS = 86_400_000;
/** A custom range may span at most three years (1,096 days covers a leap year). */
const MAX_CUSTOM_DAYS = 1_096;

/** The period fields, for schemas that add their own (the dashboard, M12b's reports). */
export const reportPeriodShape = {
  preset: z.enum(REPORT_PRESETS).default('thisQuarter'),
  from: calendarDateSchema.optional(),
  to: calendarDateSchema.optional(),
};

/** The period rules, for `.superRefine` on any schema built from `reportPeriodShape`. */
export function refinePeriod(
  value: { preset: ReportPreset; from?: Date | undefined; to?: Date | undefined },
  context: z.RefinementCtx,
): void {
  if (value.preset !== 'custom') return;
  if (!value.from) {
    context.addIssue({ code: 'custom', path: ['from'], message: 'Choose a start date' });
  }
  if (!value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'Choose an end date' });
  if (!value.from || !value.to) return;
  if (value.from > value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'End on or after the start' });
  } else if ((value.to.getTime() - value.from.getTime()) / DAY_MS + 1 > MAX_CUSTOM_DAYS) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'Choose at most three years' });
  }
}

export const reportPeriodSchema = z.object(reportPeriodShape).superRefine(refinePeriod);

export type ReportPeriodInput = z.input<typeof reportPeriodSchema>;

type Unit = 'month' | 'quarter' | 'year' | 'custom';

export interface ReportPeriod {
  preset: ReportPreset;
  from: Date;
  to: Date;
  label: string;
  /** What "previous period" means for it (Decision: presets step by their unit). */
  unit: Unit;
}

const utc = (year: number, month: number, day = 1) => new Date(Date.UTC(year, month, day));
const addMonths = (date: Date, months: number) =>
  utc(date.getUTCFullYear(), date.getUTCMonth() + months);
const lastDayOf = (monthStart: Date, months: number) =>
  new Date(addMonths(monthStart, months).getTime() - DAY_MS);

/** The first month of the financial year a date falls in (April). */
const fyStart = (date: Date) =>
  utc(date.getUTCMonth() >= 3 ? date.getUTCFullYear() : date.getUTCFullYear() - 1, 3);

/** The first month of the financial-year quarter a date falls in. */
function quarterStart(date: Date): Date {
  const start = fyStart(date);
  const monthsIntoFy =
    (date.getUTCFullYear() - start.getUTCFullYear()) * 12 + date.getUTCMonth() - 3;
  return addMonths(start, Math.floor(monthsIntoFy / 3) * 3);
}

/** `FY 2026–27` for any day from 1 April 2026 to 31 March 2027. */
export function fyLabel(date: Date): string {
  const year = fyStart(date).getUTCFullYear();
  return `FY ${year}–${String((year + 1) % 100).padStart(2, '0')}`;
}

function quarterLabel(start: Date): string {
  const quarter = Math.floor(((start.getUTCMonth() - 3 + 12) % 12) / 3) + 1;
  return `Q${quarter} ${fyLabel(start)}`;
}

const monthLabel = (start: Date) =>
  new Intl.DateTimeFormat('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    start,
  );

function rangeLabel(from: Date, to: Date): string {
  const dayMonth = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  });
  const full = new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
  const sameYear = from.getUTCFullYear() === to.getUTCFullYear();
  return `${sameYear ? dayMonth.format(from) : full.format(from)} – ${full.format(to)}`;
}

function unitPeriod(
  preset: ReportPreset,
  unit: Exclude<Unit, 'custom'>,
  start: Date,
): ReportPeriod {
  const months = unit === 'month' ? 1 : unit === 'quarter' ? 3 : 12;
  const label =
    unit === 'month'
      ? monthLabel(start)
      : unit === 'quarter'
        ? quarterLabel(start)
        : fyLabel(start);
  return { preset, from: start, to: lastDayOf(start, months), label, unit };
}

/** The UTC instant an IST calendar day starts (for timestamps such as `statusChangedAt`). */
export const istStartOf = (day: Date) => new Date(day.getTime() - 5.5 * 60 * 60 * 1000);

/** A parsed period input → concrete dates, relative to `today` (an IST day). */
export function resolvePeriod(
  input: { preset: ReportPreset; from?: Date | undefined; to?: Date | undefined },
  today: Date,
): ReportPeriod {
  const thisMonth = utc(today.getUTCFullYear(), today.getUTCMonth());
  switch (input.preset) {
    case 'thisMonth':
      return unitPeriod('thisMonth', 'month', thisMonth);
    case 'lastMonth':
      return unitPeriod('lastMonth', 'month', addMonths(thisMonth, -1));
    case 'thisQuarter':
      return unitPeriod('thisQuarter', 'quarter', quarterStart(today));
    case 'lastQuarter':
      return unitPeriod('lastQuarter', 'quarter', addMonths(quarterStart(today), -3));
    case 'thisFinancialYear':
      return unitPeriod('thisFinancialYear', 'year', fyStart(today));
    case 'lastFinancialYear':
      return unitPeriod('lastFinancialYear', 'year', addMonths(fyStart(today), -12));
    case 'custom': {
      // The schema guarantees both dates for a custom period.
      const from = input.from!;
      const to = input.to!;
      return { preset: 'custom', from, to, label: rangeLabel(from, to), unit: 'custom' };
    }
  }
}

/**
 * The period to compare with: the previous month, quarter or financial year for a preset,
 * and the same number of days immediately before for a custom range.
 */
export function previousPeriod(period: ReportPeriod): ReportPeriod {
  if (period.unit === 'custom') {
    const days = (period.to.getTime() - period.from.getTime()) / DAY_MS + 1;
    const to = new Date(period.from.getTime() - DAY_MS);
    const from = new Date(to.getTime() - (days - 1) * DAY_MS);
    return { preset: 'custom', from, to, label: rangeLabel(from, to), unit: 'custom' };
  }
  const months = period.unit === 'month' ? 1 : period.unit === 'quarter' ? 3 : 12;
  return unitPeriod(period.preset, period.unit, addMonths(period.from, -months));
}

/** The first day of each month the period touches. */
export function monthsIn(period: { from: Date; to: Date }): Date[] {
  const months: Date[] = [];
  for (
    let month = utc(period.from.getUTCFullYear(), period.from.getUTCMonth());
    month <= period.to;
    month = addMonths(month, 1)
  ) {
    months.push(month);
  }
  return months;
}

/** Months for a monthly chart: the period's, or the six ending with it when shorter. */
export function chartMonths(period: { from: Date; to: Date }): Date[] {
  const months = monthsIn(period);
  if (months.length >= 3) return months;
  const last = months.at(-1)!;
  return Array.from({ length: 6 }, (_, i) => addMonths(last, i - 5));
}
