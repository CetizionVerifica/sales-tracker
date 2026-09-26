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

export const config = {
  matcher: ['/((?!login|api/auth|api/health|_next/|favicon.ico).*)'],
};
