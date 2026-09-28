import { getDb } from '../clients.ts';
import type { Ctx } from '../context.ts';
import { NotFoundError } from '../errors.ts';

/**
 * Rebuilds the importing user's ctx from their id, source `import`. Worker jobs have no
 * HTTP session to read (`getCtxFromHeaders`), but every RBAC check and audit row for a
 * commit must still reflect the real importing user (CLAUDE.md rule 2), not the system
 * actor — a Sales user's commit must still be denied ownership it isn't allowed, exactly
 * as if they had run each create themselves.
 */
export async function actorCtxFor(userId: string): Promise<Ctx> {
  const user = await getDb().user.findUnique({
    where: { id: userId },
    select: { id: true, role: true, active: true },
  });
  if (!user) throw new NotFoundError('user');
  return { user: { id: user.id, role: user.role, active: user.active }, source: 'import' };
}
