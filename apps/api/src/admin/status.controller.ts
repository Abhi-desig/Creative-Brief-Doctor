import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { QuotaService } from '../ai/quota.service.js';
import { CapabilityGate } from '../ai/capability-gate.service.js';
import { AdminAuthGuard } from './admin-auth.guard.js';

/**
 * The admin status page. Three numbers plus health, all aggregate queries over
 * Diagnosis — no new instrumentation.
 */
@ApiExcludeController()
// `global` only. The previous set omitted `promptTest`, so the 20-per-hour tier
// meant for live model runs governed this read-only status poll — an admin page
// refreshing once a minute went dead after twenty minutes.
@SkipThrottle(skipAllExcept('global'))
@Controller('v1/admin/status')
@UseGuards(AdminAuthGuard)
export class AdminStatusController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly quota: QuotaService,
    private readonly gate: CapabilityGate,
  ) {}

  @Get()
  async status() {
    const resolved = await this.settings.resolve();
    const quota = await this.quota.status();
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [today, spend, promptCheck] = await Promise.all([
      this.prisma.diagnosis.count({ where: { createdAt: { gte: startOfUtcDay() } } }),
      this.prisma.diagnosis.aggregate({
        where: { createdAt: { gte: startOfUtcDay() } },
        _sum: { costUsd: true },
      }),
      this.settings.verifyActivePromptHash(),
    ]);

    // Error counts by kind over the last 24h, read from the audit log's failed
    // actions rather than from a new metrics table.
    const failures = await this.prisma.adminAuditLog.groupBy({
      by: ['action'],
      where: { createdAt: { gte: since }, action: { endsWith: '.failed' } },
      _count: { action: true },
    });

    return {
      provider: {
        kind: resolved.providerKind,
        label: resolved.providerLabel,
        model: resolved.activeModel,
        degradedReason: resolved.degradedReason,
        capabilities: resolved.provider
          ? this.gate.formControls(resolved.provider)
          : null,
      },
      prompt: promptCheck.status === 'checked'
        ? { label: promptCheck.label, hashMatches: promptCheck.matches }
        : { label: null, hashMatches: false },
      today: {
        diagnoses: today,
        // "free tier" rather than a silent zero when no pricing is configured.
        spendUsd: spend._sum.costUsd === null ? null : Number(spend._sum.costUsd),
        quotaUsed: quota.used,
        quotaCap: quota.cap,
        quotaResetsAt: quota.resetsAt,
      },
      failuresLast24h: failures.map((f) => ({ action: f.action, count: f._count.action })),
    };
  }
}

function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
