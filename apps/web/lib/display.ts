import { todayInIST, toCalendarDateString } from '@sales-tracker/core/schemas';

/** A calendar day as YYYY-MM-DD (Dates are @db.Date values at UTC midnight). */
function dayOf(value: string | Date): string {
  return typeof value === 'string' ? value.slice(0, 10) : toCalendarDateString(value);
}

/** Today in Asia/Kolkata as YYYY-MM-DD. */
export function istToday(): string {
  return toCalendarDateString(todayInIST());
}

/**
 * "Due today", "3 days overdue", "Tomorrow", "In 5 days" for follow-up and due dates
 * (UI guide §5). `attention` marks due-today or overdue: the only saffron in the app.
 */
export function relativeDue(
  value: string | Date,
  today: string = istToday(),
): { text: string; attention: boolean } {
  const days = Math.round(
    (Date.parse(`${dayOf(value)}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
  if (days === 0) return { text: 'Due today', attention: true };
  if (days < 0) {
    const n = -days;
    return { text: `${n} ${n === 1 ? 'day' : 'days'} overdue`, attention: true };
  }
  if (days === 1) return { text: 'Tomorrow', attention: false };
  return { text: `In ${days} days`, attention: false };
}

/** "Sam Sales" → "SS" (avatars). */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words.at(-1)?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}
