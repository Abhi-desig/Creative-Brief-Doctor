import { ApiMisconfiguredError, apiBase, assertNotSelf } from '@/lib/api';

/**
 * Proxy for the SSE diagnose stream.
 *
 * The upstream body is piped through untouched — no buffering, no transform.
 * Anything that reads the stream to completion before forwarding would turn a
 * live progress feed into a single delayed blob, which is breakage mode 2 all
 * over again, just one layer up.
 */
export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ publicId: string }> },
) {
  const { publicId } = await params;

  try {
    assertNotSelf(request.headers.get('host'));
  } catch (error) {
    if (error instanceof ApiMisconfiguredError) {
      console.error(`[proxy] ${error.message}`);
      return sseError('API_MISCONFIGURED', error.message, 500);
    }
    throw error;
  }

  let upstream: Response;
  try {
    upstream = await fetch(
    `${apiBase()}/v1/briefs/${encodeURIComponent(publicId)}/diagnose/stream`,
    {
      headers: {
        Accept: 'text/event-stream',
        ...(request.headers.get('x-forwarded-for')
          ? { 'x-forwarded-for': request.headers.get('x-forwarded-for')! }
          : {}),
      },
      // Closing the tab aborts here, which aborts upstream, which aborts the
      // model call. On a free tier an ignored abort burns shared quota.
        signal: request.signal,
        cache: 'no-store',
      },
    );
  } catch (error) {
    console.error(`[proxy] Could not reach the API at ${apiBase()}: ${String(error)}`);
    return sseError(
      'API_UNREACHABLE',
      `Could not reach the scoring API at ${apiBase()}. Is it running?`,
      502,
    );
  }

  // An HTML 404 from the wrong host would otherwise be piped to the browser as
  // if it were an event stream, and the client's parser would just see nothing.
  const contentType = upstream.headers.get('content-type') ?? '';
  if (!upstream.ok || !contentType.includes('text/event-stream')) {
    const preview = (await upstream.text()).slice(0, 200);
    console.error(
      `[proxy] Stream upstream returned ${upstream.status} content-type `
      + `"${contentType || 'none'}". First 200 chars: ${preview}`,
    );
    return sseError(
      'API_BAD_RESPONSE',
      `The scoring API returned ${upstream.status} instead of an event stream.`,
      502,
    );
  }

  if (!upstream.body) {
    return sseError('UPSTREAM', 'The scoring API produced no stream.', 502);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: SSE_HEADERS,
  });
}

/** Errors reach the browser as a terminal SSE frame, so the client parser sees
 *  a real reason instead of an empty stream. */
function sseError(code: string, message: string, status: number): Response {
  const frame = `event: error\ndata: ${JSON.stringify({ code, message })}\n\n`;
  return new Response(frame, { status, headers: SSE_HEADERS });
}

const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  // Vercel and nginx both buffer proxied responses without this.
  'X-Accel-Buffering': 'no',
};
