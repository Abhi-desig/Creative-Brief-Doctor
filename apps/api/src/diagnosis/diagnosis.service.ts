import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { nanoid } from 'nanoid';
import { AIError, type Degradation } from '@cbd/ai';
import { PrismaService } from '../prisma/prisma.service.js';
import { ProviderRegistry } from '../ai/provider-registry.service.js';
import { QuotaService } from '../ai/quota.service.js';
import { PricingService } from '../ai/pricing.service.js';
import { PromptsService } from '../prompts/prompts.service.js';
import { run, type EngineParams } from './scoring/engine.js';
import { EventQueue, interleave } from '../common/interleave.js';

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
    private readonly pricing: PricingService,
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
        // How many times this brief has been scored. A count rather than a
        // history endpoint: the author-only row needs the number, not the rows,
        // and `take: 1` above deliberately serves only the newest — a report
        // shows one diagnosis, and which one must never be ambiguous.
        _count: { select: { diagnoses: true } },
      },
    });
    if (!brief) throw new NotFoundException('Brief not found.');

    const diagnosis = brief.diagnoses[0];
    return {
      brief: {
        publicId: brief.publicId,
        title: brief.title,
        // Who the brief came from. The report page uses it for one thing only:
        // turning the ready-to-send message's `Hi,` into `Hi Sarah,`. That
        // message is the artefact this product exists to produce, and a generic
        // salutation is the difference between something you send and something
        // you rewrite first.
        requester: brief.requester,
        charCount: brief.charCount,
        createdAt: brief.createdAt,
        timesScored: brief._count.diagnoses,
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
   * The seeded gallery. Public, cacheable, and cheap — one indexed read.
   *
   * Ordered by score ascending so the gallery opens with the thinnest brief. The
   * two-line Slack request is the one that makes the tool's point immediately;
   * leading with a well-specified brief that scores 85 shows a reader nothing
   * they did not already believe.
   */
  async listExamples() {
    const briefs = await this.prisma.brief.findMany({
      where: { exampleShape: { not: null } },
      include: {
        diagnoses: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { overallScore: true, _count: { select: { questions: true } } },
        },
      },
    });

    return briefs
      // A seeded brief whose diagnosis failed is simply not an example yet.
      .filter((brief) => brief.diagnoses.length > 0)
      .map((brief) => ({
        publicId: brief.publicId,
        title: brief.title ?? 'Untitled brief',
        shape: brief.exampleShape!,
        overallScore: brief.diagnoses[0]!.overallScore,
        questionCount: brief.diagnoses[0]!._count.questions,
        charCount: brief.charCount,
      }))
      .sort((a, b) => a.overallScore - b.overallScore);
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

    /**
     * `scoring` has to reach the browser WHEN the first token arrives, not after
     * the generation finishes.
     *
     * This previously pushed into an array from inside `onFirstToken` and drained
     * it after `await run(...)` returned — but a callback nested inside an await
     * cannot yield from the enclosing generator, so the event was emitted after
     * the fact. The client sat on "Reading the brief" for the whole 22-33s
     * generation and then got scoring/saving/result back to back. See
     * common/interleave.ts for why a queue is the fix.
     */
    let announced = false;
    const queue = new EventQueue<DiagnosisEvent>();
    const result = yield* interleave(
      run(active.provider, prompt, brief.rawText, params, {
        signal,
        onFirstToken: () => {
          if (announced) return;
          announced = true;
          queue.push({ type: 'status', data: { phase: 'scoring' satisfies StatusPhase } });
        },
      }),
      queue,
    );
    // A provider without streaming support never fires the callback, so the phase
    // is still announced — just not early. The wire contract stays identical
    // whichever path ran.
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

    // Priced before the write so the row is complete on insert; a later UPDATE
    // would leave a window where the diagnosis exists with no cost and make the
    // admin spend total depend on when it was read.
    const costUsd = await this.pricing.costOf(active.providerKind, active.model, usage);

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
        // Still null when no price row exists — a silent zero in a cost figure is
        // worse than a gap — but now actually computed when one does. Gemini's
        // free tier has no price table, so null remains the expected value there.
        costUsd,
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
