# debt

Load: `reference/vocabulary.md` (Finding, Decision); `modes/audit.md` (Hotspots).

Read-only: nothing outlives the reply unless the user asks for a record.

The outer loop's recurring engine: every deliberate shortcut, every decision still owed and every signal the guards recorded, so a deferral cannot quietly become permanent and a repeated failure becomes structure.

## Scan

1. **Code markers:** `grep -rnE '(#|//|--|<!--) ?deferred:' .` skipping `node_modules`, `.git`, build output (add comment prefixes your stack uses). Each hit is one row; its age is `git blame -L<line>,<line>`.
2. **Pending decisions:** the session's queue and every `pending` entry of `<git-common-dir>/devanity/decisions.jsonl`.
3. **Ledger:** `node "${CLAUDE_PLUGIN_ROOT}/hooks/devanity-ledger.js" stats --json` for the counts, then the records beside it: `events.jsonl` (`blocked`, `would_block` with `path` or `command` and `rule`; `false_ready` with `check`; `unmeasured` with `paths`), `proofs.jsonl` (`status`, `agent_status`, `measured`, `reason`, `contract`), `contracts.jsonl` (the `scope` that places a proof on paths). A proof with `measured: null` reads by its `reason`: `no declared check…` is a `VERIFIED` claim nothing could measure (it pairs with an `unmeasured` event); no `reason` with an `agent_status` other than `VERIFIED` is an honest `NOT_VERIFIED`, which claims nothing and promotes nothing. Skip a torn last line. No ledger → say so and continue.
4. **Hotspots:** `node "${CLAUDE_PLUGIN_ROOT}/scripts/hotspots.mjs"` over the whole repository.

## Promote

A signal that recurs becomes structure. Cite the records behind every count; never assert one you cannot point to.

| signal | structure |
|---|---|
| `unmeasured` on a path (the event's `paths`, or proof → contract → scope) | lane b: propose declaring a `check` for those paths in the map |
| `false_ready` repeated on one path: its declared check already ran and refuted the claim | a `verification-loop` finding on that check, citing each `reason` (a check that passes before the fix cannot discriminate) |
| `would_block` stable over the window, each one matched by a later human decision on its path (no false block) | enforcement on: a valid map, or `DEVANITY_GUARDS=on` |
| `blocked` repeated on one class of task | a contract field that class carries from FRAME (the path under `forbidden`, the decision asked up front) |
| a `deferred:` aging in a top hotspot | a prioritized finding |
| `stats.principles`: three or more human decisions of one kind under one map area | lane b: a principle for that area, rendered as the `invariants` patch (`{id, rule, kind, from: <the decisions>}`) under a `[DECIDE][rule]`; a principle whose `check` never fired in the ledger is a finding |

Every promotion takes exactly one lane:

- **a · fix.** A dominant, reversible fix outside the high-risk class: route it as `/devanity improve <Key>`, which asks before writing because you routed it (`modes/improve.md`); unattended, the autonomy envelope decides.
- **b · propose and stop.** Tightening a guardrail (a declared check, enforcement on, a stricter threshold, a contract field) creates blocks, so it is a trade: render the patch under its `trade` decision. This run never writes the map, hooks or CI.
- **c · never.** Nothing here loosens a verifier: no threshold raised, check removed, suppression widened, tier lowered or test weakened. Evidence that a verifier is wrong (false blocks above 5%) goes to the human as a finding, never as a patch.

## Output

One row per marker, grouped by file, then the pending decisions, then `### Promotions` by lane:

`<file>:<line> — <what was simplified>. ceiling: <the limit named>. trigger: <when to revisit>.`

A `deferred:` comment that names no trigger gets a `no-trigger` tag: those are the ones that rot. A pending decision renders as its `[DECIDE]` headline. A promotion renders as its finding or decision, preceded by `a ·` or `b ·`, the signal and its records.

End with `<N> deferrals, <M> without a trigger, <K> decisions pending, <P> promotions (<a> fix, <b> proposed).` Nothing found: `No deferred debt. Clean ledger.`

## Stats

`debt --stats` (or any request for the repository's numbers): run the `stats` command above without `--json` (`--cwd <path>` for another checkout) and render its output verbatim as the closing numbers: decisions, proofs, contracts, deferrals and guard events over the 90-day window. `prune` exists on the same CLI and runs only when the user asks.

Want it persisted? Ask; it writes `DEVANITY-DEBT.md` only on request.

## Example

```md
src/sync/queue.ts:88 — retries without jitter. ceiling: a thundering herd past ~50 workers. trigger: a second consumer.
src/api/search.ts:14 — linear scan over every document. ceiling: O(n) per query. trigger: none — no-trigger
- [DECIDE][dormant][G-001][rule] Retention for soft-deleted accounts — worth doing when the first restore request lands — anchors D-accounts

### Promotions
b · unmeasured 3× on src/sync/** (`unmeasured` events beside the proofs of C-2026-08-02-1, C-2026-08-19-2, C-2026-09-10-1, each `reason: no declared check`; paths under src/sync/)
- **[DECIDE][blocking][G-002][trade] Declare `npm test -- src/sync` as the check of `src/sync/**`?**
  - decision: whether sync proofs are measured by a declared check, at the cost of a block when it fails.
  - derivation: tried the map: `src/sync/**` declares no `check`, so nothing decides it.
  - context: three `VERIFIED` claims nothing could measure; the command is the CI test step narrowed to the path.
  - options: declare → the map entry is proposed for its PR · defer → dormant, worth doing at the next unmeasured claim.
  - recommendation: declare; unmeasured claims repeating on one path are what a declared check is for.
  - if undecided: re-fires on the next debt run.
a · src/api/search.ts:14, deferred 7 months ago, top hotspot (38 commits × 260 lines)
- [P2][dominant][G-003][debt-containment][enforcement] Linear scan in `search` — Key: src/api/search.ts:search:debt-containment:linear-scan — basis: checked: the existing `SearchIndex` covers the query; no API change → `/devanity improve G-003`

2 deferrals, 1 without a trigger, 1 decision pending, 2 promotions (1 fix, 1 proposed).
```
