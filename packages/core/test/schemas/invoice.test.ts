import { describe, expect, it } from 'vitest';
import { toCalendarDateString, todayInIST } from '../../schemas/common.ts';
import {
  createInvoiceSchema,
  listInvoicesSchema,
  markInvoicePaidSchema,
  markInvoiceUnpaidSchema,
  updateInvoiceSchema,
} from '../../schemas/invoice.ts';

const base = {
  purchaseOrderId: 'po1',
  invoiceNumber: 'INV/26-27/0042',
  invoiceDate: '2026-09-01',
  serviceId: 's1',
  amount: '5,90,000',
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

const createPaths = pathsOf(createInvoiceSchema);
const updatePaths = pathsOf(updateInvoiceSchema);
const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const tomorrow = toCalendarDateString(new Date(todayInIST().getTime() + 86_400_000));

// AC2: field validation that needs no database.
describe('AC2: invoice schemas', () => {
  it('parses a valid create input, collapsing whitespace in the number', () => {
    const parsed = createInvoiceSchema.parse({
      ...base,
      invoiceNumber: '  INV / 26-27   / 0042 ',
      description: ' Milestone 1 ',
    });
    expect(parsed).toMatchObject({
      invoiceNumber: 'INV / 26-27 / 0042',
      invoiceDate: day('2026-09-01'),
      amount: '5,90,000',
      description: 'Milestone 1',
    });
    expect(parsed.dueDate).toBeUndefined();
  });

  it('keeps a typed due date and an already-paid date', () => {
    const parsed = createInvoiceSchema.parse({
      ...base,
      dueDate: '2026-10-01',
      paidAt: '2026-09-10',
      paymentReference: 'UTR 123',
    });
    expect(parsed).toMatchObject({
      dueDate: day('2026-10-01'),
      paidAt: day('2026-09-10'),
      paymentReference: 'UTR 123',
    });
  });

  it.each([
    ['a missing number', { invoiceNumber: '   ' }, 'invoiceNumber'],
    ['an over-long number', { invoiceNumber: 'x'.repeat(65) }, 'invoiceNumber'],
    ['a future invoice date', { invoiceDate: tomorrow }, 'invoiceDate'],
    ['a missing invoice date', { invoiceDate: '' }, 'invoiceDate'],
    ['a zero amount', { amount: '0' }, 'amount'],
    ['a negative amount', { amount: '-5' }, 'amount'],
    ['a non-numeric amount', { amount: 'five lakh' }, 'amount'],
    ['a missing service', { serviceId: '' }, 'serviceId'],
    ['a due date before the invoice date', { dueDate: '2026-08-31' }, 'dueDate'],
    ['a paid date in the future', { paidAt: tomorrow }, 'paidAt'],
    ['a paid date before the invoice date', { paidAt: '2026-08-31' }, 'paidAt'],
  ])('rejects %s', (_label, change, path) => {
    expect(createPaths({ ...base, ...change })).toContain(path);
  });

  it.each(['clientId', 'currency', 'status', 'dueDateBasis', 'documentId'])(
    'rejects %s in create input',
    (key) => {
      expect(createPaths({ ...base, [key]: 'x' })).not.toEqual([]);
    },
  );

  it.each(['purchaseOrderId', 'paidAt', 'currency', 'status', 'dueDateBasis', 'clientId'])(
    'rejects %s in update input',
    (key) => {
      expect(updatePaths({ description: 'x', [key]: 'x' })).not.toEqual([]);
    },
  );

  it('accepts a partial update and clears optional text with an empty string', () => {
    expect(updateInvoiceSchema.parse({ description: '', paymentReference: '' })).toEqual({
      description: null,
      paymentReference: null,
    });
  });

  it('treats an empty due date on update as "back to the default"', () => {
    expect(updateInvoiceSchema.parse({ dueDate: '' })).toEqual({ dueDate: null });
  });

  it('rejects an empty update and a due date before the invoice date in one update', () => {
    expect(updatePaths({})).not.toEqual([]);
    expect(updatePaths({ invoiceDate: '2026-09-10', dueDate: '2026-09-09' })).toContain('dueDate');
  });

  it('validates Mark paid and Mark unpaid', () => {
    expect(markInvoicePaidSchema.parse({ id: 'i1', paidAt: '2026-09-10' })).toEqual({
      id: 'i1',
      paidAt: day('2026-09-10'),
    });
    expect(pathsOf(markInvoicePaidSchema)({ id: 'i1', paidAt: '' })).toContain('paidAt');
    expect(pathsOf(markInvoicePaidSchema)({ id: 'i1', paidAt: tomorrow })).toContain('paidAt');
    expect(markInvoiceUnpaidSchema.parse({ id: 'i1', reason: ' Bounced ' })).toEqual({
      id: 'i1',
      reason: 'Bounced',
    });
    expect(pathsOf(markInvoiceUnpaidSchema)({ id: 'i1', reason: '  ' })).toContain('reason');
    expect(pathsOf(markInvoiceUnpaidSchema)({ id: 'i1', reason: 'x'.repeat(501) })).toContain(
      'reason',
    );
  });

  it('parses list filters', () => {
    expect(
      listInvoicesSchema.parse({
        status: 'PENDING,OVERDUE',
        currency: 'inr',
        due: 'next7',
        managerId: 'none',
        document: 'toReview',
        sort: 'dueDate',
      }),
    ).toMatchObject({
      status: ['PENDING', 'OVERDUE'],
      currency: ['INR'],
      due: 'next7',
      managerId: 'none',
      document: 'toReview',
      sort: 'dueDate',
      recordStatus: 'live',
    });
    expect(pathsOf(listInvoicesSchema)({ due: 'someday' })).toContain('due');
  });
});
