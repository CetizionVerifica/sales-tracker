import { getDb } from '../clients.ts';
import { assertCan, type Ctx } from '../context.ts';
import { NotFoundError } from '../errors.ts';
import { scopeAuditLog } from '../rbac/scope.ts';
import type { Page } from '../schemas/common.ts';
import {
  auditEntryIdSchema,
  listAuditLogSchema,
  type ListAuditLogInput,
} from '../schemas/audit-log.ts';

const auditEntrySelect = {
  id: true,
  action: true,
  source: true,
  entityType: true,
  entityId: true,
  before: true,
  after: true,
  changedFields: true,
  requestId: true,
  createdAt: true,
  actorId: true,
  actor: { select: { id: true, name: true, email: true } },
} as const;

type AuditEntry = Awaited<ReturnType<typeof findEntries>>[number];

function findEntries(where: object, skip: number, take: number) {
  return getDb().auditLog.findMany({
    where,
    select: auditEntrySelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    skip,
    take,
  });
}

/** Audit rows, newest first. Admins see all; others only their own changes (scopeAuditLog). */
export async function listAuditLog(ctx: Ctx, input: ListAuditLogInput): Promise<Page<AuditEntry>> {
  const { page, pageSize, entityType, entityId, actorId, from, to } =
    listAuditLogSchema.parse(input);
  assertCan(ctx, 'list', 'auditLog');

  const where = {
    AND: [
      scopeAuditLog(ctx.user), // always applied, so filters can only narrow the scope
      {
        entityType,
        entityId,
        actorId,
        createdAt: from || to ? { gte: from, lte: to } : undefined,
      },
    ],
  };
  const [items, total] = await Promise.all([
    findEntries(where, (page - 1) * pageSize, pageSize),
    getDb().auditLog.count({ where }),
  ]);
  return { items, total, page, pageSize };
}

export async function getAuditEntry(ctx: Ctx, id: string): Promise<AuditEntry> {
  const entryId = auditEntryIdSchema.parse(id);
  // The actor is the ownership field can() needs, so it is loaded before the check.
  const entry = await getDb().auditLog.findUnique({
    where: { id: entryId },
    select: auditEntrySelect,
  });
  if (!entry) throw new NotFoundError('auditLog');
  assertCan(ctx, 'read', { type: 'auditLog', actorId: entry.actorId });
  return entry;
}
