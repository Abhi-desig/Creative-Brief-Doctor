import { describe, expect, it, vi } from 'vitest';
import { AIError, FakeProvider, fakeDiagnosis, type AIProvider } from '@cbd/ai';
import { DIMENSIONS } from '@cbd/contracts';
import { run, type EngineParams, type PromptSnapshot } from './engine.js';
import { aggregateDiagnosis } from './aggregate.js';

/**
 * The engine is tested entirely against FakeProvider. No SDK is stubbed,
 * because the engine imports none — which is the payoff of taking the provider
 * as an argument.
 */

const prompt: PromptSnapshot = {
  promptVersionId: 'pv_1',
  content: 'You are a creative operations analyst. Diagnose the brief.',
  contentHash: 'a'.repeat(64),
  label: 'v1',
};

const params: EngineParams = { model: 'fake-model-1', maxTokens: 16_000 };
const BRIEF = 'We need a video for the new dashboard.';

describe('run — the happy path', () => {
  it('returns an aggregated diagnosis with server-computed overall and verdict', async () => {
    const provider = new FakeProvider({ output: fakeDiagnosis(80) });
    const result = await run(provider, prompt, BRIEF, params);

    expect(result.aggregated.overallScore).toBe(80);
    expect(result.aggregated.verdict).toBe('READY');
    expect(result.aggregated.dimensions).toHaveLength(5);
    expect(result.stopReason).toBe('complete');
    expect(result.retryCount).toBe(0);
  });

  it('passes the prompt content through verbatim, with nothing interpolated', async () => {
    const provider = new FakeProvider();
    const spy = vi.spyOn(provider, 'generateStructured');
    await run(provider, prompt, BRIEF, params);
    expect(spy.mock.calls[0]?.[0]?.system).toBe(prompt.content);
  });

  it('never resolves a provider itself — it uses exactly the one it is given', async () => {
    const provider = new FakeProvider({ output: fakeDiagnosis(60) });
    const spy = vi.spyOn(provider, 'generateStructured');
    await run(provider, prompt, BRIEF, params);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('reports the model from params rather than naming one', async () => {
    const provider = new FakeProvider();
    const spy = vi.spyOn(provider, 'generateStructured');
    await run(provider, prompt, BRIEF, { ...params, model: 'some-other-model' });
    expect(spy.mock.calls[0]?.[0]?.model).toBe('some-other-model');
  });

  it('emits onFirstToken when the provider streams', async () => {
    const provider = new FakeProvider();
    const onFirstToken = vi.fn();
    await run(provider, prompt, BRIEF, params, { onFirstToken });
    expect(onFirstToken).toHaveBeenCalled();
  });

  it('still emits onFirstToken when the provider cannot stream', async () => {
    const provider = new FakeProvider({ capabilities: { supportsStreaming: false } });
    const onFirstToken = vi.fn();
    await run(provider, prompt, BRIEF, params, { onFirstToken });
    expect(onFirstToken).toHaveBeenCalledTimes(1);
  });
});

describe('run — stopReason is checked before output is read', () => {
  it('throws REFUSAL and persists nothing on a refusal', async () => {
    const provider = new FakeProvider({ stopReason: 'refusal' });
    await expect(run(provider, prompt, BRIEF, params)).rejects.toMatchObject({
      kind: 'refusal',
    });
  });

  it('throws REFUSAL on a content filter', async () => {
    const provider = new FakeProvider({ stopReason: 'content_filter' });
    await expect(run(provider, prompt, BRIEF, params)).rejects.toMatchObject({
      kind: 'refusal',
    });
  });

  it('throws CONTEXT_OVERFLOW on a context overflow stop reason', async () => {
    const provider = new FakeProvider({ stopReason: 'context_overflow' });
    await expect(run(provider, prompt, BRIEF, params)).rejects.toMatchObject({
      kind: 'context_overflow',
    });
  });

  it('lets a typed AIError from the provider through unchanged', async () => {
    for (const kind of ['rate_limit', 'quota_exhausted', 'auth', 'upstream'] as const) {
      const provider = new FakeProvider({ failWith: kind });
      await expect(run(provider, prompt, BRIEF, params)).rejects.toMatchObject({ kind });
    }
  });
});

describe('run — max_tokens retries exactly once at a higher cap', () => {
  it('retries once, then succeeds, recording the retry', async () => {
    let call = 0;
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      call += 1;
      const base = await new FakeProvider().generateStructured(req);
      if (call === 1) return { ...base, stopReason: 'max_tokens' as const, output: null, raw: '{"trunc' };
      return base;
    });

    // Start below the provider ceiling (16_000) so there is headroom to raise
    // into; at the ceiling the engine correctly refuses to retry.
    const result = await run(provider, prompt, BRIEF, { ...params, maxTokens: 8_000 });
    expect(call).toBe(2);
    expect(result.retryCount).toBe(1);
    expect(result.aggregated.dimensions).toHaveLength(5);
  });

  it('raises the cap on the retry, bounded by the provider maximum', async () => {
    const seen: number[] = [];
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      seen.push(req.params.maxTokens);
      const base = await new FakeProvider().generateStructured(req);
      return seen.length === 1
        ? { ...base, stopReason: 'max_tokens' as const, output: null, raw: '' }
        : base;
    });

    await run(provider, prompt, BRIEF, { ...params, maxTokens: 8_000 });
    expect(seen[0]).toBe(8_000);
    expect(seen[1]).toBe(16_000);
  });

  it('does NOT retry a second time — it fails cleanly instead of saving a partial', async () => {
    let calls = 0;
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      calls += 1;
      const base = await new FakeProvider().generateStructured(req);
      return { ...base, stopReason: 'max_tokens' as const, output: null, raw: '{"partial' };
    });

    await expect(run(provider, prompt, BRIEF, { ...params, maxTokens: 8_000 }))
      .rejects.toMatchObject({ kind: 'context_overflow' });
    expect(calls).toBe(2);
  });

  it('does not retry when already at the provider ceiling', async () => {
    let calls = 0;
    const provider = new FakeProvider({ capabilities: { maxOutputTokens: 16_000 } });
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      calls += 1;
      const base = await new FakeProvider().generateStructured(req);
      return { ...base, stopReason: 'max_tokens' as const, output: null, raw: '' };
    });
    await expect(run(provider, prompt, BRIEF, { ...params, maxTokens: 16_000 })).rejects.toThrow();
    expect(calls).toBe(1);
  });
});

