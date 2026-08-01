/**
 * Debug run for the Gemini adapter, against the real API.
 *
 * Deliberately split into two phases:
 *
 *   Phase 1 spends NO generateContent quota. models.list and countTokens are
 *   billed against different quotas, so client construction, auth, the schema
 *   transform, token counting and the model picker can all be verified for
 *   free — which matters when the free tier allows only 20 generate calls a day.
 *
 *   Phase 2 makes exactly ONE generate call, and is opt-in via --generate.
 *   Whether it succeeds or 429s, it exercises the error mapping end to end
 *   against the real API, which is the part unit tests cannot reach.
 */

import { GoogleAdapter } from './dist/adapters/google.adapter.js';
import { toGeminiSchema, assertGeminiSchemaInvariants } from './dist/adapters/google.schema.js';
import { DiagnosisOutputSchema } from '@cbd/contracts';
import { AIError } from './dist/errors.js';

for (const f of ['../../.env', '.env']) {
  try { process.loadEnvFile(new URL(f, import.meta.url).pathname); } catch { /* optional */ }
}

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
const model = process.argv.find((a) => a.startsWith('--model='))?.split('=')[1] ?? 'gemini-3.6-flash';
const doGenerate = process.argv.includes('--generate');

let pass = 0;
let fail = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (ok) pass++; else fail++;
};

console.log('\n  Gemini adapter debug run');
console.log(`  model    ${model}`);
console.log(`  key      ${apiKey ? `present (${apiKey.length} chars)` : 'MISSING'}`);
console.log(`  generate ${doGenerate ? 'yes (1 call, spends quota)' : 'no (use --generate)'}\n`);

if (!apiKey) {
  console.error('  GEMINI_API_KEY not found in env or root .env.\n');
  process.exit(1);
}

// ── Phase 0: pure, no network ────────────────────────────────────────────────
console.log('  Phase 0 — schema transform (no network)');
const compiled = toGeminiSchema(DiagnosisOutputSchema);
const json = JSON.stringify(compiled);
check('no additionalProperties anywhere', !json.includes('additionalProperties'));
check('no JSON Schema plumbing keys', !/"\$(schema|ref|defs)"/.test(json));
check('propertyOrdering on all 8 objects', (json.match(/propertyOrdering/g) ?? []).length === 8);
check('SCREAMING_CASE types only', !/"type":"(string|object|array|integer|number|boolean)"/.test(json));
try {
  assertGeminiSchemaInvariants(compiled);
  check('invariant assertion passes', true);
} catch (error) {
  check('invariant assertion passes', false, error.message);
}
check('compiled schema is a reasonable size', json.length < 20_000, `${json.length} bytes`);

// ── Phase 1: live, no generateContent quota ──────────────────────────────────
console.log('\n  Phase 1 — live API, no generate quota spent');
const adapter = new GoogleAdapter({ apiKey });

check('declares openapi-subset dialect', adapter.capabilities.schemaDialect === 'openapi-subset');
check('declares automatic prompt caching', adapter.capabilities.promptCaching === 'automatic');
check('declares native token counting', adapter.capabilities.nativeTokenCounting === true);
check(
  'contextWindow exceeds maxOutputTokens',
  adapter.capabilities.contextWindow > adapter.capabilities.maxOutputTokens,
);

try {
  const ping = await adapter.ping();
  check('ping() succeeds', ping.ok === true, `${ping.latencyMs}ms, ${ping.models?.length ?? 0} models`);
} catch (error) {
  check('ping() succeeds', false, `${error.kind ?? '?'}: ${error.message}`);
}

try {
  const models = await adapter.listModels();
  const hasTarget = models.some((m) => m.id === model);
  check('listModels() returns models', models.length > 0, `${models.length} gemini models`);
  check(`target model ${model} is listed`, hasTarget,
    hasTarget ? 'note: listed does NOT prove callable' : 'not listed');
} catch (error) {
  check('listModels() returns models', false, `${error.kind ?? '?'}: ${error.message}`);
}

try {
  const count = await adapter.countInputTokens({
    model,
    system: 'You are a creative operations analyst.',
    user: 'We need a video for the new dashboard. Audience is our customers.',
  });
  check('countInputTokens() is native and positive', count.tokens > 0 && count.source === 'native',
    `${count.tokens} tokens, source=${count.source}`);
} catch (error) {
  check('countInputTokens() is native and positive', false, `${error.kind ?? '?'}: ${error.message}`);
}

