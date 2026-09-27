/** Helpers for the document upload route handler (M7). */

export class TooLargeError extends Error {
  override name = 'TooLargeError';
}

/**
 * Reads a request body into memory, failing as soon as it passes `max` bytes, so an
 * oversized upload is never fully buffered (a declared Content-Length is checked first).
 */
export async function readCappedBody(request: Request, max: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new TooLargeError();
  if (!request.body) return new ArrayBuffer(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw new TooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body.buffer;
}

/**
 * CSRF guard for cookie-authenticated POSTs to route handlers (server actions have this
 * built in; route handlers do not). The Origin must be the app's own: BETTER_AUTH_URL, or
 * the Host the request arrived on.
 */
export function isSameOrigin(request: Request, appUrl: string): boolean {
  if (request.headers.get('sec-fetch-site') === 'cross-site') return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    return false;
  }
  if (originUrl.origin === new URL(appUrl).origin) return true;
  const host = request.headers.get('x-forwarded-host') ?? request.headers.get('host');
  return host !== null && originUrl.host === host;
}
