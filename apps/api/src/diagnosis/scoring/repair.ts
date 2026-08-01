/**
 * JSON repair, bounded to a single attempt.
 *
 * With a native schema this path should be unreachable, so reaching it is
 * recorded as a degradation. The bound matters more than the cleverness: an
 * unbounded repair loop against a model that keeps returning prose is a way to
 * burn an entire day's quota on one brief.
 *
 * No decorators, no injection — plain functions on plain data.
 */

export type RepairStrategy =
  | 'direct'
  | 'fenced-block'
  | 'outermost-braces'
  | 'trailing-prose'
  | 'trailing-comma';

export interface RepairResult {
  value: unknown;
  /** Which strategy succeeded. 'direct' means no repair was needed. */
  strategy: RepairStrategy;
  repaired: boolean;
}

export interface RepairFailure {
  value: null;
  strategy: null;
  repaired: false;
  attempted: RepairStrategy[];
}

/**
 * Strategies are ordered cheapest-first and each is tried exactly once. There
 * is no recursion and no loop over strategies-of-strategies, which is what
 * guarantees termination regardless of input.
 */
export function repairJson(raw: string): RepairResult | RepairFailure {
  const attempted: RepairStrategy[] = [];

  const strategies: [RepairStrategy, (input: string) => string | null][] = [
    ['direct', (input) => input],
    // Models wrap JSON in a markdown fence far more often than anything else.
    ['fenced-block', (input) => input.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1] ?? null],
    // "Here is the report: { ... }" and "{ ... } Let me know if..."
    ['trailing-prose', (input) => {
      const start = input.indexOf('{');
      const end = input.lastIndexOf('}');
      return start !== -1 && end > start ? input.slice(start, end + 1) : null;
    }],
    ['outermost-braces', (input) => {
      const start = input.indexOf('{');
      if (start === -1) return null;
      // Brace matching that ignores braces inside strings, so a rationale
      // containing "{" cannot truncate the object.
      let depth = 0;
      let inString = false;
      let escaped = false;
      for (let i = start; i < input.length; i++) {
        const ch = input[i]!;
        if (escaped) { escaped = false; continue; }
        if (ch === '\\') { escaped = true; continue; }
        if (ch === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) return input.slice(start, i + 1);
        }
      }
      return null;
    }],
    ['trailing-comma', (input) => {
      const start = input.indexOf('{');
      const end = input.lastIndexOf('}');
      if (start === -1 || end <= start) return null;
      // Only commas immediately before a closing brace or bracket. A comma
      // inside a string is left alone.
      return stripTrailingCommas(input.slice(start, end + 1));
    }],
  ];

  for (const [strategy, extract] of strategies) {
    attempted.push(strategy);
    const candidate = extract(raw);
    if (candidate === null || candidate.trim() === '') continue;
    try {
      const value = JSON.parse(candidate);
      // A bare scalar or array is not a diagnosis; treat it as a failure of this
      // strategy rather than a success that fails validation confusingly later.
      // Arrays are typeof 'object', so they need excluding explicitly.
      if (value === null || typeof value !== 'object' || Array.isArray(value)) continue;
      return { value, strategy, repaired: strategy !== 'direct' };
    } catch {
      // Try the next strategy. Never retry this one.
    }
  }

  return { value: null, strategy: null, repaired: false, attempted };
}

export function isRepairFailure(
  result: RepairResult | RepairFailure,
): result is RepairFailure {
  return result.value === null;
}

function stripTrailingCommas(input: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (!inString && ch === ',') {
      // Look ahead past whitespace for a closer.
      let j = i + 1;
      while (j < input.length && /\s/.test(input[j]!)) j++;
      if (input[j] === '}' || input[j] === ']') continue; // drop the comma
    }
    out += ch;
  }
  return out;
}
