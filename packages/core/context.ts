import { getAuth } from './auth/auth.ts';
import { getDb } from './clients.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';
import { can } from './rbac/can.ts';
import type { Action, Actor, Resource } from './rbac/types.ts';

export type { Actor } from './rbac/types.ts';

/** Where a request came from; recorded on every audit row (CLAUDE.md rule 3). */
export type Source = 'web' | 'mcp' | 'import' | 'system';

/** The acting user plus request source: the first argument of every service (rule 2). */
export interface Ctx {
  user: Actor;
  source: Source;
}

/** Every service calls this first. Throws ForbiddenError when can() says no. */
export function assertCan(ctx: Ctx, action: Action, resource: Resource): void {
  if (!can(ctx.user, action, resource)) {
    throw new ForbiddenError(action, typeof resource === 'string' ? resource : resource.type);
  }
}

/**
 * Builds the acting context from request headers (session cookie). The user is re-read from
 * the database so role and active changes apply immediately, not at session expiry.
 */
export async function getCtxFromHeaders(headers: Headers, source: Source): Promise<Ctx> {
  const session = await getAuth().api.getSession({ headers });
  if (!session) throw new UnauthenticatedError();

  const user = await getDb().user.findUnique({
    where: { id: session.user.id },
    select: { id: true, role: true, active: true, isSystem: true },
  });
  if (!user || !user.active || user.isSystem) throw new UnauthenticatedError();

  return { user: { id: user.id, role: user.role, active: user.active }, source };
}
