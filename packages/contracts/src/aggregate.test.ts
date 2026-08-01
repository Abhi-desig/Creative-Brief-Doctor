import { describe, expect, it } from 'vitest';
import {
  aggregate,
  clampScore,
  computeOverall,
  deriveVerdict,
  isAnchorScore,
} from './aggregate.js';
import {
  DIMENSIONS,
  DiagnosisOutputSchema,
  Verdict,
  type DimensionMap,
} from './diagnosis.js';

/** A DimensionMap where every dimension carries the same score. */
const flat = (score: number): DimensionMap =>
  Object.fromEntries(
    DIMENSIONS.map((d) => [d, { score, rationale: 'r', gaps: [], evidence: ['q'] }]),
  ) as DimensionMap;

/** A DimensionMap from five scores, in DIMENSIONS order. */
const of = (scores: readonly number[]): DimensionMap =>
  Object.fromEntries(
    DIMENSIONS.map((d, i) => [d, { score: scores[i]!, rationale: 'r', gaps: [], evidence: ['q'] }]),
  ) as DimensionMap;

describe('clampScore', () => {
  it('passes through in-range values', () => {
    expect(clampScore(0)).toBe(0);
    expect(clampScore(55)).toBe(55);
    expect(clampScore(100)).toBe(100);
  });

  it('clamps out-of-range values rather than trusting the provider', () => {
    expect(clampScore(-1)).toBe(0);
    expect(clampScore(-9999)).toBe(0);
    expect(clampScore(101)).toBe(100);
    expect(clampScore(250)).toBe(100);
  });

  it('rounds non-integers and survives non-finite input', () => {
    expect(clampScore(77.4)).toBe(77);
    expect(clampScore(77.5)).toBe(78);
    expect(clampScore(Number.NaN)).toBe(0);
    expect(clampScore(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('deriveVerdict — threshold boundaries', () => {
  it('is NOT_READY below 55', () => {
    expect(deriveVerdict(0)).toBe(Verdict.NOT_READY);
    expect(deriveVerdict(54)).toBe(Verdict.NOT_READY);
  });

  it('is NEEDS_WORK at exactly 55 and through 79', () => {
    expect(deriveVerdict(55)).toBe(Verdict.NEEDS_WORK);
    expect(deriveVerdict(79)).toBe(Verdict.NEEDS_WORK);
  });

  it('is READY at exactly 80 and above', () => {
    expect(deriveVerdict(80)).toBe(Verdict.READY);
    expect(deriveVerdict(100)).toBe(Verdict.READY);
  });
});

describe('computeOverall', () => {
  it('is the mean of five equal scores', () => {
    for (const s of [0, 20, 40, 60, 80, 100]) expect(computeOverall(flat(s))).toBe(s);
  });

  it('averages mixed scores', () => {
    expect(computeOverall(of([100, 80, 60, 40, 20]))).toBe(60);
    expect(computeOverall(of([0, 0, 0, 0, 100]))).toBe(20);
  });

  it('rounds half up', () => {
    // 20+20+20+20+40 = 120 / 5 = 24
    expect(computeOverall(of([20, 20, 20, 20, 40]))).toBe(24);
    // 0+0+0+20+20 = 40 / 5 = 8
    expect(computeOverall(of([0, 0, 0, 20, 20]))).toBe(8);
  });

  it('clamps before averaging, so one bad value cannot skew the total', () => {
    expect(computeOverall(of([1000, 0, 0, 0, 0]))).toBe(20);
    expect(computeOverall(of([-500, 0, 0, 0, 0]))).toBe(0);
  });
});

describe('aggregate', () => {
  it('reports nothing to correct for clean anchor scores', () => {
    const result = aggregate(of([80, 80, 60, 100, 80]));
    expect(result.overall).toBe(80);
    expect(result.verdict).toBe(Verdict.READY);
    expect(result.offAnchor).toEqual([]);
    expect(result.clamped).toEqual([]);
  });

  it('flags an off-anchor score without rejecting it', () => {
    const result = aggregate(of([73, 80, 80, 80, 80]));
    expect(result.offAnchor).toEqual(['OBJECTIVE_CLARITY']);
    expect(result.clamped).toEqual([]);
    expect(result.overall).toBe(79);
    expect(result.verdict).toBe(Verdict.NEEDS_WORK);
  });

  it('flags a clamped score separately from an off-anchor one', () => {
    const result = aggregate(of([250, 80, 80, 80, 80]));
    expect(result.clamped).toEqual(['OBJECTIVE_CLARITY']);
    expect(result.offAnchor).toEqual([]);
    expect(result.overall).toBe(84);
  });

  it('lands on NEEDS_WORK at the 55 boundary when constructed exactly', () => {
    // 55+55+55+55+55 = 275 / 5 = 55
    expect(aggregate(flat(55)).verdict).toBe(Verdict.NEEDS_WORK);
    // 54 -> NOT_READY, one point below
    expect(aggregate(flat(54)).verdict).toBe(Verdict.NOT_READY);
  });
});

describe('isAnchorScore', () => {
  it('accepts the six anchors and rejects everything else', () => {
    for (const s of [0, 20, 40, 60, 80, 100]) expect(isAnchorScore(s)).toBe(true);
    for (const s of [1, 19, 50, 73, 99]) expect(isAnchorScore(s)).toBe(false);
  });
});

describe('DiagnosisOutputSchema', () => {
  const valid = {
    summary: 'The brief is clear on audience and thin on measurement.',
    dimensions: flat(60),
    questions: [
      { dimension: 'OBJECTIVE_CLARITY', question: 'What decision should this change?', blocking: true, rank: 1 },
      { dimension: 'SUCCESS_METRICS', question: 'What is the current baseline?', blocking: true, rank: 2 },
      { dimension: 'CONSTRAINTS', question: 'Is the launch date fixed?', blocking: false, rank: 3 },
    ],
  };

  it('accepts a well-formed diagnosis', () => {
    expect(DiagnosisOutputSchema.safeParse(valid).success).toBe(true);
  });

  it('rejects an unknown top-level key — every object is strict', () => {
    const withTotal = { ...valid, overallScore: 60 };
    expect(DiagnosisOutputSchema.safeParse(withTotal).success).toBe(false);
  });

  it('rejects a missing dimension', () => {
    const { SUCCESS_METRICS: _omitted, ...rest } = valid.dimensions;
    expect(DiagnosisOutputSchema.safeParse({ ...valid, dimensions: rest }).success).toBe(false);
  });

  it('rejects fewer than 3 or more than 8 questions', () => {
    expect(DiagnosisOutputSchema.safeParse({ ...valid, questions: valid.questions.slice(0, 2) }).success)
      .toBe(false);
    const nine = Array.from({ length: 9 }, (_, i) => ({
      dimension: 'CONSTRAINTS' as const, question: 'q', blocking: false, rank: i + 1,
    }));
    expect(DiagnosisOutputSchema.safeParse({ ...valid, questions: nine }).success).toBe(false);
  });

  it('rejects an unknown dimension in a question', () => {
    const bad = { ...valid, questions: [{ ...valid.questions[0]!, dimension: 'BUDGET' }, ...valid.questions.slice(1)] };
    expect(DiagnosisOutputSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects more than five gaps on a dimension', () => {
    const dims = { ...flat(60) };
    dims.CONSTRAINTS = { ...dims.CONSTRAINTS, gaps: ['a', 'b', 'c', 'd', 'e', 'f'] };
    expect(DiagnosisOutputSchema.safeParse({ ...valid, dimensions: dims }).success).toBe(false);
  });
});
