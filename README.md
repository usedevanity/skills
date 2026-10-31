# Devanity Open

Devanity makes a repository able to **accept more AI-generated change without growing review cost, defects or entropy in proportion**. It is written for the person who answers for the repository, and it works in two loops:

- **Per change:** every agent change is cheap to accept. Rigor is proportional to what is at stake, every change carries a proof that was seen failing before the fix, and the agent never spends authority it was not given.
- **Over time:** every change leaves the repository easier to change correctly next time. Agents reproduce the patterns of the context they are given, and the repository is that context: a clean repository propagates cleanliness, one with debt propagates debt. So every observed failure becomes structure (a declared check, a ratchet — a baseline that lets a problem's count only go down —, a map entry), never just a corrected mistake.

## What it solves

| Problem | What devanity does |
| --- | --- |
| **False-ready:** the agent says "done" or "verified" without evidence | "Verified" exists only in a `devanity-proof` block; the Stop hook re-runs the check the repository declares (never one the agent wrote) against `HEAD` and, when the claim does not hold, blocks the turn with the block it measured |
| **Usurped authority:** an available tool becomes a permission | high-risk and irreversible decisions stop as a `[DECIDE][blocking]`, with the dependent slice left as a failing stub instead of a guessed default; the guard blocks high-risk paths and commands above the session's authority; the reference CI job fails a pull request whose high-risk check fails or that carries no proof block |
| **Wrong rigor:** the same process for a rename and for billing | a proportionality ladder that stops at the first rung that holds, from `NO_CHANGE` to "propose and stop" |
| **Decision load:** asking what the repository already answers, or deciding what belongs to a human | derive from the principles in the map before asking; a human-owned choice that is reversible before merge is taken on the recommendation, marked `[DECIDE][provisional]`, and judged in batch at review; every answer is a rule written into the map, so the same axis is never asked twice; only the high-risk class and the irreversible block |
| **Over-build:** speculative abstraction, configuration and scaffolding | a craft ladder: what exists here, then stdlib, platform, installed dependency, one line |
| **Rules that rot in prose:** conventions nobody enforces | a durability ladder: `audit` proposes moving a recurring rule from prose into a test, lint rule, schema or CI gate, and dropping the prose in the same change |
| **Pattern inertia:** the agent replicates the repository's debt | reuse behavior through interfaces, never the shape of debt; debt is what the repository's gates say, not taste; `init` and `audit` propose ratchets from the repository's own stack so legacy stays frozen and new code meets the target, and `debt` turns recurring signals into the next proposal |

**Where it works.** In a repository. Every rule reads something there: the files a change touches, the check the repository declares, its ADRs and siblings, its gates. Without one (a chat, a system prompt with no files) devanity is outside its design; the field's text-only suites measure it there for comparison only ([field suites](evals/results/2026-09-29-field-suites.md)), and the kernel is not tuned for them.

**What it does not do.** It protects against the agent that errs or races for a green check, not against an adversarial one. The binding boundary is the pipeline, outside the agent: the reference CI job, branch protection and `CODEOWNERS`. The in-session hooks are fast sensors that stop honest mistakes and measure; the agent never authors, and never weakens, the check that judges it.

**Evidence so far** ([stage round](evals/results/2026-09-24-stage-round.md), Sonnet, n=4, against baseline, ponytail, superpowers, a one-sentence control and an unreleased control that has only the craft ladder): devanity is the only arm that never took a human-owned decision (0/12 cells across rounds; the others took it in 2/4 to 4/4), it ties ponytail on leaving unneeded changes undone (4/4), and it reads the repository's ADR before guessing in 3/4 cells where the best competitor does 1/4. That round measured the kernel as of `439f8b5`, before the v1 convergence rewrote it; only the Decisions block it measured is carried over unchanged. Size, rung-2 cost, greenfield, weaker models and the modes are not measured yet.

## How to use

Install it once; the kernel applies to every coding turn without being invoked. Before touching anything, the agent stops at the first rung that holds:

```text
1. Does it need to change?        → no: say why, NO_CHANGE
2. Trivial and reversible?        → do it, shortest form, no ceremony (never an instruction file)
3. Changes behavior?              → a check that fails first, then the fix
4. Alters a high-risk contract?   → propose and stop; authorization comes from outside
5. Moves a boundary or state?     → shape before code; architect when the shape is not enough
6. Can't tell?                    → read until you can; then ask ONE thing
```

Below rung 3 it writes the minimum that works (what exists here → stdlib → platform → installed dependency → one line). Decisions a reviewer can flip in one line are taken with a stated default; human-owned ones reversible before merge are taken on the recommendation and marked `[DECIDE][provisional]` for the review; high-risk or irreversible ones become a `[DECIDE][blocking]` and stop the dependent slice, not the session. "Verified" exists only inside a `devanity-proof` block filled with what was actually run.

The verbs are for the moments that need a procedure:

| What you need | Use |
| --- | --- |
| Run a change end to end: contract, preflight, bounded slices, independent verification, assurance | `/devanity plan <goal>` |
| Make or revise a material architecture decision | `/devanity architect <drivers>` |
| Review the current diff before it lands | `/devanity review [path]` |
| Audit a scope, or the instruction surfaces; propose map entries and ratchets ranked by hotspots (the files that change most) | `/devanity audit <scope>` · `/devanity audit instructions [path]` |
| Apply one approved finding, or fix one instruction surface | `/devanity improve <finding\|surface>` |
| Turn deferred shortcuts, pending decisions and the ledger's signals into proposed promotions | `/devanity debt` |
| Make a repository operable: map draft, pinned CI job, first ratchets | `/devanity init` |

With the plugin installed, a few whole-message commands talk to the hooks rather than to the model: `/devanity on|off`, `/devanity status` (state, open change, pending decisions), `/devanity pending`, `/devanity decide <id> <option> [--path <glob>]` (records a human decision and writes its rule into the map; editing the ledger by hand is the other human path), `/devanity accept [--except <id> <option>, …]` (answers every provisional decision with its recommendation), `/devanity allow <glob> [--standing]` (authorizes edits under a path, for the open change or for good), `/devanity reset` (abandons the open change), and `/devanity debt --stats` for the repository's numbers. What they enforce and record: [`docs/hooks.md`](docs/hooks.md).

You normally **do not invoke Worker or Verifier yourself**: Worker collects evidence and does not decide; Verifier tries to falsify a completed change and does not edit. The modes use them when needed; missing roles degrade explicitly rather than becoming fabricated evidence.

## Adopt it in your repository

**What it costs.** The kernel is about 1.5k tokens, injected at session start, after compaction and into each subagent except the worker and the verifier; the repository map adds at most about 400 tokens, and an open change about 120. Once a rules file declares a `check`, each `VERIFIED` claim makes the Stop hook run that check twice (before and after the change, within 120 s) before the turn ends. The ledger stays local and holds metadata only.

**What changes without configuration.** On a personal install with no `devanity.rules.json`, the guard blocks nothing and the oracle measures nothing: they only record, in a local ledger under `.git/`, what they would have done (`DEVANITY_GUARDS=on` makes them enforce anyway). The kernel and the verbs work the same.

**Declare what is at stake.** Add `devanity.rules.json` at the repository root (or let `/devanity init` draft it from your repository and show it before writing). A minimal one:

```json
{
  "version": 1,
  "paths": {
    "billing/**":    { "tier": "high-risk", "check": "pytest tests/billing -q", "purpose": "charges and refunds" },
    "migrations/**": { "tier": "high-risk", "check": "pytest tests/migrations -q" },
    "docs/**":       { "tier": "trivial" }
  }
}
```

With it, the guard blocks edits to high-risk paths until a human decides, and the oracle measures `VERIFIED` against the `check` you declared, never one the agent wrote. The fields (`delta`, `invariants`, `core`, `tests`, `commands`, `autonomy`) are in [`rules.schema.json`](plugin/skills/devanity/reference/rules.schema.json).

**When the guard blocks.** The message ends with the next step. For a high-risk path, the human types `/devanity decide <id> <option> --path <glob>` as a whole message; for a command above the session's authority (`git push --force`, `gh pr merge`, `terraform apply`), the human raises `DEVANITY_AUTHORITY` or `defaults.authority` in the rules; an unattended session is capped at `commit` (`autonomy.authority`), so merge and deploy are never its to run. The guard blocks the agent's own edits to the rules and the ledger.

**Turning it down or off.** `DEVANITY_GUARDS=off` makes the guard and the oracle record without blocking. `/devanity off` stops the kernel injection and the oracle, and `/devanity on` brings them back; the guard follows `DEVANITY_GUARDS` only.

**Make it binding.** The hooks run with the agent's permissions; the boundary is CI. Copy [`plugin/templates/devanity-rules.yml`](plugin/templates/devanity-rules.yml) to your `.github/workflows/` and pin `DEVANITY_REF` to a commit sha: it fails a pull request whose high-risk check fails, that carries no `devanity-proof` block, or that removes a path or script an always-loaded or path-scoped instruction file names on a line the diff left as it was (unless a `reference-change:` line in the PR body declares it), and its summary shows the reviewer the purpose and invariants of every path the change touched.

Everything the hooks enforce, record and cannot stop: [`docs/hooks.md`](docs/hooks.md).

## Install for Claude Code

As a plugin (recommended: the kernel is then injected on every session, compaction and subagent, and the verbs become available):

```
/plugin marketplace add usedevanity/skills
/plugin install devanity@devanity
```

Or as a skill only (the kernel loads when the skill is invoked or matched; no hooks, no persistence across compaction):

```bash
npx skills add usedevanity/skills --skill devanity --agent claude-code
```

Optional companion agents (the plugin ships them; the skill-only install needs this step):

```bash
mkdir -p .claude/agents
for agent in worker verifier; do
  curl -fsSL \
    "https://raw.githubusercontent.com/usedevanity/skills/main/plugin/agents/${agent}.md" \
    -o ".claude/agents/${agent}.md"
done
```

Skills follow the [Agent Skills](https://agentskills.io) standard. Host-specific mechanics belong in `plugin/skills/devanity/reference/claude-code.md`, not in the kernel or the modes. Hosts that read an instruction file and run no hooks get the kernel from [`AGENTS.md`](AGENTS.md): copy it into your repository root (no modes, no hooks, no persistence).

## Status

The kernel is a **candidate** (`1.0.0-candidate`): it is measured by the harness in [`evals/harness/`](evals/harness/) against the field a maintainer would choose from (ponytail, superpowers, and a one-sentence control) before it is released.

## Contributing

How the repository is built, measured and laid out: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License and Terms of Use

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-orange.svg)](https://creativecommons.org/licenses/by-nc/4.0/)

This repository contains instructions and routines licensed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)**. The benchmark instruments under `evals/harness/` ported from ponytail keep their MIT notice (`evals/harness/LICENSE-ponytail`).

* **Allowed, with attribution:** copy, adapt and share the instructions for non-commercial purposes, such as study, research and personal projects.
* **Needs the licensor's written permission:** any commercial use, including use inside a company's work or products, and selling, repackaging or monetizing the instructions or derivative works (paid products, e-books, courses). Ask through the repository's issues.

The license text in [`LICENCE`](LICENCE) governs; this summary does not change it.
