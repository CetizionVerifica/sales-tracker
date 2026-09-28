import type { DocumentKindValue } from '@sales-tracker/core/schemas';
import type { ActionResult } from './action-core.ts';

/**
 * Sends a file to the upload route (M7) from the browser; the reply has the server-action
 * result shape. Used by the Document card and the new-PO form (M9).
 */
export async function uploadDocumentFile(
  kind: DocumentKindValue,
  entityId: string,
  file: File,
): Promise<ActionResult<{ id: string }>> {
  const body = new FormData();
  body.set('kind', kind);
  body.set('entityId', entityId);
  body.set('file', file);
  try {
    const response = await fetch('/api/documents', { method: 'POST', body });
    return (await response.json()) as ActionResult<{ id: string }>;
  } catch {
    return {
      ok: false,
      error: 'The upload did not finish. Check your connection and try again.',
    };
  }
}
