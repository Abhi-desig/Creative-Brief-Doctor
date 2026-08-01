# Creative Brief Doctor — Foundation Build

*Revision 2 (lean) — provider-agnostic AI layer, two adapters, minimal admin panel. Gemini free tier is the initial live model.*

## Context

The repo is empty (one README, one commit).

**Creative Brief Doctor** is a diagnostic layer between requesters and creative teams: paste a brief, get a score out of 100 across five dimensions (objective clarity, audience specificity, message substance, constraints, success metrics), the specific gaps, and a ready-to-send list of follow-up questions.

The product's real leverage is political: a shareable, neutral-looking report is easier to send back to a stakeholder than a "please clarify" email. So the shareable report URL is a first-class MVP feature, not a phase-2 nicety — which is why this build includes Postgres from day one.

### What changed, and what got cut

The first pass wired the engine directly to the Anthropic SDK. That coupling is gone. But the intermediate draft over-corrected into five adapters and a small prompt CMS, so this revision keeps the abstraction and drops most of the surface built on top of it.

| Kept | Why |
| --- | --- |
| `AIProvider` port in `packages/ai` | The one change that matters. No vendor SDK outside `packages/ai/adapters`. |
| **Two** adapters — Google (Gemini) and Anthropic | Two proves the port. A third is one file plus a conformance run. |
| A test-double `FakeProvider` | CI runs with no key and no network. |
| Provider config from the database, entered in the admin panel | Your actual requirement: paste the Gemini key into a UI, not a platform env editor. |
| AES-256-GCM key vault | Unavoidable once keys arrive over HTTP. |
| Prompt versions: immutable, content-hashed, one active | Enforced by a trigger and a partial index, not service code. |
| Provenance columns on `Diagnosis` | Free now, and the only thing that makes later benchmarking a query instead of a migration. |

