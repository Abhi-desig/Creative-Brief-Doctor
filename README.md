# Creative Brief Doctor

Paste a creative brief, get a score across five dimensions, the specific gaps, and
a list of follow-up questions phrased so you can forward them without anyone
feeling got at.

The output is a shareable URL. That artefact is the product — the report is a
working document between colleagues, and everything else exists to produce it.

---

## Quick start

```bash
pnpm install
cp .env.example .env          # fill in DATABASE_URL, MASTER_ENCRYPTION_KEY, admin creds
pnpm --filter @cbd/api prisma:deploy
pnpm --filter @cbd/api seed
pnpm dev
```

The API listens on **3000**, the web app on **3001**. They must not share a port —
`API_BASE_URL` pointing at the web app makes it proxy to itself, and every call
404s in a way that reads like "that brief does not exist". There is a guard that
turns that into a loud, specific error instead.

**No AI provider key is required to boot.** A fresh deployment comes up
healthy-but-degraded and reports `NO_ACTIVE_PROVIDER` until an admin configures
one at `/admin/providers`. That is deliberate: a first deploy waiting for a human
is working correctly, and reporting it as down causes a restart loop that
restarting cannot fix.

### Required environment

| Variable | Why |
|---|---|
| `DATABASE_URL` | Pooled. Runtime queries. |
| `DIRECT_URL` | Unpooled. Migrations hold advisory locks and issue DDL, neither of which survives a transaction-mode pooler. |
| `MASTER_ENCRYPTION_KEY` | 32 bytes, base64. Encrypts provider API keys at rest. **Losing it means re-entering every provider key.** |
| `SESSION_SECRET` | Signs the API's bearer tokens and encrypts the admin session cookie. |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH` | The single admin credential. Hash with `pnpm --filter @cbd/api hash-password`. |
| `CORS_ORIGIN` | The web origin, exactly. |
| `API_BASE_URL` | Server-only, read by the web app. Never exposed to the browser. |

`AI_BOOTSTRAP_*` are optional and exist for CI and fresh databases. Entering the
key through the admin panel makes them unnecessary.

---

## Layout

```
apps/api        NestJS. Scoring engine, admin API, provider abstraction.
apps/web        Next.js. Public tool, shareable report, admin panel.
packages/ai     The provider port, adapters, and the conformance suite.
packages/contracts  Scoring maths and the rubric's display data. Shared by both apps.
tools/calibration   Standalone harness for scoring a corpus and comparing runs.
```

## Commands

```bash
pnpm dev                            # both apps
pnpm build && pnpm typecheck && pnpm test
pnpm --filter @cbd/api test:e2e     # needs TEST_DATABASE_URL
pnpm --filter @cbd/api seed         # rubric + price rows, idempotent
pnpm --filter @cbd/api seed:examples # scores the /examples gallery — spends real model calls
```

`seed:examples` runs sample briefs through the real pipeline and backdates them so
they do not consume the deploy day's quota. It is deliberately separate from
`seed`, because it costs money and quota.

---

## Things worth knowing before you change something

**The rubric file is the prompt, byte for byte.** `apps/api/prisma/seed/rubric-v1.md`
is hashed with SHA-256, the hash is stored on the version row, and a boot check
compares them. A database trigger forbids mutating an active version's content.
Reformatting a line in that file forks the prompt that governs every diagnosis.
The UI never reads it — `packages/contracts/src/rubric.ts` holds a transcription,
and a drift test asserts the two are byte-identical in both directions.

**Scores are computed in code, never read from the model.** The prompt explicitly
forbids producing a total, a percentage, a grade or a verdict. The overall is the
mean of five dimension scores, derived after the fact.

**Throttle skips are built, never hand-written.** `@SkipThrottle()` with no
argument writes a skip for a tier named `default`, and the guard only reads skips
for tiers that are actually configured — so a bare skip matches nothing and every
tier still applies. A partial skip set has the same problem for the tiers it
omits. Use `skipAll()` / `skipAllExcept()` from `common/throttle-tiers.ts`.

**Two densities, one component library.** The public surface carries
`data-density="comfortable"`; `/admin` does not, and keeps the compact defaults.
The rules key off `data-slot`, which is what the components emit.

**Cached input tokens are a subset of `inputTokens`.** Pricing subtracts them
before charging the fresh rate. Billing both in full double-charges the cached
portion invisibly — the total merely looks a little high.

---

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the provider abstraction, the scoring
pipeline, and the decisions behind both.
