import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { AIError, type Degradation } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';
import { QuotaService } from '../ai/quota.service.js';
import { PromptsService } from '../prompts/prompts.service.js';
import { run, type EngineParams } from './scoring/engine.js';

/**
 * Orchestration around the engine. Everything provider-specific lives behind
 * ProviderRegistry, and the engine itself is handed a provider — so this service
 * is the only thing that knows both, and it is the thing e2e tests override.
 */

export const MAX_BRIEF_CHARS = 20_000;

export type StatusPhase = 'reading' | 'scoring' | 'saving';

export interface DiagnosisEvent {
  type: 'status' | 'result' | 'error';
  data: unknown;
}

@Injectable()
export class DiagnosisService {
  private readonly logger = new Logger(DiagnosisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ProviderRegistry,
    private readonly quota: QuotaService,
    private readonly prompts: PromptsService,
  ) {}

  async createBrief(input: { text: string; title?: string; requester?: string }) {
    const rawText = input.text.trim();
    return this.prisma.brief.create({
      data: {
        publicId: nanoid(12),
        rawText,
        charCount: rawText.length,
        title: input.title ?? null,
        requester: input.requester ?? null,
      },
      select: { id: true, publicId: true, charCount: true, createdAt: true },
    });
  }

  /** The shareable report. A plain GET any stakeholder can open. */
  async getReport(publicId: string) {
    const brief = await this.prisma.brief.findUnique({
      where: { publicId },
      include: {
        diagnoses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: {
            dimensions: true,
            questions: { orderBy: { rank: 'asc' } },
            promptVersion: { select: { label: true } },
          },
        },
      },
    });
    if (!brief) throw new NotFoundException('Brief not found.');

