/**
 * Redaction. Deliberately a pure function with its own test, because redaction
 * is a test, not a promise.
 *
 * Two independent strategies, because either alone has a hole:
 *
 *   By KEY — anything whose property name looks secret is replaced wholesale.
 *     Catches `apiKey`, `authorization`, `password` regardless of value shape.
 *     Misses a secret that arrives under an innocent name.
 *
 *   By VALUE SHAPE — strings that look like credentials are masked wherever
 *     they appear, including inside free text and inside error messages.
 *     Catches a key pasted into a `label` field or echoed by a vendor error.
 *
 * Both run. A secret has to evade both to leak.
 */

const SECRET_KEY_PATTERN =
  /^(api[-_]?key|key|secret|password|passwd|pwd|token|authorization|auth|cookie|session|credential|bearer|private[-_]?key|master[-_]?encryption[-_]?key|session[-_]?secret|keyciphertext|keyiv|keytag)$/i;

/**
 * Value shapes worth masking on sight. Kept narrow enough not to mangle
 * ordinary prose: each pattern requires a recognisable prefix or a long
 * high-entropy run.
 */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google API keys
  /sk-ant-[0-9A-Za-z_-]{20,}/g, // Anthropic
  /sk-[0-9A-Za-z]{32,}/g, // OpenAI-style
  /gh[pousr]_[0-9A-Za-z]{20,}/g, // GitHub
  /eyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}/g, // JWT
  /\bBearer\s+[0-9A-Za-z._~+/-]{16,}=*/gi,
  /\$argon2(?:id|i|d)\$[^\s"']+/g, // password hashes
  /postgres(?:ql)?:\/\/[^\s"']*:[^\s"'@]+@[^\s"']+/gi, // URLs with a password
];

export const REDACTED = '[REDACTED]';

/** Masks credential-shaped substrings anywhere in a string. */
export function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}

/**
 * Deep-redacts a value for logging or for an audit row.
 *
 * Cycle-safe, depth-bounded, and never throws — a redactor that throws inside a
 * logger takes down the request it was trying to record.
 */
export function redact(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 12) return '[TRUNCATED]';

  if (typeof value === 'string') return redactString(value);
  if (value === null || value === undefined) return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return value;
  }
  if (typeof value === 'function' || typeof value === 'symbol') return '[OMITTED]';

  // Raw bytes are how ciphertext, IVs and tags arrive from Prisma. Never
  // serialise them.
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return `[BYTES:${value.length}]`;
  }
  if (value instanceof Date) return value.toISOString();

  if (value instanceof Error) {
    return {
      name: value.name,
      // Vendor errors frequently echo the request, including the key.
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }

  if (typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.slice(0, 200).map((item) => redact(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redact(item, depth + 1, seen);
    }
    return out;
  }

  return String(value);
}

/**
 * Fields that must never be selected from AiProvider into any response.
 *
 * Used as a Prisma `select`, so "write-only" is enforced by the query rather
 * than by remembering to delete fields afterwards. There is no code path that
 * could serve a key because no query asks for one.
 */
export const PROVIDER_PUBLIC_SELECT = {
  id: true,
  kind: true,
  label: true,
  baseUrl: true,
  keyLast4: true,
  keyVersion: true,
  status: true,
  lastPingAt: true,
  lastPingMs: true,
  createdAt: true,
  updatedAt: true,
} as const;
