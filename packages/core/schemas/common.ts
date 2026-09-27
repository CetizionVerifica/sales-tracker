import { z } from 'zod';

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type PaginationInput = z.input<typeof paginationSchema>;

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** Transport shape for actions that target one record: `{ id, data }`. */
export function withId<S extends z.ZodType>(data: S) {
  return z.object({ id: z.string().min(1), data });
}

export const idOnlySchema = z.object({ id: z.string().min(1) });

/**
 * Optional text: `undefined` = not provided / unchanged (updates), `''` or `null` = empty
 * (stored as null, so an update can clear a field that was set).
 */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value === '' ? null : value));

/** Same contract for fields with a format: '' clears, otherwise the format must match. */
export function clearable<T extends z.ZodType>(format: T) {
  return z.union([z.literal('').transform(() => null), z.null(), format]).optional();
}

// ─── Calendar dates (@db.Date columns, CLAUDE.md rule 6) ─────────────────────────────

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

const istDay = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Kolkata',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const isoDaySchema = z
  .string()
  .trim()
  .regex(ISO_DAY, 'Enter a date as YYYY-MM-DD')
  .transform((value, context) => {
    const [, y, m, d] = ISO_DAY.exec(value)!.map(Number) as [number, number, number, number];
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) {
      context.addIssue({ code: 'custom', message: 'Enter a real date' });
      return z.NEVER;
    }
    return date;
  });

/**
 * A calendar day → a Date at UTC midnight of that day, which is how Prisma reads and writes
 * `@db.Date`. Accepts `YYYY-MM-DD` (forms, URLs, MCP) without going through
 * `new Date(localString)`, so the day cannot shift by a time zone; impossible days
 * (2026-02-30) are rejected. Also accepts an already-parsed UTC-midnight Date, so a value
 * parsed once by a server action parses again unchanged in the service.
 */
export const calendarDateSchema = z.union([
  z
    .date()
    .refine((date) => date.getTime() % 86_400_000 === 0, 'Enter a date without a time of day'),
  isoDaySchema,
]);

/** Today in Asia/Kolkata, as a calendar date (UTC midnight). */
export function todayInIST(now: Date = new Date()): Date {
  return new Date(`${istDay.format(now)}T00:00:00.000Z`);
}

/** A calendar date as `YYYY-MM-DD` (form defaults, URLs). */
export function toCalendarDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
