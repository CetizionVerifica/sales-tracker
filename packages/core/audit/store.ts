import { AsyncLocalStorage } from 'node:async_hooks';
import type { Ctx } from '../context.ts';

/** What the audit extension needs to know about the current call (M2 Decision 1). */
export interface AuditStore {
  ctx: Ctx;
  /** One UUID per withTx call; groups the audit rows of one action. */
  requestId: string;
  /** The active interactive-transaction client; audited writes require it. */
  tx?: unknown;
}

const storage = new AsyncLocalStorage<AuditStore>();

export function getStore(): AuditStore | undefined {
  return storage.getStore();
}

/**
 * Prisma query promises are lazy: they execute when `.then` is called. Calling it inside
 * the storage scope makes the query (and the audit hook) see this store, even when `fn`
 * returns the promise without awaiting it.
 */
function runScoped<T>(store: AuditStore, fn: () => T): T {
  return storage.run(store, () => {
    const result = fn();
    const thenable = result as { then?: unknown };
    if (result && typeof thenable.then === 'function') {
      return (result as unknown as PromiseLike<unknown>).then((value) => value) as T;
    }
    return result;
  });
}

export function runInStore<T>(store: AuditStore, fn: () => T): T {
  return runScoped(store, fn);
}

/**
 * Sets the acting context without a transaction. Reads work; audited writes still need
 * withTx and will throw AuditContextError here.
 */
export function runWithCtx<T>(ctx: Ctx, fn: () => T): T {
  return runScoped({ ctx, requestId: crypto.randomUUID() }, fn);
}
