import { ApiMisconfiguredError, apiBase, assertNotSelf } from '@/lib/api';
import { createSession, destroySession, readBearer } from '@/lib/admin-session';

/**
 * Sign in and sign out.
 *
 * Separate from the `[...path]` catch-all because these are the two calls that
 * WRITE the session cookie rather than read it, and because login is the one
 * admin request that must be reachable without a session — the catch-all rejects
 * anything with no bearer, which is correct for every other route and wrong for
 * this one.
 *
 * Password handling: the password is posted here and forwarded to the API over a
 * server-side fetch. It is never stored, never logged, and never placed in a URL.
 */

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    assertNotSelf(request.headers.get('host'));
  } catch (error) {
    if (error instanceof ApiMisconfiguredError) {
      console.error(`[admin auth] ${error.message}`);
      return Response.json({ message: error.message, code: 'API_MISCONFIGURED' }, { status: 500 });
    }
    throw error;
  }

  const { email, password } = (await request.json().catch(() => ({}))) as {
    email?: string;
    password?: string;
  };

  if (!email || !password) {
    return Response.json({ message: 'Email and password are required.' }, { status: 400 });
  }

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/v1/admin/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Forwarded so the API's per-IP brute-force tier counts the real client
        // rather than attributing every attempt on earth to this server.
        ...(request.headers.get('x-forwarded-for')
          ? { 'x-forwarded-for': request.headers.get('x-forwarded-for')! }
          : {}),
      },
      body: JSON.stringify({ email, password }),
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return Response.json(
      { message: `Could not reach the API at ${apiBase()}.`, code: 'API_UNREACHABLE' },
      { status: 502 },
    );
  }

  if (!upstream.ok) {
    const body = (await upstream.json().catch(() => ({}))) as { message?: string };
    // 429 from the brute-force tier is passed through with its own status, so the
    // form can say "too many attempts" rather than "wrong password".
    return Response.json(
      { message: body.message ?? 'Sign in failed.' },
      { status: upstream.status },
    );
  }

  const { bearer } = (await upstream.json()) as { bearer: string };
  await createSession(bearer);
  return Response.json({ ok: true });
}

export async function DELETE(request: Request) {
  const bearer = await readBearer();

  // Clear the cookie first and unconditionally. If the API call below fails, the
  // browser must still end up signed out — a logout that leaves a live session
  // cookie because the network blipped is the wrong failure direction.
  await destroySession();

  if (bearer) {
    try {
      await fetch(`${apiBase()}/v1/admin/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}` },
        cache: 'no-store',
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Server-side session state will expire on its own.
      console.warn('[admin auth] Could not reach the API to revoke the session.');
    }
  }

  void request;
  return Response.json({ ok: true });
}
