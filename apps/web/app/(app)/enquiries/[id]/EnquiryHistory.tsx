import { listAuditLog, type Ctx } from '@sales-tracker/core';
import { formatDateTime } from '@/lib/format';

const ACTION_LABELS: Record<string, string> = {
  CREATE: 'Created',
  UPDATE: 'Updated',
  SOFT_DELETE: 'Deleted',
  RESTORE: 'Restored',
  DELETE: 'Removed',
};

/** Readable names for changed columns; bookkeeping columns are left out. */
const FIELD_LABELS: Record<string, string> = {
  clientId: 'client',
  sectorId: 'sector',
  ownerId: 'owner',
  receivedDate: 'received date',
  proposalSentDate: 'proposal sent date',
  source: 'source',
  sourceDetail: 'source details',
  description: 'description',
  status: 'status',
  lostReason: 'lost reason',
};

/**
 * Recent changes to this enquiry from the audit log. M2's scope applies: admins see every
 * change, others only their own. The full client timeline is M5.
 */
export async function EnquiryHistory({ ctx, enquiryId }: { ctx: Ctx; enquiryId: string }) {
  const { items } = await listAuditLog(ctx, {
    entityType: 'Enquiry',
    entityId: enquiryId,
    pageSize: 20,
  });
  if (items.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-semibold">History</h2>
      <ul className="flex flex-col gap-1 text-sm">
        {items.map((entry) => {
          const fields = entry.changedFields.flatMap((f) => FIELD_LABELS[f] ?? []);
          return (
            <li key={entry.id} className="flex flex-wrap gap-x-2">
              <span className="text-muted-foreground">{formatDateTime(entry.createdAt)}</span>
              <span className="font-medium">{entry.actor.name}</span>
              <span>{ACTION_LABELS[entry.action] ?? entry.action}</span>
              {entry.action === 'UPDATE' && fields.length > 0 && (
                <span className="text-muted-foreground">{fields.join(', ')}</span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
