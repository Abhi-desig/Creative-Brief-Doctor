import {
  Injectable,
  Logger,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { catchError, concatMap } from 'rxjs/operators';
import { from, throwError, type Observable } from 'rxjs';
import { PrismaService } from '../prisma/prisma.service.js';
import { redact } from './redact.js';
import type { AdminRequest } from './admin-auth.guard.js';

/**
 * Writes an AdminAuditLog row for every admin mutation.
 *
 * Everything written is passed through `redact` first, so a secret cannot reach
 * the audit table — which would be a particularly bad place for one, since audit
 * rows are the thing you export and hand to someone else.
 *
 * Read requests are not audited. They are not interesting, they would drown the
 * table, and a GET cannot change anything.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(private readonly prisma: PrismaService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<AdminRequest>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return next.handle();

    const actor = request.adminSession?.email ?? 'unknown';
    const action = deriveAction(request);

    /**
     * The write is AWAITED, not fire-and-forget.
     *
     * Fire-and-forget lets the response complete before its audit row lands,
     * which means a burst of mutations can be acknowledged with rows still in
     * flight — and if the process is killed in between, the change happened and
     * the audit of it did not. Awaiting closes that window.
     *
     * `write` swallows its own errors, so an audit failure still cannot fail the
     * mutation it is recording; the ordering guarantee is the only thing gained
     * here, and it is the one that matters.
     */
    return next.handle().pipe(
      concatMap(async (result) => {
        await this.write(request, actor, action, result, null);
        return result;
      }),
      catchError((error: unknown) =>
        // Failed mutations are audited too — an attempted change is exactly the
        // thing an audit trail should show.
        from(this.write(request, actor, `${action}.failed`, null, error)).pipe(
          concatMap(() => throwError(() => error)),
        ),
      ),
    );
  }

  private async write(
    request: AdminRequest,
    actor: string,
    action: string,
    result: unknown,
    error: unknown,
  ): Promise<void> {
    try {
      const after = error === null ? redact(result) : { error: redact(error) };
      await this.prisma.adminAuditLog.create({
        data: {
          actor,
          action,
          targetType: deriveTargetType(request),
          targetId: deriveTargetId(request, result),
          // The request body, redacted. This is the record of what was asked
          // for, which matters even when the key inside it is masked.
          before: redact(request.body) as never,
          after: after as never,
          ip: clientIp(request),
          userAgent: request.get('user-agent') ?? null,
        },
      });
    } catch (writeError) {
      // An audit failure must not fail the request that succeeded, but it must
      // be loud — a silently unaudited mutation is worse than a noisy one.
      this.logger.error(
        `Failed to write audit row for ${action} by ${actor}: ${String(writeError)}`,
      );
    }
  }
}

/** e.g. POST /v1/admin/providers -> "provider.create" */
function deriveAction(request: AdminRequest): string {
  const segments = request.path.replace(/^\/v1\/admin\/?/, '').split('/').filter(Boolean);
  const resource = singular(segments[0] ?? 'admin');
  const tail = segments.at(-1);

  // A trailing verb segment names the action directly.
  if (tail && !/^[a-z0-9]{20,}$/i.test(tail) && segments.length > 1) {
    return `${resource}.${tail}`;
  }
  switch (request.method) {
    case 'POST':
      return `${resource}.create`;
    case 'PATCH':
    case 'PUT':
      return `${resource}.update`;
    case 'DELETE':
      return `${resource}.delete`;
    default:
      return `${resource}.${request.method.toLowerCase()}`;
  }
}

function deriveTargetType(request: AdminRequest): string {
  const first = request.path.replace(/^\/v1\/admin\/?/, '').split('/')[0] ?? 'admin';
  switch (singular(first)) {
    case 'provider':
      return 'AiProvider';
    case 'prompt':
      return 'PromptVersion';
    case 'model':
    case 'setting':
      return 'AppSetting';
    default:
      return 'Admin';
  }
}

function deriveTargetId(request: AdminRequest, result: unknown): string | null {
  const fromParams = (request.params as Record<string, string> | undefined)?.id;
  if (fromParams) return fromParams;
  if (result && typeof result === 'object' && 'id' in result) {
    const id = (result as { id: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return null;
}

function singular(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function clientIp(request: AdminRequest): string | null {
  const forwarded = request.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0]?.trim() ?? null;
  return request.ip ?? null;
}
