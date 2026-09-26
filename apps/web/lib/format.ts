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
