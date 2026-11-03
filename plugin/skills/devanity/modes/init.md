# init

Load: `reference/rules.schema.json`; `reference/quality.md` (Severity, Foundations); `modes/audit.md` (Size first, Hotspots, Map proposal, Ratchets).

Make the repository operable: a map the guards and the CI job enforce, a CI job that binds outside the agent, ratchets that hold the legacy. Everything is a proposal derived from what the repository says about itself; nothing is written without an explicit yes per item, and an unattended session writes none of it.

## Steps

1. **Repository identity.** `git rev-parse --git-common-dir`; if this is not a git repository, propose `git init` (the oracle needs a baseline and the ledger lives under `.git/`). Stop here until decided.
2. **Map draft.** Read `CODEOWNERS`, the top-level directories, READMEs and ADRs, the test layout and CI. Propose `devanity.rules.json` under the entry rules of `modes/audit.md` (Map proposal): `tier`, `check`, `purpose`, `invariants` and the `verifiers` the checks read, each with its evidence. Show the file in full. On the yes, write it and run the self-check that entry rules name; a dead glob is fixed before the report.
3. **Ledger.** State that it lives at `<git-common-dir>/devanity/` (inside `.git/`, never committed) and what it records: decisions, proofs, contracts, events. No file is created until the first event.
4. **CI job.** Propose `.github/workflows/devanity-rules.yml`, copied from `${CLAUDE_PLUGIN_ROOT}/templates/devanity-rules.yml` with `DEVANITY_REF` pinned to a full commit sha (a release tag once one exists), never a branch: a moving ref changes the binding check under the repository. Before the devanity step, add the repository's own toolchain setup (language runtime, dependency install), copied from its existing CI with the file and line cited: the job runs every declared check, and the example installs only Node. It validates the map, checks each path's delta budget, runs the `check` of touched high-risk paths (every declared check when the map changes), fails a diff that breaks a path or script an always-loaded or scoped instruction file names on an unchanged line (unless the PR body declares a `reference-change:`), and requires a `devanity-proof` block in the PR body when a normal or high-risk path changes. It binds only as a required status check, a branch-protection setting the human makes: until then it reports and refuses nothing. It is infra (kernel rung 4): show it and stop for the yes.
5. **First ratchets.** Up to three, on the top hotspots, under `modes/audit.md` (Hotspots, Ratchets): a tool from the repository's stack, a threshold from its own distribution (`${CLAUDE_PLUGIN_ROOT}/scripts/calibrate.mjs`, as `modes/audit.md` runs it), the legacy frozen in a baseline. Each carries its config change (the rule in the existing config, the baseline file) for the same PR, written only on its yes. None fits → `none — <reason>`.
6. **Report** as one PR description, in the template below.

Nothing here changes the code. A repository without a rules file still gets the kernel; the guards then only record, unless `DEVANITY_GUARDS=on`.

## Output

The PR this report describes touches normal and high-risk paths, so the job it installs requires the proof block in its body.

```md
### Map            proposed | written · the file · evidence per field · the self-check result
### Checks         per high-risk path: its declared check, or `none — <reason>` (a service the job cannot provide, no command that could fail)
### CI job         proposed | written · the pinned ref · the toolchain steps and the CI lines they copy · required status check: set | asked of the human
### Ratchets       one line each: tool · threshold · distribution · baseline · config change · proposed | written; or `none — <reason>`
### Declined       each item answered no, or `none`
### Proof          the devanity-proof block
### Next step      one, usually `/devanity audit <scope>`
```

## Example

A TypeScript service: `CODEOWNERS` names `@payments` for `/src/billing/`, CI (ci.yml) sets up Node 20 and runs `npm ci`, `npm test` and `npm run lint`; `npm run test:integration` needs the Postgres service ci.yml:9 declares. No rules file.

```md
### Map written
{ "version": 1, "paths": {
  "src/billing/**": { "tier": "high-risk", "check": "npm test -- src/billing", "purpose": "invoicing and payment capture", "invariants": ["an issued invoice is never edited, only credited"] },
  "src/billing/README.md": { "tier": "trivial" },
  "docs/**": { "tier": "trivial" } } }
Evidence: tier, CODEOWNERS:3, and every other file under src/billing/ computes or stores an invoice; the README is the exception: prose that alters no contract; check, CI test step (ci.yml:21) narrowed; purpose, src/billing/README.md:1; invariant, tests/billing/credit.test.ts:12; docs/ holds no instruction surface. Self-check after the write: 3 globs, each matches a tracked file.

### Checks
src/billing/**: `npm test -- src/billing`. The integration suite is not declared: it needs Postgres, which the devanity job does not provide.

### CI job written
.github/workflows/devanity-rules.yml, DEVANITY_REF pinned to the plugin's full commit sha, `actions/setup-node` at 20 and `npm ci` copied from ci.yml:12–15 before the devanity step; written on your yes (infra). Required status check: asked of the human (branch protection).

### Ratchets
ESLint `complexity` at 14 · 3 of 212 functions report (median 4, p90 9, max 22) · the three in bulk suppressions · the rule in eslint.config.js plus the suppressions file · written (top hotspot src/billing/invoice.ts, 41 commits × 380 lines; the existing lint job runs it).

### Declined
none

### Proof
devanity-proof:
  check: node "${CLAUDE_PLUGIN_ROOT}/scripts/devanity-rules-ci.mjs" --self-check
  failed_before: n/a
  passed_after: yes
  probes: 0/0
  status: NOT_VERIFIED: config only; the self-check validated the map, and nothing could fail before the first one
  pending: 0

### Next step
/devanity audit src/billing
```
