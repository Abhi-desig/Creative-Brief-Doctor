import { z } from 'zod';

/**
 * `toProviderSchema` for Google Gemini: the OpenAPI 3.0 subset.
 *
 * This is the highest-risk code in the package, which is why it is golden-file
 * tested. Three things must be true of the output and none of them is the
 * default:
 *
 *   1. NO `additionalProperties`, anywhere. It is not a field on Gemini's
 *      Schema type at all, and sending it is the most likely cause of a 400
 *      from this adapter. zod emits it from every `.strict()` object — which
 *      packages/contracts uses deliberately — so it must be stripped.
 *   2. `propertyOrdering` on every object, giving stable field order. This is
 *      Google-specific and no JSON Schema emitter produces it.
 *   3. SCREAMING_CASE type names, and no `$schema`, `$ref`, or `$defs`.
 *
 * zod 4's `z.toJSONSchema(..., { target: 'openapi-3.0' })` gets us most of the
 * way but does none of the three: it still emits `additionalProperties`, never
 * emits `propertyOrdering`, and uses lowercase types. So this is a real
 * post-processing pass, not a config flag.
 */

/** The subset of OpenAPI 3.0 that Gemini's `responseSchema` accepts. */
export interface GeminiSchema {
  type: 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN' | 'ARRAY' | 'OBJECT';
  description?: string;
  nullable?: boolean;
  enum?: string[];
  format?: string;
  items?: GeminiSchema;
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, GeminiSchema>;
  required?: string[];
  propertyOrdering?: string[];
  minimum?: number;
  maximum?: number;
}

/** Intermediate shape: whatever zod's JSON Schema emitter produced. */
interface JsonSchemaNode {
  type?: string | string[];
  description?: string;
  enum?: unknown[];
  const?: unknown;
  items?: JsonSchemaNode | JsonSchemaNode[];
  minItems?: number;
  maxItems?: number;
  properties?: Record<string, JsonSchemaNode>;
  required?: string[];
  additionalProperties?: unknown;
  minimum?: number;
  maximum?: number;
  anyOf?: JsonSchemaNode[];
  oneOf?: JsonSchemaNode[];
  allOf?: JsonSchemaNode[];
  format?: string;
  $ref?: string;
  $defs?: Record<string, JsonSchemaNode>;
  definitions?: Record<string, JsonSchemaNode>;
  nullable?: boolean;
}

const TYPE_MAP: Record<string, GeminiSchema['type']> = {
  string: 'STRING',
  number: 'NUMBER',
  integer: 'INTEGER',
  boolean: 'BOOLEAN',
  array: 'ARRAY',
  object: 'OBJECT',
};

export interface ToGeminiSchemaOptions {
  /**
   * Gemini does not reliably enforce an enum on a numeric type, and numeric
   * bounds are not a server-side guarantee on any provider. Keeping them is
   * harmless documentation that the API may ignore; dropping them makes the
   * compiled schema smaller. Defaults to keeping them.
   */
  keepNumericBounds?: boolean;
}

/**
 * Compile a zod schema to Gemini's dialect.
 *
 * Uses `io: 'output'` because this schema constrains what the model produces,
 * not what we accept as input — the distinction matters for any schema with
 * defaults or transforms.
 */
export function toGeminiSchema(
  schema: z.ZodType,
  options: ToGeminiSchemaOptions = {},
): GeminiSchema {
  const jsonSchema = z.toJSONSchema(schema, {
    target: 'openapi-3.0',
    io: 'output',
    // Inline everything. Gemini's subset has no $ref support, so a shared
    // subschema referenced twice must appear twice.
    reused: 'inline',
  }) as JsonSchemaNode;

  return convert(jsonSchema, options, resolveDefs(jsonSchema), '$');
}

function resolveDefs(root: JsonSchemaNode): Record<string, JsonSchemaNode> {
  return { ...(root.definitions ?? {}), ...(root.$defs ?? {}) };
}

