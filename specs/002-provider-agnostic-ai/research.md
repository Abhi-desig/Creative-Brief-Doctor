# Phase 0 — Research

**Feature**: Provider-agnostic AI configuration | **Date**: 2026-08-01

The unusual thing about this feature is how little of it needed building. The
research was mostly establishing what already existed and why it was unreachable.

## What already existed

| Piece | State | Read by |
|---|---|---|
| `AIProvider` port + conformance suite | Complete | Every adapter |
| `AiProvider` table, encrypted credentials | Complete, with CRUD | `/v1/admin/providers` |
| `AppSetting` singleton + CHECK constraint | Migrated | `SettingsService.resolve()` |
| `CapabilityGate.formControls()` | Written | **Nothing** |
| `listModels()` on the port | Documented "for the admin model picker" | **Nothing** |
| Audit interceptor's `model`/`setting` → `AppSetting` mapping | Written | **Nothing — unreachable branch** |
| `promptTest` throttle tier | Configured | Every admin route except the one it was named for |

The pattern is consistent: the design anticipated this feature correctly and
stopped one layer short. `formControls`, `listModels` and the audit mapping were
all written for endpoints that were never added, so they sat as dead code that
looked like working code.

## The blocking discovery

`SettingsService` exposed `resolve()`, `invalidate()` and
`verifyActivePromptHash()`. The only `AppSetting` mutation anywhere in the codebase
was inside `maybeBootstrap()`, which is:

- environment-driven (`AI_BOOTSTRAP_*`),
- guarded by `if (this.bootstrapAttempted) return`, so once per process,
- and guarded by `if (existing?.activeProviderId) return`, so it refuses to
  overwrite.

Therefore once any configuration existed, no code path could change it. The
acceptance criterion was not merely unimplemented — it was impossible.

## Throttler behaviour, verified against source

The new endpoints needed a throttle decision, and reading
`@nestjs/throttler@6.5.0` to make it surfaced a live defect worth recording.

`SkipThrottle` defaults to `{ default: true }` and writes one metadata key,
`THROTTLER_SKIP + 'default'` (`throttler.decorator.js:27`). The guard resolves
skips by iterating the tiers that are actually CONFIGURED and looking up
`THROTTLER_SKIP + <that tier's name>` (`throttler.guard.js:67-68`). Our tiers are
`diagnose`, `adminLogin`, `promptTest`, `global` — none named `default`.

**A bare `@SkipThrottle()` therefore matches nothing.** `/health` carried one and
was governed by all four tiers; the tightest (`adminLogin`, 5 per 15 minutes)
429'd the sixth probe from a platform health checker and stayed 429 for the
window.

The same trap applies to any partial skip set: listing three tiers leaves the
fourth silently active. That is why skip sets are now derived from the tier list
rather than written as literals.

`Reflector.getAllAndOverride` returns the first non-`undefined` value in
`[handler, classRef]` order (`reflector.service.js:90-98`), which is what makes a
handler-level `{ adminLogin: false }` able to re-enable a tier the class skipped.
Verified before relying on it, because brute-force protection on `login` depends
on it.

## Decisions

**Decision: serve the capability descriptor rather than duplicate it.**
*Alternatives considered:* hard-code the field list in the admin form and filter
it client-side.
*Rejected because:* the decision would live in two places and the client's copy is
the one that drifts. Serving it also means `formControls()` — already written, and
already used by the admin status endpoint — becomes the single source.

**Decision: never render an unsupported control.**
*Alternatives considered:* render and disable, with a tooltip explaining why.
*Rejected because:* "disabled" is a presentational state that a re-render, a
copied component or a stale prop can lose, at which point the form submits a value
the model rejects. An absent control has no value to submit. It also stops an
operator asking why a knob is greyed out.

**Decision: validate against the provider being switched to.**
*Alternatives considered:* validate against the currently active provider.
*Rejected because:* the first save that changes provider is exactly the case that
matters, and it would be checked against the wrong capabilities.

**Decision: keep `null` distinct from `undefined`.**
*Alternatives considered:* treat empty as "leave alone" uniformly.
*Rejected because:* moving to a model that rejects `temperature` requires clearing
the column, and without the distinction the stale value would persist invisibly —
present in the database, absent from the form, dropped by the adapter.

**Decision: refuse activation of an unbuildable provider.**
*Alternatives considered:* allow it and let the degraded path handle it.
*Rejected because:* the degraded path is a safety net for states arrived at by
accident, not a place to route a deliberate action. Activating one would take
scoring down and leave the operator to work out why from a health endpoint.

## Open questions

None. Everything the description left ambiguous had a defensible default drawn
from the constitution; those are recorded under Assumptions in the spec rather
than deferred.