describe('run — the repair loop gets exactly one attempt', () => {
  it('retries once with the validator error and succeeds', async () => {
    let call = 0;
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      call += 1;
      const base = await new FakeProvider().generateStructured(req);
      return call === 1 ? { ...base, raw: 'not json at all' } : base;
    });

    const result = await run(provider, prompt, BRIEF, params);
    expect(call).toBe(2);
    expect(result.retryCount).toBe(1);
  });

  it('feeds the validator error into the retry prompt without mutating the snapshot', async () => {
    const systems: string[] = [];
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      systems.push(req.system);
      const base = await new FakeProvider().generateStructured(req);
      return systems.length === 1 ? { ...base, raw: '{"summary": 12345}' } : base;
    });

    await run(provider, prompt, BRIEF, params);
    expect(systems[0]).toBe(prompt.content);
    expect(systems[1]).toContain(prompt.content);
    expect(systems[1]).toContain('could not be accepted');
    // The immutable snapshot is untouched, so its hash stays valid.
    expect(prompt.content).toBe('You are a creative operations analyst. Diagnose the brief.');
  });

  it('fails cleanly after one repair attempt — no infinite loop', async () => {
    let calls = 0;
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      calls += 1;
      const base = await new FakeProvider().generateStructured(req);
      return { ...base, raw: 'never valid' };
    });

    await expect(run(provider, prompt, BRIEF, params)).rejects.toMatchObject({
      kind: 'bad_request',
    });
    expect(calls).toBe(2);
  });

  it('accumulates usage across both calls so the cost figure is honest', async () => {
    let call = 0;
    const provider = new FakeProvider();
    vi.spyOn(provider, 'generateStructured').mockImplementation(async (req) => {
      call += 1;
      const base = await new FakeProvider().generateStructured(req);
      const usage = { ...base.usage, inputTokens: 100, outputTokens: 50 };
      return call === 1 ? { ...base, raw: 'bad', usage } : { ...base, usage };
    });

    const result = await run(provider, prompt, BRIEF, params);
    expect(result.usage.inputTokens).toBe(200);
    expect(result.usage.outputTokens).toBe(100);
  });

  it('records a degradation when output had to be recovered by repair', async () => {
    const provider = new FakeProvider({
      rawOverride: '```json\n' + JSON.stringify(fakeDiagnosis(60)) + '\n```',
    });
    const result = await run(provider, prompt, BRIEF, params);
    expect(result.degradations.some((d) => d.detail.includes('fenced-block'))).toBe(true);
  });
});

