import {
  Catch,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { AIError, AIErrorKind } from '@cbd/ai';

/**
 * AIError -> HTTP, in exactly one place.
 *
 * Every adapter maps its vendor's failures onto the taxonomy; this maps the
 * taxonomy onto status codes. Nothing else in the application should branch on
 * an AI failure mode.
 *
 * | kind              | HTTP | why                                             |
 * |-------------------|------|-------------------------------------------------|
 * | rate_limit        | 503  | retryable; forward retry-after                  |
 * | quota_exhausted   | 503  | the daily cap, not the per-minute one           |
 * | timeout           | 504  |                                                 |
 * | auth              | 500  | our misconfiguration, not the caller's fault     |
 * | context_overflow  | 413  | the admission gate should have caught it         |
 * | bad_request       | 500  | our bug, usually a schema mismatch. Never retry. |
 * | refusal           | 422  | clean message, nothing persisted                |
 * | upstream          | 502  | fallthrough                                     |
 */

const STATUS: Record<AIErrorKind, number> = {
  [AIErrorKind.RATE_LIMIT]: HttpStatus.SERVICE_UNAVAILABLE,
  [AIErrorKind.QUOTA_EXHAUSTED]: HttpStatus.SERVICE_UNAVAILABLE,
  [AIErrorKind.TIMEOUT]: HttpStatus.GATEWAY_TIMEOUT,
  [AIErrorKind.AUTH]: HttpStatus.INTERNAL_SERVER_ERROR,
  [AIErrorKind.CONTEXT_OVERFLOW]: HttpStatus.PAYLOAD_TOO_LARGE,
  [AIErrorKind.BAD_REQUEST]: HttpStatus.INTERNAL_SERVER_ERROR,
  [AIErrorKind.REFUSAL]: HttpStatus.UNPROCESSABLE_ENTITY,
  [AIErrorKind.UPSTREAM]: HttpStatus.BAD_GATEWAY,
};

/**
 * What the end user sees. Never the vendor's message, never the key, never the
 * model name — a stakeholder reading a provider name will argue with the tooling
 * instead of the brief.
 */
const PUBLIC_MESSAGE: Record<AIErrorKind, string> = {
  [AIErrorKind.RATE_LIMIT]:
    'Scoring is busy right now. Try again in a moment.',
  [AIErrorKind.QUOTA_EXHAUSTED]:
    'Scoring is finished for today. The daily limit is shared across everyone using this tool.',
  [AIErrorKind.TIMEOUT]:
    'Scoring took too long and was stopped. Try again, or shorten the brief.',
  [AIErrorKind.AUTH]:
    'Scoring is not configured correctly. An administrator has been notified.',
  [AIErrorKind.CONTEXT_OVERFLOW]:
    'That brief is too long to score. Trim it and try again.',
  [AIErrorKind.BAD_REQUEST]:
    'Something went wrong on our side while scoring. Nothing was saved.',
  [AIErrorKind.REFUSAL]:
    'The scorer declined to process this text. Nothing was saved.',
  [AIErrorKind.UPSTREAM]:
    'The scoring service is unavailable right now. Try again shortly.',
};

@Catch(AIError)
export class AIErrorFilter implements ExceptionFilter {
  private readonly logger = new Logger('AIError');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(error: AIError, host: ArgumentsHost): void {
    const status = STATUS[error.kind] ?? HttpStatus.BAD_GATEWAY;

    // Server-side detail: the vendor's own words, the request id for
    // correlation, and the kind. This is the only place they appear.
    const detail = [
      `kind=${error.kind}`,
      `provider=${error.provider}`,
      error.status !== undefined ? `upstreamStatus=${error.status}` : null,
      error.providerRequestId ? `providerRequestId=${error.providerRequestId}` : null,
      `retryable=${error.retryable}`,
    ]
      .filter(Boolean)
      .join(' ');

    if (status >= 500) this.logger.error(`${detail} :: ${error.message}`);
    else this.logger.warn(`${detail} :: ${error.message}`);

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<{ setHeader?: (k: string, v: string) => void }>();

    // Only meaningful on a genuine per-minute limit. A daily cap must not get a
    // Retry-After measured in seconds — that would send clients back in a
    // minute to a quota that resets tomorrow.
    if (
      error.kind === AIErrorKind.RATE_LIMIT
      && error.retryAfterMs !== undefined
      && typeof response?.setHeader === 'function'
    ) {
      response.setHeader('Retry-After', String(Math.ceil(error.retryAfterMs / 1000)));
    }

    this.adapterHost.httpAdapter.reply(
      response,
      {
        statusCode: status,
        code: error.kind.toUpperCase(),
        message: PUBLIC_MESSAGE[error.kind] ?? PUBLIC_MESSAGE[AIErrorKind.UPSTREAM],
        retryable: error.retryable,
      },
      status,
    );
  }
}
