import { importCtx, withTx, type Ctx } from '../../context.ts';
import { DomainError } from '../../errors.ts';
import type { EnquirySourceValue } from '../../schemas/enquiry.ts';
import { createClient } from '../../services/client.service.ts';
import { createEnquiry } from '../../services/enquiry.service.ts';
import type { ResolvedEnquiryRow } from '../validate/rows.ts';

export interface CommitResult {
  created: number;
  skippedDuplicates: number;
}

/**
 * The all-or-nothing commit transaction (M10b "Commit and undo"). Runs as the importing
 * user, source forced to `import`: every record is created through the same
 * `createClient`/`createEnquiry` core services the regular forms use, so RBAC, the enquiry
 * number sequence, `amountInrMinor`-style derived fields (N/A for Enquiry) and the audit
 * log all behave exactly as a manual create would. `WARNING` rows (a possible duplicate)
 * are still committed — only `DUPLICATE` rows (an exact repeat) are skipped, matching
 * phase 1's "Add new only" mode.
 */
export async function commitBatch(ctx: Ctx, batchId: string): Promise<CommitResult> {
  const importingCtx = importCtx(ctx);
  let created = 0;
  let skippedDuplicates = 0;

  await withTx(
    importingCtx,
    async (tx) => {
      // Atomic claim (mirrors number-sequence.ts's pattern: a plain UPDATE takes the row
      // lock). A concurrent or retried commit of the same batch — e.g. a stray second job
      // run — finds `committedAt` already set and does nothing, so a batch is never
      // committed twice and no row is ever turned into two enquiries.
      const claim = await tx.importBatch.updateMany({
        where: { id: batchId, committedAt: null },
        data: { committedAt: new Date() },
      });
      if (claim.count === 0) return;

      const batch = await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } });
      const rows = await tx.importRow.findMany({
        where: { batchId, status: { in: ['READY', 'WARNING'] } },
        orderBy: { rowNumber: 'asc' },
      });
      skippedDuplicates = await tx.importRow.count({ where: { batchId, status: 'DUPLICATE' } });

      for (const row of rows) {
        const resolved = row.resolved as ResolvedEnquiryRow | null;
        if (!resolved) throw new DomainError(`Row ${row.rowNumber} was never validated`);

        let clientId = resolved.clientId;
        let clientCreated = false;
        if (!clientId && resolved.newClientName) {
          if (!resolved.sectorId) {
            throw new DomainError(`Row ${row.rowNumber} has no sector for the new client`);
          }
          const client = await createClient(importingCtx, {
            name: resolved.newClientName,
            sectorId: resolved.sectorId,
          });
          clientId = client.id;
          clientCreated = true;
          await tx.client.update({ where: { id: clientId }, data: { importBatchId: batchId } });
        }
        if (
          !clientId ||
          !resolved.sectorId ||
          !resolved.serviceIds?.length ||
          !resolved.source ||
          !resolved.receivedDate
        ) {
          throw new DomainError(`Row ${row.rowNumber} is missing required data`);
        }

        const enquiry = await createEnquiry(importingCtx, {
          clientId,
          sectorId: resolved.sectorId,
          serviceIds: resolved.serviceIds,
          receivedDate: resolved.receivedDate,
          proposalSentDate: resolved.proposalSentDate ?? undefined,
          source: resolved.source as EnquirySourceValue,
          sourceDetail: resolved.sourceDetail ?? undefined,
          description: resolved.description ?? undefined,
          ownerId: resolved.ownerId,
        });
        await tx.enquiry.update({ where: { id: enquiry.id }, data: { importBatchId: batchId } });

        await tx.importRow.update({
          where: { id: row.id },
          data: { resultRecordIds: { enquiryId: enquiry.id, clientId, clientCreated } },
        });
        created++;
      }

      // `counts` keeps its pre-commit ready/warning/error/duplicate/excluded breakdown
      // (service.ts's ImportCounts) and gains the commit result alongside it, rather than
      // replacing it — the result page shows both. `committedAt` is set again (now, after
      // every create) rather than trusting the claim's earlier timestamp, so it is never
      // earlier than a created record's `updatedAt` — undo's "edited since" check relies on
      // that ordering (rollback-batch.ts).
      const previousCounts = (batch.counts as Record<string, unknown> | null) ?? {};
      await tx.importBatch.update({
        where: { id: batchId },
        data: {
          status: 'COMMITTED',
          committedAt: new Date(),
          counts: { ...previousCounts, created, skippedDuplicates },
        },
      });
    },
    { timeoutMs: 60_000 },
  );

  return { created, skippedDuplicates };
}
