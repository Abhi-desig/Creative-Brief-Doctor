# Feature Specification: Provider-agnostic AI configuration

**Feature Branch**: `claude/creative-brief-doctor-nq6oj5`

**Created**: 2026-08-01

**Status**: Implemented

**Input**: User description: "Provider-agnostic AI configuration. An operator must be able to add a second AI provider through the admin panel, switch the active provider and model to it, and have the very next public diagnosis use it — without restarting or redeploying anything. The engine must never name a model itself: provider, model and generation parameters are resolved from the database and handed in. The admin form must render only the parameters the selected provider actually supports, iterating a capability descriptor rather than disabling controls, so submitting an unsupported parameter is structurally impossible. A provider whose adapter does not exist in the build must be refused at save time rather than activating and taking the app down. Nothing configured, an unreadable credential, or an unbuildable provider must all degrade with a specific reason and keep the admin panel reachable — never a 500. Provider API keys are write-only over HTTP: encrypted at rest, bound to the provider row, and returned by no endpoint. Every settings change is audited."

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Swap the model without a deployment (Priority: P1)

An operator notices the current model is producing weaker diagnoses, or is being
rate-limited, or has become more expensive. They open the admin panel, add a
second provider's credential, select it along with a model, and save. The next
brief a member of the public scores uses the new provider. Nothing is restarted,
nothing is redeployed, and nobody using the public tool sees an interruption.

**Why this priority**: This is the feature. Without it the provider abstraction is
theoretical — the active provider could only ever be set by an environment
variable at first boot, so changing it means a redeploy, which means the
abstraction buys nothing an environment variable did not already buy.

**Independent Test**: Add two providers through the panel, switch between them,
and confirm a diagnosis created afterwards records the second provider and model.
Fully testable without touching the public interface.

**Acceptance Scenarios**:

1. **Given** no provider is configured, **When** the operator adds one and selects
   a model, **Then** the next diagnosis uses it and the system stops reporting a
   degraded reason.
2. **Given** one provider is active, **When** the operator adds a second and
   switches to it, **Then** a diagnosis created immediately afterwards records the
   second provider and its model, with no restart.
3. **Given** a change has just been saved, **When** the configuration is read
   again, **Then** it reflects the change immediately rather than after a cache
   period.

---

### User Story 2 - Be stopped from breaking scoring (Priority: P1)

An operator selects a provider or a parameter that cannot work. They are told at
the moment they save, in terms that name what to do instead, and the previous
working configuration is left untouched.

**Why this priority**: Equal to Story 1, because a configuration panel that can
take the product down is worse than no panel. The operator acts on behalf of every
user, so the blast radius of a bad save is total.

**Independent Test**: Attempt to activate a provider with no adapter, with no
credential, and with an unreadable credential. Each is refused with a distinct
reason and the prior configuration survives.

**Acceptance Scenarios**:

1. **Given** a provider whose adapter is not in this build, **When** the operator
   tries to make it active, **Then** the save is refused with a reason naming the
   problem, and the previously active configuration still governs scoring.
2. **Given** a model the provider does not offer, **When** the operator saves it,
   **Then** the save is refused and the available models are listed.
3. **Given** a provider that honours no temperature control, **When** the operator
   views the form, **Then** no temperature input is present at all — not a
   disabled one.

---

### User Story 3 - Recover from a broken configuration (Priority: P2)

Something has gone wrong: no provider is configured on a fresh deployment, or a
credential can no longer be decrypted after a key rotation, or an active provider
has become invalid. The public tool declines to score, saying so plainly, and the
admin panel remains reachable so the operator can fix it.

**Why this priority**: Lower than P1 because it is a recovery path rather than the
daily one, but it is what makes P1 safe to attempt. An operator who cannot reach
the panel after a bad save has no way back.

**Independent Test**: Put the system into each degraded state and confirm the
reported reason is specific, the admin panel loads, and no request returns a
server error.

**Acceptance Scenarios**:

1. **Given** nothing is configured, **When** the system starts, **Then** it
   reports itself as running-but-degraded with the reason, and the panel loads.
2. **Given** a credential that cannot be decrypted, **When** anything reads the
   configuration, **Then** the reason distinguishes it from "nothing configured",
   because the two fixes differ.
3. **Given** any degraded state, **When** any endpoint is called, **Then** none of
   them returns a server error.

---

### User Story 4 - Trust that credentials cannot leak (Priority: P2)

An operator enters an API key. From that moment nothing can retrieve it — not the
panel, not an API response, not an audit record, not a support request.

**Why this priority**: A leaked provider key is billable by whoever finds it and is
not revocable by this system. Lower than P1 only because it constrains rather than
enables.

**Independent Test**: Create a provider with a key, then attempt to retrieve it
through every read path and inspect every audit record.

**Acceptance Scenarios**:

1. **Given** a stored credential, **When** any endpoint returning provider data is
   called, **Then** the response contains no part of the key beyond a last-four
   fragment for recognition.
