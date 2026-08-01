import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { redact } from '../admin/redact.js';

/**
 * Global fallthrough filter. Runs after the AIError filter, so anything reaching
 * here is either an HttpException or genuinely unexpected.
 *
 * Everything logged goes through `redact` first: an unexpected error is exactly
 * the kind that carries a request body, and a request body can carry a key.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger('Exception');

  constructor(private readonly adapterHost: HttpAdapterHost) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const status = exception instanceof HttpException
      ? exception.getStatus()
      : HttpStatus.INTERNAL_SERVER_ERROR;

    const payload = exception instanceof HttpException
      ? exception.getResponse()
      : { statusCode: status, message: 'Internal server error.' };

    if (status >= 500) {
      this.logger.error(JSON.stringify(redact(exception)));
    }

    const body = typeof payload === 'string'
      ? { statusCode: status, message: payload }
      : { statusCode: status, ...(payload as Record<string, unknown>) };

    this.adapterHost.httpAdapter.reply(ctx.getResponse(), redact(body), status);
  }
}
