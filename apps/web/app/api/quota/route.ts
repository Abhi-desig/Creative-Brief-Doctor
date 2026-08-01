import { ApiMisconfiguredError, apiBase, assertNotSelf } from '@/lib/api';

/**
 * Proxy for the public capacity signal.
 *
 * Goes through a route handler like every other API call, so `API_BASE_URL` stays
 * server-only and the browser never learns where the Nest API lives.
 */
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    assertNotSelf(request.headers.get('host'));
  } catch (error) {
    if (error instanceof ApiMisconfiguredError) {
      console.error(`[proxy] ${error.message}`);
      return Response.json({ error: 'API_MISCONFIGURED' }, { status: 500 });
    }
    throw error;
  }

  const forwarded = request.headers.get('x-forwarded-for');

  try {
    const upstream = await fetch(`${apiBase()}/v1/quota`, {
      headers: { ...(forwarded ? { 'x-forwarded-for': forwarded } : {}) },
      cache: 'no-store',
      // Short: this decorates a sidebar. A slow answer is worth less than no
      // answer, and the caller renders nothing when it fails.
      signal: AbortSignal.timeout(4_000),
    });
    if (!upstream.ok) {
      return Response.json({ error: 'UPSTREAM' }, { status: 502 });
    }
    return Response.json(await upstream.json(), {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch {
    return Response.json({ error: 'API_UNREACHABLE' }, { status: 502 });
  }
}