2. **Given** a settings change, **When** its audit record is read, **Then** it
   contains no credential material.
3. **Given** a copied storage record, **When** it is decrypted outside its original
   provider, **Then** decryption fails.

### Edge Cases

- **The provider's model list is unreachable.** The operator must still be able to
  change the model — a failing list endpoint cannot become a lock-out. The model
  name is left unvalidated rather than the save being refused.
- **A parameter is cleared rather than changed.** Clearing is a distinct operation
  from leaving alone, and is how an operator moves to a model that rejects a
  parameter without leaving a stale value behind.
- **A partial save.** Submitting one field must not blank the others.
- **Two operators save at once.** Last write wins; both are audited, so the
  sequence is reconstructable.
- **The configuration changes mid-diagnosis.** The in-flight diagnosis completes
  against the provider it started with and records that one, because attribution
  must match what actually ran.
- **A provider is disabled while active.** Scoring degrades with a reason rather
  than erroring.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: Operators MUST be able to add, edit, disable and test provider
  credentials without a deployment.
- **FR-002**: Operators MUST be able to change the active provider, model and
  generation parameters, and the change MUST take effect for the next scoring
  operation with no restart.
- **FR-003**: The scoring engine MUST NOT name a provider or model. Both are
  resolved externally and supplied per call.
- **FR-004**: The configuration form MUST render controls by iterating the selected
  provider's declared capabilities. A parameter the provider does not honour MUST
  have no control at all, so that submitting one is not merely rejected but
  structurally impossible from the interface.
- **FR-005**: The system MUST reject a submitted parameter the provider does not
  honour, independently of the interface, and MUST NOT silently discard it.
- **FR-006**: The system MUST refuse to activate a provider it cannot construct —
  no adapter, no credential, or an unreadable credential — and MUST leave the
  previous configuration in force.
- **FR-007**: The system MUST validate a chosen model against the provider's
  offered models where that list is available, and MUST NOT block the save where it
  is not.
- **FR-008**: Every configuration state that prevents scoring MUST be reported with
  a distinct, actionable reason, and MUST NOT produce a server error from any
  endpoint.
- **FR-009**: The administrative interface MUST remain reachable in every degraded
  state.
- **FR-010**: Provider credentials MUST be encrypted at rest, bound to their
  provider record such that a copied record cannot be decrypted, and MUST NOT be
  returned by any endpoint.
- **FR-011**: Every configuration change MUST be recorded with the actor, the
  change and the time, containing no credential material.
- **FR-012**: A diagnosis MUST record the provider and model that actually produced
  it.

### Key Entities

- **Provider**: A credential and endpoint for one AI vendor. Has a kind, an
  operator-chosen label, a status, and a sealed credential. Several may exist; at
  most one is active.
- **Active configuration**: The single record naming which provider and model are
  in use, plus the generation parameters and the ceilings that guard spend. Exactly
  one exists, enforced at the storage layer rather than by convention.
- **Capability descriptor**: What a provider declares it can do — which parameters
  it honours, its output and context limits, how it produces structured output.
  Read by both the interface and the engine, so both see the same answer.
- **Audit record**: Who changed what, and when.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: An operator can move scoring from one provider to another in under
  two minutes, with no deployment and no interruption visible to anyone using the
  public tool.
- **SC-002**: A diagnosis created after a provider change is attributed to the new
  provider in 100% of cases.
- **SC-003**: No configuration state — including nothing configured at all —
  produces a server error from any endpoint.
- **SC-004**: An operator presented with the configuration form can submit a
  parameter the selected model rejects in zero cases, because no such control is
  rendered.
- **SC-005**: A stored credential is retrievable through zero interface or API
  paths after it has been saved.
- **SC-006**: Adding support for a new AI vendor requires changes in no more than
  three files outside the vendor's own adapter.
- **SC-007**: Every configuration change is attributable to an actor and a time,
  with no gaps.

## Assumptions

- **A single operator role.** There is one administrator credential, supplied by
  the environment. Multi-user administration, roles and per-user permissions are
  out of scope; consequently the audit trail identifies an account rather than
  distinguishing colleagues.
- **At most one provider is active at a time.** Routing between providers per
  request, A/B comparison and automatic failover are out of scope. Several
  providers may exist so that switching is instant, not so that they can be used
  concurrently.
- **In-flight work is not migrated.** A configuration change applies to the next
  operation, not to one already running.
- **Capability declarations are trusted.** A provider adapter's declared
  capabilities are taken as true; the conformance suite is what holds them honest,
  and a false declaration is a defect in the adapter rather than something the
  configuration layer detects at runtime.
- **The credential encryption key is managed outside this system.** Losing it means
  re-entering every provider credential; that is accepted rather than mitigated
  with an escrow mechanism.
- **A single running instance, for cache purposes.** Configuration is cached in
  memory and invalidated on write. A multi-instance deployment would need shared
  invalidation; this is a known limitation rather than a solved problem.
