import { getSessionCookie } from '@sales-tracker/core/auth-cookie';
import { NextResponse, type NextRequest } from 'next/server';

/**
 * Convenience redirect only: checks that a session cookie exists. The security boundary is
 * requireUser()/getCtx() and assertCan() on the server, which validate the session.
 */
export function proxy(request: NextRequest) {
  if (getSessionCookie(request)) return NextResponse.next();
  const login = new URL('/login', request.url);
  const next = request.nextUrl.pathname + request.nextUrl.search;
  if (next !== '/') login.searchParams.set('next', next);
  return NextResponse.redirect(login);
}

// api/documents is excluded because the proxy buffers request bodies (10 MB by default) and
// uploads are up to DOCUMENT_MAX_BYTES; those routes check the session themselves (M7).
export const config = {
  matcher: ['/((?!login|api/auth|api/health|api/documents|_next/|favicon.ico).*)'],
};
