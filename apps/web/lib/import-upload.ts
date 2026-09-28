import type { ActionResult } from './action-core.ts';

/**
 * Sends a spreadsheet to the upload route (M10b) from the browser; the reply has the
 * server-action result shape. A route handler, not a server action, since actions cap
 * bodies at 1 MB and this accepts files up to 20 MB (mirrors `document-upload.ts`, M7).
 */
export async function uploadImportFile(file: File): Promise<ActionResult<{ id: string }>> {
  const body = new FormData();
  body.set('entity', 'ENQUIRY');
  body.set('file', file);
  try {
    const response = await fetch('/api/imports', { method: 'POST', body });
    return (await response.json()) as ActionResult<{ id: string }>;
  } catch {
    return {
      ok: false,
      error: 'The upload did not finish. Check your connection and try again.',
    };
  }
}
