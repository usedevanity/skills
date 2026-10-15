# review

Load: `reference/vocabulary.md`, `reference/quality.md`, `reference/baseline.md`; `reference/claude-code.md` and `reference/adjudication.md` for menus and the fresh-context pass.

Judge the current diff before it lands. Read-only: nothing outlives the reply unless the user asks for a record. A path after `review` narrows the diff.

## Steps

1. **Fast path.** For a typo, comment, formatting, docs-only or localized non-behavioral diff, read all of it, skip discovery, and return `PASS (trivial: <class>; checked: not misleading, no contract/verification/ambiguity change)`. The fast path is forfeited if any of those checks fails, or if the diff touches an instruction surface (skill files included).
2. **Re-review.** When this change was reviewed earlier in this session, or the user points at that review, the target is the diff since it plus its open findings: mark each open one `fixed` or `open`, and judge only the lines the delta changed. A new finding on lines that review already saw enters only at P0, tagged `missed earlier`. A Key a human already answered stays answered (`reference/vocabulary.md`, Decision).
3. **Baseline.** Run Light, and escalate to Deep on the triggers in `reference/baseline.md`. Record which one you ran and why.
4. **Account for every file.** List the changed files from the baseline commands. `reviewed N/N` comes from that list, never from memory, and a read that failed or was cut short counts as unreviewed. Size the diff with `git diff --stat HEAD` plus the untracked files, or with the branch diff.
   - Over about 15 files or 800 changed lines: capture the run manifest, group the files by package or domain, and keep a ledger of `group → files → reviewed | pending`.
   - Over about 50 files or 3k lines (the human may override, e.g. for a rename-only sweep): review the highest-risk group, run repository-wide mechanical checks at full width, and mark the rest `pending (batch k)`. Emit a `scope` decision whose options are the batches or splitting the PR, and end with `### Verdict none — scope decision owed`. Later batches end with `none — review completion pending (k/n groups)`. The run that finishes the last group reconciles the findings and owes the one verdict.
   - The same rule broken in N places is one finding, with every instance listed under it and the Key anchored at the owning rule or config.
5. **Judge.** Cover each relevant dimension (`reference/quality.md`, relevance and sufficiency), the instruction syndromes on instruction surfaces, basis-form drift in both directions, and reconciliation of the rules the diff touches (`reference/baseline.md`). For a surface written this session, run the self-review (`reference/quality.md`). A finding against prose this change added (a comment, a doc, a rule) whose claim no code or caller needs has `fix: delete it`.
6. **Plan drift.** If a `/devanity plan` Change from this session covers the diff, compare what was delivered with its scope, non-goals and slices. An undeclared deviation is a finding: scope creep or a stale plan, judged on the evidence.
7. **Conformance.** Check the diff against every accepted ADR or architecture decision that governs a touched path, and against the `invariants` of each touched path in `devanity.rules.json`; quote the record. A violation is a finding tagged by the cause it breaks; an altered invariant of a `core` path with no accepted shape or ADR behind it is one. A record whose `revise_when` has fired is not a violation: route it to `/devanity architect`.
8. **Render** per `reference/vocabulary.md`: first `### Your move`, at most three plain lines on what the human does next (which fixes, the paste-ready `/devanity decide <id> <option>` line for each answer owed, or `nothing: ship`); then the findings; a decision for each owed stop (an unaccepted P0, and each P0/P1 whose fix is a trade); missing verification; a correction prompt.
9. **PR package**, on a PASS-class verdict only: a title, a description sourced from the Summary, the verification evidence (with the change's `devanity-proof` block first, when it has one), and reviewer focus (risks and non-goals). Prepare the PR; never approve it.

## Output

```md
### Verdict PASS | PASS_WITH_FIXES | PASS_WITH_ACCEPTED_RISK | BLOCK | none — <what is owed>
### Your move                at most three plain lines: the fixes, the decide line for each answer owed, or `nothing: ship`
### Summary                  ends with `reviewed N/N changed files`, or the ledger's reviewed | pending counts
### Coverage                 Light|Deep (trigger) · check: <command> → <result>, <no side effect | check side effect: files> (or `focused check: none`) · checked: <slug> (<evidence>) … / not checked: <slug> (<reason>) …
### Required fixes           P0, then P1
### Suggested improvements   P2/P3, one line each
### Decisions                only when one is owed
### Missing verification
### Docs/instructions impact
### PR package               PASS-class verdicts only
### Correction prompt
```

## Example

The diff adds a permission check with no test.

```md
### Verdict BLOCK

### Your move
Add the allow/deny tests (`/devanity improve G-001`), or accept the risk: `/devanity decide G-003 accept`.

### Summary
New `canDelete()` gate on the delete route: permission behavior altered (high-risk class) with no test. Reviewed 3/3 changed files.

### Coverage
Deep (high-risk domain) · check: `pnpm test --filter auth` → 12 passed, no side effect · checked: verification-loop (no case covers `canDelete`), boundary-integrity (import sweep of the delete route: it reaches the DB client directly, G-002), executable-spec (no type or schema governs the gate), pattern-hygiene (sibling sweep of `src/auth`: follows the existing guard shape) / not checked: compressibility, co-located-spec, debt-containment, instruction-hygiene (not relevant: no artifact touched)

### Required fixes
- **[P0][dominant][G-001][verification-loop][enforcement] Permission gate altered with no test**
  - fix: add allow/deny unit tests to the auth suite the CI test job already runs  ·  src/auth/canDelete.ts:42
  - Key: src/auth/canDelete.ts:canDelete:verification-loop:missing-test
  - why: `canDelete` added, no test touched; a refactor could silently open the delete route, and human review is the only sensor.
  - basis: checked: a test-only addition, two deterministic cases in a suite CI already runs; no new dependency, phase, config or boundary (de minimis, named).

### Suggested improvements
- [P2][trade][G-002][boundary-integrity][enforcement] Delete route imports the DB client directly — Key: src/routes/delete.ts:handler:boundary-integrity:layer-bypass

### Decisions
- **[DECIDE][blocking][G-003][acceptance] Ship the delete route without permission tests?**
  - decision: whether unverified permission behavior may ship; a risk acceptance, not a technical choice.
  - derivation: none applies; no principle or accepted risk covers an untested permission gate.
  - context: anchors G-001; high-risk class, guarded today only by human review.
  - options: decline → add the tests, re-run review · accept → PASS_WITH_ACCEPTED_RISK, with who, why, expiry and a compensating control recorded.
  - recommendation: decline; the fix is one file, cheaper than the recorded risk.
  - if undecided: the verdict stays BLOCK and re-fires on the next review of this diff.

### Missing verification
`pnpm test --filter auth` with the allow/deny cases.

### Docs/instructions impact
none

### Correction prompt
"Add allow/deny tests for canDelete to the auth suite, then run /devanity review again. To ship without them, record an explicit acceptance (who, why, expiry)."
```
