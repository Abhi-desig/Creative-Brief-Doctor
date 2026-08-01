import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DiagnosisOutputSchema } from '@cbd/contracts';
import {
  assertGeminiSchemaInvariants,
  toGeminiSchema,
  type GeminiSchema,
} from './google.schema.js';

/**
 * Golden-file tests for the highest-risk code in the package.
 *
 * The snapshot is the contract. If it changes, either the compiled schema
 * changed — which means re-verifying against the live API before accepting —
 * or packages/contracts changed, which is a deliberate act. What must never
 * happen is the snapshot being updated to match a transform that started
 * emitting `additionalProperties`.
 */

function walk(schema: GeminiSchema, visit: (node: GeminiSchema, path: string) => void, path = '$'): void {
  visit(schema, path);
  if (schema.properties) {
    for (const [key, value] of Object.entries(schema.properties)) walk(value, visit, `${path}.${key}`);
  }
  if (schema.items) walk(schema.items, visit, `${path}[]`);
}

describe('toGeminiSchema — the three invariants', () => {
  const compiled = toGeminiSchema(DiagnosisOutputSchema);

  it('emits NO additionalProperties anywhere — it is not a field on Gemini Schema', () => {
    const offenders: string[] = [];
    walk(compiled, (node, path) => {
      if ('additionalProperties' in (node as unknown as Record<string, unknown>)) offenders.push(path);
    });
    expect(offenders).toEqual([]);
  });

  it('emits propertyOrdering on every object, matching its property keys exactly', () => {
    walk(compiled, (node, path) => {
      if (node.type !== 'OBJECT') return;
      const keys = Object.keys(node.properties ?? {});
      expect(node.propertyOrdering, `missing propertyOrdering at ${path}`).toBeDefined();
      expect(node.propertyOrdering, `propertyOrdering mismatch at ${path}`).toEqual(keys);
    });
  });

  it('emits no JSON Schema plumbing keys', () => {
    const offenders: string[] = [];
    walk(compiled, (node, path) => {
      for (const key of ['$schema', '$ref', '$defs', 'definitions']) {
        if (key in (node as unknown as Record<string, unknown>)) offenders.push(`${path}:${key}`);
      }
    });
    expect(offenders).toEqual([]);
  });

  it('uses SCREAMING_CASE type names throughout', () => {
    const allowed = new Set(['STRING', 'NUMBER', 'INTEGER', 'BOOLEAN', 'ARRAY', 'OBJECT']);
    walk(compiled, (node, path) => {
      expect(allowed.has(node.type), `unexpected type "${node.type}" at ${path}`).toBe(true);
    });
  });

  it('passes its own invariant assertion', () => {
    expect(() => assertGeminiSchemaInvariants(compiled)).not.toThrow();
  });
});

describe('toGeminiSchema — structural fidelity to the contract', () => {
  const compiled = toGeminiSchema(DiagnosisOutputSchema);

  it('preserves the five dimension keys in contract order', () => {
    const dimensions = compiled.properties?.dimensions;
    expect(dimensions?.type).toBe('OBJECT');
    expect(dimensions?.propertyOrdering).toEqual([
      'OBJECTIVE_CLARITY',
      'AUDIENCE_SPECIFICITY',
      'MESSAGE_SUBSTANCE',
      'CONSTRAINTS',
      'SUCCESS_METRICS',
    ]);
  });

  it('marks every dimension and every top-level field required', () => {
    expect(compiled.required?.sort()).toEqual(['dimensions', 'questions', 'summary']);
    const dimension = compiled.properties?.dimensions?.properties?.OBJECTIVE_CLARITY;
    expect(dimension?.required?.sort()).toEqual(['evidence', 'gaps', 'rationale', 'score']);
  });

  it('carries the question array bounds through', () => {
    const questions = compiled.properties?.questions;
    expect(questions?.type).toBe('ARRAY');
    expect(questions?.minItems).toBe(3);
    expect(questions?.maxItems).toBe(8);
  });

  it('compiles the dimension enum to a STRING enum', () => {
    const dimension = compiled.properties?.questions?.items?.properties?.dimension;
    expect(dimension?.type).toBe('STRING');
    expect(dimension?.enum).toEqual([
      'OBJECTIVE_CLARITY',
      'AUDIENCE_SPECIFICITY',
      'MESSAGE_SUBSTANCE',
      'CONSTRAINTS',
      'SUCCESS_METRICS',
    ]);
  });

  it('keeps the score description carrying the anchors, since the enum cannot be numeric', () => {
    const score = compiled.properties?.dimensions?.properties?.OBJECTIVE_CLARITY?.properties?.score;
    expect(score?.type).toBe('INTEGER');
    expect(score?.description).toContain('0, 20, 40, 60, 80, 100');
  });
});

