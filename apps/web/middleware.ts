import { NextResponse, type NextRequest } from 'next/server';
// From lib/admin-cookies, NOT lib/admin-session: this file runs in the Edge
// Runtime, and importing the name from the session module would pull its
// `node:crypto` dependency into the edge bundle and break compilation.
import { ADMIN_SESSION_COOKIE } from '@/lib/admin-cookies';

/**
 * Gates `/admin/*` on the presence of a session cookie.
 *
 * PRESENCE ONLY, deliberately. Middleware runs on every matched request and
 * cannot decrypt the cookie without pulling node:crypto into the edge runtime, so
 * this is a cheap redirect for the common case — an admin whose session has
 * expired gets the login page instead of a broken panel — and NOT an
 * authorisation check. Every `/api/admin/*` handler independently unseals the
 * cookie and the API independently verifies the bearer, so a forged cookie buys
 * an attacker a rendered shell whose every request then 401s.
 *
 * Writing this as if it were the security boundary is the classic mistake with
 * this pattern; it is a routing convenience.
 */
export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const hasSession = request.cookies.has(ADMIN_SESSION_COOKIE);
  const isLoginPage = pathname === '/admin/login';

  if (!hasSession && !isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin/login';
    // Return the admin where they were headed rather than dumping them on the
    // status page. Path only — never the full URL, which would make this an open
    // redirect.
    url.search = pathname === '/admin' ? '' : `?next=${encodeURIComponent(pathname + search)}`;
    return NextResponse.redirect(url);
  }

  if (hasSession && isLoginPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/admin';
    url.search = '';
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // `/admin/*` pages only. The `/api/admin/*` handlers are NOT matched: they do
  // their own unsealing and must be able to return a 401 as JSON rather than a
  // redirect to an HTML page, which a fetch() caller cannot act on.
  matcher: ['/admin/:path*'],
};
