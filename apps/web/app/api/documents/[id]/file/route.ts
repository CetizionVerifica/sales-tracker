import { getDocumentFile, NotFoundError, UnauthenticatedError } from '@sales-tracker/core';
import { getCtx } from '@/lib/auth';

/**
 * Streams a document after a read check (M7 Decision 3): a redirect to a short-lived
 * signed Cloudinary link, or the bytes themselves from stores without URLs (E2E).
 * `?download=1` asks the browser to save it instead of showing it.
 */
export async function GET(request: Request, ctx: RouteContext<'/api/documents/[id]/file'>) {
  const { id } = await ctx.params;
  try {
    const file = await getDocumentFile(await getCtx(), id);
    if (file.type === 'redirect') {
      return new Response(null, {
        status: 302,
        headers: { location: file.url, 'cache-control': 'private, no-store' },
      });
    }
    const download = new URL(request.url).searchParams.get('download') === '1';
    const name = encodeURIComponent(file.filename);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        'content-type': file.mimeType,
        'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
        'x-content-type-options': 'nosniff',
        'cache-control': 'private, no-store',
      },
    });
  } catch (error) {
    if (error instanceof UnauthenticatedError)
      return new Response('Sign in first', { status: 401 });
    if (error instanceof NotFoundError) return new Response('Not found', { status: 404 });
    console.error('document file failed', error);
    return new Response('Something went wrong', { status: 500 });
  }
}
