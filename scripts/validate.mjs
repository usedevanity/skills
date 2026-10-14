#!/usr/bin/env node
// Dependency-free validator for this repository (usedevanity/skills): the skill installs and its modes
// load what they cite (validate), and the repository around it keeps one identity (checkRepository).
// Checks the few invariants that break silently; deliberately NOT a markdown/prose linter.
// Run: node scripts/validate.mjs   ·   Test: node --test tests/validate.test.mjs
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Drop fenced code blocks so illustrative example paths (e.g. src/foo.ts) aren't treated as references.
const stripFences = (text) => {
  let inFence = false;
  return text
    .split('\n')
    .filter((line) => {
      if (line.trimStart().startsWith('```')) { inFence = !inFence; return false; }
      return !inFence;
    })
    .join('\n');
};

const parseFrontmatter = (text) => {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const fm = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm[kv[1]] = kv[2].trim();
  }
  return fm;
};

// Every unit's SKILL.md is an always-on kernel: it is injected into every session, compaction and
// subagent, so its cost is paid on every turn, not once per invocation. It is held at ~1.8k tokens
// (well under the 5,000 tokens compaction re-attaches); depth belongs in modes/ and reference/.
export const KERNEL_TOKEN_CAP = 1800;
// An approximation: ~4 chars/token holds for prose, but a typographic character (—, →, ≥, ·) is
// usually a whole token on its own, so those count 1:1 instead of 1/4.
const estimateTokens = (s) => {
  let wide = 0;
  for (const c of s) if (c.codePointAt(0) > 127) wide++;
  return Math.round((s.length - wide) / 4 + wide);
};

// The on-demand files have no platform boundary like the one that anchors the kernel's cap, so no
// fixed number would be honest — but silent growth is still the failure mode:
// this skill grew 17% in one PR with every added sentence individually justified, and per-file line
// counts stayed green throughout. The honest mechanism is a ratchet, not a cap: the budget sits at
// the last deliberate size, and the PR that grows the skill raises it in the same diff — growth
// stays possible and stops being free. Lowering it after a trim is the same deliberate act.
export const SKILL_TOTAL_BUDGETS = { devanity: 132500 }; // bytes, every file under skills/<name>/: 105176 after the C1 rewrite (205345 with the moved subtrees before it); 114485 after phase V3/V4 (docs merged into audit and improve, the §0.6 fixes, the outer loop in init, audit, debt and improve: +9% over 104907); 124139 after the V acceptance-review fixes (init report template and CI toolchain, the instruction-scope audit example, missing-home improve, debt's unmeasured lane: +7% over 116139); 128655 after A0.4 (the measured subagent facts in reference/claude-code.md: +0.6% over 127898), +3% headroom
export function checkSkillTotal(skillsDir, budgets) {
  const errors = [];
  const sizeOf = (d) => readdirSync(d).reduce((n, f) => {
    const p = join(d, f);
    return n + (statSync(p).isDirectory() ? sizeOf(p) : statSync(p).size);
  }, 0);
  if (!existsSync(skillsDir)) return errors;
  for (const skill of readdirSync(skillsDir).filter((n) => statSync(join(skillsDir, n)).isDirectory())) {
    const budget = budgets[skill];
    if (budget === undefined) {
      errors.push(`${skill}: no total-size budget — add a SKILL_TOTAL_BUDGETS entry (current size: ${sizeOf(join(skillsDir, skill))} chars); every skill's growth is deliberate, including its first size`);
      continue;
    }
    const total = sizeOf(join(skillsDir, skill));
    if (total > budget) {
      errors.push(`${skill}: totals ${total} chars against a budget of ${budget} — growing is fine when deliberate: raise SKILL_TOTAL_BUDGETS in the same PR that grows the skill (or trim)`);
    }
  }
  return errors;
}

