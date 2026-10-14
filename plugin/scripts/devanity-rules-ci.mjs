#!/usr/bin/env node
// devanity — reference CI job. The ceiling of what the PreToolUse guard can
// only estimate from Bash: it sees the whole diff of a pull request.
//
//   node plugin/scripts/devanity-rules-ci.mjs [--base <ref>] [--pr-body-file <path>] [--no-proof-required]
//                                     [--root <dir>] [--plugin-dir <dir>] [--self-check]
//
// 1. validates <root>/devanity.rules.json with the plugin's own loader (hooks/devanity-rules.js,
//    found next to this script inside the plugin, or under --plugin-dir / DEVANITY_PLUGIN_DIR);
// 2. computes the files changed between the merge base of --base (default origin/main, then main)
//    and HEAD, with added lines per file (`git diff --numstat`);
// 3. the map stays alive: every `paths` glob must match a tracked file;
// 4. per touched path: delta budgets (files and added lines per glob); the distinct `check` of
//    every touched high-risk path runs, and every declared check runs when the rules file changed;
//    a `devanity-proof:` block is required in the PR body (--pr-body-file, or GITHUB_EVENT_PATH
//    pull_request.body) when any touched path is tier normal or high-risk (the rung-3+ proxy)
//    unless --no-proof-required;
// 5. verifier sovereignty: a diff that removes or rewrites lines of existing tests, or changes a
//    declared check/tier/test glob, together with code needs a `verifier-change:` line in the body;
// 6. instruction references (surfaces.mjs): a diff that removes a path or package script an
//    always-loaded or path-scoped instruction file named at the base, on a line the diff left as it
//    was, fails (loaded on demand, on a rewritten line, or declared by a `reference-change:` line
//    in the PR body, it is reported); a reference the diff adds that does not resolve is reported. A proof that
//    says `failed_before: yes` on a diff with no test and no declared check is reported, never failed;
// 7. --self-check: the dogfood mode for the plugin repository itself: validates its rules and runs
//    steps 2–6 on HEAD~1..HEAD (the checks execute) without requiring a PR body (a shallow clone
//    with no parent validates the rules and reports an empty change set).
//
// Exit 1 with a list of failures, 0 otherwise. Node >= 18, no dependencies.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { measureEntropy, renderEntropy, worseParts } from './entropy.mjs';
import { compare, gitIgnored, gitRun, surfacesOf } from './surfaces.mjs';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def; };
const flag = (name) => args.includes(name);

const selfCheck = flag('--self-check');
const root = resolve(opt('--root', process.cwd()));
const scriptDir = dirname(fileURLToPath(import.meta.url));

function findLoader() {
  // The plugin this script ships in (its hooks/ sit one level up), or wherever --plugin-dir points.
  const candidates = [opt('--plugin-dir', null), process.env.DEVANITY_PLUGIN_DIR, resolve(scriptDir, '..')].filter(Boolean);
  for (const dir of candidates) {
    const file = join(resolve(dir), 'hooks', 'devanity-rules.js');
    if (existsSync(file)) return file;
  }
  return null;
}

const failures = [];
const notes = [];
const fail = (m) => failures.push(m);
const note = (m) => notes.push(m);

