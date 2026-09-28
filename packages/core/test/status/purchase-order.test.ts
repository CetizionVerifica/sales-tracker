import { describe, expect, it } from 'vitest';
import { derivePurchaseOrderStatus, type InvoiceForStatus } from '../../status/purchase-order.ts';

const po = { amountMinor: 10_00_000_00n, currency: 'INR' };
const inv = (status: InvoiceForStatus['status'], amountMinor = 5_00_000_00n) => ({
  status,
  amountMinor,
});

// AC4: the derived status, as a pure function of the PO and its live invoices.
describe('AC4: derivePurchaseOrderStatus', () => {
  it.each([
    ['no invoices', []],
    ['all pending', [inv('PENDING'), inv('PENDING')]],
    ['paid and pending', [inv('PAID'), inv('PENDING')]],
  ])('is PENDING with %s', (_label, invoices) => {
    expect(derivePurchaseOrderStatus(po, invoices)).toBe('PENDING');
  });

  it.each([
    ['one overdue', [inv('OVERDUE')]],
    ['overdue among pending', [inv('PENDING'), inv('OVERDUE')]],
    ['overdue alongside paid', [inv('PAID'), inv('OVERDUE')]],
    ['overdue even when paid ones cover the PO', [inv('PAID', po.amountMinor), inv('OVERDUE', 1n)]],
  ])('is OVERDUE with %s', (_label, invoices) => {
    expect(derivePurchaseOrderStatus(po, invoices)).toBe('OVERDUE');
  });

  it('is PAID when every invoice is paid and they total exactly the PO amount', () => {
    expect(derivePurchaseOrderStatus(po, [inv('PAID'), inv('PAID')])).toBe('PAID');
  });

  it('is PAID when paid invoices total more than the PO amount', () => {
    expect(derivePurchaseOrderStatus(po, [inv('PAID', 11_00_000_00n)])).toBe('PAID');
  });

  // Decision 5: a ₹10L PO with one paid ₹5L advance is not paid; ₹5L is still to bill.
  it('is PENDING when every invoice is paid but the PO is not fully invoiced', () => {
    expect(derivePurchaseOrderStatus(po, [inv('PAID')])).toBe('PENDING');
    expect(derivePurchaseOrderStatus(po, [inv('PAID', po.amountMinor - 1n)])).toBe('PENDING');
  });
});
