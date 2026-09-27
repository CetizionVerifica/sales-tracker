import type { Role } from '@sales-tracker/db';
import type { Action, Actor, InstanceOf, ResourceType } from './types.ts';

/**
 * Non-admin rules, one entry per resource, mirroring the PLAN.md role table and the
 * M1 spec Decisions. `instance` is undefined for type-level checks (create/list).
 * ADMIN and inactive users are handled in can() before these rules run.
 */
type Rule<T extends ResourceType> = (
  user: Actor,
  action: Action,
  instance: InstanceOf<T> | undefined,
) => boolean;

/**
 * Shared shape for owned records: the listed actions are allowed; `list` is scoped later by
 * scopeWhere; `create` without an instance is a type-level check; everything else needs an
 * instance that belongs to the user.
 */
function owned<I>(
  action: Action,
  instance: I,
  allowed: readonly Action[],
  isMine: (instance: NonNullable<I>) => boolean,
): boolean {
  if (!allowed.includes(action)) return false;
  if (action === 'list') return true;
  if (instance === undefined || instance === null) return action === 'create';
  return isMine(instance);
}

const CRUD = ['create', 'read', 'update', 'delete', 'list'] as const;
const READ_ONLY = ['read', 'list'] as const;

const DASHBOARD_SCOPE: Record<Role, InstanceOf<'dashboard'>['scope'] | null> = {
  ADMIN: null, // admins may view every scope
  SALES: 'personal',
  PROJECT_MANAGER: 'project',
};

export const policy: { [T in ResourceType]: Rule<T> } = {
  user: (user, action, i) => action === 'read' && i?.id === user.id,

  // Decision 2: everyone reads masters and settings; only admins manage them.
  master: (_user, action) => action === 'read' || action === 'list',
  settings: (_user, action) => action === 'read',

  // M3 Decision 11: everyone reads clients; Sales may also create them (not change them).
  client: (user, action) =>
    action === 'read' || action === 'list' || (action === 'create' && user.role === 'SALES'),

  // Own changes only. Rows are written by the M2 audit extension, never through can().
  auditLog: (user, action, i) => owned(action, i, READ_ONLY, (row) => row.actorId === user.id),

  apiToken: () => false,

  enquiry: (user, action, i) =>
    user.role === 'SALES'
      ? owned(action, i, CRUD, (row) => row.ownerId === user.id)
      : owned(action, i, READ_ONLY, (row) => row.projectManagerIds.includes(user.id)),

  quotation: (user, action, i) =>
    user.role === 'SALES'
      ? owned(action, i, CRUD, (row) => row.ownerId === user.id)
      : owned(action, i, READ_ONLY, (row) => row.projectManagerIds.includes(user.id)),

  // Decisions 1 and 3: Sales create projects from their own quotations and read them;
  // PMs read and update projects assigned to them.
  project: (user, action, i) =>
    user.role === 'SALES'
      ? owned(action, i, ['create', 'read', 'list'], (row) => row.quotationOwnerId === user.id)
      : owned(action, i, ['read', 'update', 'list'], (row) => row.managerId === user.id),

  purchaseOrder: (user, action, i) =>
    user.role === 'SALES'
      ? owned(action, i, CRUD, (row) => row.pipelineOwnerId === user.id)
      : owned(action, i, CRUD, (row) => row.projectManagerId === user.id),

  invoice: (user, action, i) =>
    user.role === 'SALES'
      ? owned(action, i, CRUD, (row) => row.pipelineOwnerId === user.id)
      : owned(action, i, CRUD, (row) => row.projectManagerId === user.id),

  // M5 Decision 4: read follows the linked record; logging needs read access to it
  // (Decision 10); only the author edits or deletes.
  followUp: (user, action, i) => {
    if (action === 'list') return true;
    if (i === undefined) return action === 'create';
    const mine = i.userId === user.id;
    if (action === 'read') return mine || i.canReadLinked;
    if (action === 'create') return mine && i.canReadLinked;
    return mine;
  },

  // M7 Decision 4: view with read on the record; upload, re-run, confirm and delete with
  // update on it. Type-level create/list pass; the service checks the record.
  document: (_user, action, i) => {
    if (i === undefined) return action === 'create' || action === 'list';
    if (action === 'read' || action === 'list') return i.canReadParent;
    return i.canUpdateParent;
  },

  dashboard: (user, action, i) =>
    action === 'read' && i !== undefined && i.scope === DASHBOARD_SCOPE[user.role],
};
