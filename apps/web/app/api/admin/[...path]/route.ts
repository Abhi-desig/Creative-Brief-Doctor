import { ApiMisconfiguredError, apiBase, assertNotSelf } from '@/lib/api';
import { csrfMatches, readBearer, readCsrf } from '@/lib/admin-session';

/**
 * The one proxy for every admin API call: cookie in, bearer out.
 *
 * The browser sends an httpOnly cookie it cannot read; this handler unseals it
 * and attaches the bearer as an `Authorization` header. The token exists only on
 * the server, so an XSS on the admin surface cannot exfiltrate a working admin
 * credential — it could drive this endpoint, which is what the CSRF check and the
 * API's own guards are for, but it cannot walk away with the token.
 *
 * A catch-all rather than a handler per resource: every one would be the same
 * fifteen lines, and the fifteen lines are where the security properties live.
 */

export const dynamic = 'force-dynamic';

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

async function proxy(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
): Promise<Response> {
  const { path } = await context.params;

  try {
    assertNotSelf(request.headers.get('host'));
  } catch (error) {
    if (error instanceof ApiMisconfiguredError) {
      console.error(`[admin proxy] ${error.message}`);
      return Response.json({ message: error.message, code: 'API_MISCONFIGURED' }, { status: 500 });
    }
    throw error;
  }

  const bearer = await readBearer();
  if (!bearer) {
    // JSON, not a redirect: the caller is a fetch(), and a 302 to an HTML login
    // page would arrive as an opaque success it cannot interpret.
    return Response.json({ message: 'Not signed in.', code: 'NO_SESSION' }, { status: 401 });
  }

  /**
   * Double-submit, enforced here as well as at the API.
   *
   * Not redundant: this route is itself a same-origin endpoint that attaches
   * admin credentials, so an attacker able to drive it cross-site would never
   * need to reach the API directly. Rejecting here means the bearer is never
   * attached to a request we have not authenticated the origin of.
   */
  if (MUTATING.has(request.method) && !(await csrfMatches(request.headers.get('x-csrf-token')))) {
    return Response.json(
      { message: 'Missing or mismatched CSRF token.', code: 'CSRF' },
      { status: 403 },
    );
  }

  const url = new URL(request.url);
  const target = `${apiBase()}/v1/admin/${path.map(encodeURIComponent).join('/')}${url.search}`;
  const csrf = await readCsrf();
  const body = MUTATING.has(request.method) ? await request.text() : undefined;

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': request.headers.get('content-type') ?? 'application/json',
        // The API runs the same double-submit check, so it needs both halves.
        ...(csrf ? { 'x-csrf-token': csrf, cookie: `csrf_token=${csrf}` } : {}),
        // Preserved so the API's origin check sees the real browser origin
        // rather than nothing.
        ...(request.headers.get('origin') ? { origin: request.headers.get('origin')! } : {}),
        ...(request.headers.get('x-forwarded-for')
          ? { 'x-forwarded-for': request.headers.get('x-forwarded-for')! }
          : {}),
      },
      ...(body !== undefined && body.length > 0 ? { body } : {}),
      cache: 'no-store',
      signal: AbortSignal.timeout(30_000),
    });

    const text = await upstream.text();
    return new Response(text || null, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'application/json',
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    console.error(`[admin proxy] ${request.method} ${target} failed: ${String(error)}`);
    return Response.json(
      { message: `Could not reach the API at ${apiBase()}.`, code: 'API_UNREACHABLE' },
      { status: 502 },
    );
  }
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const PUT = proxy;
export const DELETE = proxy;
