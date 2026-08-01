/**
 * The four throttle tier names, and the skip sets built from them.
 *
 * This file exists because of a silent failure that cost us `/health`.
 *
 * `@SkipThrottle()` with no argument defaults to `{ default: true }` and writes
 * exactly one metadata key: `THROTTLER_SKIP + 'default'`. But the guard resolves
 * skips by iterating the tiers that are actually CONFIGURED and looking up
 * `THROTTLER_SKIP + <that tier's name>` (throttler.guard.js:67-68). None of our
 * tiers is named `default`, so a bare `@SkipThrottle()` matches nothing and every
 * tier still governs the route. On `/health` that meant the 5-per-15-minutes
 * adminLogin tier throttled a platform liveness probe.
 *
 * The same trap catches any PARTIAL skip set: listing three of four tiers leaves
 * the fourth silently active. So skips are never hand-written as object literals
 * anywhere in the app — they are built here from TIER_NAMES, which means adding a
 * fifth tier to app.module.ts and forgetting to update a controller is
 * impossible: `skipAllExcept` derives from the same list.
 */

/**
 * The tier definitions themselves — `ThrottlerModule.forRoot` consumes this, so
 * the names here ARE the configured names. Nothing to keep in sync.
 *
 * `ttl` is MILLISECONDS in throttler v5+, which is the easiest thing here to get
 * silently wrong: `3600` would be a 3.6-second window, not an hour.
 *
 * Separately from all of this, the daily call cap is a counter over
 * Diagnosis.createdAt in QuotaService — NOT a tier here — because it guards a
 * shared upstream quota rather than a per-client rate.
 */
export const TIERS = [
  /** Unauthenticated public scoring. Costs a real generation. */
  { name: 'diagnose', limit: 10, ttl: 60 * 60 * 1000 },
  /** Its own tier: brute-force protection is a different budget. */
  { name: 'adminLogin', limit: 5, ttl: 15 * 60 * 1000 },
  /** Looping a draft against a live model is real spend. */
  { name: 'promptTest', limit: 20, ttl: 60 * 60 * 1000 },
  /** Looser catch-all so nothing is unprotected by default. */
  { name: 'global', limit: 300, ttl: 60 * 1000 },
] as const;

export const TIER_NAMES = TIERS.map((t) => t.name) as readonly TierName[];

export type TierName = (typeof TIERS)[number]['name'];

export type SkipSet = Record<TierName, boolean>;

/**
 * Skip every tier. For routes that must never be rate limited at all — a
 * liveness probe is the whole reason this exists.
 */
export function skipAll(): SkipSet {
  return Object.fromEntries(TIER_NAMES.map((name) => [name, true])) as SkipSet;
}

/**
 * Skip every tier EXCEPT the ones named. Use this instead of a literal: it names
 * what governs the route, and every other tier is skipped explicitly rather than
 * by omission.
 *
 *   `@SkipThrottle(skipAllExcept('diagnose'))` — diagnose governs, nothing else.
 */
export function skipAllExcept(...keep: TierName[]): SkipSet {
  const kept = new Set<TierName>(keep);
  return Object.fromEntries(
    TIER_NAMES.map((name) => [name, !kept.has(name)]),
  ) as SkipSet;
}
