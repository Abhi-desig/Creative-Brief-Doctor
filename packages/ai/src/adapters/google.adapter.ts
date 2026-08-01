import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import { DiagnosisOutputParseSchema, DiagnosisOutputSchema } from '@cbd/contracts';
import { AIError, AIErrorKind } from '../errors.js';
import { abortError } from './fake.adapter.js';
import {
  assertGeminiSchemaInvariants,
  toGeminiSchema,
  type GeminiSchema,
} from './google.schema.js';
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
 * Google Gemini adapter. The only file in the package that imports the Google
 * SDK.
 *
 * Four things here are non-obvious and were all learned the hard way:
 *
 *   1. Thinking is ON by default on 2.5+ models and consumes maxOutputTokens
 *      alongside the JSON. Measured at this rubric it runs roughly 3.4x the
 *      size of the visible output, so a budget sized for "just the JSON"
 *      truncates and yields max_tokens with an unparseable tail.
 *   2. `usageMetadata.thoughtsTokenCount` is reported ALONGSIDE
 *      `candidatesTokenCount`, not folded into it. The port's convention
 *      requires exactly that, so no adjustment is needed here — but the
 *      opposite convention on other vendors is why the convention is written
 *      down.
 *   3. `countTokens` rejects `systemInstruction` on the Developer API (AI
 *      Studio keys); it is Vertex-only. To count the bytes actually sent, the
 *      system text is folded into `contents`.
 *   4. Prompt caching is implicit and undependable. We declare
 *      `promptCaching: 'automatic'` and report whatever usage returns, and we
 *      never assert a cache hit — that assertion flakes.
 */

export interface GoogleAdapterOptions {
  apiKey: string;
  /**
   * Optional override, for a proxy or a regional endpoint. Passed through to
   * the SDK's httpOptions.baseUrl.
   */
  baseUrl?: string | undefined;
  /**
   * Explicit thinking budget. 0 disables thinking on Flash models; -1 is
   * automatic. Left undefined the model decides, which is the default and is
   * why maxTokens must be sized generously.
   */
  thinkingBudget?: number | undefined;
  /** Models offered by the admin picker when the list endpoint is unavailable. */
  fallbackModels?: readonly string[] | undefined;
}

/**
 * Declared capabilities. Every one of these is asserted by the conformance
 * suite, so a wrong value here fails the build rather than surfacing as a 400
 * in production.
 */
const CAPABILITIES: ProviderCapabilities = {
  structuredOutput: 'native-schema',
  schemaDialect: 'openapi-subset',
  // Implicit and not dependable. Declared so the engine can reason about it;
  // never asserted on.
  promptCaching: 'automatic',
  nativeTokenCounting: true,
  supportsTemperature: true,
  supportsTopP: true,
  supportsTopK: true,
  supportsThinkingBudget: true,
  supportsStreaming: true,
  supportsAssistantPrefill: false,
  maxOutputTokens: 65_536,
  contextWindow: 1_048_576,
  reportsCost: 'free',
};

const DEFAULT_FALLBACK_MODELS = [
  'gemini-3.6-flash',
  'gemini-3.5-flash',
  'gemini-3.1-flash-lite',
] as const;

export class GoogleAdapter implements AIProvider {
  readonly id = 'google' as const;
  readonly capabilities: ProviderCapabilities = CAPABILITIES;

  private readonly client: GoogleGenAI;
  private readonly options: GoogleAdapterOptions;
  /** Compiled once per schema identity; the transform is pure. */
  private readonly schemaCache = new WeakMap<object, GeminiSchema>();

  constructor(options: GoogleAdapterOptions) {
    if (!options.apiKey) {
      throw new AIError({
        kind: AIErrorKind.AUTH,
        message: 'Google adapter constructed without an API key.',
        provider: 'google',
      });
    }
    this.options = options;
    this.client = new GoogleGenAI({
      apiKey: options.apiKey,
      ...(options.baseUrl ? { httpOptions: { baseUrl: options.baseUrl } } : {}),
    });
  }

  async generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>> {
    if (req.signal?.aborted) throw abortError();

    const degradations: Degradation[] = [];
    const config = this.buildConfig(req, degradations);
    const startedAt = Date.now();

    let raw: GenerateContentResponse;
    try {
      raw = await this.client.models.generateContent({
        model: req.model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config,
      });
    } catch (error) {
      throw this.mapError(error);
    }

    return this.normalize(raw, Date.now() - startedAt, degradations);
  }