// Every relative markdown link must resolve on disk. A link to something that was removed reads as
// current to anyone — human or agent — who does not try it: the "stale doc" criterion applied to a
// doc's own references. Fences are stripped; a link inside a code block renders as text, not a link.
export function checkRelativeLinks(file) {
  if (!existsSync(file)) return [];
  const dir = dirname(file);
  const errors = [];
  for (const m of stripFences(readFileSync(file, 'utf8')).matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    // Skip anything not resolved against the filesystem: URL scheme, protocol-relative, in-page anchor.
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(target)) continue;
    const rel = target.split('#')[0];
    if (rel && !existsSync(resolve(dir, rel))) errors.push(`links to missing ${target}`);
  }
  return errors;
}

// A unit is a top-level directory under skillsDir: one capability, whose SKILL.md is the always-on
// kernel and whose modes/ and reference/ hold flat files. Nested skills (modes/<name>/SKILL.md) no
// longer exist; checkRepository pins the exact mode set, so one cannot reappear unnoticed.
// Returned as [name, root].
export function findUnits(skillsDir) {
  if (!existsSync(skillsDir)) return [];
  return readdirSync(skillsDir)
    .filter((n) => statSync(join(skillsDir, n)).isDirectory())
    .map((n) => [n, join(skillsDir, n)]);
}