function convert(
  node: JsonSchemaNode,
  options: ToGeminiSchemaOptions,
  defs: Record<string, JsonSchemaNode>,
  path: string,
): GeminiSchema {
  const resolved = node.$ref ? deref(node.$ref, defs, path) : node;

  // A union is only expressible here if it collapses to an enum of literals or
  // to "T or null". Anything else has no representation in the subset, and
  // failing loudly beats emitting a schema the API will reject at request time.
  const union = resolved.anyOf ?? resolved.oneOf;
  if (union && union.length > 0) return convertUnion(union, resolved, options, defs, path);

  if (resolved.allOf && resolved.allOf.length > 0) {
    // Flatten a single-branch allOf, which zod emits for some wrappers.
    if (resolved.allOf.length === 1) {
      return convert({ ...resolved.allOf[0]!, ...stripCombinators(resolved) }, options, defs, path);
    }
    throw new Error(
      `toGeminiSchema: multi-branch allOf at ${path} has no OpenAPI-3.0-subset equivalent.`,
    );
  }

  const jsonType = Array.isArray(resolved.type)
    ? resolved.type.find((t) => t !== 'null')
    : resolved.type;

  // A bare enum with no type is a string enum in practice.
  const inferred = jsonType ?? (resolved.enum ? 'string' : undefined);
  if (!inferred) {
    throw new Error(`toGeminiSchema: cannot determine a type at ${path}.`);
  }

  const type = TYPE_MAP[inferred];
  if (!type) {
    throw new Error(`toGeminiSchema: JSON Schema type "${inferred}" at ${path} is not supported.`);
  }

  const out: GeminiSchema = { type };

  // Field order below is the golden-file's field order. Keep it stable.
  if (resolved.description !== undefined) out.description = resolved.description;
  if (Array.isArray(resolved.type) && resolved.type.includes('null')) out.nullable = true;
  else if (resolved.nullable === true) out.nullable = true;

  if (resolved.enum !== undefined) {
    // Gemini's `enum` is string-typed. Numeric enums are dropped rather than
    // coerced, because a coerced numeric enum silently changes the contract.
    if (type === 'STRING') out.enum = resolved.enum.map((v) => String(v));
  } else if (resolved.const !== undefined && type === 'STRING') {
    out.enum = [String(resolved.const)];
  }

  if (resolved.format !== undefined) out.format = resolved.format;

  if (type === 'ARRAY') {
    const items = Array.isArray(resolved.items) ? resolved.items[0] : resolved.items;
    if (!items) throw new Error(`toGeminiSchema: array at ${path} has no items schema.`);
    out.items = convert(items, options, defs, `${path}[]`);
    if (resolved.minItems !== undefined) out.minItems = resolved.minItems;
    if (resolved.maxItems !== undefined) out.maxItems = resolved.maxItems;
  }

  if (type === 'OBJECT') {
    const properties = resolved.properties ?? {};
    const keys = Object.keys(properties);
    out.properties = {};
    for (const key of keys) {
      out.properties[key] = convert(properties[key]!, options, defs, `${path}.${key}`);
    }
    if (resolved.required !== undefined && resolved.required.length > 0) {
      out.required = [...resolved.required];
    }
    // Google-specific, and the reason a generic emitter is not enough.
    out.propertyOrdering = keys;
    // `additionalProperties` is deliberately NOT copied. See the file header.
  }

  if ((options.keepNumericBounds ?? true) && (type === 'INTEGER' || type === 'NUMBER')) {
    if (resolved.minimum !== undefined) out.minimum = resolved.minimum;
    if (resolved.maximum !== undefined) out.maximum = resolved.maximum;
  }

  return out;
}

function convertUnion(
  branches: JsonSchemaNode[],
  parent: JsonSchemaNode,
  options: ToGeminiSchemaOptions,
  defs: Record<string, JsonSchemaNode>,
  path: string,
): GeminiSchema {
  const nonNull = branches.filter((b) => b.type !== 'null' && b.const !== null);
  const nullable = nonNull.length !== branches.length;

  // "T or null"
  if (nonNull.length === 1) {
    const inner = convert({ ...nonNull[0]!, ...stripCombinators(parent) }, options, defs, path);
    return nullable ? { ...inner, nullable: true } : inner;
  }

  // An enum expressed as a union of string literals.
  const consts = nonNull.map((b) => b.const).filter((c) => typeof c === 'string');
  if (consts.length === nonNull.length && consts.length > 0) {
    const out: GeminiSchema = { type: 'STRING' };
    if (parent.description !== undefined) out.description = parent.description;
    out.enum = consts as string[];
    if (nullable) out.nullable = true;
    return out;
  }

  throw new Error(
    `toGeminiSchema: union at ${path} with ${nonNull.length} non-null branches has no `
      + 'OpenAPI-3.0-subset equivalent. Narrow the contract or add an explicit transform.',
  );
}

function stripCombinators(node: JsonSchemaNode): Partial<JsonSchemaNode> {
  const { anyOf: _a, oneOf: _o, allOf: _l, $ref: _r, ...rest } = node;
  return rest;
}

function deref(ref: string, defs: Record<string, JsonSchemaNode>, path: string): JsonSchemaNode {
  const name = ref.split('/').pop();
  const target = name ? defs[name] : undefined;
  if (!target) {
    throw new Error(`toGeminiSchema: unresolved $ref "${ref}" at ${path}.`);
  }
  return target;
}

/**
 * Asserts the three invariants on a compiled schema. Cheap enough to run at
 * adapter construction, which turns a class of 400 into a startup failure.
 */
export function assertGeminiSchemaInvariants(schema: GeminiSchema, path = '$'): void {
  const record = schema as unknown as Record<string, unknown>;
  if ('additionalProperties' in record) {
    throw new Error(`Gemini schema invariant violated: additionalProperties present at ${path}.`);
  }
  for (const key of ['$schema', '$ref', '$defs', 'definitions']) {
    if (key in record) {
      throw new Error(`Gemini schema invariant violated: ${key} present at ${path}.`);
    }
  }
  if (schema.type === 'OBJECT') {
    if (!schema.propertyOrdering) {
      throw new Error(`Gemini schema invariant violated: missing propertyOrdering at ${path}.`);
    }
    const keys = Object.keys(schema.properties ?? {});
    if (schema.propertyOrdering.length !== keys.length) {
      throw new Error(
        `Gemini schema invariant violated: propertyOrdering at ${path} lists `
          + `${schema.propertyOrdering.length} keys but the object has ${keys.length}.`,
      );
    }
    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      assertGeminiSchemaInvariants(value, `${path}.${key}`);
    }
  }
  if (schema.type === 'ARRAY' && schema.items) {
    assertGeminiSchemaInvariants(schema.items, `${path}[]`);
  }
}
