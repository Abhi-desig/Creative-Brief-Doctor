/**
 * Throwaway Gemini call for the Step 0 spike.
 *
 * Deliberately NOT the AIProvider port. This is one direct SDK call behind a
 * normalised return shape, written to surface the hazards the real port has to
 * handle. Every normalisation decision is commented, because those comments are
 * the input to packages/ai.
 */

import { GoogleGenAI } from '@google/genai';
import { toGeminiSchema, DIAGNOSIS_SHAPE } from './schema.mjs';

export const GEMINI_SCHEMA = toGeminiSchema(DIAGNOSIS_SHAPE);

/**
 * Common return shape. A rough sketch of StructuredResponse<T>.
 *
 * @typedef {{
 *   output: object|null,
 *   raw: string,
 *   stopReason: 'complete'|'max_tokens'|'refusal'|'content_filter',
 *   usage: { inputTokens:number, outputTokens:number, reasoningTokens:number,
 *            cachedReadTokens:number, cachedWriteTokens:number, tokenSource:'native'|'estimated' },
 *   latencyMs: number,
 *   providerRequestId: string|null,
 *   degradations: string[],
 * }} Result
 */

// ── Google Gemini ────────────────────────────────────────────────────────────

export function makeGemini({ apiKey, model = 'gemini-2.5-flash', maxTokens = 16000,
                             thinkingBudget, temperature }) {
  const ai = new GoogleGenAI({ apiKey });

  return {
    id: 'google',
    model,
    async countInputTokens({ system, user }) {
      // The Developer API (AI Studio keys) rejects `systemInstruction` on
      // countTokens — it is Vertex/Enterprise only. To count the same bytes we
      // actually send, fold the system text into contents. The role framing
      // differs slightly from the generate call, so treat this as native but
      // approximate at the margin, and keep the admission gate's ceiling below
      // the hard limit rather than exactly at it.
      const res = await ai.models.countTokens({
        model,
        contents: [{ role: 'user', parts: [{ text: system }, { text: user }] }],
      });
      return { tokens: res.totalTokens ?? 0, source: 'native' };
    },
    /** @returns {Promise<Result>} */
    async score({ system, user, signal }) {
      const degradations = [];
      const config = {
        systemInstruction: system,
        responseMimeType: 'application/json',
        responseSchema: GEMINI_SCHEMA,
        maxOutputTokens: maxTokens,
        abortSignal: signal,
      };
      // Thinking is ON by default on 2.5 models and consumes maxOutputTokens
      // alongside the JSON. Left unset it is AUTOMATIC. 0 disables it on Flash.
      // Either set it explicitly or size maxTokens well above the JSON, or you
      // get max_tokens with an unparseable tail.
      if (thinkingBudget !== undefined) config.thinkingConfig = { thinkingBudget };
      if (temperature !== undefined) config.temperature = temperature;

      const startedAt = Date.now();
      const res = await ai.models.generateContent({
        model,
        contents: [{ role: 'user', parts: [{ text: user }] }],
        config,
      });
      const latencyMs = Date.now() - startedAt;

      const um = res.usageMetadata ?? {};
      const usage = {
        inputTokens: um.promptTokenCount ?? 0,
        outputTokens: um.candidatesTokenCount ?? 0,
        // Gemini reports thoughts SEPARATELY from candidates, so thinking
        // tokens are NOT included in outputTokens here. Anthropic folds them
        // in. NormalizedUsage has to pick one convention and state it.
        reasoningTokens: um.thoughtsTokenCount ?? 0,
        // Gemini caching is implicit and undependable. Report what usage
        // returns; never assert a cache hit against this provider, it flakes.
        cachedReadTokens: um.cachedContentTokenCount ?? 0,
        cachedWriteTokens: 0,
        tokenSource: 'native',
      };

      // finishReason: SAFETY and promptFeedback.blockReason both normalise onto
      // the same two terminal cases the engine handles.
      const blockReason = res.promptFeedback?.blockReason;
      const finishReason = res.candidates?.[0]?.finishReason;
      const stopReason = normaliseGeminiStop(finishReason, blockReason);

      const raw = res.text ?? '';
      return {
        output: stopReason === 'complete' ? parseOrNull(raw, degradations) : null,
        raw,
        stopReason,
        usage,
        latencyMs,
        providerRequestId: res.responseId ?? null,
        degradations,
        finishReason: finishReason ?? null,
      };
    },
  };
}

