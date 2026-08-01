import { describe, expect, it } from 'vitest';
import { DiagnosisOutputSchema, type DiagnosisOutput } from '@cbd/contracts';
import { AIError, AIErrorKind } from '../errors.js';
import {
  STOP_REASONS,
  STRUCTURED_MODES,
  type AIProvider,
  type Degradation,
  type ProviderEvent,
  type StructuredRequest,
  type StructuredResponse,
} from '../port.js';

/**
 * The adapter conformance suite. This is the spec.
 *
 * One parameterized suite that every adapter must pass unmodified. If an
 * adapter cannot pass it, either the port is wrong or the adapter is wrong —
 * the suite does not bend. Weakening an assertion here to make an adapter go
 * green removes the only thing that makes "interchangeable" mean anything.
 *
 * Eight assertion groups, mapped to Verification step 2:
 *
 *   A1  Returns a valid DiagnosisOutput or a typed AIError, never a vendor
 *       exception.
 *   A2  All usage fields present and non-negative; tokenSource matches the
 *       declared nativeTokenCounting.
 *   A3  stopReason is one of the normalized values, and output is null unless
 *       stopReason is 'complete'.
 *   A4  abort() mid-flight rejects promptly and leaves nothing running.
 *   A5  Declared capabilities are true: an unsupported parameter is dropped
 *       with a recorded degradation rather than forwarded.
 *   A6  ping() succeeds with a valid key and reports kind 'auth' on a bad one.
 *   A7  streamStructured emits the coarse lifecycle contract and never partial
 *       JSON, falling back cleanly when streaming is unsupported.
 *   A8  Runs against a fake with no secrets, and opt-in against a live provider
 *       when a key is present.
 */

export interface ConformanceTarget {
  /** Appears in test names. */
  name: string;
  /** A fresh provider per test, so no test can leak state into another. */
  create: () => AIProvider;
  /** A model id the provider will accept. */
  model: string;
  /**
   * A provider configured with a deliberately invalid credential. Required for
   * the A6 auth assertion; omit only for a fake with no credential concept, in
   * which case that assertion is skipped and reported as such.
   */
  createWithBadKey?: (() => AIProvider) | undefined;
  /**
   * True when this target performs real network calls. Live targets get longer
   * timeouts and are skipped entirely when no key is configured (A8).
   */
  live: boolean;
  /** Overrides for slow live providers. */
  timeoutMs?: number | undefined;
}

const SYSTEM = [
  'You are a creative operations analyst. Diagnose the brief that follows.',
  'Score five dimensions on the anchors 0, 20, 40, 60, 80, 100.',
  'Quote evidence verbatim. Do not compute a total.',
].join('\n');

const BRIEF = [
  'We need a video for the new dashboard.',
  'Audience is our customers. It should feel premium.',
  'Needed by end of month. Budget is around 5000.',
].join('\n');

export function buildRequest(
  model: string,
  overrides: Partial<StructuredRequest<DiagnosisOutput>> = {},
): StructuredRequest<DiagnosisOutput> {
  return {
    model,
    system: SYSTEM,
    user: BRIEF,
    schema: DiagnosisOutputSchema,
    params: { maxTokens: 16_000 },
    ...overrides,
  };
}

const hasDegradation = (degradations: readonly Degradation[], code: Degradation['code']): boolean =>
  degradations.some((d) => d.code === code);

/** Fails the test with a useful message if a vendor exception escaped. */
function expectTypedError(error: unknown, provider: string): AIError {
  if (!AIError.is(error)) {
    throw new Error(
      `A1 violated: ${provider} let a non-AIError escape packages/ai. `
        + `Got ${Object.prototype.toString.call(error)}: ${String(
          (error as { message?: string })?.message ?? error,
        )}`,
    );
  }
  return error;
}

