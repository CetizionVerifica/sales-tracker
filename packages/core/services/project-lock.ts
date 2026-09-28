import type { Db } from '../clients.ts';

/**
 * A transaction-scoped advisory lock on one project (M9): creating or restoring a PO, and
 * deleting or cancelling its project, take it first, so a PO can never land on a project
 * whose delete or cancel committed meanwhile. It is a lock, not a write (no audit row), and
 * is released when the transaction ends. Lock order: the project first, then anything on
 * its POs (M10 must follow this). Call it only inside withTx.
 */
export async function lockProject(tx: Db, projectId: string): Promise<void> {
  // SELECT … FROM keeps the result deserialisable (pg_advisory_xact_lock returns void).
  await tx.$queryRaw`SELECT 1 AS locked FROM pg_advisory_xact_lock(hashtextextended(${`project:${projectId}`}, 0))`;
}
