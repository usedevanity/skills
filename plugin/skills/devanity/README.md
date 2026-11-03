# Devanity

One capability, always on, for the engineer who answers for the repository: rigor proportional to what is at stake, every change carries its proof, and authority never exceeds what was granted. `SKILL.md` is the kernel; `modes/` holds one procedure per verb, and `reference/` what the modes share.

This page is for a skill-only install:

```bash
npx skills add usedevanity/skills --skill devanity --agent claude-code
```

A skill-only install gets the kernel and the modes, and nothing that runs outside the model: no hooks (so no `decide`, `accept`, `allow`), no guard, no proof oracle, no ledger, no re-injection after compaction, and none of the scripts `audit`, `debt` and `init` run. For those, install the plugin. The plugin install, the verbs and what each is for are on the [repository page](https://github.com/usedevanity/skills#readme).

The modes hand collection and independent proof to two agents, which the plugin ships and a skill-only install must add:

```bash
mkdir -p .claude/agents
for agent in worker verifier; do
  curl -fsSL \
    "https://raw.githubusercontent.com/usedevanity/skills/main/plugin/agents/${agent}.md" \
    -o ".claude/agents/${agent}.md"
done
```

Status: candidate (`1.0.0-candidate`), measured by the [harness](https://github.com/usedevanity/skills/tree/main/evals/harness) against the field before release.
