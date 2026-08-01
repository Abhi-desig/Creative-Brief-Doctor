import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AIProvider } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { KeyVaultService, fromPrismaBytes, toPrismaBytes } from '../ai/key-vault.service.js';
import { buildAdapter } from '../ai/adapter.factory.js';
import type { Env } from '../config/env.schema.js';

/**
 * Configuration resolution, in this order:
 *
 *   1. DB: AppSetting singleton  ->  activeProviderId, activeModel, params, ceilings
 *   2. DB: AiProvider row        ->  encrypted key, base URL
 *   3. env bootstrap (optional)  ->  AI_BOOTSTRAP_*
 *   4. nothing configured        ->  boots healthy-but-degraded
 *
 * Step 4 is the case that used to crash the process. It must not.
 */

export interface ResolvedParams {
  maxTokens: number;
  temperature: number | undefined;
  topP: number | undefined;
  thinkingBudget: number | undefined;
  timeoutMs: number;
  maxRetries: number;
  tokenCeiling: number;
  dailyCallCap: number;
  costCeilingUsd: number;
}

export interface ResolvedConfig {
  /** null when nothing is configured. Callers must handle it. */
  provider: AIProvider | null;
  providerId: string | null;
  providerKind: 'GOOGLE' | 'ANTHROPIC' | null;
  providerLabel: string | null;
  activeModel: string | null;
  params: ResolvedParams;
  degradedReason:
    | 'NO_ACTIVE_PROVIDER'
    | 'NO_CREDENTIAL'
    | 'CREDENTIAL_UNREADABLE'
    /** The kind is known but no adapter is built for it — today, ANTHROPIC. */
    | 'PROVIDER_UNAVAILABLE'
    | null;
}

/**
 * A partial update of the singleton.
 *
 * `undefined` leaves a field untouched; an explicit `null` on the three nullable
 * params clears it, which is how a model that rejects `temperature` gets that
 * column emptied rather than left at a stale value.
 */
export interface SettingsUpdate {
  activeProviderId?: string | undefined;
  activeModel?: string | undefined;
  maxTokens?: number | undefined;
  temperature?: number | null | undefined;
  topP?: number | null | undefined;
  thinkingBudget?: number | null | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  tokenCeiling?: number | undefined;
  dailyCallCap?: number | undefined;
  costCeilingUsd?: number | undefined;
}

export type PromptHashCheck =
  | { status: 'no-active-version'; matches: false }
  | {
      status: 'checked';
      matches: boolean;
      promptVersionId: string;
      label: string;
      storedHash: string;
      computedHash: string;
    };

const DEFAULT_PARAMS: ResolvedParams = {
  maxTokens: 16_000,
  temperature: undefined,
  topP: undefined,
  thinkingBudget: undefined,
  timeoutMs: 120_000,
  maxRetries: 3,
  tokenCeiling: 12_000,
  dailyCallCap: 400,
  costCeilingUsd: 0.5,
};

/** Short enough that a stale read is bounded; invalidation does the real work. */
const CACHE_TTL_MS = 10_000;

@Injectable()
export class SettingsService {
  private readonly logger = new Logger(SettingsService.name);
  private cache: { value: ResolvedConfig; expiresAt: number } | null = null;
  private bootstrapAttempted = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly vault: KeyVaultService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Fired by every admin write. Without this, changing the model would take up
   * to a TTL to apply, which reads as "the panel doesn't work".
   */
  invalidate(): void {
    this.cache = null;
  }

