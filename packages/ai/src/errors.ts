/**
 * The error taxonomy. Vendor exceptions never escape this package.
 *
 * Each adapter maps its SDK's failures onto exactly one `kind`; the API maps
 * `kind` to HTTP once, in one place. Adapters catch most-specific-first and
 * never string-match an error message where a status code or a structured
 * field is available.
 */

export const AIErrorKind = {
  /**
   * The per-minute rate limit. Retryable. On a free tier this is the most
   * common failure, and it should be messaged as "scoring is busy" rather than
   * as a fault. Forward `retryAfterMs` when the provider supplies one.
   */
  RATE_LIMIT: 'rate_limit',
  /**
   * The daily or per-project cap. NOT the same as `rate_limit`, and the
   * distinction is the whole point: providers frequently return an identical
   * short retry hint for both, so obeying it here means retrying for hours
   * against a quota that resets on a calendar boundary. Different message,
   * different remedy, and terminal for the current period.
   */
  QUOTA_EXHAUSTED: 'quota_exhausted',
  /** Wall-clock exceeded. Worst case is `timeout x (maxRetries + 1)`. */
  TIMEOUT: 'timeout',
  /** The configured key is bad. Surface in the admin panel, never to an end user. */
  AUTH: 'auth',
  /** Input exceeded the context window. The admission gate should have caught it. */
  CONTEXT_OVERFLOW: 'context_overflow',
  /** Our bug — usually a schema-transform mismatch. Log the compiled schema. Never retry. */
  BAD_REQUEST: 'bad_request',
  /** The model declined. Clean message, nothing persisted. */
  REFUSAL: 'refusal',
  /** Fallthrough. Log `providerRequestId`. */
  UPSTREAM: 'upstream',
} as const;

export type AIErrorKind = (typeof AIErrorKind)[keyof typeof AIErrorKind];

/** Every kind, for exhaustiveness checks and for the conformance suite. */
export const AI_ERROR_KINDS = Object.values(AIErrorKind);

/** Kinds where retrying the same request can plausibly succeed later. */
const RETRYABLE = new Set<AIErrorKind>([
  AIErrorKind.RATE_LIMIT,
  AIErrorKind.TIMEOUT,
  AIErrorKind.UPSTREAM,
]);

export interface AIErrorOptions {
  kind: AIErrorKind;
  message: string;
  /** The provider whose call failed. */
  provider: string;
  /** Vendor status code, where there was one. */
  status?: number | undefined;
  /** For correlating with the vendor's own logs. */
  providerRequestId?: string | null | undefined;
  /** Honour this before any backoff of your own. */
  retryAfterMs?: number | undefined;
  /** The original exception, for logging only. Never serialised to a client. */
  cause?: unknown;
}

export class AIError extends Error {
  readonly kind: AIErrorKind;
  readonly provider: string;
  readonly status: number | undefined;
  readonly providerRequestId: string | null;
  readonly retryAfterMs: number | undefined;

  constructor(options: AIErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AIError';
    this.kind = options.kind;
    this.provider = options.provider;
    this.status = options.status;
    this.providerRequestId = options.providerRequestId ?? null;
    this.retryAfterMs = options.retryAfterMs;
  }

  /** Retrying this exact request may succeed later. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }

  static is(value: unknown): value is AIError {
    return value instanceof AIError;
  }
}
