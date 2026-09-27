import { describe, expect, it } from 'vitest';
import {
  changeQuotationStatusSchema,
  createQuotationFormSchema,
  createQuotationSchema,
  updateQuotationActionSchema,
  listQuotationsSchema,
  updateQuotationSchema,
} from '../../schemas/quotation.ts';

const base = {
  enquiryId: 'e1',
  quotationDate: '2026-03-12',
  amount: '1,25,000.50',
  currency: 'INR',
  sectorId: 's1',
  serviceIds: ['a', 'b'],
  nextFollowUpDate: '2026-03-20',
} as const;

const pathsOf =
  (schema: { safeParse(v: unknown): { success: boolean; error?: unknown } }) =>
  (input: unknown) => {
    const result = schema.safeParse(input) as {
      success: boolean;
      error?: { issues: { path: PropertyKey[] }[] };
    };
    return result.success ? [] : result.error!.issues.map((i) => i.path.join('.'));
  };

const createPaths = pathsOf(createQuotationSchema);
const updatePaths = pathsOf(updateQuotationSchema);

// AC2: field validation that needs no database.
describe('AC2: quotation schemas', () => {
  it('parses a valid create input to minor units and calendar dates', () => {
    const parsed = createQuotationSchema.parse(base);
    expect(parsed.amountMinor).toBe(12_500_050n);
    expect(parsed.currency).toBe('INR');
    expect(parsed.quotationDate.toISOString()).toBe('2026-03-12T00:00:00.000Z');
    expect(parsed).not.toHaveProperty('amount');
  });

  it.each([
    [{ amount: '-1' }, 'amount'],
    [{ amount: 'lots' }, 'amount'],
    [{ amount: '10.123' }, 'amount'],
    [{ amount: '10.5', currency: 'JPY' }, 'amount'],
    [{ amount: '1000000000000000' }, 'amount'],
    [{ currency: 'rupees' }, 'currency'],
    [{ currency: 'XYZ' }, 'currency'],
    [{ serviceIds: [] }, 'serviceIds'],
    [{ serviceIds: ['a', 'a'] }, 'serviceIds'],
    [{ quotationDate: '2999-01-01' }, 'quotationDate'],
    [{ nextFollowUpDate: undefined }, 'nextFollowUpDate'],
    [{ nextFollowUpDate: '2026-03-01' }, 'nextFollowUpDate'],
    [{ description: 'x'.repeat(2001) }, 'description'],
    [{ lastFollowUpHighlights: 'x'.repeat(1001) }, 'lastFollowUpHighlights'],
  ])('rejects %j on %s', (overrides, path) => {
    expect(createPaths({ ...base, ...overrides })).toContain(path);
  });

  it.each(['clientId', 'status', 'number', 'lostReason', 'poReceivedDate'])(
    'rejects %s in create input',
    (key) => {
      expect(createPaths({ ...base, [key]: 'x' }).length).toBeGreaterThan(0);
    },
  );

  it.each(['clientId', 'status', 'number', 'lostReason', 'poReceivedDate', 'enquiryId'])(
    'rejects %s in update input',
    (key) => {
      expect(updatePaths({ description: 'ok', [key]: 'x' }).length).toBeGreaterThan(0);
    },
  );

  it('a value the action parsed with the form schema parses again in the service', () => {
    const once = createQuotationFormSchema.parse(base);
    expect(once.amount).toBe('1,25,000.50');
    expect(createQuotationSchema.parse(once).amountMinor).toBe(12_500_050n);
    const update = updateQuotationActionSchema.parse({
      id: 'q1',
      data: { amount: '10', currency: 'USD', nextFollowUpDate: '2026-04-01' },
    });
    expect(updateQuotationSchema.parse(update.data)).toMatchObject({ amountMinor: 1000n });
    expect(createQuotationFormSchema.safeParse({ ...base, amount: '1.234' }).success).toBe(false);
  });

  it('allows a zero amount (Decision 4)', () => {
    expect(createQuotationSchema.parse({ ...base, amount: '0' }).amountMinor).toBe(0n);
  });

  it('update: an amount needs its currency, so minor units are never reinterpreted', () => {
    expect(updatePaths({ amount: '10' })).toContain('currency');
    expect(updatePaths({ currency: 'USD' })).toContain('amount');
    expect(updateQuotationSchema.parse({ amount: '10', currency: 'USD' })).toMatchObject({
      amountMinor: 1000n,
      currency: 'USD',
    });
  });

  it('update: empty string clears optional text, undefined leaves it unchanged', () => {
    expect(updateQuotationSchema.parse({ description: '' })).toEqual({ description: null });
    expect(updateQuotationSchema.parse({ description: 'x' })).toEqual({ description: 'x' });
    expect(updatePaths({})).not.toEqual([]);
  });

  it('status change input is discriminated by the target status', () => {
    expect(
      changeQuotationStatusSchema.parse({ id: 'q1', to: 'LOST', lostReason: ' Price ' }),
    ).toEqual({ id: 'q1', to: 'LOST', lostReason: 'Price' });
    expect(
      changeQuotationStatusSchema.safeParse({ id: 'q1', to: 'LOST', lostReason: '' }).success,
    ).toBe(false);
    expect(changeQuotationStatusSchema.safeParse({ id: 'q1', to: 'PO_RECEIVED' }).success).toBe(
      false,
    );
    expect(
      changeQuotationStatusSchema.parse({
        id: 'q1',
        to: 'PO_RECEIVED',
        poReceivedDate: '2026-04-01',
      }),
    ).toMatchObject({ to: 'PO_RECEIVED' });
    expect(changeQuotationStatusSchema.parse({ id: 'q1', to: 'UNDER_NEGOTIATION' })).toMatchObject({
      to: 'UNDER_NEGOTIATION',
    });
    expect(changeQuotationStatusSchema.safeParse({ id: 'q1', to: 'DRAFT' }).success).toBe(false);
  });

  it('list input accepts comma-separated statuses and currencies', () => {
    const parsed = listQuotationsSchema.parse({
      status: 'SENT,LOST',
      currency: 'INR,USD',
      followUpDue: 'true',
    });
    expect(parsed.status).toEqual(['SENT', 'LOST']);
    expect(parsed.currency).toEqual(['INR', 'USD']);
    expect(parsed.followUpDue).toBe(true);
    expect(listQuotationsSchema.parse({}).followUpDue).toBe(false);
  });
});