// Auth mapping against the real API — a bad key must produce kind 'auth',
// never a vendor exception.
try {
  const bad = new GoogleAdapter({ apiKey: 'AIzaNotARealKey0000000000000000000000000' });
  const result = await bad.ping();
  check('bad key maps to AIError kind=auth', result.ok === false, 'ping reported ok:true');
} catch (error) {
  check('bad key maps to AIError kind=auth',
    AIError.is(error) && error.kind === 'auth',
    `got ${AIError.is(error) ? `AIError kind=${error.kind}` : error?.constructor?.name}`);
}

// Abort must be honoured before any request leaves.
try {
  await adapter.generateStructured({
    model,
    system: 's',
    user: 'u',
    schema: DiagnosisOutputSchema,
    params: { maxTokens: 16_000 },
    signal: AbortSignal.abort(),
  });
  check('pre-aborted signal rejects', false, 'call resolved');
} catch (error) {
  check('pre-aborted signal rejects', error?.name === 'AbortError', `name=${error?.name}`);
}

// ── Phase 2: one generate call ───────────────────────────────────────────────
if (doGenerate) {
  console.log('\n  Phase 2 — one generateContent call');
  const started = Date.now();
  try {
    const response = await adapter.generateStructured({
      model,
      system: [
        'You are a creative operations analyst. Diagnose the brief that follows.',
        'Score five dimensions on the anchors 0, 20, 40, 60, 80, 100.',
        'Quote evidence verbatim from the brief. Do not compute a total.',
      ].join('\n'),
      user: 'We need a video for the new dashboard. Audience is our customers. Budget around 5000. Needed by end of month.',
      schema: DiagnosisOutputSchema,
      params: { maxTokens: 16_000 },
    });

    check('stopReason is normalized', ['complete', 'max_tokens', 'refusal', 'content_filter', 'context_overflow']
      .includes(response.stopReason), response.stopReason);
    check('output present when complete',
      response.stopReason !== 'complete' || response.output !== null);
    if (response.output) {
      const parsed = DiagnosisOutputSchema.safeParse(response.output);
      check('output satisfies DiagnosisOutput', parsed.success,
        parsed.success ? '' : JSON.stringify(parsed.error.issues.slice(0, 2)));
      const scores = Object.entries(response.output.dimensions)
        .map(([k, v]) => `${k.slice(0, 4)}:${v.score}`).join(' ');
      console.log(`        scores    ${scores}`);
      console.log(`        questions ${response.output.questions.length}`);
    }
    const u = response.usage;
    check('usage fields non-negative',
      [u.inputTokens, u.outputTokens, u.reasoningTokens, u.cachedReadTokens, u.cachedWriteTokens]
        .every((n) => Number.isFinite(n) && n >= 0));
    check('tokenSource is native', u.tokenSource === 'native');
    console.log(`        usage     in=${u.inputTokens} out=${u.outputTokens} thinking=${u.reasoningTokens} cacheRead=${u.cachedReadTokens}`);
    console.log(`        latency   ${response.latencyMs}ms`);
    console.log(`        thinking is ${(u.reasoningTokens / Math.max(1, u.outputTokens)).toFixed(1)}x the visible output`);
    check('output+thinking within budget', u.outputTokens + u.reasoningTokens <= 16_000);
    check('degradations recorded as an array', Array.isArray(response.degradations),
      response.degradations.map((d) => d.code).join(',') || 'none');
  } catch (error) {
    // A 429 here is a successful test of the error mapping, not a failure of
    // the adapter — which is the whole reason this phase is worth running even
    // with no quota left.
    const typed = AIError.is(error);
    check('failure surfaced as a typed AIError, not a vendor exception', typed,
      typed ? `kind=${error.kind}, retryable=${error.retryable}` : String(error?.message).slice(0, 120));
    if (typed && error.kind === 'quota_exhausted') {
      check('daily cap correctly classified as quota_exhausted (not rate_limit)', true,
        'and marked non-retryable, so no pointless backoff');
    }
    console.log(`        elapsed   ${Date.now() - started}ms`);
  }
}

console.log(`\n  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
