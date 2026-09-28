import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { todayInIST } from '../schemas/common.ts';
import { listFollowUps, listFollowUpTargets, logFollowUp } from '../services/follow-up.service.ts';
import {
  markInvoicePaid,
  markInvoiceUnpaid,
  markOverdueInvoices,
  restoreInvoice,
  softDeleteInvoice,
} from '../services/invoice.service.ts';
import { searchRecords } from '../services/search.service.ts';
import { getClientTimeline } from '../services/timeline.service.ts';
import { ensureSystemCtx } from './helpers.ts';
import { daysFromToday, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import type { PoWorld } from './purchase-order-fixtures.ts';

// AC9: follow-ups on invoices, invoice events on the client timeline, and ⌘K search.
describe('AC9: invoice follow-ups, timeline and search (integration)', () => {
  let w: PoWorld;
  let system: Ctx;

  beforeAll(async () => {
    w = await invoiceWorld();
    system = await ensureSystemCtx();
  });
  afterAll(disconnectAll);

  const timeline = async (ctx: Ctx, record?: string) =>
    (
      await getClientTimeline(ctx, {
        clientId: w.acme,
        limit: 100,
        ...(record && { entityType: 'INVOICE' as const, entityId: record }),
      })
    ).items;

  it('shows a follow-up on an invoice to the PM, the owner and admins, not another PM', async () => {
    const { invoice } = await newInvoice(w, { invoiceDate: daysFromToday(-40) });
    const followUp = await logFollowUp(w.pm, {
      entityType: 'INVOICE',
      entityId: invoice.id,
      date: daysFromToday(0),
      channel: 'CALL',
      notes: 'Chased accounts; payment promised Friday',
    });
    for (const ctx of [w.pm, w.sales, w.admin]) {
      const event = (await timeline(ctx)).find((e) => e.id === followUp.id);
      expect(event?.entity).toMatchObject({
        type: 'INVOICE',
        id: invoice.id,
        label: `Invoice ${invoice.invoiceNumber}`,
        deleted: false,
      });
      expect((await listFollowUps(ctx, { clientId: w.acme })).items.map((f) => f.id)).toContain(
        followUp.id,
      );
    }
    for (const ctx of [w.pm2, w.sales2]) {
      expect((await timeline(ctx)).some((e) => e.id === followUp.id)).toBe(false);
    }
    const targets = async (ctx: Ctx) =>
      (await listFollowUpTargets(ctx, w.acme)).map((t) => `${t.entityType}:${t.entityId}`);
    expect(await targets(w.pm)).toContain(`INVOICE:${invoice.id}`);
    expect(await targets(w.pm2)).not.toContain(`INVOICE:${invoice.id}`);
  });

  it('shows create, delete, restore and Pending → Overdue (system) → Paid in date order', async () => {
    const { invoice } = await newInvoice(w, { dueDate: daysFromToday(1) });
    await softDeleteInvoice(w.pm, invoice.id);
    await restoreInvoice(w.pm, invoice.id);
    await markOverdueInvoices(system, {
      today: new Date(todayInIST().getTime() + 2 * 86_400_000),
    });
    await markInvoicePaid(w.sales, {
      id: invoice.id,
      paidAt: daysFromToday(0),
      paymentReference: 'UTR 55',
    });
    await markInvoiceUnpaid(w.admin, { id: invoice.id, reason: 'Payment recalled' });

    const events = (await timeline(w.pm, invoice.id)).filter((e) => e.entity.id === invoice.id);
    // Newest first.
    expect(events.map((e) => [e.kind, e.change?.from ?? null, e.change?.to ?? null])).toEqual([
      ['STATUS_CHANGE', 'PAID', 'PENDING'],
      ['STATUS_CHANGE', 'OVERDUE', 'PAID'],
      ['STATUS_CHANGE', 'PENDING', 'OVERDUE'],
      ['RESTORED', null, null],
      ['DELETED', null, null],
      ['CREATED', null, null],
    ]);
    expect(events[0]!.change).toMatchObject({ unpaidReason: 'Payment recalled' });
    expect(events[1]!.change).toMatchObject({ paidAt: daysFromToday(0) });
    expect(events[2]!.actor.id).toBe(system.user.id);
    // Amounts never reach the timeline.
    expect(JSON.stringify(events)).not.toContain('amountMinor');

    // Only to users who can read the invoice.
    expect((await timeline(w.pm2)).some((e) => e.entity.id === invoice.id)).toBe(false);
  });

  it('finds an invoice by number in ⌘K, only for those who can read it', async () => {
    const { invoice, purchaseOrder } = await newInvoice(w);
    const q = invoice.invoiceNumber.slice(0, 12);
    for (const ctx of [w.pm, w.sales, w.admin]) {
      const found = (await searchRecords(ctx, { q, limit: 10 })).find((r) => r.id === invoice.id);
      expect(found).toEqual({
        type: 'INVOICE',
        id: invoice.id,
        label: `Invoice ${invoice.invoiceNumber}`,
        detail: `Acme Pharma · PO ${purchaseOrder.poNumber}`,
      });
    }
    for (const ctx of [w.pm2, w.sales2]) {
      expect((await searchRecords(ctx, { q, limit: 10 })).some((r) => r.id === invoice.id)).toBe(
        false,
      );
    }
  });
});
