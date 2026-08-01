import { NextResponse } from 'next/server';
import { ApiMisconfiguredError, apiBase, assertNotSelf } from '@/lib/api';

/**
 * Proxy for POST /v1/briefs. Keeps API_BASE_URL server-side.
 *
 * POST only — there is no GET here, so nothing about this route can be
 * triggered by a link or an image tag.
 */
export async function POST(request: Request) {
  const host = request.headers.get('host');

  // Same-origin only. The public paste form is not cross-origin.
  const origin = request.headers.get('origin');
  if (origin && host && new URL(origin).host !== host) {
    return NextResponse.json({ message: 'Origin not allowed.' }, { status: 403 });
  }

  try {
    assertNotSelf(host);
  } catch (error) {
    if (error instanceof ApiMisconfiguredError) {
      console.error(`[proxy] ${error.message}`);
      return NextResponse.json(
        { code: 'API_MISCONFIGURED', message: error.message },
        { status: 500 },
      );
    }
    throw error;
  }

  const body = await request.text();

  let upstream: Response;
  try {
    upstream = await fetch(`${apiBase()}/v1/briefs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Preserve the caller's IP so the API's per-IP throttle tiers still bind
        // to the real client rather than to this server.
        ...forwardedFor(request),
      },
      body,
      cache: 'no-store',
    });
  } catch (error) {
    // The API being down must not read as a validation failure.
    console.error(`[proxy] Could not reach the API at ${apiBase()}: ${String(error)}`);
    return NextResponse.json(
      {
        code: 'API_UNREACHABLE',
        message: `Could not reach the scoring API at ${apiBase()}. Is it running?`,
      },
      { status: 502 },
    );
  }

  return relay(upstream);
}

/**
 * Relays the upstream response, but never pretends a non-JSON body is JSON.
 * An HTML error page passed through with a JSON content-type is exactly what
 * made the original self-proxy bug unreadable.
 */
async function relay(upstream: Response): Promise<NextResponse> {
  const text = await upstream.text();
  const contentType = upstream.headers.get('content-type') ?? '';

  if (!contentType.includes('application/json')) {
    console.error(
      `[proxy] Upstream returned ${upstream.status} with content-type `
      + `"${contentType || 'none'}" — expected JSON. First 200 chars: ${text.slice(0, 200)}`,
    );
    return NextResponse.json(
      {
        code: 'API_BAD_RESPONSE',
        message:
          `The scoring API returned a ${upstream.status} that was not JSON. `
          + 'Check that API_BASE_URL points at the NestJS API.',
      },
      { status: 502 },
    );
  }

  return new NextResponse(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function forwardedFor(request: Request): Record<string, string> {
  const existing = request.headers.get('x-forwarded-for');
  return existing ? { 'x-forwarded-for': existing } : {};
}
