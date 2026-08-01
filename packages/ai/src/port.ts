import type { StandardSchemaV1 } from '@standard-schema/spec';

/**
 * The port. The scoring engine sees only this — no vendor SDK, no model name,
 * no branching on provider. Capability differences are data on the adapter,
 * negotiated by the engine.
 */

export type ProviderKind = 'google' | 'anthropic' | 'fake';

// ── normalized response vocabulary ───────────────────────────────────────────

/**
 * Normalized terminal states. Every vendor's finish reason maps onto one of
 * these, so the engine has a single code path.
 *
 * `context_overflow` is here rather than only in the error taxonomy because at
 * least one provider reports it as a stop reason on an otherwise-successful
 * response rather than as an exception, and collapsing it into `max_tokens`
 * would prescribe the wrong remedy — retrying at a higher cap cannot fix input
 * that does not fit.
 */
export type StopReason =
  | 'complete'
  | 'max_tokens'
  | 'refusal'
  | 'content_filter'
  | 'context_overflow';

export const STOP_REASONS: readonly StopReason[] = [
  'complete',
  'max_tokens',
  'refusal',
  'content_filter',
  'context_overflow',
];

/** How the adapter actually obtained structured output. */
export type StructuredMode = 'native-schema' | 'json-mode' | 'prompt-only';

export const STRUCTURED_MODES: readonly StructuredMode[] = [
  'native-schema',
  'json-mode',
  'prompt-only',
];

/** Whether token counts came from the vendor or from a declared estimator. */
export type TokenSource = 'native' | 'estimated';

export const TOKEN_SOURCES: readonly TokenSource[] = ['native', 'estimated'];

/**
 * Something the adapter had to give up. Recorded on the response and persisted
 * with the diagnosis, so a bad week is a query rather than an investigation.
 */
export interface Degradation {
  /** Stable, machine-groupable. */
  code:
    | 'param_dropped'
    | 'no_prompt_caching'
    | 'json_repaired'
    | 'schema_relaxed'
    | 'streaming_unavailable'
    | 'token_count_estimated';
  /** Human-readable, for the admin panel. */
  detail: string;
}

/**
 * Token accounting, normalized across vendors.
 *
 * IMPORTANT — the convention for `reasoningTokens`: it is reported here as a
 * count that is NOT included in `outputTokens`. Vendors disagree on this
 * natively (some report thinking alongside the visible output, others fold it
 * in), so adapters must normalize to this convention. Getting it wrong makes
 * `outputTokens + reasoningTokens` double-count on one provider and be correct
 * on another, which quietly corrupts every cost figure.
 */
export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  /** 0 where the vendor has no usable caching, or where nothing was cached. */
  cachedReadTokens: number;
  cachedWriteTokens: number;
  /** Excluded from `outputTokens`. See the note above. */
  reasoningTokens: number;
  tokenSource: TokenSource;
}

// ── capabilities ─────────────────────────────────────────────────────────────

/**
 * What an adapter can do. The engine and the admin form read this rather than
 * branching on provider name, so a new adapter needs no changes elsewhere.
 *
 * Every field here is asserted by the conformance suite. A declaration that is
 * not true of the adapter is a bug in the adapter, not in the suite.
 */
export interface ProviderCapabilities {
  structuredOutput: StructuredMode;
  schemaDialect: 'json-schema-strict' | 'openapi-subset';
  promptCaching: 'explicit' | 'automatic' | 'none';
  nativeTokenCounting: boolean;
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsTopK: boolean;
  supportsThinkingBudget: boolean;
  supportsStreaming: boolean;
  supportsAssistantPrefill: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  reportsCost: 'from-price-table' | 'free';
}

// ── requests ─────────────────────────────────────────────────────────────────

/**
 * Generation parameters as the caller would like them. An adapter drops
 * anything its capabilities do not support and records a `param_dropped`
 * degradation rather than forwarding it — a parameter the UI offers but the
 * model rejects is the most likely bug in this feature.
 */
export interface GenerationParams {
  maxTokens: number;
  temperature?: number | undefined;
  topP?: number | undefined;
  topK?: number | undefined;
  thinkingBudget?: number | undefined;
  /** Milliseconds. */
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
}

export interface StructuredRequest<T> {
  model: string;
  /** The active prompt version's content, verbatim. Nothing is interpolated. */
  system: string;
  user: string;
  /** The zod schema from packages/contracts, as a Standard Schema. */
  schema: StandardSchemaV1<unknown, T>;
  params: GenerationParams;
  signal?: AbortSignal | undefined;
}

export interface StructuredResponse<T> {
  /** null unless `stopReason === 'complete'`. Always check `stopReason` first. */
  output: T | null;
  raw: string;
  stopReason: StopReason;
  usage: NormalizedUsage;
  latencyMs: number;
  providerRequestId: string | null;
  structuredOutputMode: StructuredMode;
  degradations: Degradation[];
}

export interface TokenCountRequest {
  model: string;
  system: string;
  user: string;
}

export interface TokenCount {
  tokens: number;
  source: TokenSource;
}

export interface ModelDescriptor {
  id: string;
  displayName: string;
  contextWindow: number | null;
  maxOutputTokens: number | null;
}

export interface PingResult {
  ok: boolean;
  latencyMs: number;
  /** Populated when the probe resolved a model list as a side effect. */
  models?: ModelDescriptor[] | undefined;
}

/** Coarse lifecycle events. Never partial JSON — half-built JSON renders as garbage. */
export type ProviderEvent<T> =
  | { type: 'start' }
  /** First token received. The SSE layer turns this into `phase: scoring`. */
  | { type: 'first-token' }
  | { type: 'result'; response: StructuredResponse<T> };

// ── the interface ────────────────────────────────────────────────────────────

export interface AIProvider {
  readonly id: ProviderKind;
  readonly capabilities: ProviderCapabilities;

  /** The only call the scoring engine makes. */
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;

  /**
   * Same call, coarse lifecycle events. An adapter that cannot stream falls
   * back to `generateStructured` and emits a synthetic `first-token`
   * immediately, recording a `streaming_unavailable` degradation. The browser
   * cannot tell the difference, which is the guarantee the abstraction exists
   * for.
   */
  streamStructured<T>(req: StructuredRequest<T>): AsyncIterable<ProviderEvent<T>>;

  /** Native count where the vendor offers one; a declared estimator otherwise. */
  countInputTokens(req: TokenCountRequest): Promise<TokenCount>;

  /** For the admin model picker. Static list where there is no endpoint. */
  listModels(): Promise<ModelDescriptor[]>;

  /** Liveness probe for /health and the admin "Test connection" button. */
  ping(): Promise<PingResult>;
}
