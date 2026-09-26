import { describe, expect, it } from 'vitest';
import { actor } from '../helpers.ts';

// Regression (found by the M3 E2E run): Next.js loads packages/core once per bundle layer.
// Two copies of the store module must share one AsyncLocalStorage, or the audit hook (from
// the copy that created the cached Prisma client) cannot see withTx's context.
describe('audit store is a process-wide singleton', () => {
  it('a second copy of the module sees the context set through the first', async () => {
    const first = await import('../../audit/store.ts');
    // A query string makes Vite evaluate a separate module instance. Built at runtime so
    // TypeScript does not try to resolve the query-suffixed path.
    const specifier = new URL('../../audit/store.ts?second-copy', import.meta.url).href;
    const second = (await import(/* @vite-ignore */ specifier)) as typeof first;
    expect(second).not.toBe(first);

    const ctx = { user: actor('ADMIN'), source: 'web' as const };
    const seen = first.runWithCtx(ctx, () => second.getStore()?.ctx);
    expect(seen).toEqual(ctx);
  });
});
