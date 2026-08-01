# Creative Brief Doctor Constitution

The five principles every feature is checked against. A design that fails one of
these does not proceed until either the design changes or the violation is
recorded, with a reason, under `## Complexity Tracking` in that feature's plan.

## Core Principles

### I. The report is the product

The deliverable is a URL someone forwards to a colleague. Everything else —
the paste box, the admin panel, the scoring engine — is scaffolding around
producing that artefact. When a decision trades off against the report's
forwardability or its neutrality, the report wins.

Concretely: the report page carries no app frame, no navigation and no
account-shaped affordance. A stakeholder who opens a forwarded link and sees a
product they cannot enter reacts to the tool instead of the brief.

### II. Scores are computed in code, never read from the model

The model emits five dimension scores and nothing else numeric. It is explicitly
forbidden from producing a total, a percentage, a grade or a verdict — any it
produced would be discarded. The overall is the mean of the five, derived
afterwards, so the number cannot be talked up or down in the same pass that
assigns the dimensions.

Any feature that would let a model's own summary imply an overall judgement
violates this.

### III. The engine never names a model (NON-NEGOTIABLE)

Provider, model and parameters are resolved outside the engine and handed in.
`packages/ai` is the only place a vendor SDK is imported; everything downstream
sees the port, the capability descriptor and the error taxonomy.

Adding a provider is one enum value, one adapter file, one case in the factory,
and a conformance run. If a change requires branching on provider name anywhere
else, the abstraction is wrong and the change is the symptom.

### IV. Degraded, not down

Nothing configured is a VALID STATE that must render, respond, and be fixable
through the panel. A fresh deployment waiting for an admin is working correctly,
and reporting it as down causes a restart loop that restarting cannot fix.

This extends to every dependency: an unreadable credential, a provider with no
adapter, an unreachable model list. Each degrades with a specific reason and
leaves the admin panel reachable. No configuration failure may produce a 500.

### V. A gap is not a fault

The rubric diagnoses the document, never the person who wrote it. A brief with
gaps is a normal early-stage brief. Nothing in the interface may code a low score
as an error — no red, no warning iconography, no severity language — because most
briefs are written by someone who knows things they have not yet had reason to
write down.

The follow-up questions are phrased to be forwarded as they are, between
colleagues who both want the work to go well.

## Additional Constraints

**Quota is shared, and spending it is always visible.** The daily cap guards an
upstream allowance every user draws from, so anything that spends a model call —
including an admin prompt test — counts against it and says so.

**Credentials are write-only over HTTP.** No endpoint returns a provider key, and
that is enforced by reads selecting columns that do not contain one, rather than
by a convention that they should not.

**The rubric file is the prompt, byte for byte.** Its SHA-256 is the active
version's identity. Nothing may parse, reformat or interpolate it. Display copies
are held elsewhere and pinned by a drift test.

## Development Workflow

- Every blocker fixed gets a regression test that fails against the old
  behaviour. A test that passes both before and after does not count.
- Timing and ordering bugs are asserted with timestamps, never with `toContain`
  over a buffered result.
- `pnpm build && pnpm typecheck && pnpm test` plus the API e2e suite must be
  green before a change is considered done.

## Governance

This constitution supersedes other practice. The Constitution Check runs before
research and again after design; anything still failing goes in
`## Complexity Tracking` with the reason it is worth the cost.

**Version**: 1.0.0 | **Ratified**: 2026-08-01 | **Last Amended**: 2026-08-01
