import type { z } from 'zod';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * URL search params → validated list input. Invalid values fall back to the schema defaults
 * (a hand-edited URL should never crash a page); unknown params are ignored.
 */
export function parseListParams<S extends z.ZodObject>(
  params: SearchParams,
  schema: S,
): z.output<S> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined && key in schema.shape) flat[key] = first;
  }
  const parsed = schema.safeParse(flat);
  if (parsed.success) return parsed.data;
  // Drop only the offending keys and retry, so one bad param doesn't reset the rest.
  for (const issue of parsed.error.issues) delete flat[String(issue.path[0])];
  return schema.parse(flat);
}

/** A query string from list state, dropping empty values. */
export function toSearch(state: Record<string, string | number | undefined | null>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(state)) {
    if (value !== undefined && value !== null && value !== '') params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : '';
}

/** URL params that are view state (paging, sorting), not filters. */
const VIEW_PARAMS = new Set(['page', 'pageSize', 'sort', 'dir']);

/** The filter params a list URL carries (search included). */
export function filterKeys(params: SearchParams): string[] {
  return Object.keys(params).filter((key) => !VIEW_PARAMS.has(key) && params[key] !== undefined);
}

/** Whether the list is filtered by exactly `key=value` (a summary chip is active). */
export function isOnlyFilter(params: SearchParams, key: string, value: string): boolean {
  const keys = filterKeys(params);
  return keys.length === 1 && keys[0] === key && params[key] === value;
}
