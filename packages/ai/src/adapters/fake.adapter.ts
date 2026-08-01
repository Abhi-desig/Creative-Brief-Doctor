import { DIMENSIONS, type DiagnosisOutput } from '@cbd/contracts';
import { AIError, type AIErrorKind } from '../errors.js';
import type {
  AIProvider,
  Degradation,
  ModelDescriptor,
  PingResult,
  ProviderCapabilities,
  ProviderEvent,
  StopReason,
  StructuredRequest,
  StructuredResponse,
  TokenCount,
  TokenCountRequest,
} from '../port.js';

/**
 * The test double. Returns fixtures, simulates every stopReason, every
 * AIError.kind, and abort.
 *
 * It is what e2e tests run against, which is why no SDK is ever stubbed: the
 * engine imports no SDK, so there is nothing to stub. Overriding
 * ProviderRegistry with this is the whole mocking strategy.
 */

export interface FakeProviderOptions {
  /** Force a terminal state. Defaults to 'complete'. */
  stopReason?: StopReason;
  /** Throw this taxonomy error instead of responding. */
  failWith?: AIErrorKind;
  /** Attached to a thrown rate_limit, so retry-after handling is testable. */
  retryAfterMs?: number;
  /** Artificial latency in ms, so abort has a window to fire into. */
  latencyMs?: number;
  /** Replace the fixture entirely. */
  output?: DiagnosisOutput;
  /** Return unparseable text, to exercise the repair path. */
  rawOverride?: string;
  /** Override declared capabilities, to test the engine's negotiation. */
  capabilities?: Partial<ProviderCapabilities>;
  /** Simulate a credential that fails. */
  badKey?: boolean;
}

const DEFAULT_CAPABILITIES: ProviderCapabilities = {
  structuredOutput: 'native-schema',
  schemaDialect: 'json-schema-strict',
  promptCaching: 'none',
  nativeTokenCounting: true,
  supportsTemperature: true,
  supportsTopP: true,
  supportsTopK: false,
  supportsThinkingBudget: false,
  supportsStreaming: true,
  supportsAssistantPrefill: false,
  maxOutputTokens: 16_000,
  contextWindow: 200_000,
  reportsCost: 'free',
};

/** A fixture that satisfies DiagnosisOutputSchema. */
export function fakeDiagnosis(score = 60): DiagnosisOutput {
  const dimensions = Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      {
        score,
        rationale: `The brief matches the ${score} anchor for ${d}.`,
        gaps: score === 100 ? [] : [`no stated detail for ${d.toLowerCase()}`],
        evidence: score > 0 ? ['We need a video for the new dashboard.'] : [],
      },
    ]),
  ) as DiagnosisOutput['dimensions'];

  return {
    summary: 'The brief names a deliverable and a rough budget, and does not yet say what it is for.',
    dimensions,
    questions: [
      {
        dimension: 'OBJECTIVE_CLARITY',
        question: 'What should someone do differently after seeing this?',
        blocking: true,
        rank: 1,
      },
      {
        dimension: 'SUCCESS_METRICS',
        question: 'What number are we hoping to move, and from what baseline?',
        blocking: true,
        rank: 2,
      },
      {
        dimension: 'AUDIENCE_SPECIFICITY',
        question: 'Which customers specifically — new, existing, or a segment?',
        blocking: false,
        rank: 3,
      },
    ],
  };
}

export class FakeProvider implements AIProvider {
  readonly id = 'fake' as const;
  readonly capabilities: ProviderCapabilities;

  private readonly options: FakeProviderOptions;

  constructor(options: FakeProviderOptions = {}) {
    this.options = options;
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...options.capabilities };
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    await this.delay(req.signal);
    if (this.options.failWith) throw this.buildError(this.options.failWith);

    const degradations = this.dropUnsupportedParams(req);
    const stopReason = this.options.stopReason ?? 'complete';
    const output = this.options.output ?? fakeDiagnosis();
    const raw = this.options.rawOverride ?? JSON.stringify(output);