export function runConformanceSuite(target: ConformanceTarget): void {
  const timeout = target.timeoutMs ?? (target.live ? 120_000 : 10_000);

  describe(`conformance: ${target.name}`, () => {
    // ── A1 ──────────────────────────────────────────────────────────────────
    describe('A1 valid output or a typed AIError', () => {
      it(
        'returns a schema-valid DiagnosisOutput, or throws AIError — never a vendor exception',
        async () => {
          const provider = target.create();
          let response: StructuredResponse<DiagnosisOutput>;
          try {
            response = await provider.generateStructured(buildRequest(target.model));
          } catch (error) {
            const typed = expectTypedError(error, target.name);
            // A typed failure is a pass for A1; the kind must be in the taxonomy.
            expect(Object.values(AIErrorKind)).toContain(typed.kind);
            return;
          }

          if (response.stopReason === 'complete') {
            expect(response.output).not.toBeNull();
            const parsed = DiagnosisOutputSchema.safeParse(response.output);
            if (!parsed.success) {
              throw new Error(
                `A1 violated: output did not satisfy DiagnosisOutput — `
                  + JSON.stringify(parsed.error.issues.slice(0, 4)),
              );
            }
          }
          expect(STRUCTURED_MODES).toContain(response.structuredOutputMode);
          expect(typeof response.raw).toBe('string');
          expect(response.latencyMs).toBeGreaterThanOrEqual(0);
        },
        timeout,
      );
    });

    // ── A2 ──────────────────────────────────────────────────────────────────
    describe('A2 usage accounting', () => {
      it(
        'reports every usage field, non-negative, with tokenSource matching declared capability',
        async () => {
          const provider = target.create();
          const response = await provider.generateStructured(buildRequest(target.model));
          const { usage } = response;

          for (const field of [
            'inputTokens',
            'outputTokens',
            'cachedReadTokens',
            'cachedWriteTokens',
            'reasoningTokens',
          ] as const) {
            expect(typeof usage[field], `usage.${field} must be a number`).toBe('number');
            expect(Number.isFinite(usage[field]), `usage.${field} must be finite`).toBe(true);
            expect(usage[field], `usage.${field} must be non-negative`).toBeGreaterThanOrEqual(0);
          }

          // The declared capability and the reported source must agree.
          expect(usage.tokenSource).toBe(
            provider.capabilities.nativeTokenCounting ? 'native' : 'estimated',
          );
          if (usage.tokenSource === 'estimated') {
            expect(hasDegradation(response.degradations, 'token_count_estimated')).toBe(true);
          }
        },
        timeout,
      );

      it(
        'countInputTokens agrees with its declared source and returns a positive count',
        async () => {
          const provider = target.create();
          const count = await provider.countInputTokens({
            model: target.model,
            system: SYSTEM,
            user: BRIEF,
          });
          expect(count.tokens).toBeGreaterThan(0);
          expect(count.source).toBe(
            provider.capabilities.nativeTokenCounting ? 'native' : 'estimated',
          );
        },
        timeout,
      );
    });

    // ── A3 ──────────────────────────────────────────────────────────────────
    describe('A3 normalized stop reasons', () => {
      it(
        'returns a normalized stopReason, and output is null unless complete',
        async () => {
          const provider = target.create();
          const response = await provider.generateStructured(buildRequest(target.model));
          expect(STOP_REASONS).toContain(response.stopReason);
          if (response.stopReason !== 'complete') {
            expect(
              response.output,
              'output must be null when stopReason is not complete',
            ).toBeNull();
          }
        },
        timeout,
      );
    });

    // ── A4 ──────────────────────────────────────────────────────────────────
    describe('A4 abort propagation', () => {
      it(
        'rejects promptly with an AbortError when the signal fires mid-flight',
        async () => {
          const provider = target.create();
          const controller = new AbortController();
          const started = Date.now();

          const promise = provider.generateStructured(
            buildRequest(target.model, { signal: controller.signal }),
          );
          // Long enough for the request to be genuinely in flight.
          setTimeout(() => controller.abort(), 50);

          await expect(promise).rejects.toThrow();
          const elapsed = Date.now() - started;

          // "Promptly" — an adapter that ignores the signal and runs to
          // completion would take seconds. On a free tier an ignored abort
          // burns shared quota, which is worse than burning money.
          expect(
            elapsed,
            `abort took ${elapsed}ms; the signal was likely not forwarded to the SDK`,
          ).toBeLessThan(target.live ? 15_000 : 2_000);

          await promise.catch((error: unknown) => {
            const name = (error as { name?: string })?.name;
            if (name !== 'AbortError') {
              // An AIError is tolerated only if it is not masking a vendor throw.
              expectTypedError(error, target.name);
            }
          });
        },
        timeout,
      );

      it(
        'rejects immediately when handed a signal that is already aborted',
        async () => {
          const provider = target.create();
          const promise = provider.generateStructured(
            buildRequest(target.model, { signal: AbortSignal.abort() }),
          );
          await expect(promise).rejects.toThrow();
        },
        timeout,
      );
    });

    // ── A5 ──────────────────────────────────────────────────────────────────
    describe('A5 declared capabilities are true', () => {
      it(
        'drops every unsupported generation parameter with a recorded degradation',
        async () => {
          const provider = target.create();
          const caps = provider.capabilities;

          // Send everything. Whatever the adapter declares unsupported must be
          // dropped and recorded, never forwarded — forwarding is what produces
          // a 400 from a model that rejects the parameter.
          const response = await provider.generateStructured(
            buildRequest(target.model, {
              params: {
                maxTokens: 16_000,
                temperature: 0.7,
                topP: 0.9,
                topK: 40,
                thinkingBudget: 1024,
              },
            }),
          );

          const dropped = response.degradations.filter((d) => d.code === 'param_dropped');
          const droppedText = dropped.map((d) => d.detail).join(' | ');

          const unsupported: [boolean, string][] = [
            [caps.supportsTemperature, 'temperature'],
            [caps.supportsTopP, 'topP'],
            [caps.supportsTopK, 'topK'],
            [caps.supportsThinkingBudget, 'thinkingBudget'],
          ];

          for (const [supported, param] of unsupported) {
            if (supported) continue;
            expect(
              droppedText.toLowerCase(),
              `capabilities declare ${param} unsupported, so it must be dropped `
                + `with a param_dropped degradation naming it. Recorded: "${droppedText}"`,
            ).toContain(param.toLowerCase());
          }

          // And the call must have survived, which is the point of dropping.
          expect(STOP_REASONS).toContain(response.stopReason);
        },
        timeout,
      );

      it('declares self-consistent capabilities', () => {
        const caps = target.create().capabilities;
        expect(STRUCTURED_MODES).toContain(caps.structuredOutput);
        expect(caps.maxOutputTokens).toBeGreaterThan(0);
        expect(caps.contextWindow).toBeGreaterThan(caps.maxOutputTokens);
        expect(['json-schema-strict', 'openapi-subset']).toContain(caps.schemaDialect);
        expect(['explicit', 'automatic', 'none']).toContain(caps.promptCaching);
        expect(['from-price-table', 'free']).toContain(caps.reportsCost);
      });

      it(
        'honours maxTokens as an upper bound on reported output',
        async () => {
          const provider = target.create();
          const response = await provider.generateStructured(
            buildRequest(target.model, { params: { maxTokens: 16_000 } }),
          );
          // reasoningTokens is excluded from outputTokens by the port's
          // convention, so the budget covers their sum.
          expect(response.usage.outputTokens + response.usage.reasoningTokens)
            .toBeLessThanOrEqual(16_000);
        },
        timeout,
      );
    });

    // ── A6 ──────────────────────────────────────────────────────────────────
    describe('A6 ping', () => {
      it(
        'succeeds with a working credential',
        async () => {
          const provider = target.create();
          const result = await provider.ping();
          expect(result.ok).toBe(true);
          expect(result.latencyMs).toBeGreaterThanOrEqual(0);
        },
        timeout,
      );

      it(
        'reports a listable set of models',
        async () => {
          const provider = target.create();
          const models = await provider.listModels();
          expect(Array.isArray(models)).toBe(true);
          expect(models.length).toBeGreaterThan(0);
          for (const model of models) expect(typeof model.id).toBe('string');
        },
        timeout,
      );

      it.runIf(target.createWithBadKey !== undefined)(
        'surfaces kind "auth" — not a vendor exception — on a bad credential',
        async () => {
          const provider = target.createWithBadKey!();
          try {
            const result = await provider.ping();
            expect(result.ok, 'ping must not report ok with an invalid credential').toBe(false);
          } catch (error) {
            const typed = expectTypedError(error, target.name);
            expect(typed.kind).toBe(AIErrorKind.AUTH);
          }
        },
        timeout,
      );
    });

    // ── A7 ──────────────────────────────────────────────────────────────────
    describe('A7 streaming contract', () => {
      it(
        'emits start, then first-token, then exactly one result — and never partial JSON',
        async () => {
          const provider = target.create();
          const events: ProviderEvent<DiagnosisOutput>[] = [];
          for await (const event of provider.streamStructured(buildRequest(target.model))) {
            events.push(event);
          }

          expect(events.length).toBeGreaterThanOrEqual(2);
          expect(events[0]?.type).toBe('start');

          const results = events.filter((e) => e.type === 'result');
          expect(results.length, 'exactly one result event').toBe(1);
          expect(events.at(-1)?.type, 'result must be last').toBe('result');

          const firstTokenAt = events.findIndex((e) => e.type === 'first-token');
          const resultAt = events.findIndex((e) => e.type === 'result');
          expect(firstTokenAt, 'first-token must be emitted').toBeGreaterThan(-1);
          expect(firstTokenAt, 'first-token must precede result').toBeLessThan(resultAt);

          // The wire contract carries coarse status only. Any event type
          // beyond these three would let partial JSON reach the browser.
          for (const event of events) {
            expect(['start', 'first-token', 'result']).toContain(event.type);
          }

          const final = results[0];
          if (final?.type === 'result') {
            expect(STOP_REASONS).toContain(final.response.stopReason);
            if (!provider.capabilities.supportsStreaming) {
              expect(
                hasDegradation(final.response.degradations, 'streaming_unavailable'),
                'an adapter that cannot stream must record streaming_unavailable',
              ).toBe(true);
            }
          }
        },
        timeout,
      );

      it(
        'propagates abort through the stream',
        async () => {
          const provider = target.create();
          const controller = new AbortController();
          const started = Date.now();

          await expect(async () => {
            for await (const _event of provider.streamStructured(
              buildRequest(target.model, { signal: controller.signal }),
            )) {
              controller.abort();
            }
          }).rejects.toThrow();

          expect(Date.now() - started).toBeLessThan(target.live ? 15_000 : 2_000);
        },
        timeout,
      );
    });
  });
}

/**
 * A8 — the suite runs with no secrets against the fake, and opt-in against a
 * live provider when a key is present. Call this to decide whether to register
 * a live target, so CI stays green and offline without special-casing.
 */
export function liveTargetEnabled(envVar: string): boolean {
  const value = process.env[envVar];
  return typeof value === 'string' && value.length > 0;
}
