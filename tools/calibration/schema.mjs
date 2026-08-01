/**
 * One neutral shape description, one provider emitter.
 *
 * A deliberately miniature rehearsal of `toProviderSchema` from packages/ai.
 * It exists here so the transform's real hazards surface now rather than in
 * step 6. Throwaway: the production version is generated from the zod schema
 * in packages/contracts and golden-file tested.
 *
 * Gemini wants the OpenAPI 3.0 subset: SCREAMING_CASE types,
 * `propertyOrdering` for stable field order, and NO `additionalProperties` —
 * that key is not a field on Gemini's Schema type at all, and sending it is
 * the single most likely cause of a 400 from this adapter.
 */

export const DIMENSIONS = [
  'OBJECTIVE_CLARITY',
  'AUDIENCE_SPECIFICITY',
  'MESSAGE_SUBSTANCE',
  'CONSTRAINTS',
  'SUCCESS_METRICS',
];

export const ANCHORS = [0, 20, 40, 60, 80, 100];

// ── neutral shape DSL ────────────────────────────────────────────────────────

const str = (description) => ({ kind: 'string', description });
const bool = (description) => ({ kind: 'boolean', description });
const int = (description, opts = {}) => ({ kind: 'integer', description, ...opts });
const enumStr = (values, description) => ({ kind: 'enum', values, description });
const arr = (items, opts = {}) => ({ kind: 'array', items, ...opts });
const obj = (properties) => ({ kind: 'object', properties, order: Object.keys(properties) });

const dimensionScore = obj({
  score: int(
    `One of ${ANCHORS.join(', ')}. No other value is permitted.`,
    { anchors: ANCHORS, min: 0, max: 100 },
  ),
  rationale: str('One to three sentences explaining which anchor the brief matched.'),
  gaps: arr(str(), { maxItems: 5, description: 'Concrete absences, as short noun phrases. Empty when the score is 100.' }),
  evidence: arr(str(), { description: 'Verbatim quotes from the brief. Empty when the brief contains nothing relevant.' }),
});

export const DIAGNOSIS_SHAPE = obj({
  summary: str('Two to four sentences addressed to the requester. Contains no overall score and no verdict.'),
  dimensions: obj(Object.fromEntries(DIMENSIONS.map((d) => [d, dimensionScore]))),
  questions: arr(
    obj({
      dimension: enumStr(DIMENSIONS, 'The dimension this question addresses.'),
      question: str('Answerable in one or two sentences. Collaborative in tone.'),
      blocking: bool('True only when the creative team cannot begin without the answer.'),
      rank: int('Send order, starting at 1, consecutive, no repeats.', { min: 1 }),
    }),
    { minItems: 3, maxItems: 8 },
  ),
});

// ── Gemini: OpenAPI 3.0 subset, propertyOrdering, no additionalProperties ────

export function toGeminiSchema(node) {
  switch (node.kind) {
    case 'string':
      return clean({ type: 'STRING', description: node.description });
    case 'boolean':
      return clean({ type: 'BOOLEAN', description: node.description });
    case 'integer':
      // Gemini's Schema accepts minimum/maximum but does not reliably enforce
      // an integer enum, so the permitted anchors live in the description and
      // are enforced in code. Numeric constraints are never a server-side
      // guarantee on either provider — clamp on the way into the database.
      return clean({
        type: 'INTEGER',
        description: node.description,
        minimum: node.min,
        maximum: node.max,
      });
    case 'enum':
      return clean({ type: 'STRING', enum: node.values, description: node.description });
    case 'array':
      return clean({
        type: 'ARRAY',
        description: node.description,
        items: toGeminiSchema(node.items),
        minItems: node.minItems,
        maxItems: node.maxItems,
      });
    case 'object': {
      const properties = {};
      for (const [key, value] of Object.entries(node.properties)) {
        properties[key] = toGeminiSchema(value);
      }
      return {
        type: 'OBJECT',
        properties,
        required: Object.keys(node.properties),
        propertyOrdering: node.order, // stable field order; Gemini-specific
        // NOTE: deliberately no `additionalProperties` — not a field on
        // Gemini's Schema type.
      };
    }
    default:
      throw new Error(`unhandled shape kind: ${node.kind}`);
  }
}

function clean(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
