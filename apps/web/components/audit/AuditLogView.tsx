import { auditedModels, listAuditLog, listUsers, type Ctx } from '@sales-tracker/core';
import { listAuditLogSchema } from '@sales-tracker/core/schemas';
import { ListToolbar } from '@/components/data-table/ListToolbar';
import { parseListParams, type SearchParams } from '@/lib/list-params';
import { AuditLogTable } from './AuditLogTable';
import { DateRangeFilter } from './DateRangeFilter';

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** A calendar day in IST → the UTC instant at its start (or end), for the date filters. */
function istBoundary(value: string | string[] | undefined, end: boolean): Date | undefined {
  const day = Array.isArray(value) ? value[0] : value;
  if (!day || !DAY.test(day)) return undefined;
  return new Date(`${day}T${end ? '23:59:59.999' : '00:00:00.000'}+05:30`);
}

/**
 * The audit viewer (M3 Decision 10). Admins see every change (/admin/audit-log); everyone
 * else sees only their own (/activity): listAuditLog applies M2's scope either way.
 */
export async function AuditLogView({
  ctx,
  searchParams,
  showActor,
}: {
  ctx: Ctx;
  searchParams: SearchParams;
  showActor: boolean;
}) {
  const params = parseListParams(searchParams, listAuditLogSchema);
  const input = {
    ...params,
    from: istBoundary(searchParams.from, false),
    to: istBoundary(searchParams.to, true),
  };
  const [result, users] = await Promise.all([
    listAuditLog(ctx, input),
    showActor ? listUsers(ctx, { page: 1, pageSize: 100 }) : null,
  ]);

  return (
    <section className="flex flex-col gap-4">
      <ListToolbar
        filters={[
          {
            param: 'entityType',
            label: 'Records',
            options: auditedModels().map((model) => ({ value: model, label: model })),
          },
          ...(users
            ? [
                {
                  param: 'actorId',
                  label: 'People',
                  options: users.items.map((u) => ({ value: u.id, label: u.name })),
                },
              ]
            : []),
        ]}
      >
        <DateRangeFilter />
      </ListToolbar>
      <AuditLogTable
        showActor={showActor}
        rows={result.items.map((row) => ({
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
        }))}
        total={result.total}
        page={result.page}
        pageSize={result.pageSize}
      />
    </section>
  );
}
