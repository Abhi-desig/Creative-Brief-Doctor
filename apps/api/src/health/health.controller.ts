import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { SkipThrottle } from '@nestjs/throttler';
import { skipAll } from '../common/throttle-tiers.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';
import {
  ActiveProviderHealthIndicator,
  PrismaHealthIndicator,
  PromptIntegrityHealthIndicator,
} from './health.indicators.js';

@ApiTags('health')
@Controller('health')
/**
 * Every tier, named explicitly. A bare `@SkipThrottle()` was here and did
 * NOTHING: it writes a `default` skip key, and the guard only looks up the tiers
 * we actually configured — so all four governed this route and the tightest of
 * them (adminLogin, 5 per 15 minutes) 429'd the 6th probe from a platform health
 * checker and stayed 429 for the rest of the window. A probe on a 10-30s interval
 * failed inside two minutes and never recovered, which is precisely the
 * restart-loop this endpoint's degraded-not-down design exists to prevent.
 */
@SkipThrottle(skipAll())
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly provider: ActiveProviderHealthIndicator,
    private readonly prompt: PromptIntegrityHealthIndicator,
    private readonly settings: SettingsService,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * Reports `status: degraded` with a reason when nothing is configured, rather
   * than failing. A fresh deployment waiting for an admin is working correctly,
   * and reporting it as down would cause a restart loop that restarting cannot
   * fix.
   */
  @Get()
  @ApiOperation({ summary: 'Liveness, plus configuration state.' })
  @HealthCheck()
  async check() {
    const result = await this.health.check([
      () => this.database.check(),
      () => this.provider.check(),
      () => this.prompt.check(),
    ]);

    const active = await this.registry.tryActive();
    const resolved = await this.settings.resolve();
    const degradedReasons = [
      active ? null : (resolved.degradedReason ?? 'NO_ACTIVE_PROVIDER'),
      (await this.settings.verifyActivePromptHash()).status === 'no-active-version'
        ? 'NO_ACTIVE_PROMPT_VERSION'
        : null,
    ].filter((r): r is string => r !== null);

    return {
      ...result,
      status: result.status === 'ok' && degradedReasons.length > 0 ? 'degraded' : result.status,
      ...(degradedReasons.length > 0
        ? { reason: degradedReasons[0], reasons: degradedReasons }
        : {}),
    };
  }
}