    const diagnosis = brief.diagnoses[0];
    return {
      brief: {
        publicId: brief.publicId,
        title: brief.title,
        charCount: brief.charCount,
        createdAt: brief.createdAt,
      },
      diagnosis: diagnosis
        ? {
            publicId: diagnosis.publicId,
            overallScore: diagnosis.overallScore,
            verdict: diagnosis.verdict,
            summary: diagnosis.summary,
            dimensions: diagnosis.dimensions.map((d) => ({
              dimension: d.dimension,
              score: d.score,
              rationale: d.rationale,
              gaps: d.gaps,
              evidence: d.evidence,
            })),
            questions: diagnosis.questions.map((q) => ({
              dimension: q.dimension,
              question: q.question,
              blocking: q.blocking,
              rank: q.rank,
            })),
            // Provenance for the quiet footer line: the rubric version and the
            // date, deliberately NOT the provider or model. A stakeholder
            // reading a model name argues with the tooling instead of the brief.
            rubricVersion: diagnosis.rubricVersion,
            createdAt: diagnosis.createdAt,
          }
        : null,
    };
  }

  /**
   * Score a brief and persist the result. Yields coarse status events only —
   * never partial JSON, which renders as garbage and would make the wire
   * contract depend on which provider is active.
   */
  async *runStreaming(publicId: string, signal: AbortSignal): AsyncGenerator<DiagnosisEvent> {
    yield { type: 'status', data: { phase: 'reading' satisfies StatusPhase } };

    const brief = await this.prisma.brief.findUnique({ where: { publicId } });
    if (!brief) throw new NotFoundException('Brief not found.');

    // Admission gate, in cost order. The char cap is rejected at the DTO before
    // this point; the token ceiling costs one cheap native call; only then do we
    // spend a generation.
    const active = await this.registry.requireActive();
    await this.quota.assertWithinCap(active.settings.dailyCallCap);

    const count = await active.provider.countInputTokens({
      model: active.model,
      system: (await this.prompts.activeSnapshot()).content,
      user: brief.rawText,
    });
    if (count.tokens > active.settings.tokenCeiling) {
      throw new AIError({
        kind: 'context_overflow',
        message:
          `Brief needs ${count.tokens} input tokens, above the configured ceiling of `
          + `${active.settings.tokenCeiling}.`,
        provider: active.provider.id,
      });
    }

    const prompt = await this.prompts.activeSnapshot();
    const params: EngineParams = { ...active.params, model: active.model };

    let announced = false;
    const events: DiagnosisEvent[] = [];
    const result = await run(active.provider, prompt, brief.rawText, params, {
      signal,
      onFirstToken: () => {
        if (!announced) {
          announced = true;
          events.push({ type: 'status', data: { phase: 'scoring' satisfies StatusPhase } });
        }
      },
    });
    // Flush whatever the callback queued. The engine awaits internally, so this
    // is emitted after the fact rather than interleaved — the browser only cares
    // that it arrives before the result.
    for (const event of events) yield event;
    if (!announced) yield { type: 'status', data: { phase: 'scoring' satisfies StatusPhase } };

    yield { type: 'status', data: { phase: 'saving' satisfies StatusPhase } };

    const saved = await this.persist(brief.id, active, prompt, result);
    yield { type: 'result', data: saved };
  }

  private async persist(
    briefId: string,
    active: Awaited<ReturnType<ProviderRegistry['requireActive']>>,
    prompt: { promptVersionId: string; contentHash: string; label: string },
    result: Awaited<ReturnType<typeof run>>,
  ) {
    const { aggregated, usage } = result;

    const diagnosis = await this.prisma.diagnosis.create({
      data: {
        publicId: nanoid(12),
        briefId,
        overallScore: aggregated.overallScore,
        verdict: aggregated.verdict,
        summary: aggregated.summary,

        provider: active.providerKind,
        model: active.model,
        providerRequestId: result.providerRequestId,
        promptVersionId: prompt.promptVersionId,
        promptHash: prompt.contentHash,
        rubricVersion: prompt.label,
        params: result.paramsSent as never,
        structuredOutputMode: toPrismaMode(result.structuredOutputMode),
        degradations: result.degradations as never,
        retryCount: result.retryCount,

        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cacheReadTokens: usage.cachedReadTokens,
        cacheWriteTokens: usage.cachedWriteTokens,
        reasoningTokens: usage.reasoningTokens,
        tokenSource: usage.tokenSource === 'native' ? 'NATIVE' : 'ESTIMATED',
        // Left null when no price row exists. A silent zero in a cost figure is
        // worse than a gap.
        costUsd: null,
        latencyMs: result.latencyMs,

        dimensions: {
          create: aggregated.dimensions.map((d) => ({
            dimension: d.dimension,
            score: d.score,
            rationale: d.rationale,
            gaps: d.gaps,
            evidence: d.evidence,
          })),
        },
        questions: {
          create: aggregated.questions.map((q) => ({
            dimension: q.dimension,
            question: q.question,
            blocking: q.blocking,
            rank: q.rank,
          })),
        },
      },
      include: { dimensions: true, questions: { orderBy: { rank: 'asc' } } },
    });

    if (result.degradations.length > 0) {
      this.logger.warn(
        `Diagnosis ${diagnosis.publicId} recorded ${result.degradations.length} degradation(s): `
        + result.degradations.map((d: Degradation) => d.code).join(', '),
      );
    }

    return {
      publicId: diagnosis.publicId,
      overallScore: diagnosis.overallScore,
      verdict: diagnosis.verdict,
      summary: diagnosis.summary,
      dimensions: diagnosis.dimensions.map((d) => ({
        dimension: d.dimension,
        score: d.score,
        rationale: d.rationale,
        gaps: d.gaps,
        evidence: d.evidence,
      })),
      questions: diagnosis.questions.map((q) => ({
        dimension: q.dimension,
        question: q.question,
        blocking: q.blocking,
        rank: q.rank,
      })),
      rubricVersion: diagnosis.rubricVersion,
    };
  }
}

function toPrismaMode(mode: string): 'NATIVE_SCHEMA' | 'JSON_MODE' | 'PROMPT_ONLY' {
  switch (mode) {
    case 'native-schema':
      return 'NATIVE_SCHEMA';
    case 'json-mode':
      return 'JSON_MODE';
    default:
      return 'PROMPT_ONLY';
  }
}
