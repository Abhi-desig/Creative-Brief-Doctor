import { describe, it } from 'vitest';
import { GoogleAdapter } from '../adapters/google.adapter.js';
import { runConformanceSuite } from './suite.js';

/**
 * A8, live half: the identical unmodified suite, run against the real API.
 *
 * Gated on TWO things, deliberately. A key alone is not enough, because
 * GEMINI_API_KEY lives in the repo-root .env for the calibration harness, and a
 * key being present must not mean every `pnpm test` silently spends quota. The
 * free tier allows 20 generateContent calls per day per model, and this suite
 * makes roughly eight — so an accidental run costs close to half a day's
 * budget.
 *
 *   RUN_LIVE_AI_TESTS=1 GEMINI_API_KEY=... pnpm test
 */

const apiKey = process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY ?? '';
const optedIn = process.env.RUN_LIVE_AI_TESTS === '1';
const enabled = optedIn && apiKey.length > 0;
const model = process.env.GEMINI_TEST_MODEL ?? 'gemini-3.6-flash';

if (enabled) {
  runConformanceSuite({
    name: `GoogleAdapter (live, ${model})`,
    create: () => new GoogleAdapter({ apiKey }),
    createWithBadKey: () => new GoogleAdapter({ apiKey: 'AIzaNotARealKey0000000000000000000000000' }),
    model,
    live: true,
    timeoutMs: 180_000,
  });
} else {
  describe('conformance: GoogleAdapter (live)', () => {
    it.skip(
      `skipped — set RUN_LIVE_AI_TESTS=1 and GEMINI_API_KEY to run${
        optedIn && !apiKey ? ' (opted in, but no key found)' : ''
      }`,
      () => {
        /* intentionally empty */
      },
    );
  });
}
