import { describe, expect, it } from 'vitest';
import { formatDate, formatDateTime } from '../lib/format.ts';

describe('formatDateTime (display in Asia/Kolkata)', () => {
  it('shows a UTC instant in IST (+05:30)', () => {
    expect(formatDateTime(new Date('2026-09-26T18:45:00Z'))).toBe('27 Sept 2026, 12:15 am');
  });

  it('accepts ISO strings from audit JSON', () => {
    expect(formatDateTime('2026-01-01T00:00:00.000Z')).toBe('1 Jan 2026, 5:30 am');
  });
});

describe('formatDate (@db.Date calendar days)', () => {
  it('shows the stored day without shifting it', () => {
    expect(formatDate(new Date('2026-09-27T00:00:00.000Z'))).toBe('27 Sept 2026');
    expect(formatDate('2026-01-01T00:00:00.000Z')).toBe('1 Jan 2026');
  });

  it('shows a dash for no date', () => {
    expect(formatDate(null)).toBe('—');
  });
});