  async resolve(): Promise<ResolvedConfig> {
    if (this.cache && this.cache.expiresAt > Date.now()) return this.cache.value;

    const value = await this.load();
    this.cache = { value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  /**
   * The decrypted key is deliberately NOT part of ResolvedConfig and never
   * cached: it is decrypted inside `load()`, handed to the adapter closure, and
   * dropped. Nothing holds the plaintext across requests.
   */
  private async load(): Promise<ResolvedConfig> {
    await this.maybeBootstrap();

    const setting = await this.prisma.appSetting.findUnique({
      where: { id: 'singleton' },
      include: { activeProvider: true },
    });

    const params: ResolvedParams = setting
      ? {
          maxTokens: setting.maxTokens,
          temperature: setting.temperature ?? undefined,
          topP: setting.topP ?? undefined,
          thinkingBudget: setting.thinkingBudget ?? undefined,
          timeoutMs: setting.timeoutMs,
          maxRetries: setting.maxRetries,
          tokenCeiling: setting.tokenCeiling,
          dailyCallCap: setting.dailyCallCap,
          costCeilingUsd: Number(setting.costCeilingUsd),
        }
      : DEFAULT_PARAMS;

    const empty = (
      reason: ResolvedConfig['degradedReason'],
    ): ResolvedConfig => ({
      provider: null,
      providerId: null,
      providerKind: null,
      providerLabel: null,
      activeModel: setting?.activeModel ?? null,
      params,
      degradedReason: reason,
    });

    const row = setting?.activeProvider;
    if (!row || !setting?.activeModel) return empty('NO_ACTIVE_PROVIDER');
    if (row.status === 'DISABLED') return empty('NO_ACTIVE_PROVIDER');
    if (!row.keyCiphertext) return empty('NO_CREDENTIAL');

    let apiKey: string;
    try {
      apiKey = this.vault.open(
        {
          keyCiphertext: fromPrismaBytes(row.keyCiphertext),
          keyIv: fromPrismaBytes(row.keyIv),
          keyTag: fromPrismaBytes(row.keyTag),
          ...(row.keyLast4 ? { keyLast4: row.keyLast4 } : {}),
        },
        row.id,
      );
    } catch (error) {
      // Surfaced in the admin panel, not to end users. Degraded, not crashed.
      this.logger.error(
        `Active provider ${row.id} (${row.kind}) has an unreadable credential: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return empty('CREDENTIAL_UNREADABLE');
    }

    /**
     * `buildAdapter` throws for any kind without an adapter — ANTHROPIC today.
     * It used to be called outside this try/catch, one line below the block that
     * carefully degrades an unreadable credential, which made a single env var
     * (`AI_BOOTSTRAP_PROVIDER=anthropic` is accepted by the schema) turn every
     * caller of `resolve()` into a 500: `/health`, `requireActive`, QuotaService
     * and the admin status page. Step 4 of the resolution order above says this
     * must never crash, and now it doesn't — an unbuildable provider is degraded
     * exactly like a missing one, and the admin panel can still be reached to fix
     * it.
     */
    let provider: AIProvider;
    try {
      provider = buildAdapter({
        kind: row.kind,
        apiKey,
        baseUrl: row.baseUrl ?? undefined,
        thinkingBudget: params.thinkingBudget,
      });
    } catch (error) {
      this.logger.error(
        `Active provider ${row.id} has kind ${row.kind}, which has no adapter: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return empty('PROVIDER_UNAVAILABLE');
    }

    return {
      provider,
      providerId: row.id,
      providerKind: row.kind,
      providerLabel: row.label,
      activeModel: setting.activeModel,
      params,
      degradedReason: null,
    };
  }

  /**
   * First-boot seed from AI_BOOTSTRAP_*. Idempotent, runs once, audited with
   * actor `system`. Exists for CI and for redeploys onto a fresh database —
   * entering the key through the panel makes it unnecessary.
   */
  private async maybeBootstrap(): Promise<void> {
    if (this.bootstrapAttempted) return;
    this.bootstrapAttempted = true;

    const kindRaw = this.config.get('AI_BOOTSTRAP_PROVIDER', { infer: true });
    const apiKey = this.config.get('AI_BOOTSTRAP_API_KEY', { infer: true });
    const model = this.config.get('AI_BOOTSTRAP_MODEL', { infer: true });
    if (!kindRaw || !apiKey || !model) return;

    const existing = await this.prisma.appSetting.findUnique({ where: { id: 'singleton' } });
    if (existing?.activeProviderId) return; // already configured; never overwrite

    const kind = kindRaw === 'google' ? 'GOOGLE' : 'ANTHROPIC';
    const label = `${kind === 'GOOGLE' ? 'Gemini' : 'Anthropic'} (bootstrap)`;

    await this.prisma.$transaction(async (tx) => {
      const provider = await tx.aiProvider.upsert({
        where: { kind_label: { kind, label } },
        create: { kind, label },
        update: {},
      });
      const sealed = this.vault.seal(apiKey, provider.id);
      await tx.aiProvider.update({
        where: { id: provider.id },
        data: {
          keyCiphertext: toPrismaBytes(sealed.keyCiphertext),
          keyIv: toPrismaBytes(sealed.keyIv),
          keyTag: toPrismaBytes(sealed.keyTag),
          keyLast4: sealed.keyLast4,
        },
      });
      await tx.appSetting.upsert({
        where: { id: 'singleton' },
        create: {
          id: 'singleton',
          activeProviderId: provider.id,
          activeModel: model,
          updatedBy: 'system',
        },
        update: { activeProviderId: provider.id, activeModel: model, updatedBy: 'system' },
      });
      await tx.adminAuditLog.create({
        data: {
          actor: 'system',
          action: 'provider.bootstrap',
          targetType: 'AiProvider',
          targetId: provider.id,
          after: { kind, label, model, keyLast4: sealed.keyLast4 },
        },
      });
    });

    this.logger.log(`Bootstrapped provider ${kind} with model ${model} from env.`);
  }

  /**
   * The only write path for AppSetting outside first-boot bootstrap.
   *
   * Its absence is why "add a second provider in the panel and re-score without
   * restarting" was impossible: `maybeBootstrap` is env-driven, one-shot, and
   * explicitly refuses to overwrite an existing configuration, so once a row
   * existed nothing in the running process could change the active provider or
   * model. The schema, the migration, the audit interceptor's `AppSetting`
   * mapping and the throttle tier were all in place; only this was missing.
   *
   * Upserts the singleton in one statement and then invalidates the cache, so the
   * next `resolve()` — including the one the very next diagnosis makes — sees the
   * new provider without a restart.
   */
  async update(input: SettingsUpdate, actor: string): Promise<ResolvedConfig> {
    const before = await this.prisma.appSetting.findUnique({ where: { id: 'singleton' } });

    /**
     * `undefined` means "leave alone" and must never reach Prisma as an explicit
     * null, or a PATCH of one field would blank every other. Nullable columns
     * (the three optional model params) accept an explicit null to CLEAR them,
     * which is a distinct and meaningful operation — so those are threaded
     * through as-is rather than being filtered out with the undefineds.
     */
    const data = {
      ...(input.activeProviderId !== undefined
        ? { activeProviderId: input.activeProviderId }
        : {}),
      ...(input.activeModel !== undefined ? { activeModel: input.activeModel } : {}),
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.thinkingBudget !== undefined ? { thinkingBudget: input.thinkingBudget } : {}),
      ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
      ...(input.maxRetries !== undefined ? { maxRetries: input.maxRetries } : {}),
      ...(input.tokenCeiling !== undefined ? { tokenCeiling: input.tokenCeiling } : {}),
      ...(input.dailyCallCap !== undefined ? { dailyCallCap: input.dailyCallCap } : {}),
      ...(input.costCeilingUsd !== undefined ? { costCeilingUsd: input.costCeilingUsd } : {}),
      updatedBy: actor,
    };

    await this.prisma.$transaction(async (tx) => {
      await tx.appSetting.upsert({
        where: { id: 'singleton' },
        create: { id: 'singleton', ...data },
        update: data,
      });
      await tx.adminAuditLog.create({
        data: {
          actor,
          action: 'settings.update',
          targetType: 'AppSetting',
          targetId: 'singleton',
          // No credential is reachable from this table, so neither snapshot needs
          // redaction — AppSetting holds a provider ID, never a key.
          before: (before ?? null) as never,
          after: data as never,
        },
      });
    });

    // Before returning, not after: the caller reads the fresh configuration and a
    // stale cache here would make the panel look like it silently ignored the
    // save.
    this.invalidate();
    return this.resolve();
  }

  /**
   * Boot-time integrity check: the active version's stored hash must equal a
   * fresh hash of its content. A mismatch fails the health check loudly rather
   * than quietly halving the cache hit rate.
   */
  async verifyActivePromptHash(templateKey = 'rubric'): Promise<PromptHashCheck> {
    const version = await this.prisma.promptVersion.findFirst({
      where: { status: 'ACTIVE', template: { key: templateKey } },
      select: { id: true, label: true, content: true, contentHash: true },
    });
    if (!version) return { status: 'no-active-version', matches: false };

    const computedHash = hashContent(version.content);
    return {
      status: 'checked',
      matches: computedHash === version.contentHash,
      promptVersionId: version.id,
      label: version.label,
      storedHash: version.contentHash,
      computedHash,
    };
  }
}

/**
 * The only place content is hashed. Hashes the content byte for byte with no
 * normalisation — a prompt version's content is immutable and nothing is
 * interpolated into it, so a single differing byte SHOULD produce a different
 * hash.
 */
export function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
