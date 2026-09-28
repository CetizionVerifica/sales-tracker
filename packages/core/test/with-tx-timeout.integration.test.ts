import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { disconnectAll, getRootDb } from '../clients.ts';
import { BULK_TX, withTx } from '../context.ts';
import { ensureSystemCtx } from './helpers.ts';

// M12: bulk writes (the seed, a month of INR equivalents) get a longer transaction timeout;
// everything else keeps Prisma's default, and a nested call joins the outer transaction.

describe('withTx timeout', () => {
  afterEach(() => vi.restoreAllMocks());
  afterAll(disconnectAll);

  it('passes BULK_TX to Prisma, and nothing by default', async () => {
    const ctx = await ensureSystemCtx();
    const spy = vi.spyOn(getRootDb(), '$transaction');
    await withTx(ctx, async () => 1);
    await withTx(ctx, async () => 1, BULK_TX);
    expect(spy.mock.calls[0]![1]).toBeUndefined();
    expect(spy.mock.calls[1]![1]).toEqual({ timeout: 60_000, maxWait: 60_000 });
  });

  it('a nested call joins the outer transaction and ignores its own timeout', async () => {
    const ctx = await ensureSystemCtx();
    const spy = vi.spyOn(getRootDb(), '$transaction');
    await withTx(ctx, () => withTx(ctx, async () => 1, BULK_TX));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![1]).toBeUndefined();
  });
});
