import { getMyToday } from '@sales-tracker/core';
import type { MyTodayKindGroup } from '@sales-tracker/core/schemas';
import { cache } from 'react';
import { requireUser } from '@/lib/auth';

// React's cache() matches on each argument in turn, so always pass the same two strings:
// `loadMyToday()` and `loadMyToday(undefined, undefined)` must hit the same entry.
const load = cache(async (userId: string, kind: string) => {
  const ctx = await requireUser();
  return getMyToday(ctx, {
    ...(userId && { userId }),
    ...(kind && { kind: kind as MyTodayKindGroup }),
  });
});

/**
 * My Today once per request (M11): the layout's nav badge and the /today page share the
 * result when the page shows the user's own, unfiltered list. A chip or an admin's Viewing
 * choice is a separate (and still single) computation.
 */
export function loadMyToday(userId?: string, kind?: MyTodayKindGroup) {
  return load(userId ?? '', kind ?? '');
}
