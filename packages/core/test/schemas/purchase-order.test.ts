import { describe, expect, it } from 'vitest';
import {
  createPurchaseOrderSchema,
  listPurchaseOrdersSchema,
  updatePurchaseOrderFormSchema,
  updatePurchaseOrderSchema,
} from '../../schemas/purchase-order.ts';
import { toCalendarDateString, todayInIST } from '../../schemas/common.ts';

const base = {
  projectId: 'p1',
  poNumber: '4500012345',
  receivedDate: '2026-04-01',
  amount: '1,25,000.50',
  currency: 'INR',
  serviceIds: ['a', 'b'],
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

const createPaths = pathsOf(createPurchaseOrderSchema);
const updatePaths = pathsOf(updatePurchaseOrderSchema);

const tomorrow = toCalendarDateString(new Date(todayInIST().getTime() + 86_400_000));

// AC2: field validation that needs no database.
describe('AC2: purchase order schemas', () => {
  it('parses a valid create input to minor units and a calendar date', () => {
    const parsed = createPurchaseOrderSchema.parse({
      ...base,
      poNumber: '  PO   4500 / 12 ',
      paymentTerms: ' Net 45 ',
      paymentTermsDays: '45',
    });
    expect(parsed).toMatchObject({
      poNumber: 'PO 4500 / 12',
      amountMinor: 12_500_050n,
      currency: 'INR',
      paymentTerms: 'Net 45',
      paymentTermsDays: 45,
    });
    expect(parsed.receivedDate.toISOString()).toBe('2026-04-01T00:00:00.000Z');
    expect(parsed).not.toHaveProperty('amount');
  });

  it.each([
    [{ poNumber: '' }, 'poNumber'],
    [{ poNumber: '   ' }, 'poNumber'],
    [{ poNumber: 'x'.repeat(65) }, 'poNumber'],
    [{ receivedDate: tomorrow }, 'receivedDate'],
    [{ receivedDate: '' }, 'receivedDate'],
    [{ amount: '0' }, 'amount'],
    [{ amount: '0.00' }, 'amount'],
    [{ amount: '-1' }, 'amount'],
    [{ amount: '10.123' }, 'amount'],
    [{ currency: 'rupees' }, 'currency'],
    [{ serviceIds: [] }, 'serviceIds'],
    [{ serviceIds: ['a', 'a'] }, 'serviceIds'],
    [{ serviceIds: Array.from({ length: 11 }, (_, i) => `s${i}`) }, 'serviceIds'],
    [{ paymentTermsDays: -1 }, 'paymentTermsDays'],
    [{ paymentTermsDays: 366 }, 'paymentTermsDays'],
    [{ paymentTermsDays: 1.5 }, 'paymentTermsDays'],
    [{ paymentTermsDays: '1.5' }, 'paymentTermsDays'],
    [{ paymentTermsDays: '45 days' }, 'paymentTermsDays'],
    [{ paymentTerms: 'x'.repeat(501) }, 'paymentTerms'],
    [{ description: 'x'.repeat(2001) }, 'description'],
    [{ projectId: '' }, 'projectId'],
  ])('rejects %j on %s', (overrides, path) => {
    expect(createPaths({ ...base, ...overrides })).toContain(path);
  });

  it.each(['clientId', 'status', 'documentId', 'statusChangedAt'])(
    'rejects %s in create input',
    (key) => {
      expect(createPaths({ ...base, [key]: 'x' }).length).toBeGreaterThan(0);
    },
  );

  it.each(['clientId', 'status', 'documentId', 'projectId'])(
    'rejects %s in update input',
    (key) => {
      expect(updatePaths({ description: 'x', [key]: 'x' }).length).toBeGreaterThan(0);
    },
  );

  it('accepts net days at the edges and leaves optional fields unset', () => {
    expect(createPaths({ ...base, paymentTermsDays: 0 })).toEqual([]);
    expect(createPaths({ ...base, paymentTermsDays: 365 })).toEqual([]);
    const parsed = createPurchaseOrderSchema.parse(base);
    expect(parsed.paymentTermsDays).toBeUndefined();
    expect(parsed.paymentTerms).toBeUndefined();
  });

  it('update: empty strings clear optional fields; undefined leaves them', () => {
    expect(
      updatePurchaseOrderSchema.parse({ paymentTerms: '', paymentTermsDays: '', description: '' }),
    ).toEqual({ paymentTerms: null, paymentTermsDays: null, description: null });
    expect(updatePurchaseOrderSchema.parse({ description: 'Scope' })).toEqual({
      description: 'Scope',
    });
  });

  it('update: an amount and its currency travel together', () => {
    expect(updatePaths({ amount: '10' })).toContain('currency');
    expect(updatePaths({ currency: 'INR' })).toContain('amount');
    expect(updatePurchaseOrderSchema.parse({ amount: '12,50,000', currency: 'INR' })).toEqual({
      amountMinor: 12_50_000_00n,
      currency: 'INR',
    });
  });

  it('update: needs at least one field, and the form schema keeps the amount as typed', () => {
    expect(updatePaths({})).toContain('');
    expect(
      updatePurchaseOrderFormSchema.parse({ amount: '12,50,000', currency: 'INR' }),
    ).toMatchObject({ amount: '12,50,000' });
    // Values from the review screen arrive as strings.
    expect(updatePurchaseOrderFormSchema.parse({ paymentTermsDays: '45' })).toEqual({
      paymentTermsDays: 45,
    });
  });

  it('list: parses filters from the URL', () => {
    const parsed = listPurchaseOrdersSchema.parse({
      status: 'PENDING,OVERDUE',
      currency: 'inr,usd',
      document: 'toReview',
      managerId: 'none',
      receivedFrom: '2026-01-01',
      sort: 'amount',
    });
    expect(parsed).toMatchObject({
      status: ['PENDING', 'OVERDUE'],
      currency: ['INR', 'USD'],
      document: 'toReview',
      managerId: 'none',
      sort: 'amount',
      recordStatus: 'live',
    });
    expect(listPurchaseOrdersSchema.safeParse({ document: 'lost' }).success).toBe(false);
    expect(listPurchaseOrdersSchema.safeParse({ sort: 'clientId' }).success).toBe(false);
  });
});
