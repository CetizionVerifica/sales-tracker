import type { Db } from '../clients.ts';

/** `ENQ-2026-0042`: four digits, widening past 9999 instead of failing. */
export function formatNumber(prefix: string, year: number, value: number): string {
  return `${prefix}-${year}-${String(value).padStart(4, '0')}`;
}

/**
 * The next human-readable number for `prefix` in `year` (M4 Decision 9). Must run on the
 * caller's transaction client inside withTx, so a rolled-back create does not consume a
 * number and there are no gaps.
 *
 * Two statements, neither of which can fail on a race: the insert is ON CONFLICT DO NOTHING
 * (`skipDuplicates`), and the increment takes the row lock, so concurrent creates queue
 * behind each other. (A failed statement would abort the whole Postgres transaction, so
 * catch-and-retry is not an option here.) Both writes are audited like any other.
 */
export async function nextNumber(tx: Db, prefix: string, year: number): Promise<string> {
  const id = `${prefix}-${year}`;
  await tx.numberSequence.createMany({ data: [{ id, lastValue: 0 }], skipDuplicates: true });
  const { lastValue } = await tx.numberSequence.update({
    where: { id },
    data: { lastValue: { increment: 1 } },
    select: { lastValue: true },
  });
  return formatNumber(prefix, year, lastValue);
}
