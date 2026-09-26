import { can, getCtxFromHeaders, UnauthenticatedError, type Ctx } from '@sales-tracker/core';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';

/** The real guard: validates the session against the database. Throws if signed out. */
export async function getCtx(): Promise<Ctx> {
  return getCtxFromHeaders(await headers(), 'web');
}

/** For pages and layouts: redirects to /login when there is no valid session. */
export async function requireUser(): Promise<Ctx> {
  try {
    return await getCtx();
  } catch (error) {
    if (error instanceof UnauthenticatedError) redirect('/login');
    throw error;
  }
}

/**
 * For admin pages. A layout that renders <Forbidden/> does not stop its page from running
 * (Next renders segments independently), so each admin page calls this first and returns
 * nothing for non-admins instead of querying services it may not use (M3 review fix C).
 */
export async function requireAdmin(): Promise<Ctx | null> {
  const ctx = await requireUser();
  return can(ctx.user, 'list', 'user') ? ctx : null;
}
