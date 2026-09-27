import { readFileSync } from 'node:fs';
import { disconnectAll, getDb } from '../clients.ts';
import { getEnv } from '../env.ts';
import { closeDocumentsQueue } from '../extraction/queue.ts';
import { uploadDocument } from '../services/document.service.ts';

/**
 * Development only (M7): attaches the sample quotation PDF to up to two open quotations
 * that have no document, through the real upload path (dev Cloudinary account, queue, and
 * the worker if it is running). Not part of `pnpm db:seed`, which must work offline.
 */
const env = getEnv();
const sample = new URL('../test/fixtures/documents/globex-quotation.pdf', import.meta.url);

try {
  if (env.NODE_ENV !== 'development') throw new Error('seed:documents runs in development only');
  const quotations = await getDb().quotation.findMany({
    where: { documentId: null, status: { in: ['SENT', 'UNDER_NEGOTIATION'] } },
    select: { id: true, number: true, owner: { select: { id: true, role: true, active: true } } },
    orderBy: { number: 'asc' },
    take: 2,
  });
  if (quotations.length === 0)
    console.log('seed:documents — no open quotations without a document');
  const bytes = new Uint8Array(readFileSync(sample));
  for (const q of quotations) {
    const ctx = { user: q.owner, source: 'system' as const };
    const doc = await uploadDocument(
      ctx,
      { kind: 'QUOTATION', entityId: q.id },
      {
        bytes,
        mimeType: 'application/pdf',
        filename: 'sample-quotation.pdf',
      },
    );
    console.log(`seed:documents — attached ${doc.originalFilename} to ${q.number}`);
  }
} catch (error) {
  console.error(`seed:documents failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await closeDocumentsQueue();
  await disconnectAll();
}
