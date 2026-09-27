/** Dates are stored in UTC and shown in India Standard Time (CLAUDE.md). */
const dateTime = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});

export function formatDateTime(value: Date | string): string {
  return dateTime.format(typeof value === 'string' ? new Date(value) : value);
}

// Calendar dates (@db.Date) are stored as UTC midnight of the day itself, so they are
// formatted in UTC: formatting in IST would still show the same day, but UTC makes it exact.
const calendarDate = new Intl.DateTimeFormat('en-IN', {
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  timeZone: 'UTC',
});

export function formatDate(value: Date | string | null | undefined): string {
  if (!value) return '—';
  return calendarDate.format(typeof value === 'string' ? new Date(value) : value);
}

const time = new Intl.DateTimeFormat('en-IN', {
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
  timeZone: 'Asia/Kolkata',
});

/** Time of day in IST, for events already grouped under a date. */
export function formatTime(value: Date | string): string {
  return time.format(typeof value === 'string' ? new Date(value) : value);
}
