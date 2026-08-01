import { DIMENSIONS, type Dimension } from './diagnosis.js';

/**
 * The rubric's anchor ladder, as display data.
 *
 * WHY THIS IS TRANSCRIBED RATHER THAN PARSED FROM `rubric-v1.md`
 *
 * That file's SHA-256 IS the active prompt's identity: `seed.ts` hashes it byte
 * for byte, a boot check compares the stored hash against a fresh one, and a
 * database trigger forbids mutating the content of an ACTIVE version. Pointing a
 * display component at that file would invite someone to reflow a line for the
 * UI's benefit and, in doing so, silently fork the prompt that governs every
 * public diagnosis.
 *
 * So the anchors live here as ordinary data, and `rubric-drift.spec.ts` in
 * apps/api asserts every string below appears VERBATIM in `rubric-v1.md`. That
 * makes the two failure modes symmetrical and both loud:
 *
 *   - edit the rubric without updating this file  -> the drift test fails;
 *   - edit this file without touching the rubric  -> the drift test fails.
 *
 * Nothing here is ever sent to a model. This is what a human reads.
 */

/** One rung of a dimension's ladder. */
export interface Anchor {
  /** One of the six permitted scores. */
  score: number;
  /**
   * The anchor prose, exactly as it appears in rubric-v1.md — including the
   * `*not*` emphasis markers in OBJECTIVE_CLARITY's 100 anchor, which the
   * renderer turns into an <em> rather than stripping. Verbatim is the whole
   * point; a "harmless" tidy-up here is precisely what the drift test catches.
   */
  text: string;
}

export interface DimensionAnchors {
  dimension: Dimension;
  /** Display name, e.g. "Objective clarity". */
  label: string;
  /** The clause after the em dash in the rubric's heading for this dimension. */
  subtitle: string;
  /** Six rungs, ascending: 0, 20, 40, 60, 80, 100. */
  anchors: Anchor[];
}

export const DIMENSION_ANCHORS: DimensionAnchors[] = [
  {
    dimension: 'OBJECTIVE_CLARITY',
    label: 'Objective clarity',
    subtitle: 'what the work is for, and what should change because of it',
    anchors: [
      { score: 0, text: 'No objective of any kind. The brief names a deliverable ("we need a video", "let\'s do a campaign") and nothing about why.' },
      { score: 20, text: 'A direction only, with no stated change: "raise awareness", "build the brand", "get the word out", "increase visibility".' },
      { score: 40, text: 'A named business or communications goal, but no link between the work and anything an audience would do or think differently.' },
      { score: 60, text: 'A clear goal and a stated change in what the audience does or believes, though the connection between this work and that change is asserted rather than explained.' },
      { score: 80, text: 'A specific objective, the change it should produce, and where that change sits in the wider journey or decision the audience is making.' },
      { score: 100, text: 'All of the above, and the objective is bounded: the brief says what this work is deliberately *not* trying to do, or which adjacent goal it is not responsible for.' },
    ],
  },
  {
    dimension: 'AUDIENCE_SPECIFICITY',
    label: 'Audience specificity',
    subtitle: 'who this is for, in enough detail to make a creative decision',
    anchors: [
      { score: 0, text: 'No audience is named at all.' },
      { score: 20, text: 'A demographic or category label only: "millennials", "B2B decision-makers", "students", "our customers".' },
      { score: 40, text: 'A demographic plus a role or context, but nothing about what those people currently do or believe.' },
      { score: 60, text: 'A described segment with at least one current behaviour or held belief stated.' },
      { score: 80, text: 'A specific segment, their current behaviour or belief, and the barrier, tension, or trigger that this work has to act on.' },
      { score: 100, text: 'All of the above, and the brief says where and in what mindset the audience will encounter the work, or names who is explicitly out of scope.' },
    ],
  },
  {
    dimension: 'MESSAGE_SUBSTANCE',
    label: 'Message substance',
    subtitle: 'whether there is something to actually say',
    anchors: [
      { score: 0, text: 'No message content. The brief specifies format, channel, or tone and nothing about what is being communicated.' },
      { score: 20, text: 'Adjectives or tone words standing in for a proposition: "premium", "fun", "bold", "trustworthy", "disruptive".' },
      { score: 40, text: 'A stated claim, but one generic enough that a direct competitor could make it unchanged.' },
      { score: 60, text: 'A specific claim with at least one supporting fact, feature, or proof point behind it.' },
      { score: 80, text: 'A specific and ownable claim, supported by evidence, with a stated reason the audience should find it credible.' },
      { score: 100, text: 'All of the above, and the brief states what the audience currently believes instead, or names the single thing to take away if they remember nothing else.' },
    ],
  },
  {
    dimension: 'CONSTRAINTS',
    label: 'Constraints',
    subtitle: 'the real boundaries the work has to live inside',
    anchors: [
      { score: 0, text: 'No constraints stated. No deliverables, formats, dates, budget, or mandatories.' },
      { score: 20, text: 'A deliverable named without specification: "a campaign", "some social", "a landing page".' },
      { score: 40, text: 'Deliverables and formats listed, with timing, budget, and mandatories all absent.' },
      { score: 60, text: 'Deliverables, formats, and a deadline, with budget or legal/brand mandatories still missing.' },
      { score: 80, text: 'Deliverables with specifications, timings including any fixed external date, a budget or budget range, and the known mandatory inclusions.' },
      { score: 100, text: 'All of the above, and the brief says what has been tried before, what is off-limits, or who signs off.' },
    ],
  },
  {
    dimension: 'SUCCESS_METRICS',
    label: 'Success metrics',
    subtitle: 'how anyone will know whether this worked',
    anchors: [
      { score: 0, text: 'No measure of success stated.' },
      { score: 20, text: 'Success described only subjectively: "it should feel premium", "we\'ll know it when we see it", "make it land".' },
      { score: 40, text: 'A metric named with no number, no baseline, and no timeframe: "increase engagement", "drive traffic".' },
      { score: 60, text: 'A named metric with either a target or a timeframe, but not both, and no baseline.' },
      { score: 80, text: 'A named metric with a current baseline, a target, and a measurement window.' },
      { score: 100, text: 'All of the above, and the brief says how it will be measured, or what result would count as a failure.' },
    ],
  },
];

/**
 * Lookup by dimension. Built from DIMENSIONS so the map cannot drift out of sync
 * with the canonical dimension order the report and the sidebar both rely on.
 */
export const ANCHORS_BY_DIMENSION: Record<Dimension, DimensionAnchors> =
  Object.fromEntries(
    DIMENSIONS.map((d) => [
      d,
      DIMENSION_ANCHORS.find((entry) => entry.dimension === d)!,
    ]),
  ) as Record<Dimension, DimensionAnchors>;

/** Every anchor string, for the drift test. */
export function allAnchorTexts(): string[] {
  return DIMENSION_ANCHORS.flatMap((d) => d.anchors.map((a) => a.text));
}
