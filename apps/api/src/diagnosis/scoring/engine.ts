import { DiagnosisOutputSchema } from '@cbd/contracts';
import {
  AIError,
  AIErrorKind,
  type AIProvider,
  type Degradation,
  type GenerationParams,
  type NormalizedUsage,
  type StopReason,
  type StructuredMode,
  type StructuredResponse,
} from '@cbd/ai';
import { aggregateDiagnosis, type AggregatedDiagnosis } from './aggregate.js';
import { parseDiagnosis } from './schema.js';

/**
 * The scoring engine.
 *
 * `run(provider, prompt, brief, params)` — it RECEIVES the provider and never
 * resolves one. That single choice is what makes it testable with a fake,
 * shadow-mode a service-level addition, and the whole thing extractable into
 * packages/scoring later. No decorators anywhere in this file.
 *
 * The governing rule of response handling: check `stopReason` before reading
 * `output`. `output` can legitimately be null.
 */

export interface PromptSnapshot {
  promptVersionId: string;
  /** The active version's content, verbatim. Nothing is interpolated into it. */
  content: string;
  contentHash: string;
  /** Human label for display. Never appears inside `content`. */
  label: string;
}

export interface EngineResult {
  aggregated: AggregatedDiagnosis;
  /**
   * The provider's response text, exactly as received.
   *
   * The diagnosis path ignores this on purpose — it persists the parsed,
   * aggregated result and nothing raw. It is surfaced for the admin prompt
   * test-draft screen, where reading what the model ACTUALLY said is the entire
   * point of running a draft, especially when parsing failed and the aggregated
   * view is the least informative thing available.
   */
  rawOutput: string;
  usage: NormalizedUsage;
  stopReason: StopReason;
  structuredOutputMode: StructuredMode;
  providerRequestId: string | null;
  latencyMs: number;
  degradations: Degradation[];
  retryCount: number;
  /** The params actually sent, for the provenance snapshot. */
  paramsSent: EngineParams;
}

/**
 * Generation params plus the model id. The engine never names a model itself —
 * constitution principle 3 — so the caller supplies it here alongside the
 * negotiated parameters.
 */
export type EngineParams = GenerationParams & { model: string };

export interface EngineOptions {
  signal?: AbortSignal | undefined;
  /** Emitted when the provider reports its first token. */
  onFirstToken?: (() => void) | undefined;
  /**
   * Multiplier for the single max_tokens retry. The retry exists because a
   * truncated response is unparseable, and saving a partial diagnosis is worse
   * than failing.
   */
  maxTokensRetryFactor?: number;
}

const DEFAULT_RETRY_FACTOR = 2;