// The mode set a unit exposes: modes/<m>.md files plus the verbs of a routing table in SKILL.md whose
// Read cell names a path under the unit (`| verb | \`modes/...\` |`). Paths named by the table must
// exist, so a route cannot outlive the file it points at.
function modeSet(root, raw, err, skill) {
  const modesDir = join(root, 'modes');
  const files = existsSync(modesDir)
    ? readdirSync(modesDir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3))
    : [];
  const table = [];
  for (const row of stripFences(raw).matchAll(/^\|\s*`([a-z][a-z-]*)`\s*\|([^\n]*)$/gm)) {
    const path = row[2].match(/`((?:modes|reference)\/[^`\s]+)`/)?.[1];
    if (!path) continue;
    table.push(row[1]);
    if (!existsSync(join(root, path))) err(skill, `mode table routes "${row[1]}" to missing ${path}`);
  }
  return new Set([...files, ...table]);
}

// Validate every unit under skillsDir. Returns a deduped array of error strings (empty = valid).
export function validate(skillsDir) {
  const errors = [];
  const err = (skill, msg) => errors.push(`${skill}: ${msg}`);
  const units = findUnits(skillsDir);
  if (units.length === 0) errors.push('no skills found under skills/');

  for (const [skill, root] of units) {
    const skillMd = join(root, 'SKILL.md');
    if (!existsSync(skillMd)) { err(skill, 'missing SKILL.md'); continue; }
    const raw = readFileSync(skillMd, 'utf8');

    // 1. Structural: frontmatter present, required keys, name === directory.
    const fm = parseFrontmatter(raw);
    if (!fm) err(skill, 'SKILL.md has no YAML frontmatter');
    else {
      if (!fm.name) err(skill, 'frontmatter missing `name`');
      else if (fm.name !== skill) err(skill, `frontmatter name "${fm.name}" != directory "${skill}"`);
      if (!fm.description) err(skill, 'frontmatter missing `description`');
    }

    // 2. Referential integrity: every internal `reference/…md` / `modes/…md` mention resolves (fences ignored).
    const scanFiles = [skillMd];
    for (const sub of ['reference', 'modes']) {
      const d = join(root, sub);
      if (existsSync(d)) for (const f of readdirSync(d)) if (f.endsWith('.md')) scanFiles.push(join(d, f));
    }
    for (const file of scanFiles) {
      const body = stripFences(readFileSync(file, 'utf8'));
      for (const ref of body.matchAll(/`((?:reference|modes)\/[^`\s]+\.md)`/g)) {
        if (!existsSync(join(root, ref[1]))) err(skill, `${file.slice(root.length + 1)} references missing ${ref[1]}`);
      }
    }

    // 2b. Rung-citation integrity: a `rung N` citation must name a rung of the kernel's numbered
    //     ladder (`N. **…**`). Renumbering a list leaves every cross-reference pointing one item off,
    //     and each still reads as current. Fences and inline code are not citations.
    const rungs = new Set([...stripFences(raw).matchAll(/^(\d+)\. \*\*/gm)].map((m) => Number(m[1])));
    for (const file of rungs.size ? scanFiles : []) {
      const rel = file.slice(root.length + 1);
      let inFence = false;
      readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        if (line.trimStart().startsWith('```')) { inFence = !inFence; return; }
        if (inFence) return;
        for (const m of line.replace(/`[^`]*`/g, '').matchAll(/\b[Rr]ung (\d+)\b/g)) {
          if (!rungs.has(Number(m[1]))) {
            err(skill, `${rel}:${i + 1} cites "${m[0]}" but SKILL.md defines rungs ${Math.min(...rungs)}–${Math.max(...rungs)} — point at the rung that now holds the content`);
          }
        }
      });
    }

    // 3. Contract agreement: the exposed mode set (modes/*.md ∪ routing-table verbs, see modeSet)
    //    === modes declared in argument-hint. A verb the hint promises must have a file or a route;
    //    a file or route the hint hides is dead.
    const modesDir = join(root, 'modes');
    const modes = modeSet(root, raw, err, skill);
    if (existsSync(modesDir)) {
      const fileModes = [...modes].sort();
      const hint = fm?.['argument-hint']?.match(/([a-z|]+)/)?.[1] ?? '';
      const hintModes = hint.split('|').filter(Boolean).sort();
      if (hintModes.length && fileModes.join(',') !== hintModes.join(',')) {
        err(skill, `modes (${fileModes.join(',')}) != argument-hint (${hintModes.join(',')})`);
      }
    }

    // 4. Mode dependency agreement: a mode file may not cite a reference it does not declare. A mode
    //    declares its load set on its own `Load:` line (where the kernel's router sends the model,
    //    so the kernel pays nothing for it), or in a mode-table row of SKILL.md. The declaration may
    //    list MORE than the mode cites (a mode can need a contract without naming its path), never
    //    less: otherwise a fresh-session run that loads only the declared set is missing a reference
    //    the mode's own steps require. Subset, not equality, is the invariant.
    if (existsSync(modesDir)) {
      const refsIn = (text, re) => new Set([...text.matchAll(re)].map((r) => r[1]));
      const rows = new Map();
      for (const row of raw.matchAll(/^\|\s*([a-z][a-z-]*)\s*\|([^\n]*)\|/gm)) {
        const refs = refsIn(row[2], /(reference\/[a-z-]+\.(?:md|json))/g);
        if (refs.size) rows.set(row[1], refs);
      }
      for (const file of readdirSync(modesDir).filter((f) => f.endsWith('.md'))) {
        const body = readFileSync(join(modesDir, file), 'utf8');
        const cited = refsIn(body, /`(reference\/[a-z-]+\.(?:md|json))`/g);
        if (cited.size === 0) continue; // cites nothing, so nothing can be omitted — no declaration required
        const mode = file.slice(0, -3);
        const load = body.match(/^Load:([^\n]*)$/m);
        if (!load && !rows.has(mode)) { err(skill, `modes/${file} cites references but declares none — no Load: line and no row for "${mode}" in the mode table`); continue; }
        const declared = new Set([...(rows.get(mode) ?? []), ...(load ? refsIn(load[1], /`(reference\/[a-z-]+\.(?:md|json))`/g) : [])]);
        for (const ref of cited) {
          if (!declared.has(ref)) err(skill, `modes/${file} cites ${ref} but its declaration (Load: line or the mode table row for "${mode}") omits it`);
        }
      }
    }

    // 5. The always-on body stays lean (derivation at KERNEL_TOKEN_CAP).
    const tokens = estimateTokens(raw);
    if (tokens > KERNEL_TOKEN_CAP) {
      err(skill, `SKILL.md is ~${tokens} tokens (kernel max ~${KERNEL_TOKEN_CAP}: the always-on body is paid on every turn, compaction and subagent; move depth into a mode)`);
    }

    // 6. README drift: a `/<skill> <verb>` the README shows must be a mode that exists.
    const readmePath = join(root, 'README.md');
    if (existsSync(readmePath) && existsSync(modesDir)) {
      const readme = readFileSync(readmePath, 'utf8');
      const fileModes = modes;
      // Only command references inside code (inline `…` or fenced ```…```) count as mode claims —
      // prose like "run /devanity on any PR" must not flag `on` as a nonexistent mode.
      const code = [...readme.matchAll(/`[^`\n]+`/g), ...readme.matchAll(/```[\s\S]*?```/g)].map((c) => c[0]).join('\n');
      for (const m of code.matchAll(new RegExp(`/${skill}\\s+([a-z-]+)`, 'g'))) {
        if (!fileModes.has(m[1])) err(skill, `README references /${skill} ${m[1]} but no such mode exists (no modes/${m[1]}.md and no route in the mode table)`);
      }
    }

    // 7. Every relative link in the skill README resolves (checked whether or not modes/ exists).
    for (const e of checkRelativeLinks(readmePath)) err(skill, `README.md ${e}`);
  }

  return [...new Set(errors)];
}

