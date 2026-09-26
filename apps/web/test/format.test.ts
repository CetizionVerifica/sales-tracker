import { describe, expect, it } from 'vitest';
import { formatDateTime } from '../lib/format.ts';

describe('formatDateTime (display in Asia/Kolkata)', () => {
  it('shows a UTC instant in IST (+05:30)', () => {
    expect(formatDateTime(new Date('2026-09-26T18:45:00Z'))).toBe('27 Sept 2026, 12:15 am');
  });

  it('accepts ISO strings from audit JSON', () => {
    expect(formatDateTime('2026-01-01T00:00:00.000Z')).toBe('1 Jan 2026, 5:30 am');
  });
});
