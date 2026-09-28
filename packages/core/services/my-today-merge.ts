import { todayInIST } from '../schemas/common.ts';
import {
  MY_TODAY_HORIZON_DAYS,
  MY_TODAY_KINDS,
  MY_TODAY_SECTION_LIMIT,
  type MyTodayCounts,
  type MyTodayKind,
  type MyTodayRow,
  type MyTodaySections,
} from '../schemas/my-today.ts';

/*
 * Pure parts of My Today (M11): merging candidates into one row per record, sorting, and
 * splitting into sections. No database access, so the rules are unit-tested directly.
 */

const DAY_MS = 86_400_000;

/** A row before merging and before the viewer's actions are known. */
export type MyTodayCandidate = Omit<MyTodayRow, 'alsoReasons' | 'actions' | 'daysFromToday'>;

/** A merged row, still without the viewer's actions. */
export type MergedRow = Omit<MyTodayRow, 'actions' | 'daysFromToday'>;

const PRIORITY = new Map<MyTodayKind, number>(MY_TODAY_KINDS.map((kind, i) => [kind, i]));
const priority = (kind: MyTodayKind) => PRIORITY.get(kind) ?? MY_TODAY_KINDS.length;

/** The IST calendar day of an instant (UTC midnight), e.g. a document's `extractedAt`. */
export function istDayOf(instant: Date): Date {
  return todayInIST(instant);
}

export const addDays = (day: Date, days: number) => new Date(day.getTime() + days * DAY_MS);

const daysBetween = (from: Date, to: Date) => Math.round((to.getTime() - from.getTime()) / DAY_MS);

/**
 * One row per record (Decision 4): the highest-priority kind supplies the row, its due date
 * is the earliest of all reasons, and the other reasons are listed in priority order.
 */
export function mergeCandidates(candidates: readonly MyTodayCandidate[]): MergedRow[] {
  const byKey = new Map<string, MyTodayCandidate[]>();
  for (const candidate of candidates) {
    const group = byKey.get(candidate.key);
    if (group) group.push(candidate);
    else byKey.set(candidate.key, [candidate]);
  }
  return [...byKey.values()].map((group) => {
    const sorted = [...group].sort((a, b) => priority(a.kind) - priority(b.kind));
    const [primary, ...others] = sorted as [MyTodayCandidate, ...MyTodayCandidate[]];
    const earliest = Math.min(...group.map((c) => c.dueDate.getTime()));
    return {
      ...primary,
      dueDate: new Date(earliest),
      alsoReasons: others.map((c) => ({ kind: c.kind, dueDate: c.dueDate })),
    };
  });
}

function compareRows(a: MergedRow, b: MergedRow): number {
  return (
    a.dueDate.getTime() - b.dueDate.getTime() ||
    priority(a.kind) - priority(b.kind) ||
    a.client.name.localeCompare(b.client.name) ||
    a.record.label.localeCompare(b.record.label) ||
    a.key.localeCompare(b.key)
  );
}

export interface SplitResult<R> {
  sections: { overdue: R[]; dueToday: R[]; comingUp: R[] };
  /** The badge is the service's: it needs the unfiltered sections. */
  counts: Omit<MyTodayCounts, 'badge'>;
}

/**
 * Sections by due date alone (Decision 3): before today, today, then today + 1 to + 7.
 * Rows past the horizon are dropped. Each section keeps at most 100 rows; counts are exact
 * (Decision 7).
 */
export function splitSections(
  rows: readonly MergedRow[],
  today: Date,
): SplitResult<MergedRow & { daysFromToday: number }> {
  const horizon = addDays(today, MY_TODAY_HORIZON_DAYS).getTime();
  const all = { overdue: [], dueToday: [], comingUp: [] } as {
    [K in keyof MyTodaySections]: (MergedRow & { daysFromToday: number })[];
  };
  const byKind = Object.fromEntries(MY_TODAY_KINDS.map((k) => [k, 0])) as Record<
    MyTodayKind,
    number
  >;
  for (const row of [...rows].sort(compareRows)) {
    const due = row.dueDate.getTime();
    if (due > horizon) continue;
    const located = { ...row, daysFromToday: daysBetween(today, row.dueDate) };
    const section =
      due < today.getTime() ? 'overdue' : due === today.getTime() ? 'dueToday' : 'comingUp';
    all[section].push(located);
    byKind[row.kind] += 1;
  }
  return {
    sections: {
      overdue: all.overdue.slice(0, MY_TODAY_SECTION_LIMIT),
      dueToday: all.dueToday.slice(0, MY_TODAY_SECTION_LIMIT),
      comingUp: all.comingUp.slice(0, MY_TODAY_SECTION_LIMIT),
    },
    counts: {
      overdue: all.overdue.length,
      dueToday: all.dueToday.length,
      comingUp: all.comingUp.length,
      byKind,
    },
  };
}
