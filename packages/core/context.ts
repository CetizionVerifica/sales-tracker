import { getStore, runInStore } from './audit/store.ts';
import { getAuth } from './auth/auth.ts';
import { getDb, getRootDb, type Db } from './clients.ts';
import { ForbiddenError, UnauthenticatedError } from './errors.ts';
import { can } from './rbac/can.ts';
import type { Action, Actor, Resource } from './rbac/types.ts';
import { SYSTEM_USER_EMAIL } from './system/constants.ts';

export type { Actor } from './rbac/types.ts';
export type { Db } from './clients.ts';
export { runWithCtx } from './audit/store.ts';

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

/**
 * Runs `fn` in one interactive transaction with `ctx` as the acting user. Every audited write
 * must happen inside it (M2: the audit rows commit or roll back with the change). A nested
 * call joins the outer transaction and keeps its requestId.
 */
export async function withTx<T>(ctx: Ctx, fn: (tx: Db) => Promise<T>): Promise<T> {
  const outer = getStore();
  if (outer?.tx) return runInStore({ ...outer, ctx }, () => fn(outer.tx as Db));

  const requestId = crypto.randomUUID();
  return getRootDb().$transaction((tx) =>
    runInStore({ ctx, requestId, tx }, () => fn(tx as unknown as Db)),
  );
}

/**
 * The context for background jobs and system tasks: the seeded system user, source "system".
 * Looked up per call (one indexed read) so it is never stale after a database reset.
 */
export async function systemCtx(): Promise<Ctx> {
  const system = await getDb().user.findUnique({
    where: { email: SYSTEM_USER_EMAIL },
    select: { id: true, role: true, active: true, isSystem: true },
  });
  if (!system?.isSystem) {
    throw new Error('The system user does not exist; run `pnpm db:seed` first');
  }
  return { user: { id: system.id, role: system.role, active: system.active }, source: 'system' };
}

/** Bulk import (M13) acts as the importing user, recorded with source "import". */
export function importCtx(ctx: Ctx): Ctx {
  return { ...ctx, source: 'import' };
}
