import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';

/**
 * Terminus ships a database indicator for TypeORM and Mongoose only, so Prisma
 * needs a small custom one. `SELECT 1` is the whole check — it proves the pool
 * can hand out a live connection, which is the only thing a liveness probe
 * should assert about the database.
 */
@Injectable()
export class PrismaHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly prisma: PrismaService,
  ) {}

  async check(key = 'database') {
    const indicator = this.health.check(key);
    const startedAt = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return indicator.up({ latencyMs: Date.now() - startedAt });
    } catch (error) {
      return indicator.down({
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Active-provider reachability.
 *
 * The distinction that matters: "no provider configured" is **degraded**, not
 * **down**. A fresh deployment with an empty database is working correctly and
 * waiting for an admin, and reporting it as down would fail a platform health
 * check and cause a restart loop that no amount of restarting fixes.
 *
 * A provider that IS configured but unreachable is genuinely down.
 */
@Injectable()
export class ActiveProviderHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    // Deliberately the registry, not SettingsService: health must resolve the
    // provider by exactly the path a diagnosis would, or the two can disagree
    // and /health will claim ready while scoring 503s.
    private readonly registry: ProviderRegistry,
  ) {}

  async check(key = 'activeProvider') {
    const indicator = this.health.check(key);
    const resolved = await this.registry.tryActive();

    if (!resolved) {
      // Reported up-with-a-reason rather than down: see the note above.
      return indicator.up({
        state: 'degraded',
        reason: 'NO_ACTIVE_PROVIDER',
        action: 'Configure a provider at /admin/providers.',
      });
    }

    const startedAt = Date.now();
    try {
      const ping = await resolved.provider.ping();
      return ping.ok
        ? indicator.up({
            providerKind: resolved.providerKind,
            model: resolved.model,
            latencyMs: ping.latencyMs,
          })
        : indicator.down({
            providerKind: resolved.providerKind,
            reason: 'PING_FAILED',
          });
    } catch (error) {
      return indicator.down({
        providerKind: resolved.providerKind,
        latencyMs: Date.now() - startedAt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Boot-time prompt integrity, surfaced as a health check.
 *
 * Verifies that the active prompt version's stored hash matches a fresh hash of
 * its content. A mismatch means something wrote to the content out of band, and
 * it must fail loudly — the quiet failure mode is a halved cache hit rate and
 * scores that are no longer attributable to the recorded configuration.
 */
@Injectable()
export class PromptIntegrityHealthIndicator {
  constructor(
    private readonly health: HealthIndicatorService,
    private readonly settings: SettingsService,
  ) {}

  async check(key = 'promptIntegrity') {
    const indicator = this.health.check(key);
    try {
      const result = await this.settings.verifyActivePromptHash();
      if (result.status === 'no-active-version') {
        return indicator.up({ state: 'degraded', reason: 'NO_ACTIVE_PROMPT_VERSION' });
      }
      if (!result.matches) {
        return indicator.down({
          reason: 'PROMPT_HASH_MISMATCH',
          promptVersionId: result.promptVersionId,
          storedHash: result.storedHash,
          computedHash: result.computedHash,
          message:
            'The active prompt version\'s content no longer hashes to its stored '
            + 'contentHash. Scores produced now are not attributable to the recorded '
            + 'configuration.',
        });
      }
      return indicator.up({
        promptVersionId: result.promptVersionId,
        label: result.label,
        contentHash: result.storedHash.slice(0, 12),
      });
    } catch (error) {
      return indicator.down({
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