describe('run — abort', () => {
  it('propagates an abort rather than completing', async () => {
    const provider = new FakeProvider({ latencyMs: 500 });
    const controller = new AbortController();
    const promise = run(provider, prompt, BRIEF, params, { signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await expect(promise).rejects.toThrow();
  });
});

describe('aggregateDiagnosis — clamping and thresholds', () => {
  const withScores = (scores: number[]) => ({
    ...fakeDiagnosis(),
    dimensions: Object.fromEntries(
      DIMENSIONS.map((d, i) => [
        d,
        { score: scores[i]!, rationale: 'r', gaps: [], evidence: ['e'] },
      ]),
    ),
  }) as unknown as ReturnType<typeof fakeDiagnosis>;

  it('clamps out-of-range scores on the way to the database', () => {
    const result = aggregateDiagnosis(withScores([250, -40, 60, 60, 60]));
    expect(result.dimensions[0]?.score).toBe(100);
    expect(result.dimensions[1]?.score).toBe(0);
    expect(result.corrections.join(' ')).toMatch(/clamped/);
  });

  it('lands READY at exactly 80 and NEEDS_WORK at exactly 55', () => {
    expect(aggregateDiagnosis(withScores([80, 80, 80, 80, 80])).verdict).toBe('READY');
    expect(aggregateDiagnosis(withScores([55, 55, 55, 55, 55])).verdict).toBe('NEEDS_WORK');
    // 50+55+55+55+55 = 270, /5 = 54 -> just below the boundary.
    expect(aggregateDiagnosis(withScores([50, 55, 55, 55, 55])).verdict).toBe('NOT_READY');
    // 54+55+55+55+55 = 274, /5 = 54.8, which rounds UP to 55 and is therefore
    // NEEDS_WORK. Worth pinning: rounding happens before the threshold compare.
    expect(aggregateDiagnosis(withScores([54, 55, 55, 55, 55])).verdict).toBe('NEEDS_WORK');
    // 75+80+80+80+80 = 395, /5 = 79 -> one point below READY.
    expect(aggregateDiagnosis(withScores([75, 80, 80, 80, 80])).verdict).toBe('NEEDS_WORK');
    // 79+80+80+80+80 = 399, /5 = 79.8, which rounds UP to 80 and is therefore
    // READY. Rounding is applied before the threshold comparison, so a brief can
    // cross a band boundary it does not strictly reach on the raw mean. Pinned
    // deliberately: this is the behaviour, not an accident.
    expect(aggregateDiagnosis(withScores([79, 80, 80, 80, 80])).verdict).toBe('READY');
  });

  it('renumbers non-consecutive question ranks and records the correction', () => {
    const output = { ...fakeDiagnosis() };
    output.questions = [
      { dimension: 'CONSTRAINTS', question: 'c?', blocking: false, rank: 7 },
      { dimension: 'OBJECTIVE_CLARITY', question: 'a?', blocking: true, rank: 2 },
      { dimension: 'SUCCESS_METRICS', question: 'b?', blocking: true, rank: 4 },
    ];
    const result = aggregateDiagnosis(output);
    expect(result.questions.map((q) => q.rank)).toEqual([1, 2, 3]);
    expect(result.questions[0]?.question).toBe('a?');
    expect(result.corrections.join(' ')).toMatch(/renumbered/);
  });

  it('returns dimensions in the contract order regardless of key order in the response', () => {
    const result = aggregateDiagnosis(fakeDiagnosis(60));
    expect(result.dimensions.map((d) => d.dimension)).toEqual([...DIMENSIONS]);
  });
});
