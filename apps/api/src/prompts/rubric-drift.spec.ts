import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIMENSION_ANCHORS, DIMENSIONS, SCORE_ANCHORS } from '@cbd/contracts';

/**
 * Keeps the UI's copy of the anchor ladder honest against the prompt itself.
 *
 * `packages/contracts/src/rubric.ts` holds the 30 anchors as display data so that
 * no component has to read `rubric-v1.md` — that file's SHA-256 is the active
 * prompt's identity, and coupling a React component to it would invite someone to
 * reflow a line for the UI and silently fork the prompt that governs every public
 * diagnosis.
 *
 * The cost of that decision is two copies of the same prose, and this is what
 * makes the cost safe. It lives in apps/api rather than packages/contracts on
 * purpose: contracts must not depend on the API's seed directory, and this
 * assertion is about the relationship BETWEEN the two, so it belongs with the
 * side that already owns the rubric file.
 *
 * Both directions fail loudly:
 *   - reword the rubric and forget the display data -> the anchor is not found;
 *   - reword the display data and leave the rubric  -> the anchor is not found.
 */

/**
 * Resolved from the working directory rather than `import.meta.url`: this package
 * compiles to CommonJS for Nest, where `import.meta` is a syntax error, so the
 * typecheck rejects it even though vitest itself would run it happily.
 *
 * Vitest's root is `apps/api` (its config lives there), which is the first
 * candidate. The second covers a run launched from the monorepo root.
 */
function locateRubric(): string {
  const candidates = [
    resolve(process.cwd(), 'prisma/seed/rubric-v1.md'),
    resolve(process.cwd(), 'apps/api/prisma/seed/rubric-v1.md'),
  ];
  const found = candidates.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `Could not find rubric-v1.md. Looked in:\n  ${candidates.join('\n  ')}`,
    );
  }
  return found;
}

const RUBRIC = readFileSync(locateRubric(), 'utf8');

/**
 * The rubric's own anchor lines, parsed into `DIMENSION/score -> text`.
 *
 * Parsed and compared for EXACT EQUALITY rather than checked with
 * `expect(RUBRIC).toContain(text)`. Substring matching looks like it works and
 * quietly does not: the rubric's "No audience is named at all." contains the
 * string "No audience is named at all", so deleting the full stop from the
 * display copy passes a `toContain` assertion. Every truncation is a substring of
 * the original, which is the most likely way for this data to drift.
 *
 * Parsing the rubric here is not the coupling the display data exists to avoid —
 * that rule is about no COMPONENT reading this file at runtime. A test asserting
 * the two agree has to read both by definition.
 */
function parseRubricAnchors(): Map<string, string> {
  const found = new Map<string, string>();
  let dimension: string | null = null;

  for (const line of RUBRIC.split('\n')) {
    const heading = /^### ([A-Z_]+) — /.exec(line);
    if (heading) {
      dimension = heading[1]!;
      continue;
    }
    // A `---` rule ends the dimension section, so later bullet lists (Evidence,
    // Gaps) cannot be mistaken for anchors.
    if (line.startsWith('---')) dimension = null;
    if (!dimension) continue;

    const anchor = /^- \*\*(\d+)\*\* — (.+)$/.exec(line);
    if (anchor) found.set(`${dimension}/${anchor[1]}`, anchor[2]!);
  }
  return found;
}

const RUBRIC_ANCHORS = parseRubricAnchors();

describe('rubric display data vs rubric-v1.md', () => {
  it('reads and parses the rubric file it is asserting against', () => {
    // Guards the guard: a wrong path or a broken parser would make every
    // assertion below vacuous, and the whole suite would be worthless.
    expect(RUBRIC.length).toBeGreaterThan(2_000);
    expect(RUBRIC).toContain('## The five dimensions');
    expect(RUBRIC_ANCHORS.size).toBe(30);
  });

  it.each(DIMENSION_ANCHORS)(
    '$dimension — all six anchors match the rubric exactly',
    ({ dimension, anchors, subtitle }) => {
      expect(RUBRIC).toContain(`### ${dimension} — ${subtitle}`);

      for (const anchor of anchors) {
        // Exact equality, not substring: see parseRubricAnchors. A missing full
        // stop, a straightened quote or a reflowed clause all fail here.
        expect(
          RUBRIC_ANCHORS.get(`${dimension}/${anchor.score}`),
          `${dimension} anchor ${anchor.score} differs from rubric-v1.md`,
        ).toBe(anchor.text);
      }
    },
  );

  it('covers every dimension exactly once, in the canonical order', () => {
    expect(DIMENSION_ANCHORS.map((d) => d.dimension)).toEqual([...DIMENSIONS]);
  });

  it('uses exactly the six permitted scores for every dimension', () => {
    for (const { dimension, anchors } of DIMENSION_ANCHORS) {
      expect(anchors.map((a) => a.score), dimension).toEqual([...SCORE_ANCHORS]);
    }
  });

  it('has no anchor the rubric no longer contains, and misses none it has', () => {
    // Both directions in one comparison: a key present here but not there is an
    // anchor left behind after a rubric edit; a key there but not here is a new
    // anchor the UI would silently omit.
    const displayed = new Map(
      DIMENSION_ANCHORS.flatMap(({ dimension, anchors }) =>
        anchors.map((a) => [`${dimension}/${a.score}`, a.text] as const),
      ),
    );
    expect(Object.fromEntries([...displayed].sort()))
      .toEqual(Object.fromEntries([...RUBRIC_ANCHORS].sort()));
  });

  it('preserves the emphasis markers rather than tidying them away', () => {
    // The one anchor with inline emphasis. If someone "cleans up" the asterisks
    // for display, the string stops matching the rubric — this names the reason
    // so the next reader does not treat it as a typo.
    const bounded = DIMENSION_ANCHORS
      .find((d) => d.dimension === 'OBJECTIVE_CLARITY')!
      .anchors.find((a) => a.score === 100)!;
    expect(bounded.text).toContain('*not*');
    expect(RUBRIC_ANCHORS.get('OBJECTIVE_CLARITY/100')).toBe(bounded.text);
  });
});