function git(...a) {
  const r = gitRun(root, a);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// File contents at a revision, untrimmed (line numbers count from the first byte), or null.
function show(rev, path) {
  const r = gitRun(root, ['show', `${rev}:${path}`]);
  return r.status === 0 ? r.stdout : null;
}

// The files at a revision, how to read them, and the symlinks (path → target) and submodules git
// records there.
function snapshot(rev) {
  const r = gitRun(root, ['ls-tree', '-r', '-z', rev]);
  const entries = (r.stdout || '').split('\0').filter(Boolean).map((l) => [l.slice(0, 6), l.slice(l.indexOf('\t') + 1)]);
  const links = new Map(entries.filter(([mode]) => mode === '120000').map(([, p]) => [p, show(rev, p)]));
  const modules = new Set(entries.filter(([mode]) => mode === '160000').map(([, p]) => p));
  return { files: entries.map(([, p]) => p), read: (p) => show(rev, p), links, modules };
}

// The diff's renames, new path → old path. `-z` output is a status token, then one path, or two
// for a rename or copy: read it as records, so a file named `R` is a path, never a status.
function renames(from) {
  const out = (gitRun(root, ['diff', '--name-status', '-M', '-z', from, 'HEAD']).stdout || '').split('\0');
  const map = new Map();
  for (let i = 0; i + 1 < out.length;) {
    const status = out[i];
    if (/^[RC]/.test(status)) { if (status[0] === 'R') map.set(out[i + 2], out[i + 1]); i += 3; } else i += 2;
  }
  return map;
}

function resolveBase() {
  if (selfCheck) return git('rev-parse', '--verify', '-q', 'HEAD~1').ok ? 'HEAD~1' : null;
  const asked = opt('--base', null);
  const candidates = asked ? [asked] : ['origin/main', 'main'];
  for (const c of candidates) if (git('rev-parse', '--verify', '-q', c).ok) return c;
  fail(`base ref not found (tried ${candidates.join(', ')}); pass --base <ref> or fetch it (actions/checkout with fetch-depth: 0)`);
  return null;
}

// The merge base of `base` and HEAD: what the diff is measured from.
function fromRev(base) {
  const mb = git('merge-base', base, 'HEAD');
  return mb.ok && mb.out ? mb.out : base;
}

// [{path, added, deleted}] between the merge base of `base` and HEAD. `-z` keeps every UTF-8 path as
// it is (without it git C-quotes a non-ASCII name); a rename is `added\tdeleted\t` then the old and
// the new path as their own records, and the new path is the one touched. Only the first two tabs
// separate fields: a path may hold one.
function changedFiles(base) {
  const r = gitRun(root, ['diff', '--numstat', '-z', '-M', fromRev(base), 'HEAD']);
  if (r.status !== 0) { fail(`git diff failed: ${(r.stderr || '').trim()}`); return []; }
  const records = (r.stdout || '').split('\0');
  const files = [];
  for (let i = 0; i < records.length; i++) {
    const m = /^([^\t]*)\t([^\t]*)\t([\s\S]*)$/.exec(records[i]);
    if (!m) continue;
    const [, added, deleted, rawPath] = m;
    const path = rawPath === '' ? records[(i += 2)] : rawPath;
    files.push({ path, added: added === '-' ? 0 : parseInt(added, 10) || 0, deleted: deleted === '-' ? 0 : parseInt(deleted, 10) || 0 });
  }
  return files;
}

function prBody() {
  const file = opt('--pr-body-file', null);
  if (file) { try { return readFileSync(file, 'utf8'); } catch (e) { fail(`cannot read --pr-body-file ${file}: ${e.message}`); return null; } }
  const ev = process.env.GITHUB_EVENT_PATH;
  if (ev && existsSync(ev)) {
    try {
      const j = JSON.parse(readFileSync(ev, 'utf8'));
      if (j && j.pull_request) return String(j.pull_request.body || '');
    } catch (e) { /* not a usable event */ }
  }
  return null;   // no PR context
}

function hasProofBlock(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const i = lines.findIndex((l) => /^\s*devanity-proof\s*:\s*$/.test(l));
  if (i < 0) return { present: false };
  const block = lines.slice(i + 1).join('\n');
  const field = (name) => new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*(\\S.*?)[ \\t]*$`, 'm').exec(block)?.[1] || null;   // one line: an empty field never takes the next
  return { present: true, status: field('status'), check: field('check'), failedBefore: field('failed_before') };
}

// Whether a PR body declares `<name>: <why>`: the reason on the same line, never the next one's.
const declares = (body, name) => body !== null && new RegExp(`^[ \\t]*${name}[ \\t]*:[ \\t]*\\S`, 'm').test(body);

function runCheck(command) {
  const [bin, a] = process.platform === 'win32' ? ['cmd', ['/d', '/s', '/c', command]] : ['sh', ['-c', command]];
  const r = spawnSync(bin, a, { cwd: root, stdio: 'inherit' });
  return r.status === 0;
}

// ---- 1. rules
const loaderFile = findLoader();
if (!loaderFile) { fail('hooks/devanity-rules.js not found: run this script from the devanity plugin, or set --plugin-dir / DEVANITY_PLUGIN_DIR to a checkout of it'); }
let rulesMod = null;
let loaded = null;
if (loaderFile) {
  rulesMod = createRequire(import.meta.url)(loaderFile);
  loaded = rulesMod.loadRules(root);
  if (!loaded.present) fail(`${rulesMod.FILE} not found in ${root}`);
  for (const e of loaded.errors) fail(`${rulesMod.FILE}: ${e}`);
}

// ---- 2. diff
let files = [];
const base = loaded && loaded.present && !loaded.errors.length ? resolveBase() : null;
if (base) files = changedFiles(base);
else if (selfCheck && loaded && loaded.present) note('no parent commit (shallow clone): rules validated, empty change set');

// ---- 3. per touched path
if (base && rulesMod && !loaded.errors.length) {
  const rules = loaded.rules;
  const touched = files.map((f) => ({ ...f, rule: rulesMod.ruleFor(rules, f.path) }));
  for (const t of touched) note(`${t.path}: tier ${t.rule.tier}${t.rule.glob ? ` (${t.rule.glob})` : ''}, +${t.added}`);

  // delta budgets per glob
  const byGlob = new Map();
  for (const t of touched) {
    if (!t.rule.glob || !t.rule.delta) continue;
    const g = byGlob.get(t.rule.glob) || { files: 0, lines: 0, delta: t.rule.delta };
    g.files += 1; g.lines += t.added;
    byGlob.set(t.rule.glob, g);
  }
  for (const [glob, g] of byGlob) {
    if (g.delta.files !== undefined && g.files > g.delta.files) fail(`delta budget exceeded for ${glob}: ${g.files} files changed, budget ${g.delta.files}`);
    if (g.delta.lines !== undefined && g.lines > g.delta.lines) fail(`delta budget exceeded for ${glob}: ${g.lines} lines added, budget ${g.delta.lines}`);
  }

  // entropy (A3.2): reported for every change; a glob with `delta.entropy: ratchet` fails when the
  // files touched under it got worse (A3.3). A measurement that cannot be made is said, never scored.
  if (files.length) {
    try {
      const from = fromRev(base);
      note(renderEntropy(measureEntropy(root, from, 'HEAD')));
      for (const p of rules.paths) {
        if (!p.rule.delta || p.rule.delta.entropy !== 'ratchet') continue;
        const under = touched.filter((t) => p.re.test(t.path)).map((t) => t.path);
        if (!under.length) continue;
        const e = measureEntropy(root, from, 'HEAD', under);
        if (e.worse) fail(`entropy ratchet: ${p.glob} got worse (${worseParts(e)})`);
      }
    } catch (e) { note(`entropy: not measured (${e.message})`); }
  }

  // the map stays alive: every declared path matches a tracked file
  const tracked = git('ls-files').out.split('\n').filter(Boolean);
  for (const p of rules.paths) if (!tracked.some((f) => p.re.test(f))) fail(`devanity.rules.json: ${p.glob} matches no tracked file (a map entry for a path that is gone)`);

  // instruction references: what an instruction file names must still exist after the diff. Only a
  // reference that held at the base can break, so a path that never existed never fails;
  // a skill (loaded on demand, often vendored) is reported, since its examples name scripts and
  // paths of no repository in particular.
  const before = snapshot(fromRev(base));
  const after = snapshot('HEAD');
  const refs = compare(before, after, renames(fromRev(base)), gitIgnored(root));
  // A `reference-change: <why>` line in the PR body declares the breaks for review, as
  // `verifier-change:` does for a verifier: a residual false failure costs one visible line.
  const declaredRefs = declares(selfCheck ? null : prBody(), 'reference-change');
  for (const b of refs.broken) {
    const what = `${b.path}:${b.line} names \`${b.target}\`, which resolved before this diff and does not now`;
    if (b.load === 'on-demand') note(`${what} (loaded on demand: reported, not failed)`);
    else if (!b.stale) note(`${what} (its line was rewritten in this diff: the author's statement, reported, not failed)`);
    else if (declaredRefs) note(`${what} (declared by reference-change in the PR body)`);
    else fail(`${what}: point it at what replaced it, remove it, or declare it with a \`reference-change: <why>\` line in the PR body`);
  }
  for (const a of refs.added) note(`${a.path}:${a.line} names \`${a.target}\`, which does not exist (a reference this diff adds: reported, not failed)`);

  // checks of touched high-risk paths; when the rules file itself changed, every declared check,
  // so a check that no longer runs cannot enter the map
  const rulesChanged = touched.some((t) => t.path === rulesMod.FILE);
  const highRisk = touched.filter((t) => t.rule.tier === 'high-risk' && t.rule.check).map((t) => t.rule.check);
  const declared = rulesChanged ? rules.paths.map((p) => p.rule.check).filter(Boolean) : [];
  const checkPassed = new Map();
  for (const c of [...new Set([...highRisk, ...declared])]) {
    console.log(`\n$ ${c}`);
    checkPassed.set(c, runCheck(c));
    if (!checkPassed.get(c)) fail(highRisk.includes(c) ? `check failed: ${c}` : `declared check does not pass: ${c} (the rules file changed; every check it declares must run green)`);
  }

  // verifier sovereignty: a diff that removes or rewrites lines of existing tests
  // together with code is reviewed as a verifier change, declared in the PR body
  const verifierEdits = touched.filter((t) => t.deleted > 0 && rulesMod.isTestPath(rules, t.path)).map((t) => t.path);
  // The rules file is a verifier too: a changed `check`, `tier`, `delta` or `tests` is a change to what
  // judges, and so is a changed `commands` or `autonomy`, which decide what the session may do unasked.
  // Both sides are compared as the loader reads them (defaults filled, keys sorted), so a reordered or
  // spelled-out-default file is not a change; an invalid one always is.
  if (rulesChanged) {
    const prior = git('show', `${fromRev(base)}:${rulesMod.FILE}`);
    const sorted = (_, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) : v);
    const judges = (text) => {
      const parsed = rulesMod.parseRules(text);
      if (parsed.errors.length) return `invalid:${text}`;
      const r = parsed.rules;
      const raw = JSON.parse(text);
      return JSON.stringify([r.paths.map((p) => [p.glob, p.rule.tier, p.rule.check || null, p.rule.delta || null]).sort(), r.tests.map((t) => t.glob).sort(), r.defaults, r.commands, r.autonomy, raw.verifiers || null], sorted);
    };
    if (!prior.ok || judges(prior.out) !== judges(readFileSync(join(root, rulesMod.FILE), 'utf8'))) verifierEdits.push(rulesMod.FILE);
  }
  // The files the declared checks read (map `verifiers`: package scripts, runner config) judge too.
  const verifierRes = (loaded.raw && Array.isArray(loaded.raw.verifiers) ? loaded.raw.verifiers : []).map((g) => rulesMod.globToRegExp(g));
  for (const t of touched) if (verifierRes.some((re) => re.test(t.path)) && !verifierEdits.includes(t.path)) verifierEdits.push(t.path);
  const isVerifier = (p) => rulesMod.isTestPath(rules, p) || p === rulesMod.FILE || verifierRes.some((re) => re.test(p));
  const codeTouched = touched.some((t) => !isVerifier(t.path) && !/\.md$/i.test(t.path));
  if (verifierEdits.length && codeTouched) {
    const body = selfCheck ? null : prBody();
    const declaredChange = declares(body, 'verifier-change');
    if (declaredChange) note(`verifier-change declared for ${verifierEdits.join(', ')}`);
    else if (body === null) note(`the diff edits existing checks with code (${verifierEdits.join(', ')}); no PR body to hold the verifier-change line`);
    else fail(`the diff edits existing checks together with the code they judge (${verifierEdits.join(', ')}): add a \`verifier-change: <why>\` line to the PR body so review treats it as a verifier change`);
  }

  // What was at stake: the touched paths the map says something about, with the reason a human wrote
  // (purpose, invariants), and for each high-risk one the dominance certificate. The certificate
  // holds when the change satisfies what a human already declared: the path's check passes, no
  // verifier or instruction file changed, and its delta budget holds. It is observed only: it
  // releases nothing and never changes this job's verdict, so its rate can be measured first.
  // The map's text is repository content: one line each, with markdown and HTML neutralized, so an
  // invariant can neither forge a line of this summary nor open a code fence around the rest.
  const md = (text) => Array.from(String(text == null ? '' : text).replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, ' ').trim()).slice(0, 300).join('')   // code points: never half a character
    .replace(/[\\`*_[\]|~#]/g, (c) => `\\${c}`).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const surfaces = new Set([...surfacesOf(before.files), ...surfacesOf(after.files)]);
  const instruction = (p) => surfaces.has(p) || /(^|\/)\.claude\//.test(p);
  const stakes = new Map();
  for (const t of touched) {
    const r = t.rule;
    if (!r.glob || !(r.tier === 'high-risk' || r.purpose || (r.invariants && r.invariants.length))) continue;
    const s = stakes.get(r.glob) || { rule: r, files: [] };
    s.files.push(t.path);
    stakes.set(r.glob, s);
  }
  if (stakes.size) {
    const out = ['## What was at stake', ''];
    for (const [glob, { rule: r, files: fs }] of stakes) {
      out.push(`- ${md(glob)} (${r.tier}${r.core ? ', core' : ''}): ${fs.length} file(s)${r.purpose ? ` — ${md(r.purpose)}` : ''}`);
      for (const inv of r.invariants || []) out.push(`  - never changes: ${md(rulesMod.invariantText(inv))}`);
      if (r.tier !== 'high-risk') continue;
      const why = [];
      if (!r.check) why.push('no declared check');
      else if (checkPassed.get(r.check) === false) why.push('its check fails');
      if (verifierEdits.length) why.push(`a verifier changed (${verifierEdits.map(md).join(', ')})`);
      const g = byGlob.get(glob);
      if (g && ((g.delta.files !== undefined && g.files > g.delta.files) || (g.delta.lines !== undefined && g.lines > g.delta.lines))) why.push('its delta budget is exceeded');
      const instr = touched.filter((t) => instruction(t.path)).map((t) => t.path);
      if (instr.length) why.push(`an instruction file changed (${instr.map(md).join(', ')})`);
      out.push(`  - dominance certificate: ${why.length ? `does not hold — ${why.join('; ')}` : 'holds: the change satisfies what a human already declared'}`);
    }
    out.push('', '_The certificate is observation only: nothing is released on it._');
    console.log(`\n${out.join('\n').replace(/dominance certificate: /g, 'certificate: ')}`);
    if (process.env.GITHUB_STEP_SUMMARY) { try { appendFileSync(process.env.GITHUB_STEP_SUMMARY, out.join('\n') + '\n'); } catch (e) { note(`could not write the job summary: ${e.message}`); } }
  }

  // proof block in the PR body for rung 3+
  const needsProof = touched.some((t) => t.rule.tier !== 'trivial');
  if (needsProof && !selfCheck && !flag('--no-proof-required')) {
    const body = prBody();
    if (body === null) note('no pull request body available (not a pull_request event and no --pr-body-file): proof requirement not checked');
    else {
      const p = hasProofBlock(body);
      if (!p.present) fail('the diff touches a normal or high-risk path (rung 3+) but the PR body has no `devanity-proof:` block');
      else if (!p.status) fail('the PR body has a `devanity-proof:` block without a `status:` line');
      else {
        note(`devanity-proof in PR body: status ${p.status}`);
        // A claim that a check failed first needs an oracle the diff carries or the map declares.
        // Observed only: an existing test can legitimately be the one that failed.
        const oracle = touched.some((t) => rulesMod.isTestPath(rules, t.path) || (t.rule.check && t.rule.check === p.check));
        if (p.failedBefore === 'yes' && !oracle) note('the proof says `failed_before: yes`, but the diff changes no test and its `check` is no declared check of a touched path: nothing in this diff could have measured it (reported, never failed)');
      }
    }
  } else if (needsProof && selfCheck) note('self-check: proof block in PR body not required');
}

// ---- report
console.log(`\ndevanity rules${selfCheck ? ' (self-check)' : ''}: ${root}`);
if (base) console.log(`base: ${base}; ${files.length} file(s) changed`);
for (const n of notes) console.log(`  - ${n}`);
if (failures.length) {
  console.error(`\nFAILED (${failures.length}):`);
  for (const f of failures) console.error(`  x ${f}`);
  process.exit(1);
}
console.log('\nOK');
