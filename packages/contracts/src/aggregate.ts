import {
  DIMENSIONS,
  SCORE_ANCHORS,
  SCORE_MAX,
  SCORE_MIN,
  VERDICT_THRESHOLDS,
  Verdict,
  type DimensionMap,
} from './diagnosis.js';

/**
 * Scores are computed in code, never read from the model. Constitution
 * principle 2. These are pure functions on plain data so they can be shared by
 * the API, the web app, and the calibration harness without a round trip.
 */

/**
 * Clamp unconditionally. Neither provider dialect enforces numeric bounds, so
 * a score arriving outside 0-100 is expected rather than exceptional.
 */
export function clampScore(score: number): number {
  // NaN carries no magnitude, so it floors. Infinities do carry a direction and
  // must clamp to the corresponding bound — treating +Infinity as 0 would turn
  // a nonsense-high score into a nonsense-low one, which is worse.
  if (Number.isNaN(score)) return SCORE_MIN;
  if (score === Number.POSITIVE_INFINITY) return SCORE_MAX;
  if (score === Number.NEGATIVE_INFINITY) return SCORE_MIN;
  return Math.max(SCORE_MIN, Math.min(SCORE_MAX, Math.round(score)));
}

/** True when the score is one of the rubric's discrete anchors. */
export function isAnchorScore(score: number): boolean {
  return (SCORE_ANCHORS as readonly number[]).includes(score);
}

/**
 * Overall is the mean of the five clamped dimension scores, rounded half up.
 * The model is explicitly forbidden from computing this.
 */
export function computeOverall(dimensions: DimensionMap): number {
  const total = DIMENSIONS.reduce((sum, key) => sum + clampScore(dimensions[key].score), 0);
  return Math.round(total / DIMENSIONS.length);
}

/** >=80 READY, 55-79 NEEDS_WORK, <55 NOT_READY. */
export function deriveVerdict(overall: number): Verdict {
  if (overall >= VERDICT_THRESHOLDS.READY) return Verdict.READY;
  if (overall >= VERDICT_THRESHOLDS.NEEDS_WORK) return Verdict.NEEDS_WORK;
  return Verdict.NOT_READY;
}

export interface Aggregate {
  overall: number;
  verdict: Verdict;
  /** Dimensions whose raw score was not one of the anchors, worth recording. */
  offAnchor: readonly string[];
  /** Dimensions whose raw score needed clamping into 0-100. */
  clamped: readonly string[];
}

/** One pass: clamp, aggregate, derive, and report what had to be corrected. */
export function aggregate(dimensions: DimensionMap): Aggregate {
  const offAnchor: string[] = [];
  const clamped: string[] = [];

  for (const key of DIMENSIONS) {
    const raw = dimensions[key].score;
    if (clampScore(raw) !== raw) clamped.push(key);
    else if (!isAnchorScore(raw)) offAnchor.push(key);
  }

  const overall = computeOverall(dimensions);
  return { overall, verdict: deriveVerdict(overall), offAnchor, clamped };
}
