/**
 * Client-side SSE consumption for the diagnose stream.
 *
 * Extracted from the paste form because four separate failure modes live here and
 * every one of them was silently wrong when this was eight inline lines:
 *
 *   1. The reader was never released. No `try/finally`, no `cancel()` — and the
 *      error path `throw`s mid-stream, which exits with the reader locked and the
 *      body undrained. The socket stays open, so the proxy's `request.signal`
 *      never fires, so Nest's `finalize(() => controller.abort())` never runs, so
 *      THE MODEL CALL KEEPS RUNNING and keeps burning a shared free-tier quota.
 *      The abort chain was built end to end and then defeated by a missing
 *      `finally`.
 *   2. Server-authored errors were discarded. `if (!response.ok) throw new
 *      Error('Could not start scoring.')` ran BEFORE the body was read, but the
 *      proxy's `sseError()` returns its `event: error` frame WITH a 500/502
 *      status — so API_MISCONFIGURED, API_UNREACHABLE ("Is it running?") and
 *      API_BAD_RESPONSE were all replaced by a generic string.
 *   3. A truncated stream looked exactly like success. Nothing recorded whether a
 *      `result` frame ever arrived, so a dropped connection resolved normally and
 *      navigated the user to "This brief has not been scored yet" with no error.
 *   4. A deliberate abort was indistinguishable from a crash, so navigating away
 *      raised a toast about a failure that was the user's own action.
 */

export type StreamPhase = 'reading' | 'scoring' | 'saving';

/** Thrown when the caller aborted. Callers swallow this rather than reporting it. */
export class StreamAbortedError extends Error {
  constructor() {
    super('Scoring was cancelled.');
    this.name = 'StreamAbortedError';
  }
}

const GENERIC_START_FAILURE = 'Could not start scoring.';

/**
 * Pulls `{ event, data }` pairs out of a raw SSE payload.
 *
 * Shared by the live reader and the error-body parser so a frame is understood
 * identically whether it arrives mid-stream or as the whole body of a 502.
 */
function parseFrames(chunk: string): { event: string; data: string }[] {
  const frames: { event: string; data: string }[] = [];
  for (const raw of chunk.split('\n\n')) {
    const event = raw.match(/^event:\s*(.+)$/m)?.[1]?.trim();
    const data = raw.match(/^data:\s*(.+)$/m)?.[1]?.trim();
    if (event && data) frames.push({ event, data });
  }
  return frames;
}

/** The `message` out of an `event: error` frame, if the text contains one. */
export function extractErrorMessage(text: string): string | null {
  for (const { event, data } of parseFrames(text)) {
    if (event !== 'error') continue;
    try {
      const parsed = JSON.parse(data) as { message?: string; code?: string };
      if (parsed.message) return parsed.message;
    } catch {
      // A malformed error frame is still an error; fall through to the generic
      // message rather than masking it with a JSON parse failure.
      return null;
    }
  }
  return null;
}

/**
 * Consumes the stream for its coarse status events.
 *
 * The `result` payload is deliberately not returned: the report page re-fetches it
 * server-side, so the page the author sees is byte-identical to the one a
 * stakeholder opening the link sees. We only care THAT it arrived — see (3) above.
 */
export async function streamDiagnosis(
  publicId: string,
  onPhase: (phase: StreamPhase) => void,
  signal: AbortSignal,
): Promise<void> {
  try {
    await consume(publicId, onPhase, signal);
  } catch (error) {
    // `fetch` and `reader.read()` both reject with a DOMException named
    // 'AbortError' when the signal fires, and that can happen at any await in
    // here. Normalising at the boundary means the caller has exactly one abort
    // type to recognise instead of having to know which await was in flight.
    if (signal.aborted || (error as { name?: string })?.name === 'AbortError') {
      throw new StreamAbortedError();
    }
    throw error;
  }
}

async function consume(
  publicId: string,
  onPhase: (phase: StreamPhase) => void,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(`/api/briefs/${encodeURIComponent(publicId)}/stream`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });

  if (!response.ok || !response.body) {
    // Read the body BEFORE giving up on it. The proxy reports its real reason in
    // an error frame attached to a non-2xx response, and that reason is the whole
    // point of having built it.
    const text = await response.text().catch(() => '');
    throw new Error(extractErrorMessage(text) ?? GENERIC_START_FAILURE);
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  let sawResult = false;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;

      // Frames are separated by a blank line. Anything after the last blank line
      // is a partial frame and stays in the buffer.
      const chunks = buffer.split('\n\n');
      buffer = chunks.pop() ?? '';

      for (const { event, data } of parseFrames(chunks.join('\n\n'))) {
        if (event === 'status') {
          const parsed = JSON.parse(data) as { phase?: StreamPhase };
          if (parsed.phase) onPhase(parsed.phase);
        }
        if (event === 'error') {
          const parsed = JSON.parse(data) as { message?: string };
          throw new Error(parsed.message ?? 'Scoring failed.');
        }
        if (event === 'result') sawResult = true;
      }
    }
  } finally {
    // Releases the lock and closes the socket on EVERY exit path, including the
    // `throw` above and an abort. This is what actually propagates the abort
    // upstream to the model call.
    await reader.cancel().catch(() => {});
  }

  if (!sawResult) {
    throw new Error(
      'The connection dropped before the report was finished. '
      + 'Nothing was lost — press the button again to re-score this brief.',
    );
  }
}