// The repository around the skill, checked against what is on disk: the deliberate capability, mode
// and agent sets, retired names and token spellings, canonical repository identity, one release
// version, protocol JSON, and the ported harness attribution.
export function checkRepository(root) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const read = (path) => readFileSync(join(root, path), 'utf8');

  const requiredFiles = [
    'plugin/skills/devanity/SKILL.md',
    'plugin/skills/devanity/README.md',
    'plugin/skills/devanity/reference/vocabulary.md',
    'plugin/skills/devanity/reference/quality.md',
    'plugin/skills/devanity/reference/baseline.md',
    'plugin/skills/devanity/reference/change.schema.json',
    'plugin/skills/devanity/reference/rules.schema.json',
    'plugin/agents/worker.md',
    'plugin/agents/verifier.md',
    'CONTRIBUTING.md',
    'evals/README.md',
    'evals/harness/tasks.py'
  ];
  for (const path of requiredFiles) if (!existsSync(join(root, path))) fail(`missing required artifact: ${path}`);

  // One capability with modes (docs/evolution/PLAN.md, decision 2026-09-23): a new top-level
  // capability or a new mode is an architectural decision, not a free directory.
  const expectedSkills = ['devanity'];
  const skillDirs = readdirSync(join(root, 'plugin', 'skills')).filter((name) => statSync(join(root, 'plugin', 'skills', name)).isDirectory()).sort();
  if (skillDirs.join(',') !== expectedSkills.join(',')) {
    fail(`plugin/skills/ must be the deliberate capability set (${expectedSkills.join(', ')}); found: ${skillDirs.join(', ')}`);
  }
  // One flat file per verb, the set the kernel's routing table and argument-hint promise.
  const expectedModes = ['architect.md', 'audit.md', 'debt.md', 'improve.md', 'init.md', 'plan.md', 'review.md'];
  const modeEntries = existsSync(join(root, 'plugin/skills/devanity/modes')) ? readdirSync(join(root, 'plugin/skills/devanity/modes')).sort() : [];
  if (modeEntries.join(',') !== expectedModes.join(',')) {
    fail(`plugin/skills/devanity/modes must be the deliberate mode set (${expectedModes.join(', ')}); found: ${modeEntries.join(', ')}`);
  }

  const expectedAgents = ['verifier.md', 'worker.md'];
  const agents = readdirSync(join(root, 'plugin', 'agents')).filter((name) => name.endsWith('.md')).sort();
  if (agents.join(',') !== expectedAgents.join(',')) {
    fail(`plugin/agents/ must be the deliberate role set (${expectedAgents.join(', ')}); found: ${agents.join(', ')}`);
  }

  // Repository migration is complete only when published install/source references use the canonical repo.
  // Derive the legacy tokens so this validator does not contain the literals it is searching for.
  const CANONICAL_REPO = 'usedevanity/skills';
  const legacyRepos = [['ttoss', 'skills'].join('/'), ['TriangulosTecnologia', 'devanity-skills'].join('/')];
  // The tracked files: build output the harness generates (gitignored) is not the repository.
  // Outside a checkout, every file on disk but .git/.
  const textFiles = [];
  const listed = spawnSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' });
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (path.slice(root.length + 1).startsWith('.git/')) continue;
      if (statSync(path).isDirectory()) walk(path);
      else textFiles.push(path);
    }
  };
  if (listed.status === 0 && listed.stdout.trim()) textFiles.push(...listed.stdout.trim().split('\n').map((f) => join(root, f)).filter((f) => existsSync(f)));
  else walk(root);
  textFiles.splice(0, textFiles.length, ...textFiles.filter((f) => /\.(md|mjs|json|yml|yaml)$/.test(f)));
  for (const file of textFiles) {
    const text = readFileSync(file, 'utf8');
    for (const legacy of legacyRepos) if (text.includes(legacy)) fail(`${file.slice(root.length + 1)} still references ${legacy}; the repository is ${CANONICAL_REPO}`);
  }

  // What the model loads speaks one interface: the `/devanity <verb>` invocations and one spelling of
  // each status token. The retired skill names (and their `/name` commands) and the spaced spellings
  // of the underscore tokens are what the pre-C1 files used; a file that reintroduces one teaches the
  // model a command that does not exist or a token no parser expects. The docs a person reads speak
  // the same interface (PLAN V4): only the history keeps the old names, the spec and plan that record
  // the consolidation and the dated results; the harness names the released version's commands.
  const retiredNames = /\b(?:maestro|archer|guardian)\b/i;
  const spacedTokens = /\b(?:NOT VERIFIED|INVALID TARGET|NOT RUN|NOT ADJUDICATED|NOT FALSIFIED)\b/;
  // The harness keeps them too: it runs the released version, whose commands still carry them.
  const history = ['docs/evolution/PLAN.md', 'docs/evolution/SPEC.md', 'evals/results/', 'evals/harness/'];
  const read_by_people = (rel) => rel.startsWith('docs/') || rel.startsWith('evals/') || rel.startsWith('scripts/') || rel.startsWith('plugin/') || !rel.includes('/');
  for (const file of textFiles) {
    const rel = file.slice(root.length + 1);
    const loaded = rel.startsWith('plugin/skills/') || rel.startsWith('plugin/agents/');
    if (rel === 'scripts/validate.mjs') continue;   // it names them to find them
    if (!loaded && (!read_by_people(rel) || history.some((h) => rel.startsWith(h)))) continue;
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const name = line.match(retiredNames);
      if (name) fail(`${rel}:${i + 1} names the retired "${name[0]}"; the interface is /devanity <verb>`);
      const token = loaded && line.match(spacedTokens);
      if (token) fail(`${rel}:${i + 1} spells "${token[0]}"; the token is ${token[0].replace(' ', '_')}`);
    });
  }

  // The harness instruments are ported from ponytail (MIT). Every ported file carries its attribution
  // header and the full notice ships next to them; a rewrite that drops either is a licence defect (F0.11).
  const portedHarnessFiles = ['run.py', 'selftest.py', 'tasks.py', 'complete.py'];
  if (!existsSync(join(root, 'evals/harness/LICENSE-ponytail'))) fail('evals/harness/LICENSE-ponytail is missing');
  for (const name of portedHarnessFiles) {
    const path = `evals/harness/${name}`;
    if (!existsSync(join(root, path))) { fail(`missing ported harness file: ${path}`); continue; }
    const head = read(path).split('\n').slice(0, 6).join('\n');
    if (!/Ported from ponytail \(https:\/\/github\.com\/DietrichGebert\/ponytail\)/.test(head) || !/MIT License/.test(head)) {
      fail(`${path} lacks the ponytail MIT attribution header in its first lines`);
    }
  }

  const parseJson = (path) => {
    try { return JSON.parse(read(path)); }
    catch (error) { fail(`${path} is not valid JSON: ${error.message}`); return null; }
  };

  // One release version: the manifest's, restated wherever a person or the model reads it.
  const version = parseJson('plugin/.claude-plugin/plugin.json')?.version;
  const kernelVersion = read('plugin/skills/devanity/SKILL.md').match(/^\s*version:\s*(\S+)/m)?.[1];
  if (!version) fail('plugin/.claude-plugin/plugin.json has no version');
  else {
    if (kernelVersion !== version) fail(`plugin/skills/devanity/SKILL.md metadata version ${kernelVersion} != plugin.json ${version}`);
    for (const path of ['README.md', 'plugin/skills/devanity/README.md', 'evals/kernel-sentences.md']) {
      const named = [...read(path).matchAll(/\b\d+\.\d+\.\d+(?:-[a-z0-9.]+)?\b/g)].map((m) => m[0]).filter((v) => v !== version);
      if (!read(path).includes(version)) fail(`${path} does not state the release version ${version}`);
      if (named.length) fail(`${path} names version(s) ${[...new Set(named)].join(', ')}; the release is ${version}`);
    }
  }

  const schema = parseJson('plugin/skills/devanity/reference/change.schema.json');
  if (schema) {
    if (schema.title !== 'Devanity Open Change') fail('change.schema.json has unexpected title');
    const required = new Set(schema.required ?? []);
    for (const key of ['id', 'state', 'intent', 'scope', 'requirements', 'decisions', 'impact', 'authority', 'verification', 'execution', 'evidence', 'findings', 'completion']) {
      if (!required.has(key)) fail(`change.schema.json must require ${key}`);
    }
    if (!String(schema.$id ?? '').includes(CANONICAL_REPO)) fail('change.schema.json $id must use the canonical repository');
    const ceiling = schema.properties?.authority?.properties?.ceiling?.enum ?? [];
    for (const action of ['observe', 'recommend', 'prepare', 'execute', 'commit', 'merge', 'deploy']) {
      if (!ceiling.includes(action)) fail(`change.schema.json authority ceiling missing ${action}`);
    }
  }

  // The installable unit: the marketplace installs plugin/ and nothing else, so it holds only what a
  // session runs or the init mode copies, carries the licence, and reaches nothing outside itself.
  const market = parseJson('.claude-plugin/marketplace.json');
  if (market && (market.plugins ?? []).map((p) => p.source).join(',') !== './plugin') fail('.claude-plugin/marketplace.json must install ./plugin, the one installable unit');
  const unit = ['.claude-plugin', 'LICENCE', 'agents', 'hooks', 'scripts', 'skills', 'templates'];
  const shipped = existsSync(join(root, 'plugin')) ? readdirSync(join(root, 'plugin')).sort() : [];
  if (shipped.join(',') !== unit.join(',')) fail(`plugin/ must hold exactly ${unit.join(', ')} (what installs is what runs); found: ${shipped.join(', ')}`);
  if (existsSync(join(root, 'plugin/LICENCE')) && read('plugin/LICENCE') !== read('LICENCE')) fail('plugin/LICENCE must be a copy of LICENCE: the licence travels with what installs');
  // Every file under plugin/, whatever its extension (a local install copies the directory as it is
  // on disk); binary files are not text and cite nothing.
  const pluginFiles = [];
  const walkPlugin = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walkPlugin(path);
      else if (!readFileSync(path).includes(0)) pluginFiles.push(path);
    }
  };
  if (existsSync(join(root, 'plugin'))) walkPlugin(join(root, 'plugin'));
  // Every ${CLAUDE_PLUGIN_ROOT}/<path> the plugin names resolves inside it: that variable is the
  // installed copy's root, so a path outside plugin/ is a command that fails on the user's machine.
  for (const file of pluginFiles) {
    const rel = file.slice(root.length + 1);
    // The expansion as the shell reads it: `$VAR`, or `${VAR…}` up to its own closing brace, whatever
    // operator it carries (`:-`, `-`, `:?`, `%`, one nested `${…}`), then an optional closing quote,
    // bare or escaped inside hooks.json's JSON, then the path. Each character has one way to match,
    // so the scan is linear. A doubled slash is the same path to the shell: `//..` still climbs out.
    const EXPANSION = /\$(?:\{CLAUDE_PLUGIN_ROOT(?!\w)(?:[^{}$]|\$(?!\{)|\$\{[^{}]*\})*\}|CLAUDE_PLUGIN_ROOT\b)\\?["']?\/([A-Za-z0-9_./-]+)/g;
    for (const m of readFileSync(file, 'utf8').matchAll(EXPANSION)) {
      const target = posix.normalize(m[1].replace(/^\/+/, ''));
      if (target.startsWith('..') || !existsSync(join(root, 'plugin', target))) fail(`${rel} runs \${CLAUDE_PLUGIN_ROOT}/${m[1]}, which is not in plugin/: an installed copy has no such file`);
    }
  }

  // What installs cites nothing that does not install with it: the maintainer's SPEC and PLAN stay in
  // the repository, so a pointer to them from plugin/ is a pointer an installed copy cannot follow.
  // SPEC and PLAN in capitals only: `plan` is a mode. A feature id is dotted (F2.2b): bare F1 is a
  // phase, a key or a score. A guardrail number has one or two digits. A docs/ or evals/ path (bare,
  // or after ./) is a citation when it names something inside them in this repository, with or
  // without .md: a reader's own docs/ is not one, unless its name is also one of this repository's,
  // where an installed reader cannot tell the two apart either, so the sentence is reworded. URLs
  // are skipped: they resolve anywhere.
  const cited = (line) => {
    const bare = line.replace(/https?:\/\/\S+/g, '');
    const repoPath = [...bare.matchAll(/(?<![\w.-])(?<!(?<!\.)\/)(?:docs|evals)\/[\w.-][\w./-]*/g)]
      .map((m) => m[0].replace(/[./]+$/, ''))
      .find((rel) => rel.includes('/') && (existsSync(join(root, rel)) || existsSync(join(root, `${rel}.md`))));   // a name inside, not the bare directory
    return bare.match(/\bSPEC\b|\bPLAN\b|\bF[0-9]+\.[0-9]+[a-z]?\b|\bCONTRIBUTING\.md\b/) || bare.match(/\bguard-?rails?\s*[-#]?\s*[0-9]{1,2}\b/i) || (repoPath && [repoPath]);
  };
  for (const file of pluginFiles) {
    const rel = file.slice(root.length + 1);
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const hit = cited(line);
      if (hit) fail(`${rel}:${i + 1} cites "${hit[0].trim()}", which does not install with the plugin; state the reason in place`);
    });
  }
  for (const name of existsSync(join(root, 'plugin/hooks')) ? readdirSync(join(root, 'plugin/hooks')) : []) {
    if (/\.\.[\\/]\.\.|'\.\.', '\.\.'/.test(read(`plugin/hooks/${name}`))) fail(`plugin/hooks/${name} reaches outside the plugin; an installed copy has nothing there`);
  }

  // Every public skill should install from the canonical repository; agents remain optional companions.
  for (const skill of expectedSkills) {
    const path = `plugin/skills/${skill}/README.md`;
    if (!existsSync(join(root, path))) fail(`${skill} missing README.md`);
    else if (!read(path).includes(CANONICAL_REPO)) fail(`${path} does not name the canonical install source`);
  }
  return errors;
}

// CLI: run against this repo's plugin/skills/ plus the root README, and exit non-zero on any error.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const skillsRoot = join(repoRoot, 'plugin', 'skills');
  const errors = [
    ...validate(skillsRoot),
    ...checkRelativeLinks(join(repoRoot, 'README.md')).map((e) => `repo: README.md ${e}`),
    ...checkSkillTotal(skillsRoot, SKILL_TOTAL_BUDGETS).map((e) => `repo: ${e}`),
    ...checkRepository(repoRoot).map((e) => `repo: ${e}`),
  ];
  if (errors.length) {
    console.error(`✗ validation failed (${errors.length}):`);
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }
  const units = findUnits(skillsRoot);
  const modes = (root) => (existsSync(join(root, 'modes')) ? readdirSync(join(root, 'modes')).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : []);
  console.log(`✓ ${units.length} capability(ies) valid: ${units.map(([n, r]) => `${n} (modes: ${modes(r).join(', ')})`).join('; ')}`);
}
