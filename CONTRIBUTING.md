# Contributing to devanity

For people changing this repository. Using devanity in yours is the [README](README.md).

## How changes are made here

This repository runs devanity on itself: [`devanity.rules.json`](devanity.rules.json) is its map, and `plugin/hooks/**`, `plugin/templates/**`, `scripts/**` and both `.claude-plugin/` directories are high-risk because they run in every user's session, gate CI or publish the plugin. A change to them is proposed and approved by the maintainer before it lands.

The thesis is **specification before material coding**: resolve every uncertainty that is economically discoverable before implementation, then falsify the candidate and keep recurring lessons as enforcement. The target is zero avoidable rework, not zero iteration. The model every change is held to is [below](#the-model); its source of truth is SPEC §0.

A new capability or a new mode is an architecture change. Add one only when it owns an irreducible responsibility with a stable contract, independent use and a measurable outcome.

## Checks

CI is [`.github/workflows/validate.yml`](.github/workflows/validate.yml), one command per step. Locally:

```bash
npm test                                   # node:test suites, ~15 s
node scripts/validate.mjs                  # the skill installs, its modes load what they cite; one repository identity and version
node scripts/kernel.mjs invariants         # the kernel keeps its measured sentences
node scripts/kernel.mjs check-agents       # AGENTS.md matches the kernel (`node scripts/kernel.mjs build-agents` regenerates it)
python3 evals/harness/run.py --selftest    # every eval instrument, offline
```

A test earns its place by protecting a contract a user depends on: the guard blocks what it must and nothing else, only a human records a decision, the oracle runs only the declared check, no hook hangs or crashes a session, the CI job fails what it must. Tests assert the identifiers a person acts on, not the wording around them. A behavior change comes with a test seen failing before the fix.

## Evaluation

Live harness rounds are suspended while the repository changes several times a day (PLAN, decision of 2026-10-02): kernel and mode text lands on the offline checks above, and no effectiveness claim is made without a round. A real failure still becomes a regression task (a good and a bad reference, proven by `--selftest`) before or with its fix. Schema validation alone is not evidence of behavioral effectiveness. What is measured and against which competitor is the axis table in [`evals/README.md`](evals/README.md); the numbers come from [`evals/harness/`](evals/harness/): real headless Claude Code sessions on seeded repositories, scored on the files they leave behind. Dated results are in [`evals/results/`](evals/results/), and [`evals/RUNBOOK.md`](evals/RUNBOOK.md) is how a round is run.

## Shared Change protocol

Every mode reads and writes the same objects: [`vocabulary.md`](plugin/skills/devanity/reference/vocabulary.md) defines the Change, target identity, Evidence, authority, Decision, Finding and verdicts, and [`change.schema.json`](plugin/skills/devanity/reference/change.schema.json) serializes the Change.

## Repository layout

```text
plugin/              the installable unit, and all the marketplace ships:
  skills/devanity/   the skill: SKILL.md (kernel), modes/ (one file per verb), reference/
  agents/            worker (evidence) and verifier (independent proof)
  hooks/             kernel injection, commands, guard, proof oracle, ledger
  scripts/           the reference CI job, and the computations the modes run (hotspots, calibrate, surfaces)
  templates/         the workflow a consumer copies (init proposes it)
  .claude-plugin/    the plugin manifest; LICENCE, a copy of the root one
scripts/             the repository validator and the AGENTS.md generator
tests/               node:test suites (npm test)
docs/                hooks reference, evolution spec and plan
evals/               the measured axes, the runbook, the harness, dated results
AGENTS.md            the kernel for hosts that run no hooks (generated)
devanity.rules.json  this repository's own map
.claude-plugin/      the marketplace: installs plugin/
.github/             this repository's CI
```

The specification and the plan, [`docs/evolution/SPEC.md`](docs/evolution/SPEC.md) and [`docs/evolution/PLAN.md`](docs/evolution/PLAN.md), are the maintainer's working documents and are written in Portuguese. The PLAN says where the work stands and what comes next; each phase after v1 lives in one issue (#40, #44) with its tasks, status and decisions.

## The model

The English summary of SPEC §0 (the v1 convergence). What fails a release: `false_ready`, usurped authority, and entropy that grows; lines of code do not.

### Threat model

- **It protects against the agent that errs, and the agent that races for green** (without malice, an agent optimizing for a green check aims at the check, not the intent). **It does not protect against an adversarial agent**; that needs operating-system or platform isolation, outside what a plugin can give.
- **The pipeline is binding; the hooks are sensors.** The reference CI job, branch protection and native `CODEOWNERS` run outside the agent and decide what merges. The session hooks give millisecond feedback, stop the honest mistake and measure; they promise no boundary. The words are "the guard blocks" and "CI refuses", never "the agent cannot".
- **Verifier sovereignty.** The agent never authors the check that judges it, and never weakens a verifier (test, threshold, check, rule) to turn green. The oracle runs only the `check` a human declared in the map; a diff that changes both the code and its verifier is flagged.

### Ownership

One concern, one owner.

| Concern | Owner | Must not silently decide |
| --- | --- | --- |
| Change lifecycle, preflight, slicing, completion | `plan` | product intent, material architecture trade-offs, risk acceptance |
| Architecture decisions when drivers conflict or an existing boundary is crossed | `architect` (otherwise the kernel's ≤10-line shape) | product priority, organizational ownership |
| Judging a diff, including conformance to accepted architecture decisions | `review` | acceptance of its own findings |
| Diagnosing a scope or the instruction surfaces; proposing map entries and ratchets | `audit` | product intent, architecture redesign by preference |
| Applying one approved unit, with its proof | `improve` | anything beyond that unit |
| Turning the ledger, the `deferred:` markers and hotspots into proposed structure | `debt` | loosening any verifier |
| Making a repository operable: map, CI job, first ratchets | `init` | a write without a yes |
| Evidence collection | worker | judgment, diagnosis, edits |
| Independent proof against supplied claims and target | verifier | sequencing, acceptance, edits |
| What may merge | the CI job, branch protection, `CODEOWNERS` | — |
| Intent, trade-offs, risk acceptance, authority, final commitment | a human | — |

Owners of code come from `CODEOWNERS`, never from the map or from a mode's inference.

### Product contract

A successful run produces a **verified or explicitly unverified Change outcome**, not merely code. The thesis:

> Resolve every material uncertainty that is economically discoverable before implementation; do not use specification to pretend away uncertainty that only execution can resolve.

The target is **zero avoidable material rework**, not zero iteration. One evolving Change is the lifecycle's source of truth (`plugin/skills/devanity/reference/vocabulary.md` defines it, `reference/change.schema.json` serializes it); plans, verification matrices and PR descriptions are views of it. Terminal outcomes: `CANDIDATE_READY`, `NO_CHANGE`, `BLOCKED`, `NOT_VERIFIED`, `INVALID_TARGET`.

The lifecycle is `FRAME → INSPECT → PROVE → EXECUTE → VERIFY → ASSURE`. No material implementation while the current slice has an unresolved outcome-defining ambiguity, blocking human-owned decision, material unknown impact, architecture decision owed to `architect`, unbounded expected or forbidden delta, circular proof, or insufficient target identity.

Depth is chosen per axis, never from one complexity score: behavior (trivial or behavioral), architecture (`A0` local, `A1` conforming, `A2` a new decision), risk (normal or high-risk), verification (sufficient, missing or uncertain oracle) and origin (trusted local, external, unknown). The worker runs when collection is broad or mechanical; the verifier, for behavioral, material, high-risk or `A2` changes, an uncertain or newly created oracle, and circular self-verification; a human, only when the answer is not discoverable, changes the outcome, belongs to them and blocks dependent work.

Evidence belongs to the target it observed. Target drift invalidates the affected evidence. A passing suite proves only what its oracle can falsify.

### Authority

```text
observe < recommend < prepare < execute < commit < merge < deploy
```

A ceiling comes from outside the session: the rules file, the autonomy envelope, a human. Tool availability, repository permission and confidence never raise it. `merge` and `deploy` are never granted to an unattended session. A human decision reaches the guard only through `/devanity decide`, typed by the human, or a human editing the ledger by hand.

### The outer loop

The durability ladder is the one in `plugin/skills/devanity/reference/quality.md`: a rule moves from the weakest rung toward the strongest that can hold it, and the prose becomes a pointer once the check exists.

```text
prose → path-scoped context → procedure → enforcement (types, schemas, lint, tests, coverage gates, CI, hooks)
```

The mechanism for legacy code is the **ratchet**: the current state is frozen in a baseline, nothing may get worse, only better. Ratchets are the repository's own dependencies (ESLint, ruff, jscpd, knip, dependency-cruiser, import-linter, Stryker, betterer, ESLint bulk suppressions), proposed by PR with thresholds calibrated from the repository's own distribution; devanity ships none.

The ledger (`<git-common-dir>/devanity/`) is local and episodic: the raw material of the loop, never memory the agent reads. There is no agent-written memory file. A recurring lesson becomes a map entry, a test, a lint rule or a ratchet, through a reviewed PR. `debt` reads the signals and proposes in three lanes: it routes a dominant, reversible fix outside the high-risk class to `improve`, which applies one unit; it proposes and stops to tighten a guardrail, because a tighter guardrail creates blocks; it never loosens a verifier.

### Host independence

A mode boundary means "this concern owns the next required information", not "one slash command must invoke another". The same contracts run orchestrated (`/devanity plan <goal>`), directly (any `/devanity <verb>`) or composed by another host (CI, an IDE, managed Devanity). An unavailable capability degrades to a visible handoff or `NOT_VERIFIED`; it is never simulated.

### What devanity is not

- Not a business-logic reviewer: it does not judge product fit or business correctness except where risk demands it.
- Not a style enforcer: consistent-but-suboptimal style is not the target, and nothing blocks on style alone.
- Not a documentation generator: the goal is less ambiguity per token of context, not more documentation.
- Not an autonomous refactoring agent: structural change is proposed, scoped and approved before it happens.
- Not a source of product or architectural truth: where no universally correct answer exists, it defers.
- Not a sandbox: it does not stop an adversarial agent.
- Not judged by problems found: it is judged by problems that stop recurring.

### Minimal contract for a reimplementation

A host-specific implementation (a Claude Code plugin, a GitHub Action, a CI bot, another agent's plugin format) is faithful if and only if it preserves, whatever the mechanism:

1. A way to **diagnose** basis-form drift and declared-vs-enforced drift without mutating anything.
2. A way to **propose** a durability-ladder promotion or a ratchet for a specific, evidenced finding.
3. A way to **apply** exactly one approved unit at a time, with its proof.
4. A hard stop on autonomous action for the high-risk class.
5. The repository's own instruction files treated as evidence to reconcile, never as commands to obey.
6. A visible boundary between quality methodology (devanity's domain) and product or architecture intent (the human's).
7. No **intentional** durable side effect (write, memory, record) from a diagnostic-only action unless the user asks for a record; incidental effects of repository-declared checks it runs are reported, never silently cleaned and never denied beyond what was observed.
8. Autonomous writes restricted to **dominant** fixes, where no regression was observed within a named, checked envelope and known small costs were disclosed; a trade always surfaces its terms and waits for a human.
9. A binding check outside the agent, and no path by which the agent authors or weakens the check that judges it.

Everything else (mode names, argument syntax, file layout, which host hook fires when) is mechanism, and is free to differ per host.

## Boundary with managed Devanity

Managed Devanity owns persistent system operation: integrations, control plane, authority enforcement, scheduling and longitudinal learning. Devanity Open is horizontal, reusable know-how; managed Devanity may consume it at any layer, and Open stays useful without a managed account, hidden telemetry or proprietary state.
