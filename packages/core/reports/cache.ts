/*
 * The M12b sales reports' 5-minute cache, and the write-side of its invalidation. Kept
 * dependency-free (no imports) so `packages/core/audit/extension.ts` — itself a dependency of
 * `clients.ts`, which `reports/index.ts` needs for `getDb` — can call `notifyModelWrite` after
 * every audited write without creating an import cycle back through this package.
 */

export interface CachedReport {
  expires: number;
  value: unknown;
}

const CACHE_TTL_MS = 5 * 60_000;
const cache = new Map<string, CachedReport>();

/** Models whose writes make a cached report stale (M12b: "Invalidate on writes to
 * enquiries, POs or invoices"). Includes the tables that ride along with those writes. */
const WATCHED_MODELS = new Set([
  'Enquiry',
  'PurchaseOrder',
  'PurchaseOrderService',
  'PurchaseOrderLine',
  'Invoice',
]);

export function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry || entry.expires <= Date.now()) return undefined;
  return entry.value as T;
}

export function setCached<T>(key: string, value: T): void {
  cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
}

export function invalidateReportsCache(): void {
  cache.clear();
}

/** Called by the audit extension after a write to any audited model. */
export function notifyModelWrite(model: string): void {
  if (WATCHED_MODELS.has(model)) invalidateReportsCache();
}