describe('toGeminiSchema — golden file', () => {
  it('matches the recorded compilation of DiagnosisOutput', () => {
    expect(toGeminiSchema(DiagnosisOutputSchema)).toMatchSnapshot();
  });
});

describe('toGeminiSchema — edge cases', () => {
  it('collapses "T or null" to a nullable T', () => {
    const compiled = toGeminiSchema(z.object({ note: z.string().nullable() }).strict());
    expect(compiled.properties?.note?.type).toBe('STRING');
    expect(compiled.properties?.note?.nullable).toBe(true);
  });

  it('inlines a subschema reused twice rather than emitting a $ref', () => {
    const inner = z.object({ a: z.string() }).strict();
    const compiled = toGeminiSchema(z.object({ first: inner, second: inner }).strict());
    expect(compiled.properties?.first?.properties?.a?.type).toBe('STRING');
    expect(compiled.properties?.second?.properties?.a?.type).toBe('STRING');
    expect(() => assertGeminiSchemaInvariants(compiled)).not.toThrow();
  });

  it('carries array item bounds and nested objects', () => {
    const compiled = toGeminiSchema(
      z.object({ rows: z.array(z.object({ n: z.number().int() }).strict()).min(1).max(4) }).strict(),
    );
    expect(compiled.properties?.rows?.minItems).toBe(1);
    expect(compiled.properties?.rows?.maxItems).toBe(4);
    expect(compiled.properties?.rows?.items?.properties?.n?.type).toBe('INTEGER');
  });

  it('drops numeric bounds when asked to', () => {
    const schema = z.object({ n: z.number().min(0).max(100) }).strict();
    expect(toGeminiSchema(schema).properties?.n?.minimum).toBe(0);
    expect(toGeminiSchema(schema, { keepNumericBounds: false }).properties?.n?.minimum)
      .toBeUndefined();
  });

  it('refuses a union it cannot represent, instead of emitting a schema the API will reject', () => {
    const unrepresentable = z.object({
      value: z.union([z.object({ a: z.string() }).strict(), z.object({ b: z.number() }).strict()]),
    }).strict();
    expect(() => toGeminiSchema(unrepresentable)).toThrow(/no OpenAPI-3.0-subset equivalent/);
  });
});

describe('assertGeminiSchemaInvariants', () => {
  it('catches an injected additionalProperties', () => {
    const bad = toGeminiSchema(DiagnosisOutputSchema) as unknown as Record<string, unknown>;
    bad.additionalProperties = false;
    expect(() => assertGeminiSchemaInvariants(bad as unknown as GeminiSchema))
      .toThrow(/additionalProperties present/);
  });

  it('catches a missing propertyOrdering', () => {
    const bad = toGeminiSchema(DiagnosisOutputSchema);
    delete bad.propertyOrdering;
    expect(() => assertGeminiSchemaInvariants(bad)).toThrow(/missing propertyOrdering/);
  });

  it('catches propertyOrdering that has drifted from the property keys', () => {
    const bad = toGeminiSchema(DiagnosisOutputSchema);
    bad.propertyOrdering = ['summary'];
    expect(() => assertGeminiSchemaInvariants(bad)).toThrow(/lists 1 keys but the object has 3/);
  });
});
