# Vocabulary

The objects every mode reads and writes. Modes cite this file; they never restate it.

## Change

One intended software change, and the only record of its lifecycle. Plans, PR text, matrices and summaries are views of it; never keep one as a second source of truth.

**Material** means it alters observable behavior, a contract, data shape, verification, risk class, architecture or an instruction surface. Below that line nothing is material; every use of the word points here.

A Change carries: target identity · intent (problem, desired outcome) · scope and non-goals · acceptance claims · decisions and unknowns · impact (surfaces, architecture class, risk, origin) · authority · proof obligations · slices · evidence · findings · residual risk · completion state. Serialized, it is `reference/change.schema.json`; each mode updates only the fields it owns and appends evidence and findings.

**Architecture class**

- `A0` — implementation-local: no meaning, ownership, boundary, public contract, state model, topology or critical property changes.
- `A1` — follows an explicit existing decision, and cites it. Conformance you cannot cite is intuition: treat it as `A2`.
- `A2` — creates or revises a decision about semantics, state, ownership, boundaries, public contracts, topology, dependency direction, failure behavior, operation or critical qualities. Creating a folder or a file is not, by itself, such a decision. The kernel's ≤10-line shape (rung 5) settles an `A2` whose drivers agree and that crosses no existing boundary; drivers in conflict, or an existing boundary crossed or redrawn → `/devanity architect`.

Between two classes, take the higher.

