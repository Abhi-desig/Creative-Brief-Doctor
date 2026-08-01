import { describe, expect, it } from 'vitest';
import { extractErrorMessage } from './sse-client';

/**
 * Parsing a server-authored error out of an SSE body.
 *
 * This is the A6 fix. `if (!response.ok) throw new Error('Could not start
 * scoring.')` ran BEFORE the body was read, but the proxy returns its `event:
 * error` frame WITH a 500/502 status — so API_MISCONFIGURED, API_UNREACHABLE
 * ("Is it running?") and API_BAD_RESPONSE were all discarded and replaced with a
 * generic string, and the debuggability those messages exist for was silently off.
 */

describe('extractErrorMessage', () => {
  it('pulls the message out of a terminal error frame', () => {
    const body = 'event: error\ndata: {"code":"API_UNREACHABLE","message":"Could not reach the scoring API at http://localhost:3000. Is it running?"}\n\n';
    expect(extractErrorMessage(body)).toBe(
      'Could not reach the scoring API at http://localhost:3000. Is it running?',
    );
  });

  it('finds an error frame that follows other frames', () => {
    const body = [
      'event: status\ndata: {"phase":"reading"}',
      'event: status\ndata: {"phase":"scoring"}',
      'event: error\ndata: {"code":"UPSTREAM","message":"Gemini daily quota exhausted."}',
    ].join('\n\n');
    expect(extractErrorMessage(body)).toBe('Gemini daily quota exhausted.');
  });

  it('returns null when there is no error frame, so the caller can fall back', () => {
    expect(extractErrorMessage('event: status\ndata: {"phase":"reading"}\n\n')).toBeNull();
    expect(extractErrorMessage('')).toBeNull();
  });

  it('returns null for an HTML body, rather than mangling it into a message', () => {
    // What a misconfigured proxy actually returns: someone else's 404 page.
    expect(extractErrorMessage('<!DOCTYPE html><title>404</title>')).toBeNull();
  });

  it('returns null on a malformed error frame instead of throwing', () => {
    // A JSON parse failure must not replace the real problem with a syntax error.
    expect(extractErrorMessage('event: error\ndata: {not json\n\n')).toBeNull();
  });

  it('returns null when the error frame carries no message', () => {
    expect(extractErrorMessage('event: error\ndata: {"code":"UPSTREAM"}\n\n')).toBeNull();
  });

  it('tolerates the extra whitespace SSE permits after the colon', () => {
    expect(extractErrorMessage('event:  error\ndata:  {"message":"spaced"}\n\n')).toBe('spaced');
  });
});
