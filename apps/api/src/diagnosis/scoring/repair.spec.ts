import { describe, expect, it } from 'vitest';
import { isRepairFailure, repairJson } from './repair.js';
import { parseDiagnosis } from './schema.js';
import { DIMENSIONS } from '@cbd/contracts';

/**
 * The four malformed variants the brief calls out — trailing prose, fenced
 * block, trailing comma, truncated tail — plus the property that matters more
 * than any of them: termination. Every strategy is tried at most once, so no
 * input can loop.
 */

const validDiagnosis = () => ({
  summary: 'The brief names a deliverable and does not say what it is for.',
  dimensions: Object.fromEntries(
    DIMENSIONS.map((d) => [d, { score: 40, rationale: 'r', gaps: ['g'], evidence: ['e'] }]),
  ),
  questions: [
    { dimension: 'OBJECTIVE_CLARITY', question: 'q1?', blocking: true, rank: 1 },
    { dimension: 'SUCCESS_METRICS', question: 'q2?', blocking: true, rank: 2 },
    { dimension: 'CONSTRAINTS', question: 'q3?', blocking: false, rank: 3 },
  ],
});

const json = JSON.stringify(validDiagnosis());

describe('repairJson — the four malformed variants', () => {
  it('parses clean JSON directly, with no repair recorded', () => {
    const result = repairJson(json);
    expect(isRepairFailure(result)).toBe(false);
    if (!isRepairFailure(result)) {
      expect(result.strategy).toBe('direct');
      expect(result.repaired).toBe(false);
    }
  });

  it('recovers from a markdown fenced block', () => {
    const result = repairJson('Here you go:\n```json\n' + json + '\n```\nHope that helps!');
    expect(isRepairFailure(result)).toBe(false);
    if (!isRepairFailure(result)) {
      expect(result.strategy).toBe('fenced-block');
      expect(result.repaired).toBe(true);
    }
  });

  it('recovers from leading and trailing prose', () => {
    const result = repairJson(`Sure. ${json} Let me know if you want changes.`);
    expect(isRepairFailure(result)).toBe(false);
    if (!isRepairFailure(result)) expect(result.repaired).toBe(true);
  });

  it('recovers from a trailing comma', () => {
    const withComma = json.replace(/\}$/, ',}');
    const result = repairJson(withComma);
    expect(isRepairFailure(result)).toBe(false);
  });

  it('fails cleanly on a truncated tail rather than guessing', () => {
    const truncated = json.slice(0, Math.floor(json.length * 0.6));
    const result = repairJson(truncated);
    expect(isRepairFailure(result)).toBe(true);
    if (isRepairFailure(result)) {
      // Every strategy tried exactly once, then it stops.
      expect(result.attempted.length).toBe(new Set(result.attempted).size);
      expect(result.attempted).toContain('trailing-comma');
    }
  });
});

describe('repairJson — termination and edge cases', () => {
  it('terminates on pathological input', () => {
    const cases = [
      '',
      '   ',
      'no json here at all',
      '{',
      '}',
      '{'.repeat(5000),
      '}'.repeat(5000),
      '{'.repeat(2000) + '}'.repeat(2000),
      '```json\n```',
      '```json\n{ broken\n```',
      '[1,2,3]',
      'null',
      '42',
      '"a string"',
      '{"a":"unterminated',
    ];
    for (const input of cases) {
      const started = Date.now();
      const result = repairJson(input);
      expect(Date.now() - started, `slow on: ${input.slice(0, 20)}`).toBeLessThan(1000);
      // Whatever happens, it returns — that is the assertion.
      expect(result).toBeDefined();
    }
  });

  it('treats a bare scalar or array as a failure, not a confusing success', () => {
    for (const input of ['42', '"text"', 'null', 'true', '[1,2,3]']) {
      expect(isRepairFailure(repairJson(input)), input).toBe(true);
    }
  });

  it('does not truncate at a brace inside a string value', () => {
    const tricky = JSON.stringify({
      ...validDiagnosis(),
      summary: 'The brief says "use the {brand} token" which is unclear.',
    });
    const result = repairJson(`Result: ${tricky}`);
    expect(isRepairFailure(result)).toBe(false);
    if (!isRepairFailure(result)) {
      expect((result.value as { summary: string }).summary).toContain('{brand}');
    }
  });

  it('leaves a comma inside a string alone when stripping trailing commas', () => {
    const withCommaInString = JSON.stringify({
      ...validDiagnosis(),
      summary: 'One, two, three,',
    }).replace(/\}$/, ',}');
    const result = repairJson(withCommaInString);
    expect(isRepairFailure(result)).toBe(false);
    if (!isRepairFailure(result)) {
      expect((result.value as { summary: string }).summary).toBe('One, two, three,');
    }
  });
});

describe('parseDiagnosis', () => {
  it('accepts valid output', () => {
    const result = parseDiagnosis(json);
    expect(result.ok).toBe(true);
  });

  it('reports the json stage when nothing parses', () => {
    const result = parseDiagnosis('total nonsense');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('json');
      expect(result.validatorError).toMatch(/not valid JSON/);
    }
  });

  it('reports the schema stage with actionable field paths', () => {
    const bad = JSON.stringify({ ...validDiagnosis(), questions: [] });
    const result = parseDiagnosis(bad);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe('schema');
      expect(result.validatorError).toContain('questions');
    }
  });

  it('rejects a model-supplied total, because every object is strict', () => {
    const withTotal = JSON.stringify({ ...validDiagnosis(), overallScore: 40 });
    const result = parseDiagnosis(withTotal);
    expect(result.ok).toBe(false);
  });

  it('caps the number of issues fed back, so the retry prompt stays small', () => {
    const result = parseDiagnosis(JSON.stringify({ summary: 1, dimensions: {}, questions: 'no' }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.validatorError.split('\n').length).toBeLessThanOrEqual(11);
    }
  });
});
