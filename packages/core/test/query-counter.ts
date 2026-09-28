import { randomUUID } from 'node:crypto';
import { runInStore } from '../audit/store.ts';
import { getRootDb } from '../clients.ts';
import type { Ctx } from '../context.ts';

/*
 * Test-only: counts the database round trips a read makes, so a performance test can assert
 * a fixed number of queries whatever the data size (no query per row). M11 and M12 use it.
 */

/** Runs `fn` with getDb() returning a client that counts model calls and raw queries. */
export async function countQueries<T>(
  ctx: Ctx,
  fn: () => Promise<T>,
): Promise<{ result: T; queries: number }> {
  const root = getRootDb();
  let queries = 0;
  const counted = new Proxy(root, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (property === '$queryRaw' && typeof value === 'function') {
        return (...args: unknown[]) => {
          queries += 1;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      if (
        typeof property === 'string' &&
        !property.startsWith('$') &&
        value &&
        typeof value === 'object'
      ) {
        return new Proxy(value, {
          get(delegate, method, r) {
            const fnValue = Reflect.get(delegate, method, r) as unknown;
            if (typeof fnValue !== 'function') return fnValue;
            return (...args: unknown[]) => {
              queries += 1;
              return (fnValue as (...a: unknown[]) => unknown).apply(delegate, args);
            };
          },
        });
      }
      return value;
    },
  });
  const result = await runInStore({ ctx, requestId: randomUUID(), tx: counted }, fn);
  return { result, queries };
}
