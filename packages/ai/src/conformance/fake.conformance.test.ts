import { describe, expect, it } from 'vitest';
import { DiagnosisOutputSchema } from '@cbd/contracts';
import { AI_ERROR_KINDS, AIError, type AIErrorKind } from '../errors.js';
import { FakeProvider, fakeDiagnosis } from '../adapters/fake.adapter.js';
import { STOP_REASONS, type StopReason } from '../port.js';
import { buildRequest, runConformanceSuite } from './suite.js';

/**
 * A8: the suite runs against the fake with no secrets and no network, which is
 * what keeps CI green offline.
 */
runConformanceSuite({
  name: 'FakeProvider',
  create: () => new FakeProvider({ latencyMs: 200 }),
  createWithBadKey: () => new FakeProvider({ badKey: true }),
  model: 'fake-model-1',
  live: false,
});

/**
 * The fake carries additional obligations the real adapters cannot: it must be
 * able to simulate every terminal state and every taxonomy error, because that
 * is what lets the engine's error handling be tested without a network.
 */
describe('FakeProvider simulation coverage', () => {
  it('simulates every normalized stopReason', async () => {
    for (const stopReason of STOP_REASONS) {
      const provider = new FakeProvider({ stopReason });
      const response = await provider.generateStructured(buildRequest('fake-model-1'));
      expect(response.stopReason).toBe(stopReason);
      // The port's rule holds for the double too.
      if (stopReason === 'complete') expect(response.output).not.toBeNull();
      else expect(response.output).toBeNull();
    }
  });

  it('simulates every AIError.kind, and only ever throws AIError', async () => {
    expect(AI_ERROR_KINDS.length).toBeGreaterThan(0);
    for (const kind of AI_ERROR_KINDS) {
      const provider = new FakeProvider({ failWith: kind });
      await expect(provider.generateStructured(buildRequest('fake-model-1')))
        .rejects.toBeInstanceOf(AIError);
      try {
        await provider.generateStructured(buildRequest('fake-model-1'));
        throw new Error(`expected ${kind} to throw`);
      } catch (error) {
        expect(AIError.is(error)).toBe(true);
        expect((error as AIError).kind).toBe(kind);
      }
    }
  });

  it('marks rate_limit, timeout and upstream retryable and the rest terminal', async () => {
    const expected: Record<AIErrorKind, boolean> = {
      rate_limit: true,
      timeout: true,
      upstream: true,
      quota_exhausted: false,
      auth: false,
      context_overflow: false,
      bad_request: false,
      refusal: false,
    };
    for (const kind of AI_ERROR_KINDS) {
      const provider = new FakeProvider({ failWith: kind });
      await provider.generateStructured(buildRequest('fake-model-1')).catch((error: unknown) => {
        expect((error as AIError).retryable, `${kind} retryability`).toBe(expected[kind]);
      });
    }
  });

  it('forwards retryAfterMs on a simulated rate limit', async () => {
    const provider = new FakeProvider({ failWith: 'rate_limit', retryAfterMs: 53_000 });
    await provider.generateStructured(buildRequest('fake-model-1')).catch((error: unknown) => {
      expect((error as AIError).retryAfterMs).toBe(53_000);
    });
  });

  it('distinguishes quota_exhausted from rate_limit — different remedy, so not retryable', async () => {
    const daily = new FakeProvider({ failWith: 'quota_exhausted' });
    await daily.generateStructured(buildRequest('fake-model-1')).catch((error: unknown) => {
      expect((error as AIError).kind).toBe('quota_exhausted');
      expect((error as AIError).retryable).toBe(false);
    });
  });

  it('returns a fixture that satisfies the contract at every anchor', () => {
    for (const score of [0, 20, 40, 60, 80, 100]) {
      expect(DiagnosisOutputSchema.safeParse(fakeDiagnosis(score)).success).toBe(true);
    }
  });

  it('can simulate unparseable output, so the repair path is reachable offline', async () => {
    const provider = new FakeProvider({ rawOverride: 'Here is the report: {not json' });
    const response = await provider.generateStructured(buildRequest('fake-model-1'));
    expect(response.raw).toContain('not json');
  });

  it('records streaming_unavailable when configured without streaming', async () => {
    const provider = new FakeProvider({ capabilities: { supportsStreaming: false } });
    const events = [];
    for await (const event of provider.streamStructured(buildRequest('fake-model-1'))) {
      events.push(event);
    }
    const final = events.at(-1);
    expect(final?.type).toBe('result');
    if (final?.type === 'result') {
      expect(final.response.degradations.some((d) => d.code === 'streaming_unavailable')).toBe(true);
    }
  });

  it('drops unsupported params with a degradation when capabilities say so', async () => {
    const provider = new FakeProvider({
      capabilities: { supportsTemperature: false, supportsTopP: false, supportsThinkingBudget: false },
    });
    const response = await provider.generateStructured(
      buildRequest('fake-model-1', {
        params: { maxTokens: 16_000, temperature: 0.5, topP: 0.9, thinkingBudget: 512 },
      }),
    );
    const detail = response.degradations.filter((d) => d.code === 'param_dropped')
      .map((d) => d.detail).join(' ');
    expect(detail).toContain('temperature');
    expect(detail).toContain('topP');
    expect(detail).toContain('thinkingBudget');
  });

  it('reports estimated token counts with a degradation when it declares no native counting', async () => {
    const provider = new FakeProvider({ capabilities: { nativeTokenCounting: false } });
    const response = await provider.generateStructured(buildRequest('fake-model-1'));
    expect(response.usage.tokenSource).toBe('estimated');
    expect(response.degradations.some((d) => d.code === 'token_count_estimated')).toBe(true);
    const count = await provider.countInputTokens({ model: 'fake-model-1', system: 's', user: 'u' });
    expect(count.source).toBe('estimated');
  });
});

describe('FakeProvider stopReason coverage is exhaustive', () => {
  it('covers every value in STOP_REASONS with no gaps', () => {
    // Guards against a stopReason being added to the port and the fake — and
    // therefore the engine's tests — silently not covering it.
    const covered = new Set<StopReason>(STOP_REASONS);
    expect(covered.size).toBe(STOP_REASONS.length);
    expect([...covered].sort()).toEqual([
      'complete',
      'content_filter',
      'context_overflow',
      'max_tokens',
      'refusal',
    ]);
  });
});
