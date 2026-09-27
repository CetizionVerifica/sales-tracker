import { describe, expect, it } from 'vitest';
import { todayInIST, toCalendarDateString } from '../schemas/common.ts';
import {
  clientTimelineSchema,
  createFollowUpSchema,
  decodeTimelineCursor,
  encodeTimelineCursor,
  listFollowUpsSchema,
  updateFollowUpSchema,
} from '../schemas/follow-up.ts';

const valid = {
  entityType: 'ENQUIRY',
  entityId: 'enq-1',
  date: '2026-03-10',
  channel: 'CALL',
  notes: 'Discussed scope',
};

const pathsOf = (result: { success: boolean; error?: { issues: { path: PropertyKey[] }[] } }) =>
  result.error?.issues.map((issue) => issue.path.join('.')) ?? [];

describe('follow-up schemas (AC2, validation part)', () => {
  it('accepts a valid follow-up and parses dates to UTC midnight', () => {
    const parsed = createFollowUpSchema.parse({ ...valid, nextFollowUpDate: '2026-03-17' });
    expect(parsed.date.toISOString()).toBe('2026-03-10T00:00:00.000Z');
    expect(parsed.nextFollowUpDate?.toISOString()).toBe('2026-03-17T00:00:00.000Z');
  });

  it('allows a next date on the same day', () => {
    expect(createFollowUpSchema.safeParse({ ...valid, nextFollowUpDate: valid.date }).success).toBe(
      true,
    );
  });

  it.each([
    ['a future date', { date: '2099-01-01' }, 'date'],
    ['a next date before the date', { nextFollowUpDate: '2026-03-09' }, 'nextFollowUpDate'],
    ['empty notes', { notes: '   ' }, 'notes'],
    ['notes over 4000 characters', { notes: 'x'.repeat(4001) }, 'notes'],
    ['an unknown channel', { channel: 'FAX' }, 'channel'],
    ['an unknown record type', { entityType: 'LEAD' }, 'entityType'],
    ['a missing record id', { entityId: '' }, 'entityId'],
  ])('rejects %s', (_name, overrides, field) => {
    expect(pathsOf(createFollowUpSchema.safeParse({ ...valid, ...overrides }))).toContain(field);
  });

  it('accepts today (in IST) as the date', () => {
    const today = toCalendarDateString(todayInIST());
    expect(createFollowUpSchema.safeParse({ ...valid, date: today }).success).toBe(true);
  });

  it('has no clientId or userId: both are derived by the service', () => {
    const parsed = createFollowUpSchema.parse({ ...valid, clientId: 'x', userId: 'y' });
    expect(parsed).not.toHaveProperty('clientId');
    expect(parsed).not.toHaveProperty('userId');
  });

  it('update: fields are optional, the link cannot change, empty string clears', () => {
    const parsed = updateFollowUpSchema.parse({
      entityType: 'CLIENT',
      entityId: 'other',
      contactId: '',
      nextFollowUpDate: '',
    });
    expect(parsed).toEqual({ contactId: null, nextFollowUpDate: null });
  });

  it('update: rejects a next date before a date given in the same update', () => {
    expect(
      pathsOf(
        updateFollowUpSchema.safeParse({ date: '2026-03-10', nextFollowUpDate: '2026-03-01' }),
      ),
    ).toContain('nextFollowUpDate');
  });

  it('list: parses multi-value channels and date ranges', () => {
    const parsed = listFollowUpsSchema.parse({
      channel: ['CALL', 'EMAIL'],
      dateFrom: '2026-01-01',
      nextTo: '2026-12-31',
    });
    expect(parsed.channel).toEqual(['CALL', 'EMAIL']);
    expect(parsed.dateFrom?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(parsed.recordStatus).toBe('live');
  });

  it('timeline: limit defaults to 50 and is capped at 100; the record filter needs both parts', () => {
    expect(clientTimelineSchema.parse({ clientId: 'c' }).limit).toBe(50);
    expect(clientTimelineSchema.safeParse({ clientId: 'c', limit: 101 }).success).toBe(false);
    expect(
      pathsOf(clientTimelineSchema.safeParse({ clientId: 'c', entityType: 'ENQUIRY' })),
    ).toContain('entityId');
  });

  it('timeline cursor round-trips and rejects garbage', () => {
    const cursor = {
      day: '2026-03-10',
      at: '2026-03-12T04:05:06.007Z',
      rank: 1,
      id: 'abc',
    };
    expect(decodeTimelineCursor(encodeTimelineCursor(cursor))).toEqual(cursor);
    expect(clientTimelineSchema.safeParse({ clientId: 'c', cursor: 'not-a-cursor' }).success).toBe(
      false,
    );
  });
});
