import { Prisma } from '@sales-tracker/db';
import { getDb } from '../../clients.ts';
import { withTx, type Ctx } from '../../context.ts';
import { ForbiddenError } from '../../errors.ts';
import { softDeleteClient } from '../../services/client.service.ts';
import { softDeleteEnquiry } from '../../services/enquiry.service.ts';

export interface RollbackResult {
  undone: number;
  /** Enquiries edited after the import; undo skipped them unless `force` was set. */
  blocked: { rowId: string; enquiryId: string }[];
}

interface ResultRecordIds {
  enquiryId: string;
  clientId: string;
  clientCreated: boolean;
}

/**
 * Undoes a committed batch (M10b "Commit and undo"): soft-deletes every record it created.
 * Phase 1 has no update-existing mode, so undo is always a plain soft-delete — there is no
 * `before` state to restore. A record edited after the import (its `updatedAt` moved past
 * `committedAt`) blocks undo for that row unless `force` is set ("Undo the rest"). Each
 * soft-delete still goes through `softDeleteEnquiry`, so an importer undoing their own
 * batch is bound by the same ownership rule as deleting it by hand (CLAUDE.md rule 2) —
 * if a row's owner was set to someone else during import, only an admin can undo it.
 */
export async function rollbackBatch(
  ctx: Ctx,
  batchId: string,
  options: { force?: boolean } = {},
): Promise<RollbackResult> {
  const batch = await getDb().importBatch.findUniqueOrThrow({ where: { id: batchId } });
  const rows = await getDb().importRow.findMany({
    where: { batchId, resultRecordIds: { not: Prisma.DbNull } },
    orderBy: { rowNumber: 'asc' },
  });

  let undone = 0;
  const blocked: { rowId: string; enquiryId: string }[] = [];
  const createdClientIds = new Set<string>();

  for (const row of rows) {
    const result = row.resultRecordIds as ResultRecordIds | null;
    if (!result?.enquiryId) continue;

    const enquiry = await getDb().enquiry.findFirst({
      where: { id: result.enquiryId },
      select: { updatedAt: true, deletedAt: true },
    });
    if (!enquiry || enquiry.deletedAt) continue; // already gone

    if (batch.committedAt && enquiry.updatedAt > batch.committedAt && !options.force) {
      blocked.push({ rowId: row.id, enquiryId: result.enquiryId });
      continue;
    }

    await softDeleteEnquiry(ctx, result.enquiryId);
    undone++;
    if (result.clientCreated) createdClientIds.add(result.clientId);
  }

  for (const clientId of createdClientIds) {
    const stillUsed = await getDb().enquiry.findFirst({ where: { clientId, deletedAt: null } });
    if (stillUsed) continue;
    try {
      await softDeleteClient(ctx, clientId);
    } catch (error) {
      // Sales can never delete a client (M3 policy) — the auto-created client just stays.
      if (!(error instanceof ForbiddenError)) throw error;
    }
  }

  // Only mark the batch UNDONE once every one of its records was actually reversed — if
  // some were blocked, the batch stays COMMITTED so a later retry (or an admin "force") can
  // still act on it, rather than looking undone while records it created still exist.
  if (blocked.length === 0) {
    await withTx(ctx, (tx) =>
      tx.importBatch.update({ where: { id: batchId }, data: { status: 'UNDONE', undoneAt: new Date() } }),
    );
  }

  return { undone, blocked };
}
