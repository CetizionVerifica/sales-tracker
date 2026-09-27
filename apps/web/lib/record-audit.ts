import { can, listAuditLog, type Ctx } from '@sales-tracker/core';
import type { AuditRowView } from '@/components/audit/AuditLogTable';

/** The latest 50 audit rows of one record, shaped for the Audit tab (scoped by M2). */
export async function loadRecordAudit(
  ctx: Ctx,
  entityType: string,
  entityId: string,
): Promise<{ rows: AuditRowView[]; ownOnly: boolean }> {
  const result = await listAuditLog(ctx, { entityType, entityId, page: 1, pageSize: 50 });
  return {
    ownOnly: !can(ctx.user, 'list', 'user'),
    rows: result.items.map((row) => ({
      id: row.id,
      createdAt: row.createdAt.toISOString(),
      actor: row.actor.name,
      action: row.action,
      source: row.source,
      entityType: row.entityType,
      entityId: row.entityId,
      changedFields: row.changedFields,
      before: row.before as Record<string, unknown> | null,
      after: row.after as Record<string, unknown> | null,
    })),
  };
}
