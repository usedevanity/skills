# architect

Load: `reference/vocabulary.md` (architecture class, Decision); `reference/change.schema.json` for the status it records.

Decide architecture when a change is material to it. The input is the words after `architect` (a system, a change, a question) or the packet `/devanity plan` hands over. Start from the required properties and meanings, then derive state, ownership, boundaries, topology, failure behavior, enforcement and evidence from them. Never start from a technology, framework, pattern or folder template.

## Gate

Classify first (`reference/vocabulary.md`):

- `A0` → return the constraints that already hold, and stop.
- `A1` → cite the decision or contract being followed, state the conformance constraints, and stop. No citable decision → it is `A2`.
- `A2` whose drivers agree, that crosses no existing boundary and alters no `core` invariant → the kernel's ≤10-line shape is the whole answer: write it and stop.
- `A2` with drivers in conflict, crossing or redrawing a boundary, or altering a `core` invariant → run the phases.

## Rules

- Semantics before structure: settle concepts, identity, state, transitions, invariants and sources of truth before modules, services or folders.
- Optimize the objectives, and never average away a hard constraint (security, correctness, data loss, authorization, auditability).
- Every module, service, store, broker, abstraction, directory axis and protocol earns its cost against a named driver (see Minimality).
- A decision is a conditioned hypothesis: record its assumptions, consequences, expected evidence, and the condition that forces a revision.
- Operation is architecture: failure, recovery, rollback, load, security, observability and evolution are part of the design.
- Design for limited context: one owner per meaning, explicit contracts, local verification, one obvious home for new behavior.
- Keep observed fact, inference, assumption, accepted decision, implemented constraint and enforced constraint apart. Never present an inference as a rule.
- Stop at a `design` decision when materially different architectures remain and the choice depends on product intent, organizational authority, accepted risk, or a constraint nobody supplied.
- Owners come from the repository (`CODEOWNERS`, an ADR, a human's word). Never invent organizational ownership: an unknown owner is `owner: unknown`, and a critical choice that depends on it is the organizational-authority stop above.

## Phases (A2)

The phases are ordered by dependency. Skip depth that cannot change a decision, but never skip a kind of information that a later decision needs. Name every skip on one `Skipped: <what> — <why>` line. Each phase adds one class of information and never redefines another phase's; a later phase that needs to change an earlier one reopens that phase's gate. Close each phase with `Gate: PASS` or `Gate: FAIL — <unmet criterion>`.

**P1 Align**: what must be true, for whom, and why. Cover purpose and boundary, stakeholders and who decides, capabilities, non-goals, drivers, critical properties, hard constraints, dominant losses, and the time horizon. Turn each abstract quality into a scenario: `property · source · stimulus · environment · artifact · expected response · measure · criticality · owner`. *Critical*, here and below, means a scenario with high criticality, or a hard constraint.
Gate: no critical driver is left undispositioned; purpose, boundary, non-goals, authority and critical properties constrain the later choices.

**P2 Represent**: what the system means and how its state may change. Per concept: `meaning · identity · owned state · invariants · commands · events · source of truth · semantic owner`. Per transition: `state + command + preconditions → new state + effects + events`. Say what an event or status does *not* mean wherever conflating them breeds defects: authorized is not settled; accepted is not completed.
Gate: central concepts have one meaning each; invariants and transitions are explicit; each source of truth and owner is known.

**P3 Compose**: where state and responsibility live. Derive boundaries from reasons to change, consistency needs, failure containment, trust, scaling independence and ownership, never from nouns or framework habit. Per unit: `responsibility · owned concepts and state · public contracts · dependencies · forbidden dependencies · local invariants · local verification · owner`. A unit with no independent responsibility, contract, state, failure boundary, owner or evolution need is an empty axis. Keep one source of truth per meaning; any replication names its authority and its reconciliation rule.
Gate: every important responsibility and piece of state has one owner; collaboration goes through explicit contracts; dependency direction supports the independent changes that are required.

**P4 Harden**: behavior under failure, pressure, misuse and attack. Per hazard: `trigger · path to loss · prevention · detection · containment · recovery · residual risk · who may accept it`. Cover each class the design touches, or name it on a `Skipped:` line: time, retry and idempotency; concurrency and consistency; overload and degradation; privacy and destructive operations; recovery and rollback; audit. A design that describes only the nominal path is not complete. Keep these apart: retryable is not idempotent; at-least-once delivery needs consumers that tolerate duplicates; authorization, decision and execution are separate; an attempted action is not an observed outcome; an undetectable critical failure is a design defect; human confirmation records acceptance and isolates nothing.
Gate: each class above is covered or skipped with its reason; each critical loss has prevention, detection, containment and recovery in proportion to its risk.

**P5 Encode**: how decisions become checks. Use the strongest mechanism that decides the property with acceptable precision and latency: types, schemas, contract tests, dependency rules, fitness functions, CI or runtime gates, signals tied to properties. Prose explains a decision; it is never the only control for a decidable critical invariant. Per critical property: `property · decision · enforcement · verification · operational signal · evidence owner · blind spots`. Never compute a composite "architecture health" score.
Gate: every critical decision has enforcement or evidence, or a stated reason why it stays human-judged.

**P6 Release and revise**: what reality confirmed or broke. Conformance has an owner: `/devanity review` checks every later diff against the accepted records. Revisit a decision when an assumption turns false, a scenario misses its bound, operation contradicts the model, change amplification grows, a boundary keeps leaking, or a simpler design now covers the problem.
Gate: the implementation traces back to the critical decisions; deviations are explicit; every conditioned decision shows its revision condition.

## Topology

When the decision changes where code lives, project the semantic model into the smallest physical structure that passes all five tests:

- **Tree decode**: a shallow look at the tree yields a mostly correct mental model.
- **Placement**: new behavior has one obvious home.
- **Change locality**: a conceptually local change stays local.
- **Deletion**: removing a capability removes one coherent region.
- **Dependency**: the direction of dependencies is understandable and enforceable.

A folder per concept, or a layered, feature or hexagonal template chosen by taste, fails these tests.

## Checks on the design

- **Basis-form**, applied to the design itself: *irreducible* (no duplicate semantic owner, rule, schema or state authority that can drift); *orthogonal* (each concern changes for one reason); *spanning* (the model covers the relevant states, failures and change classes, not only today's examples); *decodable* (meaning, ownership, contracts and local checks can be found with bounded context). They are not a score, and a material trade between them needs a human decision.
- **Pivot test**, for any core the design draws or touches (a `core` path in `devanity.rules.json`, or the stable center the phases derive): name the two or three adjacent pivots it must survive (a new channel, market, pricing model, product line) and the one it refuses. Its invariants are rigid and its content flexible, so a pivot is absorbed at the boundary (an adapter, a projection, a new optional field), never by editing an invariant. A core that survives every pivot is generic and fails; one that a named adjacent pivot breaks is too narrow. Projections (reports, exports, views, prompts) are never its source of truth.
- **Minimality**: for each element, ask which driver needs it, which failure or change it contains, what it costs, and whether something smaller satisfies the same properties. If no driver survives, remove the element.
- **A novel problem**: derive in this order: outcome or loss → property → invariant → one owner → the smallest boundary that preserves it → stress it → encode it → the evidence that would falsify it → the revision condition.
- **Reject on sight**: microservices or modularity as goals; abstractions for hypothetical consumers; async without ordering and idempotency semantics; logical ownership conflated with deployment; eventual consistency without a stated invariant; domain meaning duplicated across code, schemas, docs and prompts without one authority; scalability, security or reliability claims without a scenario; a diagram offered as proof: diagrams are optional projections, and a box diagram never stands in for state, failure or contract semantics.

## Output: the decision packet

Produce the smallest packet implementation needs, and omit any section that carries no decision:

```yaml
architecture_class: A2
purpose_and_scope:
drivers_and_critical_properties:
semantic_model:
state_and_invariants:
core_and_pivots:            # only when a core is drawn: what it holds, the pivots it survives, the one it refuses
boundaries_and_ownership:
contracts_and_dependencies:
repository_topology:        # only when placement is material
failure_security_operations:
decisions:                  # one record each, below
enforcement_and_evidence:   # one P5 record per critical property
implementation_constraints:
blocking_decisions:         # decision blocks (reference/vocabulary.md)
residual_risk:
```

One record per material decision. This is the ADR:

```yaml
id:
context:
drivers:
alternatives:            # the real ones; a single forced solution names the constraint that forced it
decision:
properties_favored:
properties_sacrificed:
consequences:
assumptions:
enforcement:
evidence_expected:
revise_when:
authority:
status:                  # proposed | accepted | implemented | enforced | observed | disputed | stale | invalidated | superseded
```

If the repository keeps ADRs, render the records in its format and propose the files. Otherwise they stay in the reply.

## Completion

The architecture is done when implementation can rebuild, for each critical property, the chain objective → scenario → decision → structure → enforcement → signal → revision condition. When topology is material, implementation must also know where each responsibility belongs, which dependencies are allowed, and how drift is detected. Name any broken link; never paper over it. Record the outcome as the Change's `architecture.status`: `A0` → `not-required`; `A1` → `conforming`; the kernel shape, or every chain complete → `resolved`; a blocking `design` decision open → `needs-decision`; a named broken link → `incomplete`. Then hand the constraints back to `/devanity plan`, which owns the sequencing.
