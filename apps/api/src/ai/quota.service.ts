import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';

/**
 * The daily call cap.
 *
 * Deliberately NOT a throttler tier. Throttling protects against one client
 * making too many requests; this protects a shared upstream quota that every
 * user draws from. The distinction is concrete: on a free tier there is no bill
 * to cap, there is a fixed number of requests per day per project, and one
 * enthusiastic person can exhaust the day for everyone. A per-IP rate limit
 * cannot see that.
 *
 * Implemented as a count over Diagnosis.createdAt, which the
 * `@@index([createdAt])` makes cheap, so no new instrumentation is needed.
 */

export class QuotaExhaustedException extends ServiceUnavailableException {
  constructor(used: number, cap: number, resetsAt: Date) {
    super({
      code: 'QUOTA_EXHAUSTED',
      message:
        'Scoring is finished for today. The daily limit exists because the '
        + 'underlying model quota is shared across everyone using this tool.',
      used,
      cap,
      resetsAt: resetsAt.toISOString(),
    });
  }
}

export interface QuotaStatus {
  used: number;
  cap: number;
  remaining: number;
  resetsAt: Date;
  exhausted: boolean;
}

@Injectable()
export class QuotaService {
  private readonly logger = new Logger(QuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * @param cap Supplied by the caller, which has already resolved the active
   *   provider. Reading settings again here would let the cap and the provider
   *   come from two different resolutions — and in tests, from two different
   *   sources entirely.
   */
  async status(cap?: number, now = new Date()): Promise<QuotaStatus> {
    const effectiveCap = cap ?? (await this.settings.resolve()).params.dailyCallCap;
    const since = startOfUtcDay(now);

    const used = await this.prisma.diagnosis.count({
      where: { createdAt: { gte: since } },
    });

    return {
      used,
      cap: effectiveCap,
      remaining: Math.max(0, effectiveCap - used),
      resetsAt: nextUtcDay(now),
      exhausted: used >= effectiveCap,
    };
  }

  /**
   * Called before a model request. Throws the specific, friendly 503 rather
   * than letting the provider's own quota error surface — a brief scorer that
   * silently dies at 4pm every day is worse than one that says "back tomorrow".
   */
  async assertWithinCap(cap?: number, now = new Date()): Promise<QuotaStatus> {
    const status = await this.status(cap, now);
    if (status.exhausted) {
      this.logger.warn(
        `Daily cap reached: ${status.used}/${status.cap}. Resets ${status.resetsAt.toISOString()}.`,
      );
      throw new QuotaExhaustedException(status.used, status.cap, status.resetsAt);
    }
    return status;
  }
}

/**
 * UTC day boundaries. Chosen over local time because the cap protects an
 * upstream quota that resets on the provider's schedule, and a server timezone
 * change must not silently double or halve a day's allowance.
 */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function nextUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}
