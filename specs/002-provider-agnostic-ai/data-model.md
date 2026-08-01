# Phase 1 — Data model

**Feature**: Provider-agnostic AI configuration | **Date**: 2026-08-01

No schema changes were needed for this feature. Everything below already existed;
this records what it means and which invariants are enforced where, because
several are enforced by the database rather than by application code and are
therefore easy to miss when reading the services.

## AiProvider

One vendor credential.

| Field | Meaning |
|---|---|
| `kind` | `GOOGLE` \| `ANTHROPIC`. The only thing `adapter.factory.ts` branches on. |
| `label` | Operator's own name. Shown in the picker; never interpreted. |
| `baseUrl` | Optional. For a proxy or compatible gateway. |
| `status` | `UNTESTED` \| `OK` \| `FAILING` \| `DISABLED`. Advisory except `DISABLED`, which blocks activation. |
| `keyCiphertext`, `keyIv`, `keyTag` | AES-256-GCM. |
| `keyLast4` | The only fragment any read path may return. |
| `keyVersion` | Incremented on rotation. |

**Invariant: the credential is bound to the row.** The provider's id is the
additional authenticated data for the GCM seal, so a row copied to another
provider fails to decrypt rather than silently working. This is what makes FR-010
a property of the data rather than a rule about queries.

**Invariant: no read path selects the credential columns.** Enforced by every read
going through a select list that does not name them, so there is no code path that
could return a key — rather than a convention that one should not.

## AppSetting

The active configuration. Exactly one row.

| Field | Meaning |
|---|---|
| `id` | Always `'singleton'`. |
| `activeProviderId` | Null when nothing is configured — a valid state. |
| `activeModel` | Null likewise. |
| `maxTokens`, `temperature`, `topP`, `thinkingBudget` | Generation parameters. The last three are nullable, and null means "do not send", which is distinct from "not yet set". |
| `timeoutMs`, `maxRetries` | Transport. |
| `tokenCeiling` | A brief above this is refused before any call is made. |
| `dailyCallCap` | Guards the shared upstream quota. |
| `costCeilingUsd` | Decimal. Never a float. |
| `updatedBy` | Actor, for correlation with the audit log. |

**Invariant: singleton.** A `CHECK (id = 'singleton')` in the migration, not a
convention. A second row is refused by the database.

**Why the three parameters are nullable rather than defaulted:** a default would
mean the system always has an opinion about `temperature`, including for models
that reject it. Null lets the resolved configuration say "do not send this", which
is what the capability gate and the adapters both need to hear.

## ModelPricing

Effective-dated rates.

**Invariant: cached reads are a SUBSET of input tokens.** Not a database
constraint — a normalisation contract the adapters honour and the port now
documents. It is recorded here because pricing depends on it: fresh input is
`inputTokens - cachedReadTokens`, and billing both in full double-charges the
cached portion invisibly.

**Invariant: no row means `null`, never `0`.** A free tier genuinely has no price
table, and a zero is indistinguishable from a real free call.

## AdminAuditLog

| Field | Meaning |
|---|---|
| `actor` | The administrator's email, or `system` for bootstrap. |
| `action` | `settings.update`, `provider.create`, `prompt.activate`, … |
| `targetType`, `targetId` | `AppSetting`/`singleton` for this feature. |
| `before`, `after` | Snapshots. |

**Invariant: no credential material in a snapshot.** For this feature it holds
structurally rather than by redaction: `AppSetting` contains a provider *id*, never
a key, so there is nothing in reach to leak.

## State transitions

```
             ┌──────────────────────┐
             │  NO_ACTIVE_PROVIDER  │ ◄── fresh deploy, or provider disabled
             └──────────┬───────────┘
                        │ operator adds a provider and selects a model
                        ▼
   ┌───────────────► ACTIVE ◄──────────────┐
   │                    │                  │
   │   credential       │   kind has no    │  operator switches
   │   unreadable       │   adapter        │  to another provider
   │                    ▼                  │
   │        ┌───────────────────────┐      │
   └────────┤ CREDENTIAL_UNREADABLE │      │
            │ PROVIDER_UNAVAILABLE  │──────┘
            │ NO_CREDENTIAL         │
            └───────────────────────┘
```

Every state on the right is reachable, reported with its own reason, and leaves
the admin panel usable. `PROVIDER_UNAVAILABLE` is additionally unreachable by a
deliberate save, because activation of an unbuildable provider is refused — it can
only be arrived at by a build that dropped an adapter, or by a bootstrap
environment variable.

The reasons are distinct rather than collapsed into one because the fixes differ:
`NO_ACTIVE_PROVIDER` means add one, `NO_CREDENTIAL` means supply a key,
`CREDENTIAL_UNREADABLE` means re-enter it, `PROVIDER_UNAVAILABLE` means choose a
different provider entirely.