  async *streamStructured<T>(req: StructuredRequest<T>): AsyncIterable<ProviderEvent<T>> {
    if (req.signal?.aborted) throw abortError();
    yield { type: 'start' };

    const degradations: Degradation[] = [];
    const config = this.buildConfig(req, degradations);
    const startedAt = Date.now();

    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.client.models.generateContentStream({
        model: req.model,
        contents: [{ role: 'user', parts: [{ text: req.user }] }],
        config,
      });
    } catch (error) {
      throw this.mapError(error);
    }

    // Coarse events only. Partial JSON is never forwarded — half-built JSON
    // renders as garbage, and forwarding it would make the wire contract
    // provider-dependent.
    let announced = false;
    let last: GenerateContentResponse | undefined;
    const chunks: string[] = [];
    try {
      for await (const chunk of stream) {
        if (req.signal?.aborted) throw abortError();
        last = chunk;
        const text = chunk.text;
        if (text) chunks.push(text);
        if (!announced && text) {
          announced = true;
          yield { type: 'first-token' };
        }
      }
    } catch (error) {
      if ((error as { name?: string }).name === 'AbortError') throw error;
      throw this.mapError(error);
    }

    // A response that produced no text still needs a first-token boundary, so
    // the consumer's state machine sees the same shape either way.
    if (!announced) yield { type: 'first-token' };

    if (!last) {
      throw new AIError({
        kind: AIErrorKind.UPSTREAM,
        message: 'Gemini stream closed without yielding a response.',
        provider: 'google',
      });
    }

