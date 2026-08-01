# Implementation Plan: Provider-agnostic AI configuration

**Branch**: `claude/creative-brief-doctor-nq6oj5` | **Date**: 2026-08-01 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/002-provider-agnostic-ai/spec.md`

## Summary

Make the active AI provider a runtime setting rather than a boot-time one.

The port, the adapter factory, the capability descriptor, the credential vault and
the audit interceptor all existed. What did not was a write path: `AppSetting` was
only ever written by a one-shot, environment-driven bootstrap that explicitly
refuses to overwrite. So once a row existed, nothing in a running process could
change the active provider — which made the abstraction unexercisable and
FR-002 impossible by construction.

The approach is therefore narrow: add the one missing service method and the two
HTTP handlers, and make the admin form read the capability descriptor those
handlers already produce, so the interface cannot offer a control the model would
reject.

## Technical Context

**Language/Version**: TypeScript 5.9, Node 22

**Primary Dependencies**: NestJS 11 (API), Next.js 16 (web), Prisma 7, Zod

**Storage**: PostgreSQL. `AppSetting` (singleton, enforced by a CHECK), `AiProvider`, `AdminAuditLog`

**Testing**: Vitest. Unit for pure logic; e2e against a real database with the provider port replaced by a conformance-tested fake

**Target Platform**: Linux server (API), Vercel (web)

**Project Type**: Web application — separate API and web app in a pnpm monorepo

**Performance Goals**: A configuration change visible to the next scoring call with no restart; configuration resolution off the hot path via a short-TTL cache invalidated on write

**Constraints**: No configuration state may produce a server error. Credentials never leave the server. A single administrator credential from the environment

**Scale/Scope**: One operator, a handful of providers, one active at a time

## Constitution Check

*GATE: passed before research, re-checked after design.*

| Principle | Verdict | How |
|---|---|---|
| I. The report is the product | **Pass** (not engaged) | Nothing in this feature touches the report or its framing. |
| II. Scores computed in code | **Pass** | Unaffected. FR-012 strengthens it: a diagnosis records the provider that actually ran, so a mid-flight swap cannot silently re-attribute a score. |
| III. Engine never names a model | **Pass** | The engine's signature is unchanged; it still receives `(provider, prompt, brief, params)`. The new code sits entirely above it, in resolution. |
| IV. Degraded, not down | **Pass, and this feature repairs a violation.** | `buildAdapter` was called outside the try/catch that degrades an unreadable credential, so an `ANTHROPIC` provider turned every caller of `resolve()` into a 500 — including the health check and the admin panel needed to fix it. Now caught, degrading with `PROVIDER_UNAVAILABLE`, and refused at save time so it cannot be reached by accident. |
| V. A gap is not a fault | **Pass** (not engaged) | No end-user-facing judgement in this feature. |

**Post-design re-check: still passing.** The design added no branch on provider
name outside `adapter.factory.ts`, and added no path that can return a server
error for a configuration state.

### Complexity Tracking

*Empty.* No principle required a violation, so nothing is recorded here.

## Project Structure

### Documentation (this feature)

```text
specs/002-provider-agnostic-ai/
├── spec.md
├── plan.md              # This file
├── research.md
├── data-model.md
├── quickstart.md
└── checklists/
    └── requirements.md
```

### Source Code (repository root)

```text
apps/api/src/
├── settings/
│   └── settings.service.ts          # + update(); buildAdapter moved inside try/catch
├── admin/
│   ├── settings.controller.ts       # NEW — GET/PATCH /v1/admin/model
│   └── providers.controller.ts      # existing CRUD, unchanged
├── ai/
│   ├── adapter.factory.ts           # the one place a kind becomes an adapter
│   ├── capability-gate.service.ts   # negotiate() for the engine, formControls() for the UI
│   ├── provider-registry.service.ts # + PROVIDER_UNAVAILABLE description
│   └── key-vault.service.ts         # unchanged
└── common/
    └── throttle-tiers.ts            # NEW — skip sets built, not hand-written

apps/web/
├── app/admin/
│   ├── model/page.tsx               # NEW — iterates the capability descriptor
│   ├── providers/page.tsx           # NEW — credential CRUD, no reveal control
│   ├── page.tsx                     # NEW — status
│   └── login/page.tsx               # NEW
├── app/api/admin/[...path]/route.ts # NEW — cookie in, bearer out
├── lib/admin-session.ts             # NEW — sealed session cookie
├── lib/admin-cookies.ts             # NEW — names only, edge-safe
└── middleware.ts                    # NEW — /admin gate

apps/api/test/
└── acceptance.e2e-spec.ts           # NEW — the acceptance criterion, executable
```

## Design decisions

**The capability descriptor is served, not duplicated.** `GET /v1/admin/model`
returns `controls` alongside the settings, and the form iterates it. Hard-coding
the field list in the client and filtering it would put the decision in two places
and the client's copy would drift. This is what makes FR-004 structural rather
than defensive: a parameter with no control has no value, so there is nothing to
submit.

**Validation targets the provider being switched TO.** Resolving the target from
`dto.activeProviderId ?? current` means the first save that changes provider is
checked against the incoming model's capabilities, not the outgoing one's.

**`undefined` and `null` mean different things.** `undefined` leaves a field alone;
`null` on the three nullable parameters clears it. Without that distinction a
partial save would blank every field it omitted (FR edge case), and there would be
no way to move to a model that rejects a parameter without leaving a stale value.

**Invalidate before returning.** `update()` clears the cache and re-resolves before
responding, so the panel shows the state that will actually govern the next
diagnosis. Returning first and invalidating after would make a correct save look
like it had been ignored.

**A failing model list does not block a save.** The provider's `listModels` is
allowed to fail; validation is skipped rather than the save refused. An operator
fixing a broken configuration needs the page to work precisely when the provider
is unhappy.

## Phases

- **Phase 0 — research**: [research.md](research.md). What already existed versus
  what was missing, and the throttler behaviour that governs the new endpoints.
- **Phase 1 — design**: [data-model.md](data-model.md) and
  [quickstart.md](quickstart.md).
- **Phase 2 — tasks**: not generated. The feature is implemented and verified; see
  [quickstart.md](quickstart.md) for how to reproduce the acceptance run.
