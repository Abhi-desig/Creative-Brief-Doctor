import { interval, map, type Observable } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';

/**
 * Headers that keep SSE alive through the layers between Nest and the browser.
 *
 * `X-Accel-Buffering: no` is the one that fixes the classic "works locally,
 * hangs in production" failure: nginx buffers proxied responses by default, so
 * the browser receives nothing until the stream ends.
 */
export const SSE_HEADERS: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Route prefixes that must never see a global interceptor or compression. */
export const STREAMING_ROUTE_PATTERN = /\/diagnose\/stream$/;

/**
 * Nest emits no keepalives, so an idle connection gets reaped by proxies and
 * load balancers. Scoring takes 20-30 seconds at this prompt size, which is well
 * inside the window where that happens.
 */
export function keepAlive(everyMs = 15_000): Observable<MessageEvent> {
  return interval(everyMs).pipe(
    map(() => ({ type: 'ping', data: { t: Date.now() } }) as MessageEvent),
  );
}
