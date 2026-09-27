import { afterEach, describe, expect, it, vi } from 'vitest';
import { quickClientSchema } from '../../schemas/client.ts';
import { calendarDateSchema, todayInIST } from '../../schemas/common.ts';
import {
  createEnquirySchema,
  listEnquiriesSchema,
  updateEnquirySchema,
} from '../../schemas/enquiry.ts';

const base = {
  clientId: 'c1',
  sectorId: 's1',
  serviceIds: ['a', 'b'],
  receivedDate: '2026-03-10',
  source: 'EMAIL',
} as const;

const pathsOf = (input: unknown) => {
  const result = createEnquirySchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.path.join('.'));
};

describe('calendar dates (@db.Date)', () => {
  it('parses YYYY-MM-DD to UTC midnight of that day, never shifting it', () => {
    expect(calendarDateSchema.parse('2026-09-27').toISOString()).toBe('2026-09-27T00:00:00.000Z');
  });

  it('accepts a UTC-midnight Date (a value an action already parsed) unchanged', () => {
    const day = new Date('2026-09-27T00:00:00.000Z');
    expect(calendarDateSchema.parse(day)).toEqual(day);
    expect(calendarDateSchema.safeParse(new Date('2026-09-27T10:00:00.000Z')).success).toBe(false);
  });

  it('parses the same input twice to the same day (action, then service)', () => {
    const once = createEnquirySchema.parse(base);
    expect(createEnquirySchema.parse(once).receivedDate).toEqual(once.receivedDate);
  });

  it.each(['2026-02-30', '27-09-2026', '2026-9-7', '', 'yesterday'])('rejects %j', (value) => {
    expect(calendarDateSchema.safeParse(value).success).toBe(false);
  });

  describe('today in Asia/Kolkata', () => {
    afterEach(() => vi.useRealTimers());

    it('is already the next day at 00:30 IST (19:00 UTC the day before)', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-26T19:00:00.000Z'));
      expect(todayInIST().toISOString()).toBe('2026-09-27T00:00:00.000Z');
    });

    it('is still the same day at 23:59 IST', () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-09-27T18:29:00.000Z'));
      expect(todayInIST().toISOString()).toBe('2026-09-27T00:00:00.000Z');
    });
  });
});

describe('createEnquirySchema (AC2)', () => {
  afterEach(() => vi.useRealTimers());

  it('accepts a minimal enquiry', () => {
    expect(pathsOf(base)).toEqual([]);
  });

  it('accepts today (IST) as the received date just after midnight IST', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-26T19:00:00.000Z')); // 00:30 IST on the 27th
    expect(pathsOf({ ...base, receivedDate: '2026-09-27' })).toEqual([]);
    expect(pathsOf({ ...base, receivedDate: '2026-09-28' })).toEqual(['receivedDate']);
  });

  it('rejects no services and duplicate services', () => {
    expect(pathsOf({ ...base, serviceIds: [] })).toEqual(['serviceIds']);
    expect(pathsOf({ ...base, serviceIds: ['a', 'a'] })).toEqual(['serviceIds']);
  });

  it('rejects a future received date', () => {
    expect(pathsOf({ ...base, receivedDate: '2099-01-01' })).toEqual(['receivedDate']);
  });

  it('rejects a proposal sent before the enquiry was received, or in the future', () => {
    expect(pathsOf({ ...base, proposalSentDate: '2026-03-09' })).toEqual(['proposalSentDate']);
    expect(pathsOf({ ...base, proposalSentDate: '2099-01-01' })).toEqual(['proposalSentDate']);
    expect(pathsOf({ ...base, proposalSentDate: '2026-03-10' })).toEqual([]);
  });

  it.each(['TENDER_PORTAL', 'REFERRAL', 'OTHER'])('%s requires source detail', (source) => {
    expect(pathsOf({ ...base, source })).toEqual(['sourceDetail']);
    expect(pathsOf({ ...base, source, sourceDetail: '  ' })).toEqual(['sourceDetail']);
    expect(pathsOf({ ...base, source, sourceDetail: 'GeM 2026/B/123' })).toEqual([]);
  });

  it.each(['EMAIL', 'PHONE', 'WEBSITE', 'WALK_IN'])('%s does not require detail', (source) => {
    expect(pathsOf({ ...base, source })).toEqual([]);
  });

  it('rejects a missing or unknown source', () => {
    const { source: _source, ...noSource } = base;
    expect(pathsOf(noSource)).toEqual(['source']);
    expect(pathsOf({ ...base, source: 'FAX' })).toEqual(['source']);
  });
});

describe('updateEnquirySchema (AC8)', () => {
  it('drops status and number: they only change through the status machine / never', () => {
    const parsed = updateEnquirySchema.parse({
      description: 'x',
      status: 'LOST',
      number: 'ENQ-1999-0001',
    });
    expect(parsed).toEqual({ description: 'x' });
  });

  it('clears optional fields with an empty string', () => {
    expect(updateEnquirySchema.parse({ proposalSentDate: '', sourceDetail: '' })).toEqual({
      proposalSentDate: null,
      sourceDetail: null,
    });
  });

  it('rejects an empty update', () => {
    expect(updateEnquirySchema.safeParse({}).success).toBe(false);
  });
});

describe('listEnquiriesSchema', () => {
  it('reads comma-separated multi-value filters from the URL', () => {
    const parsed = listEnquiriesSchema.parse({ status: 'IN_PROGRESS,LOST', source: 'EMAIL' });
    expect(parsed.status).toEqual(['IN_PROGRESS', 'LOST']);
    expect(parsed.source).toEqual(['EMAIL']);
  });

  it('accepts arrays from services and ignores empty values', () => {
    expect(listEnquiriesSchema.parse({ status: ['CONVERTED'] }).status).toEqual(['CONVERTED']);
    expect(listEnquiriesSchema.parse({ status: '' }).status).toBeUndefined();
  });

  it('rejects an unknown sort column', () => {
    expect(listEnquiriesSchema.safeParse({ sort: 'lostReason' }).success).toBe(false);
  });
});

describe('quickClientSchema (New client from the enquiry form)', () => {
  const client = { name: 'Delta Labs', sectorId: 's1' };

  it('accepts a client with or without a contact', () => {
    expect(quickClientSchema.safeParse(client).success).toBe(true);
    expect(
      quickClientSchema.safeParse({ ...client, contactName: 'Kiran', contactEmail: 'k@d.example' })
        .success,
    ).toBe(true);
  });

  it('asks for the contact name when an email or phone is given', () => {
    const result = quickClientSchema.safeParse({ ...client, contactPhone: '+91 98200 00000' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['contactName']);
  });
});
