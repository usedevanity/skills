# improve

Load: `reference/vocabulary.md`, `reference/quality.md`, `reference/baseline.md`; `reference/claude-code.md` for an ambiguous reference.

Fix exactly one approved unit, on the ladder (`reference/quality.md`): a finding, or one instruction surface. The words after `improve` are the reference; with none, ask. When the human typed `improve <ref>`, that is the approval for that one unit; when you routed here yourself, state how you read the reference and ask before any write. Either way, four exceptions stop for a decision with the proposed patch: the high-risk class (kernel rung 4), a trade, a new dependency, or a hook or CI change.

## Resolve

A path to an instruction surface, not a Key, makes that one file the unit: run the instruction syndromes on it (`reference/quality.md`) and apply its dominant fixes inside it. A fix that must write a second file is not this unit: audit it and improve the resulting Key. A path absent from disk is a unit only as the missing home a finding's `fix:` names (`modes/audit.md`, Instruction surfaces): `improve <path>` creates that file with exactly the rules the finding lists, which is propagation, never an empty axis (`reference/quality.md`, Basis-form). No such finding this session → ask.

1. **Find the Key.** A `G-###` in this session's findings → its Key. A full Key resolves on its own, because it carries its path. An unambiguous suffix of a Key → resolve it against this session's findings. Several matches → list them and ask. No match (always the case in a fresh session) → ask for the full Key. A stale or cross-session alias → ask, or re-run the diagnostic. Parse the Key right to left: the last segment is the rule, then the dimension, and the rest splits at its first colon into path and symbol. Fewer than four segments, or a dimension not in `reference/quality.md` → the Key is malformed: ask.
2. **Locate.** Read the path and find the symbol. If either is gone, stop and ask: a vanished file is not a fixed finding. The exception is a Key whose path is the missing home its finding's `fix:` names: that path is the target, with no symbol to find.
3. **Re-verify.** Violation absent → `ALREADY_RESOLVED [<ref>] — <evidence run this session>`, and stop. Violation present, but the evidence shows an undeclared invariant (the divergence is intended and the rule is stale; `reference/baseline.md`, Reconciliation) → `RECLASSIFIED [<ref>] — <the stale rule and its evidence>` with the replacement finding, and stop.

## Fix

- **Basis-form migration** (case → basis, or collapsing an empty axis) → migrate first, then promote the syndrome to a check. A check written against the case list outlives the cases it was meant to remove.
- **Mechanizable** → codify the enforcement, not just the instance, using a rule or plugin already available. One that needs a new dependency or a hook or CI change → propose it and stop.
- **Not mechanizable** → make the smallest correct prose or spec change. If it needs product or architecture judgment, route it to `/devanity plan` or `/devanity architect`.

Fix one finding with a small patch, never mixed with feature work. A structural change (many files, redrawn boundaries) is not one `improve`: plan it with `/devanity plan`, then run it as a sequence of `improve` units.

## Oracle before fix

A unit that adds or alters an oracle (a test, type, schema, validator, lint rule, coverage threshold or CI gate) writes the oracle first, and runs the focused check against the unfixed code (kernel rung 3). An erroring run decides nothing; repair the run first.

- **Red** → the oracle discriminates. Write the fix, re-run, expect green.
- **Green where red was expected** → the oracle does not test the thing. Stop: the oracle is now the unit.
- **No red state reachable** (a new rule over code that is already clean) → introduce a deliberate violation inside the unit, revert it before completion, and let the final capture confirm the revert. Otherwise record `NOT_FALSIFIED: <reason>`, which makes the class trade.

**Order of stops.** Classify before any write. A provisional trade stops before the oracle exists. A provisional dominant writes and runs the oracle; `NOT_FALSIFIED` then turns it into a trade, which stops before the fix. The high-risk, new-dependency and hook or CI stops come before every write, the oracle included.

## Boundary

Before verifying, name the expected files in order: oracle first, then implementation. Capture around each run (`reference/baseline.md`). Declare `Finding fixed` only once every delta is dispositioned and every changed expected file has been re-read.

## Output

```md
### Finding fixed [G-###, Key or path]
### Ladder rung targeted             enforcement | path-scoped-context | procedure | prose
### Files changed                    oracle: <files> (or `oracle: n/a`) · implementation: <files>
### Why this improves the repository
### Fix class                        dominant (checked: <what>) | trade (the decision above and the human's answer)
### Verification command / result    red, then green, both this session; or `n/a` (no oracle) · `focused check: none` · `NOT_FALSIFIED: <reason>` · `NOT_RUN: <reason>`; then the observed delta against the expected set, inventory and identity
### Residual risk
### Suggested PR description
### Proof                          the devanity-proof block
```

Every applied unit ends with the kernel's `devanity-proof` block, which also opens the PR description (the reference CI job refuses a rung-3+ PR without one): `check` is the map's declared check for the path when there is one, else the focused check; `failed_before`/`passed_after` are the red and green runs (`n/a` with no oracle); `probes: 0/0` unless a verifier ran. A unit that stopped before any write emits none.

## Example

Fixing G-001 from the audit example. It alters what a billing path returns, so the invocation first proposes:

```md
- **[DECIDE][blocking][G-005][acceptance] Authorize the cents fix to `sumLineItems`?**
  - decision: whether this run may write to the billing path.
  - derivation: tried the ledger: no human decision covers `billing/**` in this change.
  - context: anchors G-001; the patch sums in integer cents and adds the failing case as a test.
  - options: authorize → the oracle-first sequence runs and the fix applies · decline → the patch stays a proposal · test only → land the oracle, leave the arithmetic.
  - recommendation: authorize; the failing case is known, and the oracle lands with the fix.
  - if undecided: nothing is written; G-001 re-fires on the next audit.
```

Once authorized:

```md
### Finding fixed [G-001] (Key: src/payments/totals.ts:sumLineItems:verification-loop:float-money)

### Ladder rung targeted enforcement

### Files changed
oracle: `src/payments/totals.test.ts` (new) · implementation: `src/payments/totals.ts` (sums in integer cents)

### Why this improves the repository
The prose rule "money integers" is now a test: a float sum fails a check instead of a human.

### Fix class
dominant (checked: the oracle failed on the defect before the fix existed; no API or dependency change; one test file in a suite that already runs; de minimis, named)

### Verification command / result
`pnpm test --filter payments`, twice. Red, oracle only: 1 failed, `sumLineItems([10.10, 20.20, 30.30])` returned `60.599999999999994`. Green, after the fix: 6 passed. Captures around both runs: the delta matched the expected set (`totals.test.ts`, then `totals.ts`), and the diff hash changed only across the edits: no verification side effect.

### Residual risk
Other modules may still do float money math; raised as a follow-up finding, not fixed here.

### Suggested PR description
The proof block below, then: "Fix float money arithmetic in sumLineItems; add cents-based tests."

### Proof
devanity-proof:
  check: pnpm test --filter payments
  failed_before: yes
  passed_after: yes
  probes: 0/0
  status: VERIFIED
  pending: 0
```
