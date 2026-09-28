import type { Db } from '../clients.ts';
import { DomainError } from '../errors.ts';
import { allocateProportional, formatMoney, parseAmount } from '../schemas/money.ts';

/*
 * One service's slice of a PO's amount (M12b schema change 1, R4's source of truth). A PO
 * with one service always gets one line for the full amount, set automatically; several
 * services split it, the user's numbers checked here to sum to the PO amount exactly. A
 * line's `amountInrMinor` is never independently rated: it is the PO's own INR equivalent
 * (M12 Decision 1), divided across the lines in proportion to their amount, so the lines
 * always sum back to the PO's value (`allocateProportional`, largest-remainder method).
 */

export interface LineInput {
  serviceId: string;
  /** A decimal string in the PO's currency, as `amount` on the PO itself. */
  amount: string;
}

export interface ParsedLine {
  serviceId: string;
  amountMinor: bigint;
}

export interface ResolvedLine extends ParsedLine {
  /** Set when nobody confirmed this split: an implicit equal split with `lines` omitted, or
   * the M12b data migration backfill. R4 foot notes estimated data (M12b Metric definitions). */
  allocationEstimated: boolean;
}

/** The equal split a PO form pre-fills for a new multi-service PO (M12b UI). */
export function deriveEqualSplit(serviceIds: readonly string[], totalMinor: bigint): bigint[] {
  return allocateProportional(
    totalMinor,
    serviceIds.map(() => 1n),
  );
}

/** Parses each line's amount in the PO's currency; reports the offending line by index. */
export function parseLines(lines: readonly LineInput[], currency: string): ParsedLine[] {
  return lines.map((line, index) => {
    const parsed = parseAmount(line.amount, currency);
    if (!parsed.ok) {
      throw new DomainError(parsed.message, { field: `lines.${index}.amount` });
    }
    if (parsed.value <= 0n) {
      throw new DomainError('Each line must be more than zero', {
        field: `lines.${index}.amount`,
      });
    }
    return { serviceId: line.serviceId, amountMinor: parsed.value };
  });
}

/** The lines cover exactly one of each service, and nothing outside the PO's services. */
export function assertLinesMatchServices(
  lines: readonly ParsedLine[],
  serviceIds: readonly string[],
) {
  const wanted = new Set(serviceIds);
  const covered = new Set(lines.map((l) => l.serviceId));
  if (lines.length !== covered.size) {
    throw new DomainError('Each service can have only one line', { field: 'lines' });
  }
  if (covered.size !== wanted.size || [...covered].some((id) => !wanted.has(id))) {
    throw new DomainError('The lines must match the PO’s services exactly', { field: 'lines' });
  }
}

/** The lines must sum to the PO's amount exactly (CLAUDE.md: schema change 1). */
export function assertLinesSum(lines: readonly ParsedLine[], totalMinor: bigint, currency: string) {
  const sum = lines.reduce((total, line) => total + line.amountMinor, 0n);
  if (sum !== totalMinor) {
    const diff = totalMinor - sum;
    const short = diff > 0n;
    throw new DomainError(
      `The lines ${short ? 'are short by' : 'exceed the PO amount by'} ${formatMoney(short ? diff : -diff, currency)}`,
      { field: 'lines' },
    );
  }
}

/**
 * What to write for a PO's lines: one row per service. One service always takes the full
 * amount (`lines` is ignored, so callers need not send it). Several services split the
 * user's numbers when given, checked to sum to the PO amount exactly; omitting `lines`
 * (a caller that does not offer a split, such as a bulk import) falls back to the same equal
 * split the form pre-fills, marked `allocationEstimated` since nobody confirmed it.
 */
