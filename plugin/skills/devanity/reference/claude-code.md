# Claude Code

What the host provides and what the plugin enforces today. Every other rule in the modes holds only because the model follows it; say so when it matters, and never present it as a guarantee.

## Instruction surfaces

- Root `CLAUDE.md` (or `.claude/CLAUDE.md`) loads at session start. A nested `CLAUDE.md` loads when a file in its directory is read.
- `.claude/rules/*.md` with a `paths:` glob load when a matching file is read; without `paths:` they always load, like the root file.
- `@import` expands at launch, so it saves no context.
- `AGENTS.md` is not read natively: import it (`@AGENTS.md`) or symlink it.
- A nested `CLAUDE.md` and a path-scoped rule that match the same file have undefined precedence. Flag `UNDEFINED-PRECEDENCE: <path>`; never resolve it silently.
- A skill's body stays in context once invoked, and compaction re-attaches only its first 5,000 tokens. The words after a `/devanity` verb are that mode's argument, and may be empty.

## What the plugin enforces

| Hook | Event | What it holds |
|---|---|---|
| inject | SessionStart, SubagentStart | injects the kernel, the repository rules and the open change (a node's own change, else the milestone, else the latest; with its family: done siblings' intent and scope, open siblings' held areas); the verifier gets a one-line note, the worker nothing |
| mode | UserPromptSubmit | whole-message `/devanity` off, on, status, pending, reset and decide; `decide` is the only writer of `by: human` |
| guard | PreToolUse | blocks (exit 2) a write to a `high-risk` path with no human decision, a Bash write into one, a command above the session's authority, a role's write across its boundary (`implementer` never a test file, `oracle-author` only test files), a write outside the scope a human decision tied to the open change approved, and a write into the scope an open child change of another node holds (one writer per area) |
| oracle | Stop, SubagentStop | re-runs the `devanity-proof` check on HEAD plus the test overlay and on the working tree (on SubagentStop: the node's worktree, from its transcript); rewrites an unsupported claim to `NOT_VERIFIED` and blocks the turn once; a test that existed at HEAD and changed is `NOT_VERIFIED: old test changed` with a `scope` decision queued, until a human decision covers its path; records `devanity-contract` (with the node that declared it) |
| ledger | (library) | keeps decisions, proofs, contracts and events under `<git-common-dir>/devanity/` |

The guards block only with a valid `devanity.rules.json` (or `DEVANITY_GUARDS=on`); otherwise they record `would_block`. Bash detection is a heuristic; the reference CI job (`${CLAUDE_PLUGIN_ROOT}/scripts/devanity-rules-ci.mjs`) is the ceiling. Each hook is documented at https://github.com/usedevanity/skills/blob/main/docs/hooks.md.

Held by the model alone: a read-only mode writes nothing unless the user asks for a record; a writing mode writes one approved unit; the adjudicator runs no command.

## Subagents (measured on 2.1.296, headless `claude -p --plugin-dir`, 2026-10-14)

- `SubagentStart`, `PreToolUse` and `SubagentStop` inside a subagent carry `agent_id` and `agent_type`; a plugin agent's type is namespaced `<plugin>:<agent>`, so a guard matches the suffix.
- `isolation: worktree` holds for a plugin-distributed agent: its `cwd` and writes land in `<repo>/.claude/worktrees/agent-<id>` on branch `worktree-agent-<id>` from the default branch.
- `SubagentStop` with `{"decision":"block","reason":…}` keeps the subagent running with the reason as its next instruction and fires again with `stop_hook_active: true`; the payload names `agent_transcript_path`.

## Menus

A menu is the `AskUserQuestion` tool. It is only ever the projection of an emitted decision block or the closing next-step chooser. The emitted text is the source of truth, and choosing an option is exactly typing that `/devanity …` command, so the stops are unchanged.

- It may fire as the one closing chooser (ambiguous routing, an oversized scope's batches, the top P0/P1 findings to `improve`) or to render a small, enumerable stop you already owe (an ambiguous `improve` reference).
- Cap it at about 4 options: the recommended one first, a no-op always present.
- Never fire it on a clean PASS, on a trade or high-risk confirmation in a writing mode (the tool approval already prompts), or in a headless run (`claude -p`, CI). When in doubt, skip it; the text next step never regresses.

## Fresh-context pass

Pass `reference/adjudication.md` verbatim as the whole prompt, plus the surface paths, the syndrome set, and each tag vocabulary with its path. Never add why the surface is written as it is. Use the highest rung available and name it in the output:

1. **A read-only subagent type** (`Explore`, `Plan`): writes are impossible; commands stay prompt-held, and its own system prompt competes with the contract.
2. **The general-purpose subagent**: no session history, which is what matters; writes stay prompt-held.
3. **None** (no subagent facility, or instructions forbid one; policy is authorization, not capability): record the self-review as unmitigated, and make the next step a human review or `/devanity review` in a fresh session.
