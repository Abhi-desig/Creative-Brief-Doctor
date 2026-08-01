import { z } from 'zod';

/**
 * The single source of truth for the diagnosis shape.
 *
 * Consumed four ways: per-provider schema compilation in `packages/ai`, API
 * request/response validation, admin forms, and web types. Nothing else defines
 * this shape.
 *
 * Every object is `.strict()`. That is load-bearing rather than stylistic:
 * `.strict()` is what makes `z.toJSONSchema` emit `additionalProperties: false`,
 * which providers on the strict-JSON-Schema dialect require. Adapters targeting
 * the OpenAPI subset strip that key back out; the direction of travel is
 * strict-by-default and relax per adapter, never the reverse.
 */

// ── enums ────────────────────────────────────────────────────────────────────

/**
 * Values match the Prisma `Dimension` enum exactly, and are also the object
 * keys in `DiagnosisOutput.dimensions`. One vocabulary, no mapping layer.
 */
export const Dimension = {
  OBJECTIVE_CLARITY: 'OBJECTIVE_CLARITY',
  AUDIENCE_SPECIFICITY: 'AUDIENCE_SPECIFICITY',
  MESSAGE_SUBSTANCE: 'MESSAGE_SUBSTANCE',
  CONSTRAINTS: 'CONSTRAINTS',
  SUCCESS_METRICS: 'SUCCESS_METRICS',
} as const;

export const DimensionSchema = z.enum(Dimension);
export type Dimension = z.infer<typeof DimensionSchema>;

/** Fixed order. Display order, and `propertyOrdering` for adapters that want it. */
export const DIMENSIONS = [
  Dimension.OBJECTIVE_CLARITY,
  Dimension.AUDIENCE_SPECIFICITY,
  Dimension.MESSAGE_SUBSTANCE,
  Dimension.CONSTRAINTS,
  Dimension.SUCCESS_METRICS,
] as const satisfies readonly Dimension[];

export const Verdict = {
  READY: 'READY',
  NEEDS_WORK: 'NEEDS_WORK',
  NOT_READY: 'NOT_READY',
} as const;

export const VerdictSchema = z.enum(Verdict);
export type Verdict = z.infer<typeof VerdictSchema>;

// ── thresholds ───────────────────────────────────────────────────────────────

/**
 * Lower bounds, inclusive: >=80 READY, 55-79 NEEDS_WORK, <55 NOT_READY.
 * Lives here so web and api agree without a round trip.
 */
export const VERDICT_THRESHOLDS = {
  READY: 80,
  NEEDS_WORK: 55,
} as const;

/**
 * The permitted dimension scores. The rubric defines six discrete anchors and
 * forbids values between them, so a score outside this set means the model
 * ignored the scale — worth recording as a degradation rather than silently
 * accepting.
 */
export const SCORE_ANCHORS = [0, 20, 40, 60, 80, 100] as const;

export const SCORE_MIN = 0;
export const SCORE_MAX = 100;

// ── the model's output ───────────────────────────────────────────────────────

/**
 * `.min(0).max(100)` is documented intent and client-side validation only.
 * Both provider dialects strip or ignore numeric constraints, so this is never
 * a server-side guarantee — clamp on the way into the database, unconditionally.
 */
const ScoreSchema = z
  .number()
  .int()
  .min(SCORE_MIN)
  .max(SCORE_MAX)
  .describe(`One of ${SCORE_ANCHORS.join(', ')}. No other value is permitted.`);

export const DimensionScoreSchema = z
  .object({
    score: ScoreSchema,
    rationale: z
      .string()
      .min(1)
      .describe('One to three sentences explaining which anchor the brief matched.'),
    gaps: z
      .array(z.string().min(1))
      .max(5)
      .describe('Concrete absences as short noun phrases. Empty when the score is 100.'),
    evidence: z
      .array(z.string().min(1))
      .describe(
        'Verbatim quotes from the brief. Empty when the brief contains nothing '
          + 'relevant to this dimension.',
      ),
  })
  .strict();

export type DimensionScore = z.infer<typeof DimensionScoreSchema>;

export const FollowUpQuestionSchema = z
  .object({
    dimension: DimensionSchema.describe('The dimension this question addresses.'),
    question: z
      .string()
      .min(1)
      .describe('Answerable in one or two sentences. Collaborative in tone.'),
    blocking: z
      .boolean()
      .describe('True only when the creative team cannot begin without the answer.'),
    rank: z
      .number()
      .int()
      .min(1)
      .describe('Send order, starting at 1, consecutive, no repeats.'),
  })
  .strict();

export type FollowUpQuestion = z.infer<typeof FollowUpQuestionSchema>;

/**
 * Five fixed keys rather than an array of five discriminated objects. That makes
 * "all five dimensions present" a schema guarantee instead of a runtime check,
 * and gives adapters a stable key order for free.
 */
export const DimensionMapSchema = z
  .object({
    OBJECTIVE_CLARITY: DimensionScoreSchema,
    AUDIENCE_SPECIFICITY: DimensionScoreSchema,
    MESSAGE_SUBSTANCE: DimensionScoreSchema,
    CONSTRAINTS: DimensionScoreSchema,
    SUCCESS_METRICS: DimensionScoreSchema,
  })
  .strict();

export type DimensionMap = z.infer<typeof DimensionMapSchema>;

/**
 * What the model returns. Deliberately contains no total and no verdict:
 * the server computes both from the five dimension scores. A model-supplied
 * total would be discarded, so asking for one only invites disagreement.
 */
export const DiagnosisOutputSchema = z
  .object({
    summary: z
      .string()
      .min(1)
      .describe(
        'Two to four sentences addressed to the requester. Contains no overall '
          + 'score and no verdict.',
      ),
    dimensions: DimensionMapSchema,
    questions: z.array(FollowUpQuestionSchema).min(3).max(8),
  })
  .strict();

export type DiagnosisOutput = z.infer<typeof DiagnosisOutputSchema>;

/**
 * The schema used to VALIDATE model output, as opposed to the one used to
 * COMPILE a provider schema.
 *
 * The difference is the numeric bounds on `score`, and it matters: both provider
 * dialects strip or ignore `minimum`/`maximum`, so a model can and does return
 * 105 or -20. Validating against the bounded schema would reject the whole
 * diagnosis over a single out-of-range integer — throwing away four good
 * dimension scores and a set of usable questions.
 *
 * So the bounds stay in `DiagnosisOutputSchema` as documentation for the
 * provider schema, parsing uses this relaxed form, and `clampScore` corrects the
 * value on the way into the database. That is what "clamp unconditionally"
 * requires in practice: accept and correct, not reject.
 */
const LenientScoreSchema = z.number().int();

const LenientDimensionScoreSchema = DimensionScoreSchema.extend({
  score: LenientScoreSchema,
}).strict();

export const DiagnosisOutputParseSchema = z
  .object({
    summary: z.string().min(1),
    dimensions: z
      .object({
        OBJECTIVE_CLARITY: LenientDimensionScoreSchema,
        AUDIENCE_SPECIFICITY: LenientDimensionScoreSchema,
        MESSAGE_SUBSTANCE: LenientDimensionScoreSchema,
        CONSTRAINTS: LenientDimensionScoreSchema,
        SUCCESS_METRICS: LenientDimensionScoreSchema,
      })
      .strict(),
    questions: z.array(FollowUpQuestionSchema).min(3).max(8),
  })
  .strict();
