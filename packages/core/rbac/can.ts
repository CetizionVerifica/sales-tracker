import { policy } from './policy.ts';
import type { Action, Actor, InstanceOf, Resource, ResourceType } from './types.ts';

// Resources without ownership fields: the type alone is a complete instance.
const OWNERLESS = new Set<ResourceType>(['master', 'settings', 'apiToken']);

/** Audit rows are append-only for everyone; the M2 extension writes them directly. */
const AUDIT_IMMUTABLE = new Set<Action>(['create', 'update', 'delete']);

/**
 * The single permission check (CLAUDE.md RBAC). Pure and synchronous: callers load the
 * ownership fields the resource needs before calling.
 */
export function can(user: Actor, action: Action, resource: Resource): boolean {
  if (!user.active) return false;

  const type = typeof resource === 'string' ? resource : resource.type;
  if (type === 'auditLog' && AUDIT_IMMUTABLE.has(action)) return false;
  if (user.role === 'ADMIN') return true;

  const instance =
    typeof resource === 'string' ? (OWNERLESS.has(type) ? { type } : undefined) : resource;
  const rule = policy[type] as (
    user: Actor,
    action: Action,
    instance: InstanceOf<typeof type> | undefined,
  ) => boolean;
  return rule(user, action, instance as InstanceOf<typeof type> | undefined);
}
