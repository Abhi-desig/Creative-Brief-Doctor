import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Patch,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import type { ProviderCapabilities } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { SettingsService } from '../settings/settings.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';
import { CapabilityGate } from '../ai/capability-gate.service.js';
import { buildAdapter } from '../ai/adapter.factory.js';
import { KeyVaultService, fromPrismaBytes } from '../ai/key-vault.service.js';
import { skipAllExcept } from '../common/throttle-tiers.js';
import { AdminAuthGuard, type AdminRequest } from './admin-auth.guard.js';
import { AdminCsrfGuard } from './csrf.guard.js';
import { AuditInterceptor } from './audit.interceptor.js';

/**
 * Read and write the active model configuration.
 *
 * This is the endpoint the whole "provider-agnostic" claim rests on: without it
 * the active provider could only ever be set by an environment variable at first
 * boot, which makes "add a second provider in the panel and re-score without
 * restarting" impossible by construction.
 *
 * The GET deliberately returns the capability descriptor and the live model list
 * alongside the settings, because the panel's rule is that an unsupported control
 * is NEVER RENDERED — not rendered-and-disabled. A disabled input still tells the
 * operator the knob exists and invites a support question about why it is greyed
 * out; an absent one is simply not part of this model. That only works if the form
 * can iterate a descriptor rather than hard-coding which fields exist, so the
 * descriptor has to come from here.
 */

const PARAM_LIMITS = {
  maxTokens: { min: 256, max: 200_000 },
  temperature: { min: 0, max: 2 },
  topP: { min: 0, max: 1 },
  thinkingBudget: { min: 0, max: 32_768 },
  timeoutMs: { min: 5_000, max: 600_000 },
  maxRetries: { min: 0, max: 5 },
  tokenCeiling: { min: 256, max: 200_000 },
  dailyCallCap: { min: 0, max: 100_000 },
  costCeilingUsd: { min: 0, max: 1_000 },
} as const;

class UpdateSettingsDto extends createZodDto(
  z
    .object({
      activeProviderId: z.string().min(1).max(64).optional(),
      activeModel: z.string().min(1).max(200).optional(),
      maxTokens: z.number().int().min(PARAM_LIMITS.maxTokens.min)
        .max(PARAM_LIMITS.maxTokens.max).optional(),
      // Nullable, not merely optional: clearing a parameter is a distinct
      // operation from leaving it alone, and is what happens when an operator
      // switches to a model that rejects it.
      temperature: z.number().min(PARAM_LIMITS.temperature.min)
        .max(PARAM_LIMITS.temperature.max).nullable().optional(),
      topP: z.number().min(PARAM_LIMITS.topP.min).max(PARAM_LIMITS.topP.max)
        .nullable().optional(),
      thinkingBudget: z.number().int().min(PARAM_LIMITS.thinkingBudget.min)
        .max(PARAM_LIMITS.thinkingBudget.max).nullable().optional(),
      timeoutMs: z.number().int().min(PARAM_LIMITS.timeoutMs.min)
        .max(PARAM_LIMITS.timeoutMs.max).optional(),
      maxRetries: z.number().int().min(PARAM_LIMITS.maxRetries.min)
        .max(PARAM_LIMITS.maxRetries.max).optional(),
      tokenCeiling: z.number().int().min(PARAM_LIMITS.tokenCeiling.min)
        .max(PARAM_LIMITS.tokenCeiling.max).optional(),
      dailyCallCap: z.number().int().min(PARAM_LIMITS.dailyCallCap.min)
        .max(PARAM_LIMITS.dailyCallCap.max).optional(),
      costCeilingUsd: z.number().min(PARAM_LIMITS.costCeilingUsd.min)
        .max(PARAM_LIMITS.costCeilingUsd.max).optional(),
    })
    .strict(),
) {}

/** Which capability flag governs which submitted parameter. */
const CAPABILITY_FOR_PARAM = {
  temperature: 'supportsTemperature',
  topP: 'supportsTopP',
  thinkingBudget: 'supportsThinkingBudget',
} as const;