export function resolveLines(input: {
  serviceIds: readonly string[];
  amountMinor: bigint;
  currency: string;
  lines: readonly LineInput[] | undefined;
}): ResolvedLine[] {
  const { serviceIds, amountMinor, currency, lines } = input;
  if (serviceIds.length === 1) {
    return [{ serviceId: serviceIds[0]!, amountMinor, allocationEstimated: false }];
  }
  if (!lines || lines.length === 0) {
    const shares = deriveEqualSplit(serviceIds, amountMinor);
    return serviceIds.map((serviceId, i) => ({
      serviceId,
      amountMinor: shares[i]!,
      allocationEstimated: true,
    }));
  }
  const parsed = parseLines(lines, currency);
  assertLinesMatchServices(parsed, serviceIds);
  assertLinesSum(parsed, amountMinor, currency);
  return parsed.map((line) => ({ ...line, allocationEstimated: false }));
}

/** Splits the PO's own INR pair across lines in proportion to their amount. */
function withLineFx<T extends ParsedLine>(
  lines: readonly T[],
  po: { amountInrMinor: bigint | null; fxRate: string | null },
): (T & { amountInrMinor: bigint | null; fxRate: string | null })[] {
  if (po.amountInrMinor === null || po.fxRate === null) {
    return lines.map((line) => ({ ...line, amountInrMinor: null, fxRate: null }));
  }
  const shares = allocateProportional(
    po.amountInrMinor,
    lines.map((l) => l.amountMinor),
  );
  return lines.map((line, i) => ({ ...line, amountInrMinor: shares[i]!, fxRate: po.fxRate }));
}

/** Replaces a PO's lines to match `lines` exactly, keeping a line's id when its service stays. */
export async function writeLines(
  tx: Db,
  purchaseOrderId: string,
  currency: string,
  lines: readonly ResolvedLine[],
  po: { amountInrMinor: bigint | null; fxRate: string | null },
): Promise<void> {
  const withFx = withLineFx(lines, po);
  const current = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId },
    select: { id: true, serviceId: true },
  });
  const byService = new Map(current.map((row) => [row.serviceId, row.id]));
  for (const line of withFx) {
    const existingId = byService.get(line.serviceId);
    byService.delete(line.serviceId);
    const data = {
      amountMinor: line.amountMinor,
      currency,
      amountInrMinor: line.amountInrMinor,
      fxRate: line.fxRate,
      allocationEstimated: line.allocationEstimated,
    };
    if (existingId) {
      await tx.purchaseOrderLine.update({ where: { id: existingId }, data });
    } else {
      await tx.purchaseOrderLine.create({
        data: { purchaseOrderId, serviceId: line.serviceId, ...data },
      });
    }
  }
  // Left in byService: services no longer on the PO.
  const removedIds = [...byService.values()];
  if (removedIds.length > 0) {
    await tx.purchaseOrderLine.deleteMany({ where: { id: { in: removedIds } } });
  }
}

/**
 * Re-splits a PO's stored `amountInrMinor` across its existing lines, unchanged in amount or
 * service (fx.ts calls this after filling or recalculating a month's rate, M12 Decision 2).
 */
export async function syncLineFx(tx: Db, purchaseOrderId: string): Promise<void> {
  const po = await tx.purchaseOrder.findUniqueOrThrow({
    where: { id: purchaseOrderId },
    select: { amountInrMinor: true, fxRate: true },
  });
  const lines = await tx.purchaseOrderLine.findMany({
    where: { purchaseOrderId },
    select: { id: true, serviceId: true, amountMinor: true },
  });
  if (lines.length === 0) return;
  const fxRate = po.fxRate === null ? null : po.fxRate.toString();
  const withFx = withLineFx(
    lines.map((l) => ({ serviceId: l.serviceId, amountMinor: l.amountMinor })),
    { amountInrMinor: po.amountInrMinor, fxRate },
  );
  for (const [i, line] of lines.entries()) {
    await tx.purchaseOrderLine.update({
      where: { id: line.id },
      data: { amountInrMinor: withFx[i]!.amountInrMinor, fxRate: withFx[i]!.fxRate },
    });
  }
}