export async function run(
  provider: AIProvider,
  prompt: PromptSnapshot,
  brief: string,
  params: EngineParams,
  options: EngineOptions = {},
): Promise<EngineResult> {
  const degradations: Degradation[] = [];
  let retryCount = 0;
  let paramsSent = params;

  let response = await callProvider(provider, prompt, brief, paramsSent, options);

  // ── max_tokens: retry ONCE at a higher cap ────────────────────────────────
  // Thinking tokens count against the output budget on some providers, so a
  // budget sized for "just the JSON" truncates. Retrying beats persisting a
  // partial diagnosis; retrying twice would just burn quota.
  if (response.stopReason === 'max_tokens') {
    const factor = options.maxTokensRetryFactor ?? DEFAULT_RETRY_FACTOR;
    const raised = Math.min(
      Math.floor(paramsSent.maxTokens * factor),
      provider.capabilities.maxOutputTokens,
    );

    if (raised > paramsSent.maxTokens) {
      retryCount = 1;
      degradations.push({
        code: 'json_repaired',
        detail:
          `Response truncated at maxTokens=${paramsSent.maxTokens} `
          + `(output ${response.usage.outputTokens} + reasoning `
          + `${response.usage.reasoningTokens}); retried once at ${raised}.`,
      });
      paramsSent = { ...paramsSent, maxTokens: raised };
      response = await callProvider(provider, prompt, brief, paramsSent, options);
    }

    if (response.stopReason === 'max_tokens') {
      throw new AIError({
        kind: AIErrorKind.CONTEXT_OVERFLOW,
        message:
          `Response still truncated at maxTokens=${paramsSent.maxTokens}. `
          + 'Nothing persisted — a partial diagnosis is worse than none.',
        provider: provider.id,
        providerRequestId: response.providerRequestId,
      });
    }
  }

  // ── refusal and content_filter: persist nothing ───────────────────────────
  if (response.stopReason === 'refusal' || response.stopReason === 'content_filter') {
    throw new AIError({
      kind: AIErrorKind.REFUSAL,
      message: `Provider returned stopReason=${response.stopReason}. Nothing persisted.`,
      provider: provider.id,
      providerRequestId: response.providerRequestId,
    });
  }

  if (response.stopReason === 'context_overflow') {
    throw new AIError({
      kind: AIErrorKind.CONTEXT_OVERFLOW,
      message: 'Input exceeded the model context window.',
      provider: provider.id,
      providerRequestId: response.providerRequestId,
    });
  }

  // Only now is it safe to read output.
  let parsed = parseDiagnosis(response.raw);

  // ── one repair attempt, fed the validator's own error ─────────────────────
  if (!parsed.ok) {
    retryCount += 1;
    degradations.push({
      code: 'json_repaired',
      detail: `First response failed at the ${parsed.stage} stage; retried once with the validator error.`,
    });

    const corrective = [
      prompt.content,
      '',
      '---',
      '',
      'Your previous response could not be accepted:',
      '',
      parsed.validatorError,
      '',
      'Return the corrected JSON object only.',
    ].join('\n');

    // NOTE: the corrective text is appended for THIS request only and is never
    // written back to the prompt version. Prompt content stays immutable and
    // its hash stays valid, which is why the retry composes a new string rather
    // than mutating the snapshot.
    const retryResponse = await callProvider(
      provider,
      { ...prompt, content: corrective },
      brief,
      paramsSent,
      options,
    );

    if (retryResponse.stopReason !== 'complete') {
      throw new AIError({
        kind: AIErrorKind.BAD_REQUEST,
        message:
          `Repair attempt ended with stopReason=${retryResponse.stopReason}. Nothing persisted.`,
        provider: provider.id,
        providerRequestId: retryResponse.providerRequestId,
      });
    }

    // Accumulate usage across both calls so the cost figure is honest.
    response = mergeUsage(response, retryResponse);
    parsed = parseDiagnosis(retryResponse.raw);

    // One attempt, then fail cleanly. No loop.
    if (!parsed.ok) {
      throw new AIError({
        kind: AIErrorKind.BAD_REQUEST,
        message:
          `Response failed validation twice at the ${parsed.stage} stage. `
          + `Nothing persisted. Validator said: ${parsed.validatorError}`,
        provider: provider.id,
        providerRequestId: response.providerRequestId,
      });
    }
  }

  if (parsed.repaired) {
    degradations.push({
      code: 'json_repaired',
      detail: `Output recovered using the "${parsed.strategy}" strategy rather than parsing directly.`,
    });
  }

  const aggregated = aggregateDiagnosis(parsed.output);
  for (const correction of aggregated.corrections) {
    degradations.push({ code: 'schema_relaxed', detail: correction });
  }

  return {
    aggregated,
    rawOutput: response.raw,
    usage: response.usage,
    stopReason: response.stopReason,
    structuredOutputMode: response.structuredOutputMode,
    providerRequestId: response.providerRequestId,
    latencyMs: response.latencyMs,
    degradations: [...response.degradations, ...degradations],
    retryCount,
    paramsSent,
  };
}

async function callProvider(
  provider: AIProvider,
  prompt: PromptSnapshot,
  brief: string,
  params: EngineParams,
  options: EngineOptions,
): Promise<StructuredResponse<unknown>> {
  const { model, ...generation } = params;
  const request = {
    model,
    system: prompt.content,
    user: brief,
    schema: DiagnosisOutputSchema,
    params: generation,
    signal: options.signal,
  };

  if (options.onFirstToken && provider.capabilities.supportsStreaming) {
    let announced = false;
    let final: StructuredResponse<unknown> | undefined;
    for await (const event of provider.streamStructured(request)) {
      if (event.type === 'first-token' && !announced) {
        announced = true;
        options.onFirstToken();
      }
      if (event.type === 'result') final = event.response;
    }
    if (!final) {
      throw new AIError({
        kind: AIErrorKind.UPSTREAM,
        message: 'Provider stream produced no result event.',
        provider: provider.id,
      });
    }
    return final;
  }

  const response = await provider.generateStructured(request);
  options.onFirstToken?.();
  return response;
}

/** Two calls happened, so the recorded cost has to reflect both. */
function mergeUsage(
  first: StructuredResponse<unknown>,
  second: StructuredResponse<unknown>,
): StructuredResponse<unknown> {
  return {
    ...second,
    usage: {
      inputTokens: first.usage.inputTokens + second.usage.inputTokens,
      outputTokens: first.usage.outputTokens + second.usage.outputTokens,
      cachedReadTokens: first.usage.cachedReadTokens + second.usage.cachedReadTokens,
      cachedWriteTokens: first.usage.cachedWriteTokens + second.usage.cachedWriteTokens,
      reasoningTokens: first.usage.reasoningTokens + second.usage.reasoningTokens,
      tokenSource: second.usage.tokenSource,
    },
    latencyMs: first.latencyMs + second.latencyMs,
    degradations: [...first.degradations, ...second.degradations],
  };
}