@ApiExcludeController()
@SkipThrottle(skipAllExcept('global'))
@Controller('v1/admin/model')
@UseGuards(AdminAuthGuard, AdminCsrfGuard)
@UseInterceptors(AuditInterceptor)
export class AdminSettingsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
    private readonly registry: ProviderRegistry,
    private readonly gate: CapabilityGate,
    private readonly vault: KeyVaultService,
  ) {}

  /**
   * Current settings, plus everything the form needs to render itself: which
   * controls this provider supports, and which models it offers.
   */
  @Get()
  async get() {
    const resolved = await this.settings.resolve();
    const active = await this.registry.tryActive();

    const providers = await this.prisma.aiProvider.findMany({
      select: { id: true, kind: true, label: true, status: true },
      orderBy: { createdAt: 'asc' },
    });

    if (!active) {
      // Degraded rather than an error: this is the page an operator opens
      // precisely BECAUSE nothing is configured, so it has to render.
      return {
        settings: this.publicSettings(resolved),
        providers,
        degradedReason: resolved.degradedReason,
        capabilities: null,
        controls: null,
        models: [],
      };
    }

    return {
      settings: this.publicSettings(resolved),
      providers,
      degradedReason: null,
      capabilities: active.provider.capabilities,
      controls: this.gate.formControls(active.provider),
      models: await this.listModelsSafely(active),
    };
  }

  @Patch()
  async update(@Body() dto: UpdateSettingsDto, @Req() request: AdminRequest) {
    // The provider being validated against is the one being SWITCHED TO, not the
    // one currently active — otherwise the first save that changes provider would
    // be checked against the outgoing model's capabilities.
    const target = await this.resolveTargetProvider(dto);

    if (target) {
      await this.assertModelIsOffered(target, dto);
      this.assertParamsAreSupported(target.capabilities, dto);
    }

    const resolved = await this.settings.update(
      dto,
      request.adminSession?.email ?? 'unknown',
    );
    return { settings: this.publicSettings(resolved), degradedReason: resolved.degradedReason };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** Never leaks a credential: AppSetting holds a provider id, never a key. */
  private publicSettings(resolved: Awaited<ReturnType<SettingsService['resolve']>>) {
    return {
      activeProviderId: resolved.providerId,
      activeProviderKind: resolved.providerKind,
      activeProviderLabel: resolved.providerLabel,
      activeModel: resolved.activeModel,
      ...resolved.params,
    };
  }

  /**
   * Builds the adapter for whichever provider this request will end up pointing
   * at, so validation reflects the post-save state.
   */
  private async resolveTargetProvider(dto: UpdateSettingsDto) {
    const resolved = await this.settings.resolve();
    const targetId = dto.activeProviderId ?? resolved.providerId;
    if (!targetId) return null;

    if (targetId === resolved.providerId && resolved.provider) return resolved.provider;

    const row = await this.prisma.aiProvider.findUnique({ where: { id: targetId } });
    if (!row) throw new BadRequestException('That provider does not exist.');
    if (row.status === 'DISABLED') {
      throw new BadRequestException('That provider is disabled. Enable it first.');
    }
    if (!row.keyCiphertext) {
      throw new BadRequestException('That provider has no API key stored. Add one first.');
    }

    try {
      return buildAdapter({
        kind: row.kind,
        apiKey: this.vault.open(
          {
            keyCiphertext: fromPrismaBytes(row.keyCiphertext),
            keyIv: fromPrismaBytes(row.keyIv),
            keyTag: fromPrismaBytes(row.keyTag),
            ...(row.keyLast4 ? { keyLast4: row.keyLast4 } : {}),
          },
          row.id,
        ),
        baseUrl: row.baseUrl ?? undefined,
        thinkingBudget: dto.thinkingBudget ?? undefined,
      });
    } catch (error) {
      // Covers both an unreadable credential and a kind with no adapter. Refusing
      // the save is right here — activating a provider that cannot be built would
      // put the whole app into PROVIDER_UNAVAILABLE, and the operator would have
      // to work out why from /health.
      throw new BadRequestException(
        `That provider cannot be activated: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * A model the provider does not offer is rejected here rather than at the first
   * diagnosis, where it would surface to a member of the public as a failed score.
   */
  private async assertModelIsOffered(
    provider: Awaited<ReturnType<AdminSettingsController['resolveTargetProvider']>> & object,
    dto: UpdateSettingsDto,
  ): Promise<void> {
    if (dto.activeModel === undefined) return;

    let offered: { id: string }[];
    try {
      offered = await provider.listModels();
    } catch {
      // The list endpoint being down is not a reason to block a save — the
      // adapter falls back to a static list, and an operator fixing a broken
      // configuration needs this page to work when the provider is unhappy.
      return;
    }

    if (offered.length > 0 && !offered.some((m) => m.id === dto.activeModel)) {
      throw new BadRequestException(
        `${provider.id} does not offer a model called "${dto.activeModel}". `
        + `Available: ${offered.map((m) => m.id).join(', ')}.`,
      );
    }
  }

  /**
   * Rejects any parameter the provider cannot honour.
   *
   * The panel never renders these controls in the first place — that is the
   * primary guarantee, and it is structural rather than defensive. This is the
   * server-side half: an unsupported value arriving here means the request did
   * not come from our form, and silently dropping it would leave a value sitting
   * in the database that the UI cannot show and the adapter will not send.
   */
  private assertParamsAreSupported(
    capabilities: ProviderCapabilities,
    dto: UpdateSettingsDto,
  ): void {
    const entries = Object.entries(CAPABILITY_FOR_PARAM) as [
      keyof typeof CAPABILITY_FOR_PARAM,
      (typeof CAPABILITY_FOR_PARAM)[keyof typeof CAPABILITY_FOR_PARAM],
    ][];

    for (const [param, capability] of entries) {
      const submitted = dto[param];
      // `null` clears the column, which is always allowed — it is how an operator
      // moves to a model that rejects the parameter.
      if (submitted === undefined || submitted === null) continue;
      if (capabilities[capability] !== true) {
        throw new BadRequestException(
          `This model does not support ${param}. Clear it (send null) or choose a `
          + 'model that supports it.',
        );
      }
    }
  }

  private async listModelsSafely(active: Awaited<ReturnType<ProviderRegistry['requireActive']>>) {
    try {
      return await active.provider.listModels();
    } catch {
      // The picker degrades to "the model you already have" rather than an empty
      // select that looks like the provider vanished.
      return active.model
        ? [{ id: active.model, displayName: active.model, contextWindow: null, maxOutputTokens: null }]
        : [];
    }
  }
}