    const response = this.normalize<T>(
      last,
      Date.now() - startedAt,
      degradations,
      chunks.join(''),
    );
    yield { type: 'result', response };
  }

  async countInputTokens(req: TokenCountRequest): Promise<TokenCount> {
    try {
      // systemInstruction is Vertex-only on countTokens, so the system text is
      // folded into contents. That counts the same bytes we send, though the
      // role framing differs slightly — keep the admission ceiling below the
      // hard limit rather than exactly at it.
      const result = await this.client.models.countTokens({
        model: req.model,
        contents: [{ role: 'user', parts: [{ text: req.system }, { text: req.user }] }],
      });
      return { tokens: result.totalTokens ?? 0, source: 'native' };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const fallback = (): ModelDescriptor[] =>
      (this.options.fallbackModels ?? DEFAULT_FALLBACK_MODELS).map((id) => ({
        id,
        displayName: id,
        contextWindow: null,
        maxOutputTokens: null,
      }));

    try {
      const models: ModelDescriptor[] = [];
      for await (const model of await this.client.models.list()) {
        const name = model.name?.replace(/^models\//, '');
        if (!name || !name.startsWith('gemini')) continue;
        const actions = model.supportedActions ?? [];
        if (actions.length > 0 && !actions.includes('generateContent')) continue;
        models.push({
          id: name,
          displayName: model.displayName ?? name,
          contextWindow: model.inputTokenLimit ?? null,
          maxOutputTokens: model.outputTokenLimit ?? null,
        });
      }
      // A model appearing in the list is NOT proof it is callable: retired
      // models keep showing up here and return 404 "no longer available to new
      // users" on generateContent. The admin panel must allow manual entry, and
      // "Test connection" is the real availability check.
      return models.length > 0 ? models : fallback();
    } catch (error) {
      const mapped = this.mapError(error);
      if (mapped.kind === AIErrorKind.AUTH) throw mapped;
      return fallback();
    }
  }

  async ping(): Promise<PingResult> {
    const startedAt = Date.now();
    const models = await this.listModels();
    return { ok: true, latencyMs: Date.now() - startedAt, models };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private compileSchema<T>(schema: StructuredRequest<T>['schema']): GeminiSchema {
    const key = schema as unknown as object;
    const cached = this.schemaCache.get(key);
    if (cached) return cached;

    const compiled = toGeminiSchema(schema as never);
    // Turns a class of 400 into a construction-time failure.
    assertGeminiSchemaInvariants(compiled);
    this.schemaCache.set(key, compiled);
    return compiled;
  }

  private buildConfig<T>(
    req: StructuredRequest<T>,
    degradations: Degradation[],
  ): Record<string, unknown> {
    const { params } = req;
    const config: Record<string, unknown> = {
      systemInstruction: req.system,
      responseMimeType: 'application/json',
      responseSchema: this.compileSchema(req.schema),
      maxOutputTokens: params.maxTokens,
    };
    if (req.signal) config.abortSignal = req.signal;

    // Gemini supports all of these, so nothing is dropped here. The branches
    // exist so that a capability flipping to false in future automatically
    // starts dropping-with-a-degradation instead of forwarding — which is the
    // behaviour the conformance suite asserts.
    if (params.temperature !== undefined) {
      if (this.capabilities.supportsTemperature) config.temperature = params.temperature;
      else degradations.push(dropped('temperature'));
    }
    if (params.topP !== undefined) {
      if (this.capabilities.supportsTopP) config.topP = params.topP;
      else degradations.push(dropped('topP'));
    }
    if (params.topK !== undefined) {
      if (this.capabilities.supportsTopK) config.topK = params.topK;
      else degradations.push(dropped('topK'));
    }

    // Thinking budget: explicit option wins over a per-request param. 0
    // disables it on Flash. Left unset the model decides, which is why
    // maxOutputTokens has to accommodate thinking as well as the JSON.
    const thinkingBudget = this.options.thinkingBudget ?? params.thinkingBudget;
    if (thinkingBudget !== undefined) {
      if (this.capabilities.supportsThinkingBudget) config.thinkingConfig = { thinkingBudget };
      else degradations.push(dropped('thinkingBudget'));
    }

    return config;
  }

  private normalize<T>(
    raw: GenerateContentResponse,
    latencyMs: number,
    degradations: Degradation[],
    streamedText?: string,
  ): StructuredResponse<T> {
    const usage = raw.usageMetadata ?? {};
    const blockReason = raw.promptFeedback?.blockReason;
    const finishReason = raw.candidates?.[0]?.finishReason;
    const stopReason = normalizeStopReason(finishReason, blockReason);

    const text = streamedText !== undefined && streamedText.length > 0
      ? streamedText
      : (raw.text ?? '');

    let output: T | null = null;
    if (stopReason === 'complete') {
      output = this.parse<T>(text, degradations);
    }

    return {
      output,
      raw: text,
      stopReason,
      usage: {
        inputTokens: usage.promptTokenCount ?? 0,
        outputTokens: usage.candidatesTokenCount ?? 0,
        cachedReadTokens: usage.cachedContentTokenCount ?? 0,
        // Implicit caching gives no write signal, and asserting on it flakes.
        cachedWriteTokens: 0,
        // Reported alongside candidates, which is exactly the port's
        // convention: excluded from outputTokens.
        reasoningTokens: usage.thoughtsTokenCount ?? 0,
        tokenSource: 'native',
      },
      latencyMs,
      providerRequestId: raw.responseId ?? null,
      structuredOutputMode: 'native-schema',
      degradations,
    };
  }

  private parse<T>(text: string, degradations: Degradation[]): T | null {
    const direct = tryParse(text);
    if (direct !== undefined) return validate<T>(direct, degradations);

    // Minimal repair. A native schema should make this unnecessary, so reaching
    // it is itself worth recording.
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced?.[1]
      ?? text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    const repaired = tryParse(candidate);
    if (repaired !== undefined) {
      degradations.push({
        code: 'json_repaired',
        detail: 'Response was not valid JSON as returned; recovered by extracting the object.',
      });
      return validate<T>(repaired, degradations);
    }
    return null;
  }

  private mapError(error: unknown): AIError {
    if (AIError.is(error)) return error;
    if ((error as { name?: string })?.name === 'AbortError') throw error;

    const message = String((error as { message?: string })?.message ?? error);
    const status = extractStatus(error, message);
    const body = parseErrorBody(message);
    const providerRequestId = null;

    const build = (kind: AIErrorKind, detail: string, retryAfterMs?: number): AIError =>
      new AIError({
        kind,
        message: detail,
        provider: 'google',
        status,
        providerRequestId,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
        cause: error,
      });

    // Most specific first, and never on a bare string match where structure
    // is available.
    if (status === 429 || body?.status === 'RESOURCE_EXHAUSTED') {
      // The per-day cap and the per-minute limit both arrive as 429 with a
      // similar short retry hint. Only quotaId distinguishes them, and getting
      // this wrong means retrying for hours against a quota that resets on a
      // calendar boundary.
      const quotaId = body?.quotaId ?? '';
      if (/PerDay/i.test(quotaId) || /RequestsPerDay/i.test(message)) {
        return build(
          AIErrorKind.QUOTA_EXHAUSTED,
          `Gemini daily quota exhausted${body?.limit ? ` (limit ${body.limit}/day/model)` : ''}. `
            + 'Resets on a calendar boundary, not after the advertised retry delay.',
        );
      }
      return build(
        AIErrorKind.RATE_LIMIT,
        'Gemini per-minute rate limit reached.',
        body?.retryAfterMs,
      );
    }

    if (status === 401 || status === 403 || /API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(message)) {
      return build(AIErrorKind.AUTH, 'Gemini rejected the configured API key.');
    }
    if (status === 404) {
      // A retired model is our configuration problem, not an upstream outage,
      // and retrying cannot help.
      return build(
        AIErrorKind.BAD_REQUEST,
        `Gemini model unavailable: ${body?.message ?? message}. `
          + 'Note that models.list() still returns retired models, so pick another and re-test.',
      );
    }
    if (status === 400) {
      if (/token count|too many tokens|exceeds the maximum|context length/i.test(message)) {
        return build(AIErrorKind.CONTEXT_OVERFLOW, 'Input exceeded the Gemini context window.');
      }
      return build(
        AIErrorKind.BAD_REQUEST,
        `Gemini rejected the request: ${body?.message ?? message}. `
          + 'Usually a schema transform mismatch — log the compiled schema. Do not retry.',
      );
    }
    if (status === 408 || /timeout|ETIMEDOUT|deadline/i.test(message)) {
      return build(AIErrorKind.TIMEOUT, 'Gemini request timed out.');
    }
    if (status !== undefined && status >= 500) {
      return build(AIErrorKind.UPSTREAM, `Gemini upstream error (${status}).`);
    }
    return build(AIErrorKind.UPSTREAM, `Unclassified Gemini failure: ${message}`);
  }
}

const dropped = (param: string): Degradation => ({
  code: 'param_dropped',
  detail: `${param} is not supported by the active Gemini model; dropped rather than forwarded.`,
});

function validate<T>(value: unknown, degradations: Degradation[]): T | null {
  // Relaxed on numeric range: the provider schema cannot enforce bounds, so
  // rejecting here would discard an otherwise-usable diagnosis. Clamped later.
  const parsed = DiagnosisOutputParseSchema.safeParse(value);
  if (parsed.success) return parsed.data as unknown as T;
  degradations.push({
    code: 'schema_relaxed',
    detail:
      'Response parsed as JSON but failed contract validation: '
      + parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.')} ${i.message}`).join('; '),
  });
  return null;
}

function tryParse(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * `finishReason: SAFETY` and `promptFeedback.blockReason` normalize onto the
 * same two terminal cases, so the engine has one code path.
 */
export function normalizeStopReason(
  finishReason: string | undefined,
  blockReason: string | undefined,
): StopReason {
  if (blockReason) return 'content_filter';
  switch (finishReason) {
    case 'STOP':
      return 'complete';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'IMAGE_SAFETY':
      return 'refusal';
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
    case 'RECITATION':
      return 'content_filter';
    case undefined:
      return 'complete';
    default:
      // MALFORMED_FUNCTION_CALL, LANGUAGE, OTHER and friends. Treated as a
      // filtered response rather than a success, because output cannot be
      // trusted and 'complete' would let a null through the engine's happy path.
      return 'content_filter';
  }
}

interface ParsedErrorBody {
  status?: string;
  message?: string;
  quotaId?: string;
  limit?: number;
  retryAfterMs?: number;
}

/** The SDK stringifies the API's JSON error into `message`. Recover the structure. */
function parseErrorBody(message: string): ParsedErrorBody | undefined {
  const start = message.indexOf('{');
  const end = message.lastIndexOf('}');
  if (start === -1 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(message.slice(start, end + 1)) as {
      error?: {
        status?: string;
        message?: string;
        details?: { '@type'?: string; retryDelay?: string; violations?: { quotaId?: string }[] }[];
      };
    };
    const error = parsed.error;
    if (!error) return undefined;

    const details = error.details ?? [];
    const quota = details.find((d) => String(d['@type']).endsWith('QuotaFailure'));
    const retry = details.find((d) => String(d['@type']).endsWith('RetryInfo'));
    const seconds = retry?.retryDelay ? Number.parseFloat(retry.retryDelay.replace('s', '')) : NaN;
    const limit = error.message?.match(/limit:\s*(\d+)/i)?.[1];

    const out: ParsedErrorBody = {};
    if (error.status !== undefined) out.status = error.status;
    if (error.message !== undefined) out.message = error.message.split('\n')[0] ?? error.message;
    const quotaId = quota?.violations?.[0]?.quotaId;
    if (quotaId !== undefined) out.quotaId = quotaId;
    if (limit !== undefined) out.limit = Number(limit);
    if (Number.isFinite(seconds)) out.retryAfterMs = seconds * 1000;
    return out;
  } catch {
    return undefined;
  }
}

function extractStatus(error: unknown, message: string): number | undefined {
  const direct = (error as { status?: unknown }).status;
  if (typeof direct === 'number') return direct;
  const nested = (error as { response?: { status?: unknown } }).response?.status;
  if (typeof nested === 'number') return nested;
  const fromCode = (error as { code?: unknown }).code;
  if (typeof fromCode === 'number') return fromCode;
  const match = message.match(/"code"\s*:\s*(\d{3})/) ?? message.match(/\b(4\d{2}|5\d{2})\b/);
  return match?.[1] ? Number(match[1]) : undefined;
}
