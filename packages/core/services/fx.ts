import type { Db } from '../clients.ts';
import { rateFromDecimal, rateToDecimalString, toInrMinor } from '../schemas/money.ts';

/*
 * INR equivalents (M12 Decision 1). Quotations, projects, POs and invoices store
 * `amountInrMinor` and the `fxRate` used: 1 for INR, else the admin-entered rate for the
 * month of the record's own date, or null while no rate exists. Not exported from the
 * package: callers pass a transaction and have checked permissions.
 *
 * A stored value changes only when its record's amount, currency or date changes, or when an
 * admin fills or recalculates a month (Decision 2); editing a rate never rewrites history.
 */

export interface FxFields {
  /** A decimal string for Prisma's `Decimal` column, or null. */
  fxRate: string | null;
  amountInrMinor: bigint | null;
}

export const monthOf = (day: Date) =>
  new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), 1));
const nextMonth = (month: Date) =>
  new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));

/** The live rate (micro-units) for a currency in the month of `day`, if any. */
export async function rateFor(db: Db, currency: string, day: Date): Promise<bigint | null> {
  const row = await db.exchangeRate.findFirst({
    where: { currency, month: monthOf(day) },
    select: { inrPerUnit: true },
  });
  return row ? rateFromDecimal(row.inrPerUnit) : null;
}

function fieldsAt(amountMinor: bigint, currency: string, rate: bigint | null): FxFields {
  if (currency === 'INR') return { fxRate: '1', amountInrMinor: amountMinor };
  if (rate === null) return { fxRate: null, amountInrMinor: null };
  return {
    fxRate: rateToDecimalString(rate),
    amountInrMinor: toInrMinor(amountMinor, currency, rate),
  };
}

/** The INR pair for a new record. */
export async function fxFields(
  db: Db,
  amountMinor: bigint,
  currency: string,
  day: Date,
): Promise<FxFields> {
  return fieldsAt(
    amountMinor,
    currency,
    currency === 'INR' ? null : await rateFor(db, currency, day),
  );
}

type Money = { amountMinor: bigint; currency: string; day: Date };

/**
 * The INR pair to merge into an update, or `{}` when neither the amount, the currency nor
 * the record's date changes (so an unrelated edit leaves it, and its audit row, alone).
 */
export async function fxOnChange(
  db: Db,
  before: Money,
  after: Partial<Money>,
): Promise<Partial<FxFields>> {
  const next: Money = {
    amountMinor: after.amountMinor ?? before.amountMinor,
    currency: after.currency ?? before.currency,
    day: after.day ?? before.day,
  };
  const changed =
    next.amountMinor !== before.amountMinor ||
    next.currency !== before.currency ||
    monthOf(next.day).getTime() !== monthOf(before.day).getTime();
  return changed ? fxFields(db, next.amountMinor, next.currency, next.day) : {};
}

// ─── Filling and recalculating a month ─────────────────────────────────────────────

/** How each model finds its records in a currency and month, and reads their amount. */
const MODELS = {
  quotation: {
    where: (currency: string, from: Date, to: Date) => ({
      currency,
      deletedAt: undefined,
      quotationDate: { gte: from, lt: to },
    }),
    select: { id: true, amountMinor: true, fxRate: true },
  },
  purchaseOrder: {
    where: (currency: string, from: Date, to: Date) => ({
      currency,
      deletedAt: undefined,
      receivedDate: { gte: from, lt: to },
    }),
    select: { id: true, amountMinor: true, fxRate: true },
  },
  invoice: {
    where: (currency: string, from: Date, to: Date) => ({
      currency,
      deletedAt: undefined,
      invoiceDate: { gte: from, lt: to },
    }),
    select: { id: true, amountMinor: true, fxRate: true },
  },
  // A project has no date of its own: its revenue converts at its quotation's PO month.
  project: {
    where: (currency: string, from: Date, to: Date) => ({
      currency,
      deletedAt: undefined,
      quotation: { poReceivedDate: { gte: from, lt: to } },
    }),
    select: { id: true, revenueMinor: true, fxRate: true },
  },
} as const;

type ModelName = keyof typeof MODELS;
type Row = {
  id: string;
  amountMinor?: bigint;
  revenueMinor?: bigint;
  fxRate: { toString(): string } | null;
};

/** The four models behind one loosely typed facade (their delegates differ only in types). */
function delegate(db: Db, model: ModelName) {
  return db[model] as unknown as {
    findMany(args: { where: unknown; select: unknown }): Promise<Row[]>;
    count(args: { where: unknown }): Promise<number>;
    update(args: { where: { id: string }; data: FxFields }): Promise<unknown>;
  };
}

const amountOf = (model: ModelName, row: Row) =>
  model === 'project' ? row.revenueMinor! : row.amountMinor!;

async function rowsIn(db: Db, currency: string, month: Date, extra: object) {
  const out: { model: ModelName; row: Row }[] = [];
  for (const model of Object.keys(MODELS) as ModelName[]) {
    const spec = MODELS[model];
    const rows = await delegate(db, model).findMany({
      where: { ...spec.where(currency, month, nextMonth(month)), ...extra },
      select: spec.select,
    });
    for (const row of rows) out.push({ model, row });
  }
  return out;
}

/** Records in the currency and month that have no INR value yet, set at `rate`. */
export async function fillMissingFx(db: Db, currency: string, month: Date, rate: bigint) {
  const rows = await rowsIn(db, currency, month, { fxRate: null });
  for (const { model, row } of rows) {
    await delegate(db, model).update({
      where: { id: row.id },
      data: fieldsAt(amountOf(model, row), currency, rate),
    });
  }
  return rows.length;
}

/** Records in the currency and month converted at a rate other than `rate`, re-converted. */
export async function recalculateFx(db: Db, currency: string, month: Date, rate: bigint) {
  const rows = (await rowsIn(db, currency, month, {})).filter(
    ({ row }) => row.fxRate === null || rateFromDecimal(row.fxRate) !== rate,
  );
  for (const { model, row } of rows) {
    await delegate(db, model).update({
      where: { id: row.id },
      data: fieldsAt(amountOf(model, row), currency, rate),
    });
  }
  return rows.length;
}

/** How many records use a month's rate, and how many were converted at another one. */
export async function fxUsage(db: Db, currency: string, month: Date, rate: bigint) {
  const rows = (await rowsIn(db, currency, month, { fxRate: { not: null } })).map(({ row }) => row);
  return {
    recordCount: rows.length,
    staleCount: rows.filter((row) => rateFromDecimal(row.fxRate!) !== rate).length,
  };
}