    return {
      // The port's rule, honoured by the double as well as the real adapters.
      output: stopReason === 'complete' ? (output as unknown as T) : null,
      raw,
      stopReason,
      usage: {
        inputTokens: this.estimate(req.system + req.user),
        outputTokens: this.estimate(raw),
        cachedReadTokens: 0,
        cachedWriteTokens: 0,
        reasoningTokens: 0,
        tokenSource: this.capabilities.nativeTokenCounting ? 'native' : 'estimated',
      },
      latencyMs: this.options.latencyMs ?? 1,
      providerRequestId: 'fake_req_00000000',
      structuredOutputMode: this.capabilities.structuredOutput,
      degradations,
    };
  }

  async *streamStructured<T>(req: StructuredRequest<T>): AsyncIterable<ProviderEvent<T>> {
    yield { type: 'start' };
    // Abort must be observable between events, not only inside the request.
    this.throwIfAborted(req.signal);
    await this.delay(req.signal);
    if (this.options.failWith) throw this.buildError(this.options.failWith);
    yield { type: 'first-token' };
    this.throwIfAborted(req.signal);

    const response = await this.generateStructured(req);
    if (!this.capabilities.supportsStreaming) {
      response.degradations.push({
        code: 'streaming_unavailable',
        detail: 'FakeProvider configured with supportsStreaming: false; fell back to a single call.',
      });
    }
    yield { type: 'result', response };
  }

  async countInputTokens(req: TokenCountRequest): Promise<TokenCount> {
    if (this.options.badKey) throw this.buildError('auth');
    return {
      tokens: this.estimate(req.system + req.user),
      source: this.capabilities.nativeTokenCounting ? 'native' : 'estimated',
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.options.badKey) throw this.buildError('auth');
    return [
      {
        id: 'fake-model-1',
        displayName: 'Fake Model 1',
        contextWindow: this.capabilities.contextWindow,
        maxOutputTokens: this.capabilities.maxOutputTokens,
      },
    ];
  }

  async ping(): Promise<PingResult> {
    if (this.options.badKey) throw this.buildError('auth');
    return { ok: true, latencyMs: 1, models: await this.listModels() };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Drops whatever the declared capabilities do not support, recording a
   * degradation per parameter. The real adapters do the same thing; keeping the
   * behaviour identical here is what lets the conformance suite assert it
   * uniformly.
   */
  private dropUnsupportedParams<T>(req: StructuredRequest<T>): Degradation[] {
    const degradations: Degradation[] = [];
    const { params } = req;
    const drop = (name: string, value: unknown): void => {
      if (value === undefined) return;
      degradations.push({
        code: 'param_dropped',
        detail: `${name} is not supported by fake; dropped instead of forwarded.`,
      });
    };

    if (!this.capabilities.supportsTemperature) drop('temperature', params.temperature);
    if (!this.capabilities.supportsTopP) drop('topP', params.topP);
    if (!this.capabilities.supportsTopK) drop('topK', params.topK);
    if (!this.capabilities.supportsThinkingBudget) drop('thinkingBudget', params.thinkingBudget);
    if (!this.capabilities.nativeTokenCounting) {
      degradations.push({
        code: 'token_count_estimated',
        detail: 'fake declares no native token counting; counts are estimated from length.',
      });
    }
    return degradations;
  }

  private buildError(kind: AIErrorKind): AIError {
    const messages: Record<AIErrorKind, string> = {
      rate_limit: 'Simulated per-minute rate limit.',
      quota_exhausted: 'Simulated daily quota exhaustion. Does not reset for hours.',
      timeout: 'Simulated timeout.',
      auth: 'Simulated invalid credential.',
      context_overflow: 'Simulated context window overflow.',
      bad_request: 'Simulated malformed request — likely a schema transform mismatch.',
      refusal: 'Simulated refusal.',
      upstream: 'Simulated upstream failure.',
    };
    return new AIError({
      kind,
      message: messages[kind],
      provider: 'fake',
      providerRequestId: 'fake_req_00000000',
      ...(kind === 'rate_limit' && this.options.retryAfterMs !== undefined
        ? { retryAfterMs: this.options.retryAfterMs }
        : {}),
    });
  }

  private throwIfAborted(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw abortError();
  }

  /** Resolves after the configured latency, or rejects the moment abort fires. */
  private delay(signal: AbortSignal | undefined): Promise<void> {
    this.throwIfAborted(signal);
    const ms = this.options.latencyMs ?? 1;
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(abortError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private estimate(text: string): number {
    return Math.max(1, Math.ceil(text.length / 4));
  }
}

/**
 * The port's abort contract: rejection with a standard AbortError, not a
 * taxonomy error. Abort is the caller's own doing, so it is not a provider
 * failure and should not be counted as one.
 */
export function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