| Cut | Where it went |
| --- | --- |
| OpenAI, OpenRouter, Ollama adapters | [Seams](#seams-left-open). One file each, later. |
| Playground with a fixture library and compare mode | Reduced to a single "test this draft" run on one brief. |
| Prompt diff view and `parentId` lineage | A `changeNote` field. Diffs are a `git diff` on the seed file until someone asks. |
| `/admin/usage` dashboard | Three numbers on the admin status page. The columns still get written. |
| Automatic failover, multi-admin, RBAC, 2FA | Seams. The error taxonomy already separates retryable from terminal. |

Nine build steps in v1 became fifteen in the intermediate draft; this is twelve, and the first one is a measurement rather than code.

### Decisions confirmed with the user

| Area | Decision |
| --- | --- |
| **Scope** | Working MVP + Postgres persistence (shareable report URLs) + minimal admin panel. No public accounts, no team analytics. |
| **Frontend** | Next.js App Router + shadcn/ui |
| **Backend** | NestJS REST API, provider-agnostic AI scoring layer |
| **AI layer** | `AIProvider` port; adapters for Google Gemini and Anthropic; `FakeProvider` for tests |
| **Live model** | Gemini free tier initially, configured through the admin panel. Anthropic is the documented swap, not a required key. |
| **Admin auth** | Single administrator, credentials from env, encrypted session cookie. Deliberately *not* a user system. |
| **Secrets** | Provider API keys encrypted at rest, write-only over HTTP, never returned or logged |
| **Method** | spec-kit installed for real (constitution + `/speckit.*` workflow) |
| **Deploy** | Next.js → Vercel; NestJS → Railway/Render/Fly; Postgres → Neon or Supabase |

**Non-goals:** public authentication, workspaces, Slack app, benchmarking dashboard, provider failover.

---

## Step 0 — the calibration spike (half a day, before any code)

Do this first, because its result changes whether the rest of this document is a cost optimisation or a correctness problem.

The product's whole premise is a report a stakeholder treats as objective. Anchored 0–100 scoring with quoted evidence extraction is precisely the task cheap models are worst at. So before building anything:

1. Write the rubric prompt (you need it anyway — see [Rubric prompt design](#rubric-prompt-design)).
2. Run **twenty real briefs** through `gemini-2.5-flash` and `claude-opus-5` at the same prompt. A throwaway script, not application code.
3. Record per-dimension and overall scores, and look at the spread.

Read the result like this:

- **Within ~5 points overall** → Gemini free is a legitimate production model here. Proceed exactly as written.
- **5–15 points, but the same *ordering* of briefs** → usable, but the absolute number is not defensible. Consider shipping bands ("needs input" / "ready") more prominently than the number itself.
- **Above 15 points, or evidence extraction failing on Gemini** → the provider abstraction is still right, but the free tier can't be the live model. Budget for Opus and treat Gemini as the dev-only path.

The spike also gives you the seed rubric, a set of real fixture briefs, and the first data point on whether the anchors are specific enough — which is the single biggest lever on score stability regardless of model.

---

## Two free-tier facts to decide on before you paste client briefs into it

Neither is a reason not to use Gemini free. Both are decisions someone should make deliberately rather than discover later.

1. **Free-tier data use.** Google's paid and free API tiers have historically differed on whether submitted content may be used to improve their products, with the free tier being the permissive one. Creative briefs are frequently confidential — budgets, launch dates, unannounced products. Read the current terms for the tier you enable, and if briefs will contain client-confidential material, either move to a paid tier or put a plain-language notice on the paste page. Check this at scaffold time; the terms change.
2. **Quota is shared and daily.** Free-tier limits are per-project requests-per-minute and requests-per-day, not per-user. One enthusiastic person can exhaust the day for everyone. The existing 10/hour/IP throttle was designed to cap *spend*; on a free tier it needs to cap *quota* too, so add a global daily counter and return a specific, friendly 503 when it's hit. A brief scorer that silently dies at 4pm every day is worse than one that says "back tomorrow".

---

## Architecture

pnpm workspaces + Turborepo. Node 22, pnpm 10 (both already present; NestJS 11 requires Node ≥ 20).

```
creative-brief-doctor/
├── .specify/                      # spec-kit: memory/constitution.md, templates/, scripts/, feature.json
├── specs/
│   ├── 001-brief-diagnosis/
│   └── 002-provider-agnostic-ai/  # this revision — a new feature, not an edit of 001
├── apps/
│   ├── api/
│   │   └── src/
│   │       ├── ai/                # Nest module: registry, key vault, capability gate
│   │       ├── admin/             # auth, providers, model settings, prompts
│   │       ├── settings/          # DB-backed config with cache + invalidation
│   │       └── diagnosis/         # controller, service, scoring/
│   └── web/                       # Next.js App Router + shadcn/ui (public + /admin)
├── packages/
│   ├── contracts/                 # zod schemas + inferred types, shared by api & web
│   └── ai/                        # AIProvider port, 2 adapters, fake, conformance suite
├── docker-compose.yml             # local Postgres 16
├── pnpm-workspace.yaml
├── turbo.json
└── ARCHITECTURE.md
```

**Not NestJS's built-in monorepo mode.** That mode is Nest-only: it assumes every project is a Nest app built by `nest build` under a single shared `package.json`, and it defaults to webpack — deprecated in the upcoming v12 in favour of Rspack. Dropping Next.js into it means two toolchains fighting over one `package.json` and one root `tsconfig.json`. pnpm workspaces gives each app its own manifest.

**`packages/ai` is plain TypeScript with no Nest decorators.** It exports the port, normalized types, the two adapters, the error taxonomy, and the conformance suite. It knows nothing about Prisma, Nest, HTTP, or brief scoring. `apps/api/src/ai` is the thin wrapper that reads settings, decrypts the key, and hands the engine a constructed adapter. That split is what makes "switch to Claude in production" a settings write.

**`packages/contracts` stays the single source of truth for the diagnosis shape**, consumed four ways: per-provider schema compilation, API request/response validation, admin forms, and web types.

### Request flow

```
paste  →  POST /v1/briefs                                    persist Brief, return publicId
       →  GET  /v1/briefs/:publicId/diagnose/stream   (SSE)  resolve provider → score → persist Diagnosis
       →  redirect to /d/:publicId                           server-rendered, shareable report
```

Three endpoints, not one, for two concrete reasons: the shareable URL has to be a plain `GET` any stakeholder can open, and `EventSource` is GET-only and cannot send headers — so the brief text can't ride the streaming request. POST first, stream by id.

The SSE contract is provider-independent (coarse status events only, never partial JSON), so swapping providers changes nothing observable in the browser except latency.

---

## spec-kit setup

Python 3.11+ and uv are prerequisites; both are present.

```bash
uv tool install specify-cli                   # published on PyPI
specify init . --force --integration claude   # --force: the repo already has README.md
specify check
specify self check                            # read-only; reports whether a newer release exists
```

Pin the release when reproducibility matters: `uv tool install specify-cli --from git+https://github.com/github/spec-kit.git@vX.Y.Z`, keeping the leading `v`.

### Corrections — each would have produced a broken setup

1. **`--ai` no longer exists.** The flag is `--integration`, and the documented non-interactive example agent is Copilot, so `--integration claude` must be passed explicitly.
2. **Skills mode is opt-in, not the default.** The earlier assumption that the `claude` integration writes `.claude/skills/speckit-*/SKILL.md` automatically is wrong. Slash-command prompt files are the default; skills come from `--integration claude --integration-options="--skills"`. Decide before init.
3. **Invocation follows that choice.** Slash-command mode gives dotted `/speckit.plan`; skills mode gives hyphenated `speckit-plan`. Pick one spelling and use it consistently in the constitution and task files. This document uses the dotted default.

**Commands installed:** constitution, specify, clarify, plan, tasks, taskstoissues, implement, converge, plus optional analyze and checklist.

```
constitution → specify → clarify → plan → checklist → tasks → analyze → implement → converge
```

`/speckit.analyze` is read-only; `/speckit.converge` is append-only (its only write is adding tasks to `tasks.md`).

**Do not install the git extension.** Git is optional now — the active feature lives in `.specify/feature.json`, not the checked-out branch. The extension's numbered `001-feature-name` branches would fight the mandated `claude/creative-brief-doctor-nq6oj5` branch.

### This revision is a new feature, not an edit of 001

Provider-agnosticism and the admin panel are an intended-behaviour change, so:

```
/speckit.constitution   # amend FIRST — principle 1 changes materially
/speckit.specify        # creates specs/002-provider-agnostic-ai/
/speckit.clarify
/speckit.plan
```

Amend the constitution before `/speckit.plan`, because `plan-template.md`'s `## Constitution Check` gates on the current principles. Planning against the old principle 1 ("the rubric prompt is a frozen constant") produces a design the admin panel then violates.

If the capability rules and secret-handling constraints should be enforced on every future plan rather than restated, that's a **preset** overriding `plan-template.md` (`.specify/presets/templates/`). One-offs go in `.specify/templates/overrides/`, top of the resolution stack.

### The constitution is a real gate

Five principles, all of which bite on this project:

1. **Configuration is versioned, immutable, and recorded.** A prompt version's content is write-once and content-hashed; editing a non-draft forks a new draft. Every diagnosis persists the provider, model, prompt hash, and parameter snapshot that produced it. A score you cannot attribute to a configuration is not auditable.
2. **Scores are computed in code, and every dimension quotes evidence.** The model returns five 0–100 dimension scores with quoted spans from the brief; the server computes the total and derives the verdict.
3. **The vendor boundary is absolute.** Nothing outside `packages/ai/adapters/*` imports a provider SDK, names a model, or branches on provider. Capability differences are data on the adapter, negotiated by the engine.
4. **Every model call passes an admission gate and a cost ceiling.** Char cap, then token count, then a configured ceiling. Free tiers are not exempt — they have quota instead of bills, and quota exhaustion is an outage.
5. **Output tone is diagnostic, never accusatory.** The report has to be sendable to a stakeholder.

> spec-kit's Claude integration references `.claude/settings.json` for event hooks. We aren't enabling hooks, so nothing there needs configuring.

---

## The AI layer (`packages/ai`)

### The port

One interface, two real implementations plus a test double. The engine sees only this.

```ts
// packages/ai/src/port.ts
export interface AIProvider {
  readonly id: ProviderKind;                 // 'google' | 'anthropic'
  readonly capabilities: ProviderCapabilities;

  /** The only call the scoring engine makes. */
  generateStructured<T>(req: StructuredRequest<T>): Promise<StructuredResponse<T>>;

  /** Same call, coarse lifecycle events. Falls back to generateStructured if unsupported. */
  streamStructured<T>(req: StructuredRequest<T>): AsyncIterable<ProviderEvent<T>>;

  /** Native count where the vendor offers one; a declared estimator otherwise. */
  countInputTokens(req: TokenCountRequest): Promise<TokenCount>;

  /** For the admin model picker. Static list where there is no endpoint. */
  listModels(): Promise<ModelDescriptor[]>;

  /** Liveness probe for /health and the admin "Test connection" button. */
  ping(): Promise<PingResult>;
}

export interface StructuredRequest<T> {
  model: string;
  system: string;                            // the active prompt version's content, verbatim
  user: string;
  schema: StandardSchemaV1<T>;               // the zod schema from packages/contracts
  params: GenerationParams;
  signal?: AbortSignal;
}

export interface StructuredResponse<T> {
  output: T | null;                          // null unless stopReason === 'complete'
  raw: string;
  stopReason: StopReason;                    // 'complete' | 'max_tokens' | 'refusal' | 'content_filter'
  usage: NormalizedUsage;
  latencyMs: number;
  providerRequestId: string | null;
  structuredOutputMode: StructuredMode;
  degradations: Degradation[];               // what the adapter had to give up
}

export interface NormalizedUsage {
  inputTokens: number;
  outputTokens: number;
  cachedReadTokens: number;                  // 0 where the vendor has no usable caching
  cachedWriteTokens: number;
  reasoningTokens: number;                   // Gemini thoughts / Anthropic thinking
  tokenSource: 'native' | 'estimated';
}
```

`degradations` is not decoration. It's how the engine records that a diagnosis ran without caching, or through the JSON-repair path — and it goes into the database, so a bad week is a query rather than an investigation.

### Capability negotiation, not feature detection

Each adapter declares what it can do; the engine adapts. Nothing branches on provider name.

```ts
export interface ProviderCapabilities {
  structuredOutput: 'native-schema' | 'json-mode' | 'prompt-only';
  schemaDialect: 'json-schema-strict' | 'openapi-subset';
  promptCaching: 'explicit' | 'automatic' | 'none';
  nativeTokenCounting: boolean;
  supportsTemperature: boolean;
  supportsTopP: boolean;
  supportsThinkingBudget: boolean;
  supportsStreaming: boolean;
  maxOutputTokens: number;
  contextWindow: number;
  reportsCost: 'from-price-table' | 'free';
}
```

| | Google Gemini | Anthropic |
| --- | --- | --- |
| Structured output | `responseMimeType: 'application/json'` + `responseSchema` | `output_config.format` + schema |
| Schema dialect | OpenAPI 3.0 subset; `propertyOrdering`; **no** `additionalProperties` | JSON Schema; `additionalProperties: false` **required** |
| Prompt caching | implicit, not dependable | explicit `cache_control` breakpoints |
| Native token count | yes (`countTokens`) | yes (`countTokens`) |
| `temperature` | yes | **rejected on Opus 5** |
| Thinking control | `thinkingConfig.thinkingBudget` | **rejected on Opus 5** (adaptive, always on) |
| Cost | free tier / price table | price table |

### Four load-bearing constraints this creates

1. **One zod schema, two compilations.** `DiagnosisOutput` cannot go to both as-is. Anthropic requires `additionalProperties: false` (`.strict()` on every zod object); Gemini's OpenAPI subset doesn't accept it and wants `propertyOrdering` for stable field order. Each adapter owns `toProviderSchema(schema)`. These transforms are the highest-risk code in the package and get golden-file tests.
2. **Generation-parameter controls must be capability-driven.** Sending `temperature`, `top_p`, `top_k`, a thinking budget, or an assistant prefill to Opus 5 returns 400. The admin form renders controls *from* `capabilities`, and the adapter drops anything unsupported with a recorded degradation rather than forwarding it. A parameter the UI offers but the model rejects is the most likely bug in this feature.
3. **Thinking tokens count against your output budget on Gemini 2.5 models.** Thinking is on by default and consumes `maxOutputTokens` alongside the JSON, so a budget sized for "just the JSON" truncates and you get `max_tokens` with an unparseable tail. Either set an explicit `thinkingBudget` (0 disables it on Flash) or size `maxTokens` well above the JSON — 16K is the floor for both providers, not a generous ceiling. Record `reasoningTokens` so you can see which it is.
4. **Numeric constraints are never a server-side guarantee.** `z.number().min(0).max(100)` is stripped or ignored by both. Clamp on the way into the database, unconditionally.

And one rule that governs all response handling: **check `stopReason` before reading `output`.** `refusal` / `content_filter` → clean 4xx, persist nothing. `max_tokens` → truncated JSON; retry once at a higher cap rather than saving a partial. `output` can legitimately be `null`. Gemini's `finishReason: SAFETY` plus `promptFeedback.blockReason` and Anthropic's `stop_reason: "refusal"` normalize to the same two cases, so the engine has one code path.

### Adapter notes

**Google Gemini** (`google.adapter.ts`) — the initial live model. Free-tier keys from AI Studio, quota-limited rather than billed. `usageMetadata` supplies prompt / candidate / cached / thought counts, mapping cleanly onto `NormalizedUsage`; `countTokens` is native and free, so the admission gate is exact. Declare `promptCaching: 'automatic'` but treat `cachedReadTokens: 0` as normal — never write a cache-hit assertion against this provider, it will flake. The schema dialect and the thinking budget are the two things that will actually break.

**Anthropic** (`anthropic.adapter.ts`) — the documented production swap. `claude-opus-5`, 1M context, 128K max output. Explicit cache breakpoint on the **last** system block so the brief, which follows, never invalidates it; minimum cacheable prefix is 512 tokens, which a rubric with real anchors clears comfortably. Do not pass `temperature`, `top_p`, `top_k`, `thinking.budget_tokens`, or an assistant prefill. Uses `messages.stream()` + `finalMessage()` internally for timeout protection. Client configured once: `new Anthropic({ maxRetries: 3, timeout: 120_000 })` — **milliseconds** in TypeScript, seconds in Python.

**`FakeProvider`** (`fake.adapter.ts`) — returns fixtures, simulates each `stopReason`, each `AIError.kind`, and abort. It is what e2e tests run against, which is why no SDK is ever stubbed: the engine imports no SDK to stub.

### Error taxonomy

Vendor exceptions never escape `packages/ai`. Each adapter maps to one taxonomy; the API maps that to HTTP once.

| `AIError.kind` | HTTP out | Notes |
| --- | --- | --- |
| `rate_limit` | 503 | forward `retry-after` when supplied. **On a free tier this is your most common error** — message it as "scoring is busy", not as a failure. |
| `quota_exhausted` | 503 | distinct from `rate_limit`: the daily cap, not the per-minute one. Different message, different remedy. |
| `timeout` | 504 | worst case is `timeout × (maxRetries + 1)`; keep Nest's request timeout above it |
| `auth` | 500 | the configured key is bad — surface in the admin panel, not to the end user |
| `context_overflow` | 413 | the admission gate should have caught this; log it as a gate failure |
| `bad_request` | 500 | our bug, usually a schema-transform mismatch. Log the compiled schema. Do not retry. |
| `refusal` | 422 | clean message, nothing persisted |
| `upstream` | 502 | fallthrough. Log `providerRequestId`. |

Catch most-specific-first inside the adapter; never string-match error messages.

### Admission gate, caching, cost

**Admission gate**, three steps in cost order: hard char cap (20,000) rejected at the DTO, no API call; then `countInputTokens` (native on both providers, so exact) rejected above the configured ceiling; then persist real usage from the response so cost-per-diagnosis is a query.

**Caching.** The rubric is a large stable prefix with a small volatile suffix — the ideal shape, and it stays that way on both. What differs is who asks. Anthropic: explicit breakpoint, and assert `cachedReadTokens > 0` on the second identical call in the smoke test. That assertion is the cost regression test; without it a stray interpolation into the prompt silently triples spend. Gemini: report what usage returns, assert nothing.

The old "frozen string constant" rule is enforced differently now that the rubric lives in the database: **a prompt version's content is immutable and content-hashed, and nothing interpolates into it at request time.** No timestamps, no version labels, no conditional sections. The label is a separate column and never appears in the content. Verified by a boot-time check that the active version's stored hash matches a fresh hash of its content — a mismatch fails the health check loudly rather than quietly halving the cache hit rate.

**Cost.** `reportsCost: 'free'` → zero. `'from-price-table'` → look up `ModelPricing` by `(provider, model)`, pricing cached input separately from fresh, stored as `Decimal` and never a float. No price row for an active model → `costUsd` is `null` and the admin status card says "pricing not configured". A silent zero in a cost figure is worse than a gap.

---

## Configuration resolution (`apps/api/src/settings`)

The single most important behavioural change: **no provider key is required at boot.**

Previously `ConfigModule` validated `ANTHROPIC_API_KEY` and crashed without it — wrong twice over, since it hardcodes a vendor and makes a fresh deploy unbootable before an admin has logged in. New order:

```
1. DB: AppSetting singleton  →  activeProviderId, activeModel, params, ceilings
2. DB: AiProvider row        →  encrypted key, base URL
3. env bootstrap (optional)  →  AI_BOOTSTRAP_PROVIDER, AI_BOOTSTRAP_API_KEY, AI_BOOTSTRAP_MODEL
4. nothing configured        →  API boots healthy-but-degraded
```

Step 3 lets a fresh environment score a brief before anyone opens the panel: on first boot, if settings are empty and bootstrap vars are present, seed a provider row from them. Idempotent, runs once, audited with actor `system`. Since you're entering the Gemini key through the panel, you can skip these entirely — they exist for CI and for redeploys onto a fresh database.

Step 4 is the case that used to crash. Instead: `GET /health` returns `status: degraded`, `reason: NO_ACTIVE_PROVIDER`, and diagnose returns **503 `NO_ACTIVE_PROVIDER`** pointing at `/admin`. The web app renders that as a configuration notice, not a stack trace.

**Env still validated at boot** (infrastructure, not vendor choice): `DATABASE_URL`, `DIRECT_URL`, `MASTER_ENCRYPTION_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD_HASH`, `SESSION_SECRET`, `CORS_ORIGIN`, `PORT`. `validate` stays `(config) => Schema.parse(config)`, so the zod env schema drops straight in.

`SettingsService` caches the resolved config with a short TTL **and** an explicit invalidation hook fired by every admin write, so changing the model takes effect on the next request. Never cache the decrypted key beyond the request that needs it.

---

## Admin panel

`apps/web/app/admin/*` plus `apps/api/src/admin/*`. Five screens. It exists so the two things that determine output quality — the model and the prompt — are changeable without a deploy.

### Authentication — narrow on purpose

Not a user system. One administrator, no signup route, no password reset, no registration endpoint to attack.

- Credentials from env: `ADMIN_EMAIL` and `ADMIN_PASSWORD_HASH` (argon2id). Plaintext never exists in the repo, the database, or the container.
- Login POSTs through a Next.js route handler. Constant-time comparison, one generic failure message.
- Session is an **encrypted, httpOnly, secure, sameSite=lax cookie on the web origin** holding a short-lived bearer for the API. The browser never sees an API credential and never talks to the API directly — reusing the proxy pattern the public app already uses, so admin traffic is same-origin and the cross-site cookie problem never arises.
- CSRF: mutations are POST/PATCH/DELETE only, through handlers that check `Origin` and require a double-submit token. No mutating GETs.
- Login throttle: 5 attempts / 15 minutes / IP, its own tier.
- 8-hour sessions, 30-minute idle expiry, logout clears server-side state rather than just the cookie.
- `/admin/*` is gated in Next.js middleware **and** by a Nest guard on `/v1/admin/*`. Middleware protects the UI; the guard protects the data, and only one of those matters if someone finds the API hostname.

### `/admin/providers` — keys

- Add a provider: kind (`google` or `anthropic`), display label, optional base URL override, API key. This is where the Gemini key goes.
- **Keys are write-only over HTTP.** POST and PATCH accept one; no endpoint returns one. The list shows kind, label, `keyLast4`, key version, timestamps, last successful ping. There is no reveal button because there is no code path that could serve it.
- **At rest:** AES-256-GCM. 32-byte `MASTER_ENCRYPTION_KEY` (base64) from env; fresh 12-byte IV per record; the provider row's id as additional authenticated data, so a ciphertext copied between rows fails to decrypt rather than silently working. Stored as `keyCiphertext`, `keyIv`, `keyTag`, `keyLast4`, `keyVersion`.
- **Rotation:** a new key writes a new version and increments `keyVersion`; the old ciphertext is overwritten, not archived. Rotating `MASTER_ENCRYPTION_KEY` is a documented re-encrypt script, not a feature.
- **Never logged.** A redacting serializer on the admin module, plus a unit test that feeds a known key through the request logger and asserts absence.
- **Test connection** calls `ping()` and reports latency and the resolved model list — how you find out a key is bad immediately rather than through a failed diagnosis.

### `/admin/model` — active provider, model, parameters

- Provider select → model select from `listModels()`, with manual entry for models the endpoint hasn't listed yet.
- Parameter controls **rendered from `capabilities`**, so the form cannot offer something the selected model rejects: `maxTokens` always; `temperature` / `topP` / `thinkingBudget` only where supported; plus `timeoutMs`, `maxRetries`, `tokenCeiling`, and the daily quota cap.
- Switching provider shows a blunt warning: **scores are not comparable across models, even at the same prompt version.** Comparability is keyed on `(promptVersion, provider, model)`.
- Save is atomic and audited, cache invalidated.

### `/admin/prompts` — the rubric

```
DRAFT ──edit──▶ DRAFT ──test──▶ DRAFT ──activate──▶ ACTIVE ──(new activation)──▶ ARCHIVED
```

- One `PromptTemplate` (`rubric`) with many `PromptVersion` rows. Exactly one `ACTIVE`, enforced by a partial unique index — not application logic.
- **`ACTIVE` and `ARCHIVED` content is immutable.** Editing forks a new `DRAFT` seeded from it. Constitution principle 1, enforced by a trigger.
- Each version stores `contentHash` (SHA-256), a required `changeNote`, and the author. No lineage graph, no diff view — the seed file is in git.
- Activation records who and why. Rollback is activating an older version, which creates a new activation event.
- No path exists to leave a template with no active version.
- **Test draft**: runs the draft against the active model on one brief (pasted, or the last brief scored) and shows parsed scores, evidence, follow-up questions, raw output, `stopReason`, tokens, latency, cost, and degradations. One run, one result, no fixture library and no compare mode. Its own throttle tier, because looping this on Opus is real spend.

### `/admin` — status

Active provider, model, and prompt version. Health. Three numbers: diagnoses today, spend today (or "free tier"), and today's quota consumption against the cap. Error count by `AIError.kind` for the last 24 hours. All aggregate queries over `Diagnosis` — no new instrumentation.

---

## Data model (Prisma + Postgres 16)

```prisma
model Brief {
  id          String      @id @default(cuid())
  publicId    String      @unique          // nanoid, URL-safe, used in shareable links
  rawText     String      @db.Text
  charCount   Int
  title       String?
  requester   String?                      // free-text stakeholder label — the benchmarking seed
  createdAt   DateTime    @default(now())
  diagnoses   Diagnosis[]
}

model Diagnosis {
  id                   String        @id @default(cuid())
  publicId             String        @unique
  briefId              String
  brief                Brief         @relation(fields: [briefId], references: [id], onDelete: Cascade)

  overallScore         Int                             // computed server-side, not by the model
  verdict              Verdict
  summary              String        @db.Text

  // --- provenance: what produced this score (principle 1) ---
  provider             ProviderKind
  model                String
  providerRequestId    String?
  promptVersionId      String
  promptVersion        PromptVersion @relation(fields: [promptVersionId], references: [id])
  promptHash           String                          // must equal promptVersion.contentHash
  rubricVersion        String                          // human label, denormalized for display
  params               Json                            // snapshot of what was actually sent
  structuredOutputMode StructuredMode
  degradations         Json
  retryCount           Int           @default(0)

  // --- economics ---
  inputTokens          Int
  outputTokens         Int
  cacheReadTokens      Int           @default(0)
  cacheWriteTokens     Int           @default(0)
  reasoningTokens      Int           @default(0)
  tokenSource          TokenSource
  costUsd              Decimal?      @db.Decimal(12, 6)   // null = pricing not configured
  latencyMs            Int

  createdAt            DateTime      @default(now())
  dimensions           DimensionScore[]
  questions            FollowUpQuestion[]

  @@index([briefId])
  @@index([provider, model, createdAt])                  // the benchmarking query
  @@index([promptVersionId, createdAt])
  @@index([createdAt])                                   // the daily quota / spend query
}

model DimensionScore {
  id          String    @id @default(cuid())
  diagnosisId String
  dimension   Dimension
  score       Int                          // 0-100, clamped in code — no provider guarantees it
  rationale   String    @db.Text
  gaps        String[]
  evidence    String[]                     // quotes from the brief — makes the score auditable
  @@unique([diagnosisId, dimension])
}

model FollowUpQuestion {
  id          String    @id @default(cuid())
  diagnosisId String
  dimension   Dimension
  question    String    @db.Text
  blocking    Boolean                      // "lock before we start" vs "nice to have"
  rank        Int
  @@index([diagnosisId])
}

// ─── AI configuration ────────────────────────────────────────────────

model AiProvider {
  id             String         @id @default(cuid())
  kind           ProviderKind
  label          String                       // "Gemini (free tier)"
  baseUrl        String?
  keyCiphertext  Bytes?                       // AES-256-GCM
  keyIv          Bytes?
  keyTag         Bytes?
  keyLast4       String?
  keyVersion     Int            @default(1)
  status         ProviderStatus @default(UNTESTED)
  lastPingAt     DateTime?
  lastPingMs     Int?
  createdAt      DateTime       @default(now())
  updatedAt      DateTime       @updatedAt
  activeIn       AppSetting[]
  @@unique([kind, label])
}

model AppSetting {
  id               String      @id @default("singleton")   // enforced single row
  activeProviderId String?
  activeProvider   AiProvider? @relation(fields: [activeProviderId], references: [id])
  activeModel      String?
  maxTokens        Int         @default(16000)
  temperature      Float?                                  // null when the model rejects it
  topP             Float?
  thinkingBudget   Int?
  timeoutMs        Int         @default(120000)
  maxRetries       Int         @default(3)
  tokenCeiling     Int         @default(12000)
  dailyCallCap     Int         @default(400)               // free-tier quota guard
  costCeilingUsd   Decimal     @db.Decimal(10, 4) @default(0.50)
  updatedAt        DateTime    @updatedAt
  updatedBy        String?
}

model ModelPricing {
  id                String       @id @default(cuid())
  provider          ProviderKind
  model             String
  inputPerMTok      Decimal      @db.Decimal(10, 4)
  outputPerMTok     Decimal      @db.Decimal(10, 4)
  cachedReadPerMTok Decimal?     @db.Decimal(10, 4)
  cacheWritePerMTok Decimal?     @db.Decimal(10, 4)
  currency          String       @default("USD")
  effectiveFrom     DateTime     @default(now())
  @@unique([provider, model, effectiveFrom])
}

// ─── Prompt versioning ───────────────────────────────────────────────

model PromptTemplate {
  id        String          @id @default(cuid())
  key       String          @unique          // "rubric"
  name      String
  versions  PromptVersion[]
  createdAt DateTime        @default(now())
}

model PromptVersion {
  id           String          @id @default(cuid())
  templateId   String
  template     PromptTemplate  @relation(fields: [templateId], references: [id], onDelete: Cascade)
  label        String                          // "v3" — never interpolated into content
  content      String          @db.Text        // immutable once status != DRAFT
  contentHash  String                          // SHA-256 of content
  status       PromptStatus    @default(DRAFT)
  changeNote   String          @db.Text
  createdBy    String
  createdAt    DateTime        @default(now())
  activatedAt  DateTime?
  activatedBy  String?
  diagnoses    Diagnosis[]
  testRuns     PromptTestRun[]
  @@unique([templateId, label])
  @@index([templateId, status])
}

model PromptTestRun {
  id              String        @id @default(cuid())
  promptVersionId String
  promptVersion   PromptVersion @relation(fields: [promptVersionId], references: [id], onDelete: Cascade)
  provider        ProviderKind
  model           String
  briefText       String        @db.Text
  params          Json
  rawOutput       String        @db.Text
  parsedOutput    Json?
  stopReason      String
  overallScore    Int?
  inputTokens     Int
  outputTokens    Int
  latencyMs       Int
  costUsd         Decimal?      @db.Decimal(12, 6)
  error           String?
  createdBy       String
  createdAt       DateTime      @default(now())
  @@index([promptVersionId, createdAt])
}

model AdminAuditLog {
  id         String   @id @default(cuid())
  actor      String                          // email, or "system" for bootstrap
  action     String                          // "provider.create", "prompt.activate", "settings.update"
  targetType String
  targetId   String?
  before     Json?                           // secrets redacted before write
  after      Json?
  ip         String?
  userAgent  String?
  createdAt  DateTime @default(now())
  @@index([createdAt])
}

enum Dimension      { OBJECTIVE_CLARITY AUDIENCE_SPECIFICITY MESSAGE_SUBSTANCE CONSTRAINTS SUCCESS_METRICS }
enum Verdict        { READY NEEDS_WORK NOT_READY }
enum ProviderKind   { GOOGLE ANTHROPIC }
enum ProviderStatus { UNTESTED OK FAILING DISABLED }
enum PromptStatus   { DRAFT ACTIVE ARCHIVED }
enum StructuredMode { NATIVE_SCHEMA JSON_MODE PROMPT_ONLY }
enum TokenSource    { NATIVE ESTIMATED }
```

Three constraints belong in the database, not in application code, because application code gets bypassed by scripts and by the next developer. They live in a hand-written migration that must not get squashed away:

1. **One active version per template** — `CREATE UNIQUE INDEX one_active_prompt ON "PromptVersion" ("templateId") WHERE status = 'ACTIVE';`
2. **One `AppSetting` row** — `CHECK (id = 'singleton')`.
3. **Immutable non-draft content** — a `BEFORE UPDATE` trigger raising on any change to `content` or `contentHash` when the existing `status` is not `DRAFT`.

`ProviderKind` has two values today. Adding a third is an enum migration plus one adapter file — deliberately cheap, deliberately not pre-built.

`evidence` is what makes the report defensible to a stakeholder who disputes a score. `requester` is captured now because it's the column the future "which stakeholders send bad briefs" view reads, and it costs nothing today.

Verdict thresholds live in `packages/contracts` (**≥80 READY, 55–79 NEEDS_WORK, <55 NOT_READY**) so web and api agree without a round trip.

### Prisma's current shape changed

Driver adapters and a generated client path, not the legacy global client:

```ts
import { PrismaClient } from './generated/prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';

@Injectable()
export class PrismaService extends PrismaClient {
  constructor() {
    super({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }) });
  }
}
```

No `onModuleInit`/`$connect` — that pattern is from older docs. There's no built-in Prisma health indicator (Terminus ships one for TypeORM only), so the health check needs a small custom indicator running `SELECT 1`.

---

## Streaming (SSE)

Unchanged by design, which is the point. Partial JSON is **not** forwarded to the browser (half-built JSON renders as garbage), so the wire contract is identical whichever provider is active:

```
event: status   data: {"phase":"reading"}
event: status   data: {"phase":"scoring"}     // first token received
event: result   data: {…full report…}
event: error    data: {"code":"…","message":"…"}
```

Adapters that stream emit the `scoring` transition on their first token; one that doesn't falls back to `generateStructured` and emits a synthetic event immediately. The browser can't tell — which is exactly the guarantee the abstraction is for.

```ts
@Sse('briefs/:publicId/diagnose/stream')
diagnose(@Param('publicId') id: string): Observable<MessageEvent> {
  const ac = new AbortController();
  return from(this.diagnosis.runStreaming(id, ac.signal)).pipe(
    map((e) => ({ type: e.type, data: e.data }) as MessageEvent),
    finalize(() => ac.abort()),
  );
}
```

Nest auto-unsubscribes on client disconnect and `finalize()` is the documented cleanup hook. **Abort propagation is a conformance requirement**, not an implementation detail: every adapter must accept `signal` and abandon the in-flight request. On a free tier an ignored abort burns quota rather than money, which is worse — quota is shared.

### Four things silently break SSE

1. A global `timeout()` interceptor kills the stream; `TransformInterceptor` or `ClassSerializerInterceptor` corrupts the frames. Exclude streaming routes explicitly.
2. `compression` middleware buffers SSE. Disable it on the streaming path.
3. Reverse proxies buffer — nginx needs `proxy_buffering off`, or send `X-Accel-Buffering: no`. The classic "works locally, hangs in prod" failure.
4. Nest emits no keepalives; idle connections get reaped. Merge a ping interval into the observable. This matters more on a free tier, which can sit quiet longer than a paid one.

---

## Backend module map (`apps/api`) — NestJS 11

| Module | Contents |
| --- | --- |
| `config/` | `ConfigModule.forRoot({ isGlobal: true, validate })` — zod env schema. Infrastructure only; **no provider key required at boot.** |
| `prisma/` | `PrismaService`, migrations, seed (rubric v1, price rows) |
| `settings/` | `SettingsService` — DB-backed config, TTL cache + invalidation on admin write |
| `ai/` | `ProviderRegistry` (settings → decrypted key → adapter), `KeyVaultService`, `CapabilityGate`, `AIError` → HTTP mapping. The only module importing `packages/ai`. |
| `admin/` | `AdminAuthGuard`, providers, model settings, prompts, audit interceptor, redacting logger |
| `diagnosis/` | controller (POST brief, GET report, SSE diagnose), service, `scoring/{schema,engine,aggregate,repair}.ts` |
| `health/` | `@nestjs/terminus` 11.x — custom Prisma indicator + **active-provider** reachability |

**Cross-cutting:** global `ZodValidationPipe`, global exception filter, `helmet` (registered before any other `app.use()`, or earlier routes miss the headers), CORS restricted to the web origin, `@nestjs/throttler` 6.x.

**Four throttle tiers**, protecting four different things: diagnose (10/hour/IP — unauthenticated), admin login (5/15min/IP), prompt test (its own budget), plus a looser global limit. Separately from throttling, the **daily call cap** (`dailyCallCap`) is a counter over `Diagnosis.createdAt`, not a throttler tier, because it guards a shared free-tier quota rather than a per-client rate. `ttl` is **milliseconds** in throttler v5+, and the in-memory store is per-instance, so multi-replica later needs a Redis `ThrottlerStorage`.

**zod validation is not native to NestJS 11.** Use `nestjs-zod` (v5.5.0) for `createZodDto` + `ZodValidationPipe` + swagger schema generation, so `packages/contracts` schemas validate HTTP input and generate OpenAPI with no duplicated class-validator DTOs. Keep the DTO layer thin: NestJS 12 adds native Standard Schema validation, making that swap mechanical.

**Two starter defaults to fix immediately:** `tsconfig.json` doesn't enable `strict` (turn it on), and `main.ts` hardcodes port 3000 (use `process.env.PORT ?? 3000`).

**Swagger** uses the lazy-factory form: `SwaggerModule.setup('api', app, () => SwaggerModule.createDocument(app, config))`, with the CLI plugin in `tsconfig.json`. Exclude `/v1/admin/*` from the public document.

**Logging:** `ConsoleLogger({ json: true })` plus a redaction layer on the admin module. Redaction is a test, not a promise.

`scoring/engine.ts` and `aggregate.ts` take plain arguments and return plain objects, no decorators. The engine's signature is `run(provider: AIProvider, prompt: PromptSnapshot, brief: string, params: GenerationParams)` — it receives the provider rather than resolving one, which is what makes it testable with a fake and extractable into `packages/scoring` later.

### Version watch

`@nestjs/core` latest is 11.1.28; 12.0.0-alpha.5 exists and v12 targets "approx. Q3 2026" — now. Build on 11, but run `npm view @nestjs/core dist-tags` at scaffold time before locking. v12's changes (ESM, Vitest + oxlint, Rspack, native Standard Schema validation) are all migration-relevant.

---

## Frontend (`apps/web`)

**Correction to the starting assumption:** shadcn/ui's default primitive library is now **Base UI** (`@base-ui/react` 1.6.0), not Radix. `style` is no longer `"default"`/`"new-york"` — it's a `<base>-<style>` enum defaulting to `base-nova`. `shadcn` (4.16.0) is now a **runtime dependency**, because `globals.css` does `@import "shadcn/tailwind.css"`.

```bash
npx shadcn@latest init -t next          # Base UI + base-nova; add -b radix only to opt out
npx shadcn@latest mcp init --client claude
```

`style`, `baseColor`, and `cssVariables` are **immutable after init** — changing them later means deleting and reinstalling every component. Tailwind v4, so no `tailwind.config.ts`; theming is CSS-first via `@theme inline`, tokens are OKLCH (`bg-primary` works directly, no `hsl()` wrapper).

| Route | Rendering | Purpose |
| --- | --- | --- |
| `/` | Server shell + client form | Positioning copy + the paste box |
| `/d/[publicId]` | Server Component | The shareable report. SSR so pasted links unfurl with real OG metadata. |
| `/api/briefs`, `/api/briefs/[id]/stream` | Route handlers | Proxy to NestJS — keeps `API_BASE_URL` and the service token server-side |
| `/admin/login` | Client form → route handler | Sets the encrypted session cookie |
| `/admin` | Server Component | Status: provider, model, prompt version, today's counts, health |
| `/admin/providers` | Server + client forms | Add / rotate / test providers. Key inputs are write-only. |
| `/admin/model` | Server + client forms | Active provider + model + capability-driven parameters |
| `/admin/prompts` | Server + client editor | Version list, draft editor, test draft, activate |
| `/api/admin/*` | Route handlers | Every admin mutation: cookie in, bearer out |

`middleware.ts` gates `/admin/*` on the session cookie. It's the convenience gate; the Nest guard is the real one.

**Components:** textarea, button, card, badge, progress, accordion, separator, skeleton, tabs, tooltip, alert, label, collapsible, scroll-area, toast, `field` (forms), `empty` (pre-submission), `spinner` (during scoring), `item` (question and gap rows). Admin adds table, select, switch, dialog, alert-dialog.

### Two renames that reverse expectations

1. **Use `toast`, not `sonner`.** A first-class toast built on Base UI shipped in July 2026 with status types and promise support. `sonner` still installs, but its docs page now serves the Toast content.
2. **Use `field`, not `form`.** `/docs/components/form` redirects to a form-library guide. The current API is `Field`/`FieldLabel`/`FieldError`/`FieldDescription`, and `FieldError` consumes Standard Schema issues directly — so `packages/contracts` zod schemas drive client-side validation with no adapter. Pair with `react-hook-form` + `@hookform/resolvers`.

### The report page's job is to be sendable

- Overall score + verdict at the top, phrased as a decision ("ready to brief" / "needs input before we start"), not a grade.
- Five dimension rows: score bar, one-line rationale, gaps, and the quoted evidence behind the score.
- Follow-up questions with copy-to-clipboard — the highest-value interaction in the product. Two framings via `Tabs`: plain list, and a pre-written message to paste into email or Slack. Collaborative tone, never "your brief is bad."
- A quiet provenance line in the footer: rubric version and scoring date. **Not** the provider or model name — a stakeholder reading "scored by gemini-2.5-flash" will argue with the tooling instead of the brief. Full attribution lives in the database and the admin panel.
- Dark/light via `next-themes` (`suppressHydrationWarning` on `<html>` required).

Before building the score visuals, load the **dataviz skill** — the overall-score meter and dimension bars are the stat-tile/meter forms it governs, and the colour semantics matter: a low score must not read as an error in a tool whose whole job is to avoid feeling like an accusation.

### One version decision to settle at scaffold time

shadcn's form docs specify zod v3; `nestjs-zod` 5.5.0 supports v3, v4, and zod-mini. Before writing any schema, check the zod peer range of both adapter SDKs (`npm view @anthropic-ai/sdk peerDependencies`, same for the Google SDK) and pin one zod major across the workspace. If a schema-compilation helper needs v4, the frontend resolver bends — not `packages/contracts`. Settle this in the first hour.

---

## Rubric prompt design

The prompt is the product. It lives in the database as an immutable version, seeded from `apps/api/prisma/seed/rubric-v1.md` so it's reviewable in git even though it's served from Postgres.

1. **Role and stance** — a creative operations analyst diagnosing the brief, never the person.
2. **Per-dimension definitions with explicit 0–100 anchors** (what 20 looks like vs 60 vs 90). Anchors are what make scores comparable across briefs. They matter more on a free model: Gemini Flash leans much harder on explicit anchors than Opus does, so a rubric calibrated only against Opus will score erratically. This is the main lever you have on the Step 0 spread.
3. **Quote evidence from the brief for every dimension.** Score only what the brief says; never credit inferred intent.
4. **Follow-up question rules:** 3–8 questions, each tied to a dimension, each answerable in one or two sentences, phrased as a collaborative ask.
5. **An explicit prohibition on computing the total.**
6. **Output-shape restatement.** Redundant with a native schema, cheap insurance when a schema transform degrades. Keep it.
7. **No interpolation, ever.** No timestamps, no version labels, no conditional sections, no config in template literals. One byte invalidates the cache and changes the hash. Versioning happens through the `label` column, which never appears in the content.

---

## Deployment

- **Web → Vercel.** Root `apps/web`, `pnpm install`, build through turbo.
- **API → Railway / Render / Fly.** Multi-stage Dockerfile using `pnpm deploy --filter api`. Disable compression on the SSE route and set `X-Accel-Buffering: no` behind any proxy.
- **Postgres → Neon or Supabase.** Both pool connections, which breaks Prisma migrations. Configure both URLs — `url = env("DATABASE_URL")` (pooled, runtime) and `directUrl = env("DIRECT_URL")` (unpooled, migrations). Omitting `directUrl` is the classic first-deploy failure on Neon.
- **Local:** `docker-compose.yml` with Postgres 16; `pnpm dev` runs both apps via turbo.
- `.env.example` at the root, committed. No secrets in the repo.

### Environment variables

| Variable | Where | Required | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | api | yes | pooled |
| `DIRECT_URL` | api | yes | unpooled, migrations only |
| `MASTER_ENCRYPTION_KEY` | api | yes | 32 bytes base64. **Losing it means re-entering every provider key.** Back it up outside the platform. |
| `ADMIN_EMAIL` | api | yes | |
| `ADMIN_PASSWORD_HASH` | api | yes | argon2id, generated by a one-off script |
| `SESSION_SECRET` | web + api | yes | cookie encryption + bearer signing |
| `CORS_ORIGIN` | api | yes | the web origin, exactly |
| `PORT` | api | yes | platform-injected |
| `API_BASE_URL` | web | yes | server-only |
| `NEXT_PUBLIC_APP_URL` | web | yes | for OG metadata on shared links |
| `AI_BOOTSTRAP_PROVIDER` | api | no | first-boot seed only: `google` \| `anthropic` |
| `AI_BOOTSTRAP_API_KEY` | api | no | first-boot seed only; encrypted into the DB then unused |
| `AI_BOOTSTRAP_MODEL` | api | no | first-boot seed only |
| `WARM_CACHE_ON_BOOT` | api | no | default off; only meaningful on Anthropic |

**`ANTHROPIC_API_KEY` is gone as a required variable.** That deletion is the change. A key arriving through the admin panel and the vault rather than the platform's env editor is what makes switching providers a two-minute action with an audit trail.

Posture: **dev and initial production** on Gemini free tier, configured in the panel; **Anthropic** added as a second provider row whenever the Step 0 spread or the confidentiality question says it's time. Same image, same code, one settings row.

---

## Verification

Ordered so failures surface cheaply — pure logic before anything spends a token or a quota unit.

**1. Unit (no network)**
- `aggregate.ts` — overall from five dimensions, threshold boundaries at exactly 55 and 80, clamping of out-of-range scores.
- `schema.ts` — a recorded real response from each provider parses; a truncated one fails cleanly.
- **Schema transform golden files** — `toProviderSchema(DiagnosisOutput)` snapshotted per provider. Asserts the Anthropic output carries `additionalProperties: false`; asserts the Gemini output carries none and does carry `propertyOrdering`. This catches the most expensive class of bug here.
- `repair.ts` — malformed JSON variants (trailing prose, fenced block, trailing comma, truncated tail) recover or fail cleanly. No infinite loops.
- `KeyVaultService` — encrypt/decrypt round-trip; a ciphertext moved to a different provider id **fails** (AAD binding); a tampered tag fails; `keyLast4` matches.
- Cost calculation — known usage against a known price row; cached vs fresh input priced differently; missing price row yields `null`, not `0`.
- Prompt immutability — updating a non-draft version's content throws at the database layer, not just in the service.
- Log redaction — a known key fed through the request logger does not appear in output.

**2. Adapter conformance suite (`packages/ai/conformance`)**
One parameterized suite every adapter must pass. This is what "interchangeable" means in practice.

- Returns a valid `DiagnosisOutput` or a typed `AIError` — never a vendor exception.
- All `usage` fields present and non-negative; `tokenSource` matches the declared `nativeTokenCounting`.
- `stopReason` is one of the normalized values.
- `abort()` mid-flight rejects promptly and leaves nothing running.
- Declared capabilities are true: with `supportsTemperature: false`, sending temperature is dropped with a recorded degradation rather than raising a 400.
- `ping()` succeeds with a valid key and returns `auth` on a bad one.
- Runs against `FakeProvider` in CI with no secrets, and opt-in against Google and Anthropic when keys are present.

**3. e2e (supertest, `FakeProvider`)**
- Override `ProviderRegistry` via `Test.createTestingModule().overrideProvider(...)`. No SDK is stubbed, because the engine imports none.
- POST → SSE → GET yields a persisted, retrievable report; oversized input is rejected at the DTO; the throttle returns 429 on the 11th call; the daily cap returns 503 `QUOTA_EXHAUSTED` at `dailyCallCap + 1`.
- **No active provider → 503 `NO_ACTIVE_PROVIDER`** and `/health` degraded, rather than a dead process.
- Admin: unauthenticated `/v1/admin/*` returns 401; a POSTed key never appears in any subsequent GET body; login throttles at the 6th attempt; every mutation writes an `AdminAuditLog` row with secrets redacted.
- Prompt lifecycle: activating B archives A; exactly one ACTIVE survives concurrent activation attempts (the partial index does the work); rolling back to A leaves B's history intact.
- One test consumes the SSE stream to completion — this is what catches a global interceptor silently breaking it.

**4. Live smoke (opt-in, per provider)**
- Score one fixture brief twice. Assert `stopReason === 'complete'`, `output` non-null, five dimensions present, evidence non-empty.
- **Anthropic only:** second call has `cachedReadTokens > 0`. The prompt-cache regression test. Do not write this for Gemini — it will flake.
- **Gemini only:** assert `reasoningTokens + outputTokens < maxTokens`, so a thinking-budget regression shows up as a test failure rather than as truncated JSON in production.

**5. Manual, both apps up**
- Paste a deliberately vague brief (low score, specific gaps) and a genuinely good one (high score, no invented complaints).
- Confirm SSE progress arrives, the report page server-renders in a fresh browser with no session, and copy-to-clipboard produces sendable text.
- Close the tab mid-scoring and confirm the upstream request aborts — on each provider, since propagation is per-adapter.
- **Add a second provider in the admin panel and re-score the same brief without restarting anything.** That single action is the acceptance criterion for this whole revision.
- Edit the rubric to a draft, test it, activate, confirm the next diagnosis records the new `promptVersionId` and `promptHash`.

**6. Migrations**
- `prisma migrate deploy` against a throwaway Neon branch before the first real deploy. Confirm the three database-level constraints survive it — Prisma won't generate them, so they live in a hand-written migration.

---

## Seams left open

- **A third provider** is one adapter file, one enum value, and a conformance run. OpenAI (strict JSON Schema), OpenRouter (OpenAI-compatible, `:free` variants, reports real cost per response), and Ollama (local, free, no key) are the obvious candidates, in that order of effort.
- **Cross-provider benchmarking** is a query, not a migration: `Diagnosis` already carries provider, model, prompt version, params, tokens, latency, and cost. "Does Flash agree with Opus on the same 200 briefs at prompt v4?" is answerable the day it's asked — and Step 0 is its first data point.
- **Shadow mode** (run a second provider async, store the result, show nothing) is a service-level addition, because the engine takes a provider as an argument.
- **Failover** isn't built, but `ProviderRegistry` returning a list rather than one adapter is a one-file change, and the taxonomy already separates retryable `rate_limit` / `upstream` from terminal `bad_request` / `refusal`.
- **Prompt diffs and lineage** — add `parentId` and a diff view when the version count makes git insufficient.
- `AdminAuditLog.actor` is a string, so multi-admin and RBAC are additive.
- `Brief` has no user FK, so `workspaceId` / `userId` is an additive migration.
- The scoring core is decorator-free and provider-injected, so it's extractable for the Slack app.
- The validation layer is thin, so NestJS 12's native Standard Schema support is a swap.

---

## Build order

Twelve steps. The first is a measurement.

1. **Step 0 calibration spike** — twenty briefs through Gemini Flash and Opus at the same rubric. Read the spread before writing application code. Decide the free-tier confidentiality question at the same time.
2. Monorepo skeleton, `specify init . --force --integration claude`, then **amend the constitution** — principle 1 changed, and every later `/speckit.plan` gates on it.
3. `/speckit.specify` → `specs/002-provider-agnostic-ai/`, then clarify and plan.
4. `packages/contracts` — zod schemas, dimensions, thresholds. **Settle the zod major here**, against both adapter SDKs' peer ranges.
5. `packages/ai` — port, normalized types, error taxonomy, capability interface, and the **conformance suite before any adapter**. The suite is the spec; write it first. Then `FakeProvider`.
6. **Gemini adapter** (the live model; proves the OpenAPI-subset transform and the thinking-budget trap), then **Anthropic adapter** (proves strict schema and explicit caching).
7. NestJS scaffold: config, Prisma, health, throttler, validation, swagger. `strict: true`, `process.env.PORT`.
8. `settings/` + `ai/` Nest modules: `KeyVaultService`, `ProviderRegistry`, capability gate, `AIError` → HTTP mapping, the degraded-boot path, the daily cap counter.
9. `admin/`: auth guard, providers CRUD, audit interceptor, redacting logger. Get secret handling right before anything depends on it.
10. Prompt versioning: models, the three database constraints in a hand-written migration, seed `rubric-v1` from Step 0, activation as an event.
11. Scoring engine + aggregate + repair loop with unit tests; then the diagnosis endpoints (POST, GET, SSE) + e2e against `FakeProvider`.
12. Next.js: scaffold, shadcn init, paste page, report page, questions copy block; then admin login, status, providers, model, prompts. Then Docker Compose, Dockerfile, `.env.example`, Vercel config, README/ARCHITECTURE, live smoke, the provider-switch acceptance check, and push to `claude/creative-brief-doctor-nq6oj5`.

Steps 5 and 6 are worth over-investing in. Every later decision assumes the port is right, and a port that leaks one vendor's assumptions — a cache-control field, a `temperature` that's always accepted, a `stop_reason` string — costs far more to fix at step 12 than to get right at step 5.
