import { Injectable, Logger } from '@nestjs/common';
import { AIError } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';
import { QuotaService } from '../ai/quota.service.js';
import { PricingService } from '../ai/pricing.service.js';
import { run, type EngineParams } from '../diagnosis/scoring/engine.js';
import { PromptsService } from './prompts.service.js';

/**
 * Runs a prompt version against one pasted brief and records the result.
 *
 * `PromptTestRun` was in the schema, migrated, indexed — and never written by
 * anything. The practical consequence was that a draft went straight from the
 * editor to ACTIVE, where it immediately governed every public diagnosis, with no
 * way to see its output even once first. Editing the rubric was therefore a
 * change you could only evaluate in production, on someone else's brief.
 *
 * Deliberately NOT a Diagnosis:
 *
 *   - it writes no `Diagnosis` row, so a test cannot appear in a public report,
 *     in the admin spend total's diagnosis count, or in anyone's device list;
 *   - it still counts against the daily quota, because it spends exactly the same
 *     upstream allowance as a real score and pretending otherwise is how a free
 *     tier gets exhausted by an afternoon of prompt tuning;
 *   - it records the raw output, because the entire reason to run a draft is to
 *     read what the model actually said, including when parsing failed.
 */
@Injectable()
export class PromptTestService {
  private readonly logger = new Logger(PromptTestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prompts: PromptsService,
    private readonly registry: ProviderRegistry,
    private readonly quota: QuotaService,
    private readonly pricing: PricingService,
  ) {}

  async testDraft(input: {
    versionId: string;
    briefText: string;
    actor: string;
    signal?: AbortSignal | undefined;
  }) {
    const snapshot = await this.prompts.snapshotOf(input.versionId);
    const active = await this.registry.requireActive();
    await this.quota.assertWithinCap(active.settings.dailyCallCap);

    const params: EngineParams = { ...active.params, model: active.model };
    const startedAt = Date.now();

    try {
      const result = await run(active.provider, snapshot, input.briefText, params, {
        ...(input.signal ? { signal: input.signal } : {}),
      });

      const costUsd = await this.pricing.costOf(
        active.providerKind,
        active.model,
        result.usage,
      );

      const row = await this.prisma.promptTestRun.create({
        data: {
          promptVersionId: snapshot.promptVersionId,
          provider: active.providerKind,
          model: active.model,
          briefText: input.briefText,
          params: result.paramsSent as never,
          rawOutput: result.rawOutput,
          parsedOutput: result.aggregated as never,
          stopReason: result.stopReason,
          overallScore: result.aggregated.overallScore,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          latencyMs: result.latencyMs,
          costUsd,
          createdBy: input.actor,
        },
        select: { id: true, createdAt: true },
      });

      return {
        id: row.id,
        createdAt: row.createdAt,
        promptVersionId: snapshot.promptVersionId,
        promptLabel: snapshot.label,
        provider: active.providerKind,
        model: active.model,
        stopReason: result.stopReason,
        structuredOutputMode: result.structuredOutputMode,
        scores: result.aggregated,
        rawOutput: result.rawOutput,
        usage: result.usage,
        latencyMs: result.latencyMs,
        costUsd: costUsd === null ? null : costUsd.toString(),
        // The point of a test run: which compromises the engine had to make. A
        // draft that only parses after a repair pass is a draft with a problem.
        degradations: result.degradations,
        retryCount: result.retryCount,
        error: null,
      };
    } catch (error) {
      /**
       * A failed run is recorded, not swallowed. "This draft makes the model
       * produce unparseable output" is the single most valuable thing a test can
       * tell you, and it is exactly the case where there is no result to return —
       * so it has to be persisted here or it is lost.
       */
      const message = error instanceof Error ? error.message : String(error);
      const kind = error instanceof AIError ? error.kind : 'unknown';

      await this.prisma.promptTestRun.create({
        data: {
          promptVersionId: snapshot.promptVersionId,
          provider: active.providerKind,
          model: active.model,
          briefText: input.briefText,
          params: params as never,
          rawOutput: '',
          stopReason: 'error',
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: Date.now() - startedAt,
          error: `${kind}: ${message}`,
          createdBy: input.actor,
        },
      }).catch((writeError: unknown) => {
        // Never let a bookkeeping failure replace the real error the operator
        // needs to see.
        this.logger.error(
          `Could not record the failed prompt test run: ${String(writeError)}`,
        );
      });

      throw error;
    }
  }

  /** Recent runs for a version, for the history panel under the editor. */
  async history(versionId: string, take = 20) {
    return this.prisma.promptTestRun.findMany({
      where: { promptVersionId: versionId },
      orderBy: { createdAt: 'desc' },
      take,
      // `briefText` and `rawOutput` are omitted: this feeds a list, and both are
      // large enough to make it slow for no benefit.
      select: {
        id: true,
        createdAt: true,
        model: true,
        provider: true,
        stopReason: true,
        overallScore: true,
        inputTokens: true,
        outputTokens: true,
        latencyMs: true,
        costUsd: true,
        error: true,
        createdBy: true,
      },
    });
  }
}
