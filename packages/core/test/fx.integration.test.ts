import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { disconnectAll, getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { DomainError, ForbiddenError } from '../errors.ts';
import { convertEnquiry, createEnquiry } from '../services/enquiry.service.ts';
import {
  createExchangeRate,
  listExchangeRates,
  recalculateExchangeRate,
  softDeleteExchangeRate,
  updateExchangeRate,
} from '../services/exchange-rate.service.ts';
import { getInvoice, updateInvoice } from '../services/invoice.service.ts';
import { getProject } from '../services/project.service.ts';
import { getPurchaseOrder } from '../services/purchase-order.service.ts';
import {
  changeQuotationStatus,
  createQuotation,
  getQuotation,
  updateQuotation,
} from '../services/quotation.service.ts';
import { daysFromToday, invoiceWorld, newInvoice } from './invoice-fixtures.ts';
import { auditOf, fieldOf, newProject, rejection, sameRequest } from './project-fixtures.ts';
import type { PoWorld } from './purchase-order-fixtures.ts';

// M12 AC2 and AC10 (INR equivalents) and the exchange-rate service (M12 Decision 1).

let w: PoWorld;

const stored = (model: 'quotation' | 'project' | 'purchaseOrder' | 'invoice', id: string) =>
  (
    getDb()[model] as unknown as {
      findFirstOrThrow(
        args: unknown,
      ): Promise<{ fxRate: { toString(): string } | null; amountInrMinor: bigint | null }>;
    }
  ).findFirstOrThrow({
    where: { id, deletedAt: undefined },
    select: { fxRate: true, amountInrMinor: true },
  });

const fx = async (model: Parameters<typeof stored>[0], id: string) => {
  const row = await stored(model, id);
  return { fxRate: row.fxRate?.toString() ?? null, amountInrMinor: row.amountInrMinor };
};

/** A SENT quotation on a fresh converted enquiry, dated `quotationDate`. */
async function quotation(ctx: Ctx, quotationDate: string, amount: string, currency = 'USD') {
  const enquiry = await createEnquiry(ctx, {
    clientId: w.acme,
    sectorId: w.pharma,
    serviceIds: [w.inspection],
    receivedDate: '2026-01-05',
    proposalSentDate: '2026-01-05',
    source: 'EMAIL',
  });
  await convertEnquiry(ctx, { id: enquiry.id });
  return createQuotation(ctx, {
    enquiryId: enquiry.id,
    quotationDate,
    amount,
    currency,
    sectorId: w.pharma,
    serviceIds: [w.inspection],
    nextFollowUpDate: '2099-01-01',
  });
}

beforeAll(async () => {
  w = await invoiceWorld();
});
afterAll(disconnectAll);

describe('AC2: INR equivalents on records', () => {
  it('an INR record converts at 1', async () => {
    const q = await quotation(w.sales, '2026-03-10', '1,25,000.50', 'INR');
    expect(await fx('quotation', q.id)).toEqual({ fxRate: '1', amountInrMinor: 12_500_050n });
  });

  it('a record with no rate for its month saves with no INR value', async () => {
    const q = await quotation(w.sales, '2026-02-10', '1,000');
    expect(await fx('quotation', q.id)).toEqual({ fxRate: null, amountInrMinor: null });
  });

  it('adding the month’s rate fills records that had none, in the admin’s request', async () => {
    const q = await quotation(w.sales, '2026-02-12', '12,500');
    const other = await quotation(w.sales, '2026-01-20', '100'); // another month: untouched
    const { rate, filled } = await createExchangeRate(w.admin, {
      currency: 'USD',
      month: '2026-02',
      rate: '83.125',
    });
    expect(filled).toBeGreaterThanOrEqual(2); // this one and the previous test's
    // $12,500 × 83.125 = ₹10,39,062.50
    expect(await fx('quotation', q.id)).toEqual({
      fxRate: '83.125',
      amountInrMinor: 103_906_250n,
    });
    expect((await fx('quotation', other.id)).amountInrMinor).toBeNull();

    const rateRow = (await auditOf('ExchangeRate', rate.id))[0]!;
    const fill = (await auditOf('Quotation', q.id)).at(-1)!;
    expect(fill).toMatchObject({ action: 'UPDATE', actorId: w.admin.user.id, source: 'web' });
    expect(fill.requestId).toBe(rateRow.requestId);
    expect(fill.changedFields).toEqual(['amountInrMinor', 'fxRate']);
  });

  it('a new record picks up the rate for its own month', async () => {
    await createExchangeRate(w.admin, { currency: 'USD', month: '2026-03', rate: '84' });
    const q = await quotation(w.sales, '2026-03-31', '10');
    expect(await fx('quotation', q.id)).toEqual({ fxRate: '84', amountInrMinor: 84_000n });
  });

  it('changing the amount or date recomputes it in the same audit row; a description does not', async () => {
    const q = await quotation(w.sales, '2026-03-05', '10');
    await updateQuotation(w.sales, q.id, { amount: '20', currency: 'USD' });
    expect((await fx('quotation', q.id)).amountInrMinor).toBe(168_000n);
    let last = (await auditOf('Quotation', q.id)).at(-1)!;
    expect(last.changedFields).toEqual(expect.arrayContaining(['amountMinor', 'amountInrMinor']));

    await updateQuotation(w.sales, q.id, { quotationDate: '2026-02-20' }); // Feb: 83.125
    expect(await fx('quotation', q.id)).toEqual({ fxRate: '83.125', amountInrMinor: 166_250n });

    await updateQuotation(w.sales, q.id, { description: 'Scope clarified' });
    last = (await auditOf('Quotation', q.id)).at(-1)!;
    expect(last.changedFields).toEqual(['description']);

    await updateQuotation(w.sales, q.id, { amount: '1,00,000', currency: 'INR' });
    expect(await fx('quotation', q.id)).toEqual({ fxRate: '1', amountInrMinor: 10_000_000n });
  });

  it('a project converts at its quotation’s PO received month; a PO and an invoice at their own', async () => {
    await createExchangeRate(w.admin, { currency: 'USD', month: '2026-04', rate: '85' });
    const month = daysFromToday(0).slice(0, 7);
    await createExchangeRate(w.admin, { currency: 'USD', month, rate: '86.5' });

    const q = await quotation(w.sales, '2026-03-10', '1,000');
    await changeQuotationStatus(w.sales, {
      id: q.id,
      to: 'PO_RECEIVED',
      poReceivedDate: '2026-04-02',
    });
    const { project } = await newProject(w, {
      quotationId: q.id,
      currency: 'USD',
      revenue: '1,000',
    });
    expect(await fx('project', project.id)).toEqual({ fxRate: '85', amountInrMinor: 8_500_000n });

    const { purchaseOrder, invoice } = await newInvoice(
      w,
      { amount: '500', invoiceDate: daysFromToday(0) },
      { po: { currency: 'USD', amount: '1,000', receivedDate: '2026-04-02' } },
    );
    expect(await fx('purchaseOrder', purchaseOrder.id)).toEqual({
      fxRate: '85',
      amountInrMinor: 8_500_000n,
    });
    expect(await fx('invoice', invoice.id)).toEqual({
      fxRate: '86.5',
      amountInrMinor: 4_325_000n,
    });

    // Detail views carry them for "≈ ₹… at …".
    expect(await getProject(w.sales, project.id)).toMatchObject({
      fxRate: '85',
      amountInrMinor: 8_500_000n,
    });
    expect(await getPurchaseOrder(w.sales, purchaseOrder.id)).toMatchObject({ fxRate: '85' });
    expect(await getInvoice(w.sales, invoice.id)).toMatchObject({ amountInrMinor: 4_325_000n });
    expect(await getQuotation(w.sales, q.id)).toMatchObject({
      fxRate: '84',
      amountInrMinor: 8_400_000n,
    });

    await updateInvoice(w.sales, invoice.id, { amount: '400' });
    expect((await fx('invoice', invoice.id)).amountInrMinor).toBe(3_460_000n);
  });

  it('editing a rate leaves stored values until Recalculate, which reports how many change', async () => {
    const q = await quotation(w.sales, '2026-03-12', '10');
    const [march] = (await listExchangeRates(w.admin, { currency: 'USD' })).filter(
      (r) => r.month === '2026-03',
    );
    const updated = await updateExchangeRate(w.admin, march!.id, { rate: '90' });
    expect(updated.rate.rate).toBe('90.00');
    expect(updated.stale).toBeGreaterThanOrEqual(1);
    expect((await fx('quotation', q.id)).amountInrMinor).toBe(84_000n);

    const { updated: count } = await recalculateExchangeRate(w.admin, march!.id);
    expect(count).toBe(updated.stale);
    expect(await fx('quotation', q.id)).toEqual({ fxRate: '90', amountInrMinor: 90_000n });
    const last = (await auditOf('Quotation', q.id)).at(-1)!;
    expect(last).toMatchObject({ action: 'UPDATE', actorId: w.admin.user.id });
    expect((await sameRequest(last)).some((row) => row.entityType === 'Quotation')).toBe(true);
  });

  it('the database keeps the pair consistent (CHECKs)', async () => {
    const inr = await quotation(w.sales, '2026-03-10', '10', 'INR');
    const usd = await quotation(w.sales, '2026-03-10', '10');
    await expect(
      getDb().$executeRawUnsafe(
        `UPDATE quotation SET "fxRate" = NULL, "amountInrMinor" = NULL WHERE id = '${inr.id}'`,
      ),
    ).rejects.toThrow(/quotation_fx_inr_check/);
    await expect(
      getDb().$executeRawUnsafe(`UPDATE quotation SET "fxRate" = NULL WHERE id = '${usd.id}'`),
    ).rejects.toThrow(/quotation_fx_pair_check/);
  });
});

describe('exchange-rate service', () => {
  it('lists rates with how many records use each', async () => {
    const rows = await listExchangeRates(w.sales, { currency: 'USD' });
    const feb = rows.find((r) => r.month === '2026-02')!;
    expect(feb).toMatchObject({ currency: 'USD', rate: '83.125' });
    expect(feb.recordCount).toBeGreaterThanOrEqual(2);
  });

  it('only admins write rates: create, update, recalculate and delete are refused', async () => {
    const [feb] = (await listExchangeRates(w.admin, { currency: 'USD' })).filter(
      (r) => r.month === '2026-02',
    );
    for (const ctx of [w.sales, w.pm]) {
      for (const attempt of [
        createExchangeRate(ctx, { currency: 'USD', month: '2025-01', rate: '80' }),
        updateExchangeRate(ctx, feb!.id, { rate: '99' }),
        recalculateExchangeRate(ctx, feb!.id),
        softDeleteExchangeRate(ctx, feb!.id),
      ]) {
        expect(await rejection(attempt)).toBeInstanceOf(ForbiddenError);
      }
    }
    // Nothing changed.
    expect(
      (await listExchangeRates(w.admin, { currency: 'USD' })).find((r) => r.id === feb!.id),
    ).toMatchObject({ rate: '83.125' });
  });

  it('updating a rate writes one audit row with the change', async () => {
    const { rate } = await createExchangeRate(w.admin, {
      currency: 'USD',
      month: '2024-06',
      rate: '82',
    });
    await updateExchangeRate(w.admin, rate.id, { rate: '82.5' });
    const rows = await auditOf('ExchangeRate', rate.id);
    expect(rows.map((r) => r.action)).toEqual(['CREATE', 'UPDATE']);
    expect(rows[1]).toMatchObject({ actorId: w.admin.user.id, changedFields: ['inrPerUnit'] });
  });

  it.each([
    ['INR', { currency: 'INR', month: '2025-01', rate: '1' }, 'currency'],
    [
      'a currency that is not enabled',
      { currency: 'EUR', month: '2025-01', rate: '90' },
      'currency',
    ],
    ['a bad month', { currency: 'USD', month: '2025-13', rate: '80' }, 'month'],
    ['a zero rate', { currency: 'USD', month: '2025-01', rate: '0' }, 'rate'],
    ['seven decimals', { currency: 'USD', month: '2025-01', rate: '80.1234567' }, 'rate'],
    ['a second rate for the month', { currency: 'USD', month: '2026-02', rate: '80' }, 'month'],
  ])('refuses %s', async (_label, input, field) => {
    const error = await rejection(createExchangeRate(w.admin, input));
    expect(
      fieldOf(error) ?? (error as { issues?: { path: string[] }[] }).issues?.[0]?.path[0],
    ).toBe(field);
  });

  it('creating writes one audit row; deleting a rate in use is refused, an unused one is allowed', async () => {
    const { rate } = await createExchangeRate(w.admin, {
      currency: 'USD',
      month: '2025-01',
      rate: '80',
    });
    expect(await auditOf('ExchangeRate', rate.id)).toMatchObject([{ action: 'CREATE' }]);
    await softDeleteExchangeRate(w.admin, rate.id);
    expect((await auditOf('ExchangeRate', rate.id)).at(-1)).toMatchObject({
      action: 'SOFT_DELETE',
    });

    const [feb] = (await listExchangeRates(w.admin, { currency: 'USD' })).filter(
      (r) => r.month === '2026-02',
    );
    const error = await rejection(softDeleteExchangeRate(w.admin, feb!.id));
    expect(error).toBeInstanceOf(DomainError);
    expect((error as Error).message).toMatch(/records use this rate/);
  });
});
