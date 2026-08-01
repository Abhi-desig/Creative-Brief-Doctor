import 'server-only';
import { headers } from 'next/headers';

/**
 * Server-side API client.
 *
 * `API_BASE_URL` is read here and nowhere else, and this module is `server-only`
 * so importing it from a client component is a build error rather than a leaked
 * base URL. The browser never talks to the Nest API directly — every call goes
 * through a route handler.
 */

/**
 * The API's default port is 3000 — and so is Next's. Defaulting this to
 * localhost:3000 meant `next dev` with no env produced a web app proxying to
 * ITSELF: `/v1/briefs` hit Next's own router, matched nothing, and returned
 * Next's 404 page. The symptom was a bare 404 on submit with nothing in either
 * log to explain it.
 *
 * The fallback stays for convenience, but `assertNotSelf` below turns a
 * self-call into a loud, specific error instead of a mystery 404.
 */
const BASE = (process.env.API_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');

export class ApiMisconfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiMisconfiguredError';
  }
}

/**
 * Refuses to proxy to ourselves.
 *
 * Without this the failure mode is a 404 from Next's own router, which reads
 * exactly like "that brief does not exist" and sends you hunting in the wrong
 * place entirely.
 */
export function assertNotSelf(requestHost: string | null): void {
  if (!requestHost) return;
  let target: URL;
  try {
    target = new URL(BASE);
  } catch {
    throw new ApiMisconfiguredError(`API_BASE_URL is not a valid URL: ${JSON.stringify(BASE)}`);
  }
  if (target.host === requestHost) {
    throw new ApiMisconfiguredError(
      `API_BASE_URL points at this same server (${requestHost}), so the web app is `
      + 'proxying to itself and every API call 404s. Point API_BASE_URL at the '
      + 'NestJS API and run the web app on a different port — `pnpm dev` uses 3001.',
    );
  }
}

export interface DimensionPayload {
  dimension: 'OBJECTIVE_CLARITY' | 'AUDIENCE_SPECIFICITY' | 'MESSAGE_SUBSTANCE'
    | 'CONSTRAINTS' | 'SUCCESS_METRICS';
  score: number;
  rationale: string;
  gaps: string[];
  evidence: string[];
}

export interface QuestionPayload {
  dimension: DimensionPayload['dimension'];
  question: string;
  blocking: boolean;
  rank: number;
}

export interface ReportPayload {
  brief: { publicId: string; title: string | null; charCount: number; createdAt: string };
  diagnosis: {
    publicId: string;
    overallScore: number;
    verdict: 'READY' | 'NEEDS_WORK' | 'NOT_READY';
    summary: string;
    dimensions: DimensionPayload[];
    questions: QuestionPayload[];
    /** The only provenance the public page ever sees. No provider, no model. */
    rubricVersion: string;
    createdAt: string;
  } | null;
}

/**
 * A hung API must not hang the render forever. Ten seconds is generous for a
 * single indexed read and short enough that the error boundary appears while the
 * reader is still paying attention.
 */
const REPORT_TIMEOUT_MS = 10_000;

/** Raised on timeout so the boundary can say something true about what happened. */
export class ApiTimeoutError extends Error {
  constructor(ms: number) {
    super(`The scoring API did not respond within ${ms / 1000} seconds.`);
    this.name = 'ApiTimeoutError';
  }
}

export async function fetchReport(publicId: string): Promise<ReportPayload | null> {
  /**
   * `assertNotSelf` was called from both proxy route handlers but NOT from here,
   * which is the one path it was written for. With `API_BASE_URL` pointing at the
   * web app, this fetch hit Next's own router, got a 404, returned null, and the
   * page called `notFound()` — reproducing the exact "reads like that brief does
   * not exist" misdiagnosis the guard exists to eliminate.
   */
  const incoming = await headers();
  assertNotSelf(incoming.get('host'));

  /**
   * Forwarding the reader's IP is what makes the report's rate limit per-reader.
   * Both proxy handlers forward it and this did not, so with `trust proxy` set on
   * the API every reader on earth was attributed to the single Next server IP and
   * shared one bucket — a shared report URL that a dozen colleagues opened would
   * start 429ing for all of them.
   */
  const forwarded = incoming.get('x-forwarded-for') ?? incoming.get('x-real-ip');

  let response: Response;
  try {
    response = await fetch(`${BASE}/v1/briefs/${encodeURIComponent(publicId)}`, {
      // A report is immutable once written, but a brief can be re-scored, so this
      // is fetched fresh rather than cached at the edge.
      cache: 'no-store',
      ...(forwarded ? { headers: { 'x-forwarded-for': forwarded } } : {}),
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
  } catch (error) {
    // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
    if ((error as { name?: string })?.name === 'TimeoutError') {
      throw new ApiTimeoutError(REPORT_TIMEOUT_MS);
    }
    throw error;
  }

  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Report fetch failed: ${response.status}`);
  return (await response.json()) as ReportPayload;
}

export interface ExampleSummary {
  publicId: string;
  title: string;
  /** Why this example is in the gallery — the shape of brief it represents. */
  shape: string;
  overallScore: number;
  questionCount: number;
  charCount: number;
}

/**
 * The seeded example gallery.
 *
 * Returns `[]` rather than throwing on any failure. `/examples` is a marketing
 * surface: an empty gallery with an explanation is a far better outcome than an
 * error boundary, and an unseeded database is the expected state on a fresh
 * deployment rather than a fault.
 */
export async function fetchExamples(): Promise<ExampleSummary[]> {
  const incoming = await headers();
  try {
    assertNotSelf(incoming.get('host'));
  } catch (error) {
    console.error(`[examples] ${String(error)}`);
    return [];
  }

  try {
    const response = await fetch(`${BASE}/v1/examples`, {
      // Revalidated by the page's own `revalidate`, so this may be cached.
      next: { revalidate: 3600 },
      signal: AbortSignal.timeout(REPORT_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    return (await response.json()) as ExampleSummary[];
  } catch (error) {
    console.error(`[examples] Could not load examples: ${String(error)}`);
    return [];
  }
}

export function apiBase(): string {
  return BASE;
}
