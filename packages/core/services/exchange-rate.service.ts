import { getDb, type Db } from '../clients.ts';
import { assertCan, BULK_TX, withTx, type Ctx } from '../context.ts';
import { DomainError, NotFoundError } from '../errors.ts';
import {
  createExchangeRateSchema,
  listExchangeRatesSchema,
  updateExchangeRateSchema,
  type CreateExchangeRateInput,
  type ExchangeRateRow,
  type ListExchangeRatesInput,
  type UpdateExchangeRateInput,
} from '../schemas/exchange-rate.ts';
import { formatRate, rateFromDecimal, rateToDecimalString } from '../schemas/money.ts';
import { fillMissingFx, fxUsage, recalculateFx } from './fx.ts';
import { SETTINGS_ID } from './settings.service.ts';
import { guardUnique } from './unique.ts';

/*
 * Monthly exchange rates (M12 Decision 1). Admins manage them; everyone reads them, since
 * detail pages show the INR equivalent of a USD amount. Adding a month's rate fills the
 * records of that month that had no INR value, in the same request and audit trail; editing
 * a rate leaves stored values alone until an admin recalculates the month (Decision 2).
 */

type RateRecord = {
  id: string;
  currency: string;
  month: Date;
  inrPerUnit: { toString(): string };
  updatedAt: Date;
};

const rateSelect = { id: true, currency: true, month: true, inrPerUnit: true, updatedAt: true };

const monthText = (month: Date) => month.toISOString().slice(0, 7);

async function toRow(db: Db, row: RateRecord): Promise<ExchangeRateRow> {
  const micros = rateFromDecimal(row.inrPerUnit);
  const usage = await fxUsage(db, row.currency, row.month, micros);
  return {
    id: row.id,
    currency: row.currency,
    month: monthText(row.month),
    rate: formatRate(micros),
    ...usage,
    updatedAt: row.updatedAt,
  };
}

async function findRate(db: Db, id: string): Promise<RateRecord> {
  const row = await db.exchangeRate.findFirst({ where: { id }, select: rateSelect });
  if (!row) throw new NotFoundError('exchange rate');
  return row;
}

/** Newest month first. */
export async function listExchangeRates(
  ctx: Ctx,
  input: ListExchangeRatesInput = {},
): Promise<ExchangeRateRow[]> {
  const { currency } = listExchangeRatesSchema.parse(input);
  assertCan(ctx, 'list', 'exchangeRate');
  const db = getDb();
  const rows = await db.exchangeRate.findMany({
    where: currency ? { currency } : {},
    select: rateSelect,
    orderBy: [{ month: 'desc' }, { currency: 'asc' }],
  });
  return Promise.all(rows.map((row) => toRow(db, row)));
}

/** Adds a month's rate, then gives records of that month without an INR value one. */
export async function createExchangeRate(
  ctx: Ctx,
  input: CreateExchangeRateInput,
): Promise<{ rate: ExchangeRateRow; filled: number }> {
  const { currency, month, rate } = createExchangeRateSchema.parse(input);
  assertCan(ctx, 'create', 'exchangeRate');
  return withTx(
    ctx,
    async (tx) => {
      const settings = await tx.companySettings.findUniqueOrThrow({
        where: { id: SETTINGS_ID },
        select: { enabledCurrencies: true },
      });
      if (!settings.enabledCurrencies.includes(currency)) {
        throw new DomainError(`${currency} is not enabled in company settings`, {
          field: 'currency',
        });
      }
      const duplicate = `${currency} already has a rate for ${monthText(month)}`;
      if (await tx.exchangeRate.findFirst({ where: { currency, month }, select: { id: true } })) {
        throw new DomainError(duplicate, { field: 'month' });
      }
      const row = await guardUnique('month', duplicate, () =>
        tx.exchangeRate.create({
          data: { currency, month, inrPerUnit: rateToDecimalString(rate) },
          select: rateSelect,
        }),
      );
      const filled = await fillMissingFx(tx, currency, month, rate);
      return { rate: await toRow(tx, row), filled };
    },
    BULK_TX,
  );
}

/**
 * Corrects a rate. Stored INR values keep the rate they were converted at; `stale` says how
 * many records Recalculate would change.
 */
export async function updateExchangeRate(
  ctx: Ctx,
  id: string,
  input: UpdateExchangeRateInput,
): Promise<{ rate: ExchangeRateRow; stale: number }> {
  const { rate } = updateExchangeRateSchema.parse(input);
  assertCan(ctx, 'update', 'exchangeRate');
  return withTx(ctx, async (tx) => {
    await findRate(tx, id);
    const row = await tx.exchangeRate.update({
      where: { id },
      data: { inrPerUnit: rateToDecimalString(rate) },
      select: rateSelect,
    });
    const view = await toRow(tx, row);
    return { rate: view, stale: view.staleCount };
  });
}

/** Re-converts the month's records at the rate as it is now (an explicit admin action). */
export async function recalculateExchangeRate(ctx: Ctx, id: string): Promise<{ updated: number }> {
  assertCan(ctx, 'update', 'exchangeRate');
  return withTx(
    ctx,
    async (tx) => {
      const row = await findRate(tx, id);
      const updated = await recalculateFx(
        tx,
        row.currency,
        row.month,
        rateFromDecimal(row.inrPerUnit),
      );
      return { updated };
    },
    BULK_TX,
  );
}

/** Refused while records use it: their INR values would lose their source. */
export async function softDeleteExchangeRate(ctx: Ctx, id: string): Promise<void> {
  assertCan(ctx, 'delete', 'exchangeRate');
  await withTx(ctx, async (tx) => {
    const row = await findRate(tx, id);
    const { recordCount } = await fxUsage(
      tx,
      row.currency,
      row.month,
      rateFromDecimal(row.inrPerUnit),
    );
    if (recordCount > 0) {
      throw new DomainError(
        `${recordCount} ${recordCount === 1 ? 'record uses' : 'records use'} this rate`,
      );
    }
    const { count } = await tx.exchangeRate.updateMany({
      where: { id, deletedAt: null },
      data: { deletedAt: new Date() },
    });
    if (count === 0) throw new NotFoundError('exchange rate');
  });
}
