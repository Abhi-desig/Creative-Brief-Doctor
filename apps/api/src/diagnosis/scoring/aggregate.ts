import {
  DIMENSIONS,
  aggregate as aggregateScores,
  clampScore,
  type DiagnosisOutput,
  type Dimension,
  type Verdict,
} from '@cbd/contracts';

/**
 * Turns validated model output into rows ready for the database.
 *
 * The arithmetic lives in @cbd/contracts so web and api cannot disagree; this
 * is the persistence-facing half: clamping, ordering, and the record of what
 * had to be corrected. No decorators.
 */

export interface DimensionRow {
  dimension: Dimension;
  score: number;
  rationale: string;
  gaps: string[];
  evidence: string[];
}

export interface QuestionRow {
  dimension: Dimension;
  question: string;
  blocking: boolean;
  rank: number;
}

export interface AggregatedDiagnosis {
  overallScore: number;
  verdict: Verdict;
  summary: string;
  dimensions: DimensionRow[];
  questions: QuestionRow[];
  /** Corrections applied on the way in, recorded as degradations. */
  corrections: string[];
}

export function aggregateDiagnosis(output: DiagnosisOutput): AggregatedDiagnosis {
  const { overall, verdict, offAnchor, clamped } = aggregateScores(output.dimensions);

  const corrections: string[] = [];
  if (clamped.length > 0) {
    corrections.push(`scores clamped into 0-100: ${clamped.join(', ')}`);
  }
  if (offAnchor.length > 0) {
    corrections.push(`scores not on a rubric anchor: ${offAnchor.join(', ')}`);
  }

  // Clamp unconditionally on the way to the database. No provider guarantees
  // the range, and both dialects strip numeric constraints from the schema.
  const dimensions: DimensionRow[] = DIMENSIONS.map((dimension) => {
    const node = output.dimensions[dimension];
    return {
      dimension,
      score: clampScore(node.score),
      rationale: node.rationale,
      gaps: [...node.gaps],
      evidence: [...node.evidence],
    };
  });

  // Re-rank consecutively from 1 in the model's stated order. A duplicate or
  // gapped rank is cosmetic, so it is repaired rather than rejected.
  const sorted = [...output.questions].sort((a, b) => a.rank - b.rank);
  const questions: QuestionRow[] = sorted.map((q, index) => ({
    dimension: q.dimension,
    question: q.question,
    blocking: q.blocking,
    rank: index + 1,
  }));
  if (sorted.some((q, i) => q.rank !== i + 1)) {
    corrections.push('question ranks were not consecutive; renumbered');
  }

  return {
    overallScore: overall,
    verdict,
    summary: output.summary,
    dimensions,
    questions,
    corrections,
  };
}