function normaliseGeminiStop(finishReason, blockReason) {
  if (blockReason) return 'content_filter';
  switch (finishReason) {
    case 'STOP':
      return 'complete';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'SAFETY':
    case 'IMAGE_SAFETY':
      return 'refusal';
    case 'PROHIBITED_CONTENT':
    case 'BLOCKLIST':
    case 'SPII':
    case 'RECITATION':
      return 'content_filter';
    default:
      return finishReason ? 'content_filter' : 'complete';
  }
}

// ── mock, for verifying the harness without spending quota ───────────────────

/**
 * Deterministic fake scorer. Derives scores from a hash of the brief text plus
 * an optional bias and jitter, so `--mock` exercises the full pipeline —
 * validation, CSV, statistics, report — with no network and no key.
 */
export function makeMock({ key = 'gemini', bias = 0, jitter = 0, model = `mock-${key}` }) {
  return {
    id: key,
    model,
    async countInputTokens({ system, user }) {
      return { tokens: Math.ceil((system.length + user.length) / 4), source: 'estimated' };
    },
    async score({ system, user }) {
      const dimensions = {};
      const DIMS = ['OBJECTIVE_CLARITY', 'AUDIENCE_SPECIFICITY', 'MESSAGE_SUBSTANCE',
        'CONSTRAINTS', 'SUCCESS_METRICS'];
      // First sentence of the brief, so the quote really is verbatim.
      const quote = (user.match(/[^.\n]{10,120}[.\n]/)?.[0] ?? user.slice(0, 80)).trim();
      DIMS.forEach((d) => {
        const h = hash(`${user}|${d}`);
        const base = ANCHORS_LOCAL[h % ANCHORS_LOCAL.length];
        const noise = jitter ? (hash(`${user}|${d}|${key}|${Math.random()}`) % (2 * jitter + 1)) - jitter : 0;
        const raw = base + bias + noise;
        const snapped = ANCHORS_LOCAL.reduce((a, b) => (Math.abs(b - raw) < Math.abs(a - raw) ? b : a));
        dimensions[d] = {
          score: snapped,
          rationale: `Mock rationale for ${d}.`,
          gaps: snapped === 100 ? [] : [`mock gap for ${d.toLowerCase()}`],
          evidence: snapped > 0 ? [quote] : [],
        };
      });
      const output = {
        summary: 'Mock summary. No overall score stated.',
        dimensions,
        questions: [1, 2, 3].map((rank) => ({
          dimension: DIMS[rank - 1], question: `Mock question ${rank}?`,
          blocking: rank === 1, rank,
        })),
      };
      await new Promise((r) => setTimeout(r, 5));
      return {
        output, raw: JSON.stringify(output), stopReason: 'complete',
        usage: {
          inputTokens: Math.ceil(system.length / 4), outputTokens: 400,
          reasoningTokens: 120, cachedReadTokens: 0, cachedWriteTokens: 0,
          tokenSource: 'estimated',
        },
        latencyMs: 5, providerRequestId: `mock_${hash(user).toString(16)}`, degradations: [],
      };
    },
  };
}

const ANCHORS_LOCAL = [0, 20, 40, 60, 80, 100];

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < String(s).length; i++) { h ^= String(s).charCodeAt(i); h = Math.imul(h, 16777619); }
  return Math.abs(h);
}

// ── shared ───────────────────────────────────────────────────────────────────

function parseOrNull(raw, degradations) {
  try {
    return JSON.parse(raw);
  } catch {
    // Minimal repair: strip a fenced block, then take the outermost braces.
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    const candidate = fenced ? fenced[1] : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
    try {
      const parsed = JSON.parse(candidate);
      degradations.push('json_repair');
      return parsed;
    } catch {
      degradations.push('json_unparseable');
      return null;
    }
  }
}