**Origin** — `trusted-local` (the user's own work) · `external` (a fetched PR, an applied patch) · `unknown`. Reading is not executing. Executing external or unknown code needs real isolation or an `acceptance` decision; consent is not isolation.

## Target identity

A conclusion is about one version of one thing. Record repository, ref, base and head, and a content fingerprint: `git diff HEAD | git hash-object --stdin`, plus a hash per untracked file in the target. `git status --short` is the inventory (files entering or leaving the set); only the fingerprint catches a rewrite of a file already in it.

Evidence belongs to the target it observed. When the target changes, invalidate the evidence whose subject changed. Never carry a verdict across a mutation you did not re-check.

## Evidence

An observation made against the target in this session: a read, a command and its exit code, a diff, a human confirmation. Confidence, fluency and summaries are not evidence. A check result exists only from a run in this session; otherwise write `NOT_RUN: <reason>`. A negative or completeness claim ("no X", "reviewed 12/12", "nothing else") is a check result: name what ran that could have falsified it.

## Authority

`observe < recommend < prepare < execute < commit < merge < deploy`

Before a side effect, name its rung and compare it with the ceiling this session was given (the rules file, the autonomy envelope, the human). Above the ceiling → stop at a decision. Tool availability, repository permission and confidence never raise the ceiling. `merge` and `deploy` are never granted to an unattended session.

## Decision

Every decision you cannot derive renders as this block. It hands over the rule, not the case: someone without this session's context must be able to decide from the block alone, and the answer must still hold in cases not yet seen.

```txt
- **[DECIDE][blocking|provisional|dormant][G-###][rule|trade|acceptance|scope|design] Question, one line**
  - axis: <map area> × <slug>
  - rule: <the sentence the answer instantiates, in product terms, true in cases not yet seen>
  - derivation: <the principle tried (`id: rule` from the map, a decision already made, a sibling), and why it does not decide this; or `none applies`>
  - context: <why it surfaced: one line of evidence> · anchors <G-### or Key>
  - options: <A → durable consequence> · <B → durable consequence> (2–4, one a no-op; only options no other beats)
  - recommendation: <the pick and its basis: labeled; `p=<0–1>` after the label, your probability that it is the answer>
  - acted: <provisional only: the option taken, where (`path:line`), and the one-line change that flips it>
  - if undecided: <the visible fate>
```

- **Status.** `blocking` is owed now (kernel: the high-risk class, or irreversible outside the repository) and dependent work stays blocked until a human answers; `if undecided:` names the fate (the dependent slice stays a failing stub, the verdict holds, it re-fires on the next run). `provisional` was acted on: the recommended option is in the code, `acted:` says where and how to flip it, and the human answers at review, in batch; a `no` there reverts that slice and is evidence against the rule, not a case. `dormant` may sleep and renders on one line: `- [DECIDE][dormant][G-###][trade] Title — worth doing when <pain observed> — anchors <Key>`. Deciding "defer" turns a blocking decision into a dormant one.
- **Kind.** `rule`: a recurring rule or product intent; a yes resolves to `<rule> → codify at <surface>`. `trade`: a fix-class trade (`reference/quality.md`). `acceptance`: someone takes on a risk, either an unfixed P0/P1 or the exposure of an action such as running untrusted code; record who, what, why, expiry and any compensating control. `scope`: what falls inside this unit (routing, a sub-scope, absorbing an unexpected change). `design`: a pick between materially different architectures that rests on product intent, organizational authority, accepted risk or a constraint nobody supplied (`modes/architect.md`). When `trade` and `acceptance` both fit, it is `acceptance`.
- **Axis and id.** The axis (`<map area> × <slug>`) is the durable identity of the question: one axis, one answer, every later case derived. A question whose axis a principle in the map already answers is attention wasted: `derivation:` names what was tried, so the reader sees the gap. `G-###` is the session alias, one sequence shared with findings; a decision the guard or the oracle queued keeps its ledger id (`D-…`, `T-…`, `I-…`).
- **Anchor, don't repeat.** A decision about a finding cites it and adds only the question, the options, the recommendation and the fate.
- **Only real trades reach a human.** An option that another beats or ties on every criterion that matters here is dropped before the block renders, and `context` names it and what beats it. When one option beats every other, there is nothing to trade: take it as the default the kernel allows, unless the choice is human-owned, which the kernel routes (blocking or provisional) even when one option looks best.
- **Recorded.** A `blocking` or `provisional` block in a final message is queued with its axis, rule, options and recommendation, so `/devanity pending` and the next session show the question, not an id. `/devanity decide <id> <option>` answers one and writes its `rule:` into the map as a principle of the axis's area (`from: [<id>]`), so it is never asked again; `/devanity accept [--except <id> <option>, …]` answers every provisional with its recommendation. An answer authorizes no edit: `/devanity allow <glob> [--standing]` does.
- **Answered stays answered.** A question a human already answered (a `decided` or `rejected` record in `<git-common-dir>/devanity/decisions.jsonl`, a principle in the map, or their own words this session) is never asked again: cite the answer. Words alone record nothing, so an answer given only in words gets its paste-ready `/devanity decide <id> <option>` line.

## Finding

A discrepancy between what should hold and what was observed.

```txt
- **[P0–P3][dominant|trade][G-###][dimension][rung] Title**
  - fix: <the one action> · <path:line>
  - Key: <path>:<symbol-or-heading>:<dimension>:<rule>
  - why: <evidence and risk, framed by the crosswalk test it maps to>
  - basis: <why this fix class>
- [P2][trade][G-007][pattern-hygiene][prose] One-line title — Key: <path>:<symbol>:<dimension>:<rule>
```

- **Headline axes**, in order and never mixed: severity judges the finding; fix class judges the fix; `G-###` is the alias; dimension is one slug from `reference/quality.md`; rung is `enforcement|path-scoped-context|procedure|prose`.
- **`Key:`** is the durable identity: a structural anchor, never a line number. `G-###` is a session alias for it. Numbering continues across runs in a session. A stale or cross-session alias does not resolve.
- **`fix:`** proposes exactly one action. "A or B" is an undecided fix, so it is a trade.
- **One-line form** (P2/P3, and every P1 after the first three): the whole headline, then `— Key: …`, no nested items. A one-line `dominant` also carries `— basis: <what was checked>`, or it is a trade.
- **The forms are exclusive.** A full form opens and closes its bold and carries each field once as a nested item; extra items (instances) are fine. A one-line form grows nothing. A `blocking` decision always renders full; a `dormant` one always on one line.
- **Compose before you render**: surface → sink → the crosswalk test → only then severity and dimension. Render the headline first. Never pick the tags before you can name the test behind `why:`.

## Rendering a report

- Findings and decisions are markdown list items. Nesting carries the structure, never bare indentation.
- Strict severity order: every P0 in full, the top three P1 in full, the rest on one line; P2/P3 one line each, or counts per dimension past about five. No prose between findings.
- A section whose value is one word carries it on the heading (`### Verdict BLOCK`). An empty section is the line `none` (or `none — <reason>`); an absent heading reads as unchecked. `### Decisions` renders only when one is owed, after the findings.
- No terminal verdict while a required unit (a file, group, dimension, check or owed decision) is unaccounted for: emit `none — <what is owed>` instead.
- Promotion to the issue tracker is proposed, never performed: draft the entry (the open question and the Key, never a coverage claim) and name a tracker only if you saw one. Never a backlog file of your own.
- End with exactly one next step, under its own heading.

## Verdicts

| Who | Verdicts, most severe first |
|---|---|
| review | `BLOCK` (an unaccepted P0) · `PASS_WITH_ACCEPTED_RISK` · `PASS_WITH_FIXES` (a P1 is open) · `PASS` |
| audit | `AUDIT_BACKLOG` |
| verifier (`agents/verifier.md`) | `INVALID_TARGET` · `FAILED` · `NOT_VERIFIED` · `VERIFIED` |
| a Change | `INVALID_TARGET` · `BLOCKED` · `NOT_VERIFIED` · `NO_CHANGE` · `CANDIDATE_READY` |

Several apply → emit the most severe. Accepted risk is `PASS_WITH_ACCEPTED_RISK`, never `PASS`. No PASS-class verdict authorizes a merge: `PASS_WITH_FIXES` names the P1s still owed.
