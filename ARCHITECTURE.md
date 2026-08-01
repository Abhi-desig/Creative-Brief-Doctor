# Architecture

Why the system is shaped the way it is. For how to run it, see
[README.md](README.md).

---

## The five principles

1. **The report is the product.** Everything else is scaffolding around producing
   a URL someone forwards to a colleague. When a decision trades off against the
   report's forwardability, the report wins.
2. **Scores are computed in code, never read from the model.** The model emits
   five dimension scores and nothing else numeric. The overall and the verdict are
   derived afterwards, so they cannot be talked up or down in the same pass that
   assigns the dimensions.
3. **The engine never names a model.** Provider, model and parameters are resolved
   and handed in. Adding a provider is one enum value, one adapter file and one
   case in the factory.
4. **Degraded, not down.** Nothing configured is a valid state that must render,
   respond and be fixable through the panel. A deployment waiting for a human is
   working correctly.
5. **A gap is not a fault.** The rubric diagnoses the document, never the person.
   No colour codes a low score as an error, anywhere.

---

## The provider abstraction

```
DiagnosisService
      │  resolves via
      ▼
ProviderRegistry ──► SettingsService ──► AppSetting + AiProvider (+ KeyVault)
      │                                        │
      │ hands the engine a provider            └─► buildAdapter(kind) ─► GoogleAdapter
      ▼
   engine.run(provider, prompt, brief, params)
      │
      ▼
   AIProvider port  ── generateStructured / streamStructured / countInputTokens
                       / listModels / ping
```

`packages/ai` is the only place a vendor SDK is imported. Everything downstream
sees the port and the error taxonomy. That is what makes the e2e suite's mocking
strategy a single `overrideProvider(ProviderRegistry)` — the engine imports no
SDK, so there is nothing to stub.

**The conformance suite is the contract.** `packages/ai/src/conformance/suite.ts`
runs the same assertions against every adapter. A capability an adapter declares
but does not honour is a bug in the adapter, not in the suite.

### Adding a provider

1. Write the adapter against the port.
2. Add the enum value and a case in `adapter.factory.ts`.
3. Run the conformance suite against it.

Nothing else in `apps/api` branches on provider. `buildAdapter` throwing for an
unimplemented kind is caught and degrades to `PROVIDER_UNAVAILABLE` rather than
crashing every caller — and the admin panel refuses to activate such a provider
in the first place, so the failure is a validation message rather than a
site-wide outage.

---

## The scoring pipeline

```
POST /v1/briefs                    persist, return publicId
GET  /v1/briefs/:id/diagnose/stream  SSE: reading → scoring → saving → result
GET  /v1/briefs/:id                the shareable report, a plain GET
```

Three endpoints rather than one, for two concrete reasons: the shareable URL has
to be a plain GET any stakeholder can open, and EventSource is GET-only and cannot
send headers, so the brief text cannot ride the streaming request.

**The admission gate runs in cost order.** A character cap at the DTO (free), then
a token count (one cheap native call), then the daily quota, and only then a
generation.

**Status events are coarse and never carry partial JSON.** Half-built JSON renders
as garbage and would make the wire contract depend on which provider is active.

**`scoring` must arrive during generation, not after it.** A callback nested inside
an `await` cannot yield from the enclosing generator, so the event is queued and
drained between awaits — see `common/interleave.ts`. The tests assert timing, not
just ordering, because the broken version produced an identical sequence.

**Abort propagates end to end.** Client disconnect → Nest's `finalize` → the
controller's signal → the adapter's fetch. On a free tier an ignored abort burns
shared quota, which is worse than burning money.

---

## Data model decisions

**`AppSetting` is a singleton**, enforced by a database CHECK rather than
convention.

**Provider keys are write-only over HTTP.** Every read selects columns that do not
include the credential, so there is no code path that could serve a key — not a
convention that one should not. There is no reveal endpoint because there is
nothing to build one out of. Keys are sealed with AES-256-GCM and bound to the
provider's id as additional authenticated data, so a copied row is useless without
both.

**Prompt versions are immutable once active**, enforced by a trigger. Editing
forks a new draft. The content hash is verified on every read, not only at boot,
so a diagnosis can never be attributed to content that has since changed.

**Cost is `null` when no price row exists, never `0`.** A silent zero is
indistinguishable from a genuinely free call and understates spend the moment a
paid model is added.

---

## The web app

Three route groups, and the split is the most important structural decision on
the public surface:

| Group | Routes | Frame |
|---|---|---|
| `(app)` | `/`, `/rubric`, `/examples` | Sidebar with the rubric ladder |
| `(public)` | `/d/[publicId]` | **None.** Deliberately bare. |
| `admin` | `/admin/*` | Compact density, own nav |

A stakeholder who opens a forwarded report and sees an app frame they cannot enter
reacts to the tool instead of the brief. The bareness is a feature.

**The browser never talks to the API directly.** `API_BASE_URL` is read in one
server-only module; every call goes through a route handler. The admin bearer
token is sealed in an httpOnly cookie and attached server-side, so an XSS on the
admin surface cannot exfiltrate a working credential.

**localStorage is the only claim made about identity.** "This browser scored these
briefs" is honest and needs no account. It is also what reveals the author-only
action row on a report — client-side, after hydration, so the server's HTML is
identical for every reader.

---

## Deliberately not built

- **Accounts.** Not even a greyed-out sign-in button — a disabled one is worse
  than none.
- **Server-side history keyed to IP or a fingerprint.** An account with none of the
  honesty and all of the liability.
- **Aggregate stats** ("the average brief scores 47"). Publishing an average
  invites arguing against the mean instead of reading the gaps.
- **A locally computed predicted score.** It will disagree with the real one and
  destroy confidence in both.
- **Live sample scoring.** Twenty model calls a day is the whole budget.
- **A Redis throttle store.** The in-memory store is per-instance, so a
  multi-replica deployment needs one. Noted rather than built.
