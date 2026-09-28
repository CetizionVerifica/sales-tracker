import { createImportBatch, getEnv, MAX_IMPORT_FILE_BYTES } from '@sales-tracker/core';
import { revalidatePath } from 'next/cache';
import { ACTION_ERRORS, toResult, type ActionResult } from '@/lib/action-core';
import { getCtx } from '@/lib/auth';
import { isSameOrigin, readCappedBody, TooLargeError } from '@/lib/upload';

/** Multipart overhead allowed on top of the file itself. */
const FORM_OVERHEAD = 64 * 1024;

function reply(result: ActionResult<unknown>, status = 200) {
  return Response.json(result, { status });
}

/**
 * Uploads a spreadsheet to start a bulk import (M10b). A route handler, not a server
 * action: actions cap bodies at 1 MB, and imports allow up to 20 MB. Returns the same
 * `{ ok, data } | { ok, error, fieldErrors }` shape as actions (mirrors `/api/documents`).
 */
export async function POST(request: Request) {
  const env = getEnv();
  if (!isSameOrigin(request, env.BETTER_AUTH_URL)) {
    return reply({ ok: false, error: ACTION_ERRORS.forbidden }, 403);
  }
  try {
    const ctx = await getCtx();
    let body: ArrayBuffer;
    try {
      body = await readCappedBody(request, MAX_IMPORT_FILE_BYTES + FORM_OVERHEAD);
    } catch (error) {
      if (!(error instanceof TooLargeError)) throw error;
      const message = 'The file is larger than 20 MB';
      return reply({ ok: false, error: message, fieldErrors: { file: [message] } }, 413);
    }
    const form = await new Response(body, {
      headers: { 'content-type': request.headers.get('content-type') ?? '' },
    }).formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      const message = 'Choose a file to upload';
      return reply({ ok: false, error: message, fieldErrors: { file: [message] } }, 400);
    }
    const batch = await createImportBatch(
      ctx,
      { fileName: file.name, fileSize: file.size, entity: 'ENQUIRY' },
      { bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name },
    );
    revalidatePath('/imports');
    return reply({ ok: true, data: { id: batch.id } });
  } catch (error) {
    const result = toResult(error);
    const status =
      result.ok || result.error === ACTION_ERRORS.unexpected
        ? 500
        : result.error === ACTION_ERRORS.unauthenticated
          ? 401
          : result.error === ACTION_ERRORS.forbidden
            ? 403
            : result.error === ACTION_ERRORS.notFound
              ? 404
              : 400;
    return reply(result, status);
  }
}
