// Tests for plugin/scripts/devanity-rules-ci.mjs (the reference CI job, F2.8). node:test, no dependencies.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(root, 'plugin', 'scripts', 'devanity-rules-ci.mjs');

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-ci-test-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const fresh = () => { const d = join(temp, `r${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const commitAll = (cwd, msg) => { git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg); };
const write = (cwd, rel, text) => { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); };

function runCi(cwd, args = [], env = {}) {
  const inherited = { ...process.env };
  delete inherited.GITHUB_EVENT_PATH;   // the suite may itself run in Actions
  delete inherited.NODE_TEST_CONTEXT;   // node's runner marks this process; a nested check must not report to it
  const e = { ...inherited, ...env };
  const r = spawnSync(process.execPath, [SCRIPT, '--root', cwd, ...args], { cwd, encoding: 'utf8', env: e });
  return { code: r.status, out: r.stdout + r.stderr };
}

// main holds a rules file and one billing file; a `feature` branch adds to billing.
function seed({ rules, changes }) {
  const d = fresh();
  git(d, 'init', '-q', '-b', 'main');
  write(d, 'devanity.rules.json', JSON.stringify(rules));
  write(d, 'billing/charge.js', 'module.exports = 1;\n');
  write(d, 'docs/a.md', 'a\n');
  commitAll(d, 'base');
  git(d, 'checkout', '-qb', 'feature');
  for (const [rel, text] of Object.entries(changes)) write(d, rel, text);
  commitAll(d, 'change');
  return d;
}

const marker = (d) => `node -e "require('fs').writeFileSync('${join(d, 'ci.marker')}', '1')"`;

describe('rules CI', () => {
  test('validates the rules file: missing or invalid fails with a clear message', () => {
    const d = fresh(); git(d, 'init', '-q', '-b', 'main');
    let r = runCi(d, ['--base', 'HEAD']);
    assert.equal(r.code, 1); assert.match(r.out, /devanity\.rules\.json not found/);
    write(d, 'devanity.rules.json', '{"version": 3}');
    r = runCi(d, ['--base', 'HEAD']);
    assert.equal(r.code, 1); assert.match(r.out, /version must be 1/);
  });

  test('delta budget exceeded fails; within budget passes (trivial-only diff needs no proof)', () => {
    const rules = { version: 1, paths: { 'billing/**': { tier: 'high-risk', delta: { files: 1, lines: 10 } }, 'docs/**': { tier: 'trivial' } } };
    let d = seed({ rules, changes: { 'billing/a.js': '1\n', 'billing/b.js': '2\n' } });
    let r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /delta budget exceeded for billing\/\*\*: 2 files changed, budget 1/);
    d = seed({ rules, changes: { 'billing/a.js': Array(20).fill('x').join('\n') + '\n' } });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /20 lines added, budget 10/);
    d = seed({ rules, changes: { 'docs/b.md': 'b\n' } });
    r = runCi(d, ['--base', 'main']);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /docs\/b\.md: tier trivial/);
  });

  test('entropy is reported for every change, and a `delta.entropy: ratchet` glob fails the job when it got worse (A3.2, A3.3)', () => {
    const block = ['const a = read(x);', 'if (!a) {', '  return fail(1);', '}', 'const b = parse(a);', 'return b.value;'].join('\n');
    const dupe = { 'billing/a.js': `${block}\n`, 'billing/b.js': `${block}\n` };
    let d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'normal' } } }, changes: dupe });
    let r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /entropy \S+\.\.HEAD: .*duplication 0 → 4 \(\+4\)/, r.out);
    d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'normal', delta: { entropy: 'ratchet' } } } }, changes: dupe });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /entropy ratchet: billing\/\*\* got worse \(duplication \+4\)/, r.out);
    d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'normal', delta: { entropy: 'ratchet' } } } }, changes: { 'billing/a.js': 'const a = 1;\n' } });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 0, r.out);
  });

  test('the check of a touched high-risk path runs (once per distinct command) and its failure fails the job', () => {
    // the check must reference this repo's own marker path, so the rules are written after seeding
    let d = seed({ rules: { version: 1 }, changes: {} });
    const rules = { version: 1, paths: { 'billing/**': { tier: 'high-risk', check: marker(d) }, 'billing/legacy/**': { tier: 'high-risk', check: marker(d) } } };
    write(d, 'devanity.rules.json', JSON.stringify(rules));
    write(d, 'billing/charge.js', 'module.exports = 2;\n'); write(d, 'billing/legacy/x.js', '1\n');
    commitAll(d, 'touch billing');
    let r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 0, r.out);
    assert.ok(existsSync(join(d, 'ci.marker')), 'the check ran');
    assert.equal((r.out.match(/^\$ node -e/gm) || []).length, 1, 'one distinct check runs once');
    write(d, 'devanity.rules.json', JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', check: 'exit 3' } } }));
    write(d, 'billing/charge.js', 'module.exports = 3;\n'); commitAll(d, 'again');
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /check failed: exit 3/);
    d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'high-risk', check: 'exit 3' } } }, changes: { 'src/other.js': '1\n' } });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 0, 'a check of an untouched path does not run');
  });

  test('a normal or high-risk touch requires a devanity-proof block in the PR body', () => {
    const d = seed({ rules: { version: 1, paths: { 'docs/**': { tier: 'trivial' } } }, changes: { 'src/app.js': '1\n' } });
    const body = join(temp, `body${n}.md`);
    writeFileSync(body, 'Fixes the thing.\n');
    let r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /no `devanity-proof:` block/);
    writeFileSync(body, 'Fixes the thing.\n\n```\ndevanity-proof:\n  check: node --test\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /devanity-proof in PR body: status VERIFIED/);
    // the GitHub event payload is the default source
    const ev = join(temp, `event${n}.json`);
    writeFileSync(ev, JSON.stringify({ pull_request: { body: 'no block' } }));
    r = runCi(d, ['--base', 'main'], { GITHUB_EVENT_PATH: ev });
    assert.equal(r.code, 1, r.out);
    r = runCi(d, ['--base', 'main']);
    assert.equal(r.code, 0, 'without any PR context the requirement is reported, not failed');
    assert.match(r.out, /no pull request body available/);
  });

  test('the map stays alive: a path that matches no tracked file fails, and a changed rules file runs every declared check', () => {
    let d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'high-risk' }, 'payments/**': { tier: 'high-risk' } } }, changes: { 'docs/a.md': 'b\n' } });
    let r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /payments\/\*\* matches no tracked file/);
    d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'normal' } } }, changes: { 'devanity.rules.json': JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'normal', check: 'node -e "process.exit(3)"' } } }) } });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /declared check does not pass/);
    d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'normal' } } }, changes: { 'devanity.rules.json': JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'normal', check: marker(fresh()) } } }) } });
    r = runCi(d, ['--base', 'main', '--no-proof-required']);
    assert.equal(r.code, 0, r.out);
  });

  test('verifier sovereignty: a diff that edits existing checks together with code needs a verifier-change line', () => {
    const rules = { version: 1, paths: { 'docs/**': { tier: 'trivial' } } };
    const d = fresh(); git(d, 'init', '-q', '-b', 'main');
    write(d, 'devanity.rules.json', JSON.stringify(rules));
    write(d, 'src/app.js', 'module.exports = 1;\n');
    write(d, 'src/app.test.js', "assert(app() === 2);\nassert(app(1) === 3);\n");
    write(d, 'docs/a.md', 'a\n');
    commitAll(d, 'base');
    git(d, 'checkout', '-qb', 'feature');
    write(d, 'src/app.js', 'module.exports = 2;\n');
    write(d, 'src/app.test.js', "assert(app() === 2);\n");   // an assertion removed with the fix
    commitAll(d, 'change');
    const body = join(temp, `vbody${n}.md`);
    const proof = '\n```\ndevanity-proof:\n  check: node --test\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n';
    writeFileSync(body, 'Fix.' + proof);
    let r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*src\/app\.test\.js/);
    writeFileSync(body, 'Fix.\n\nverifier-change: the second case asserted the old contract, removed on purpose\n' + proof);
    r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /verifier-change declared/);
    // adding a test next to the fix is the normal case, not a verifier change
    const d2 = fresh(); git(d2, 'init', '-q', '-b', 'main');
    write(d2, 'devanity.rules.json', JSON.stringify(rules)); write(d2, 'src/app.js', 'module.exports = 1;\n'); write(d2, 'src/app.test.js', 'assert(true);\n'); write(d2, 'docs/a.md', 'a\n');
    commitAll(d2, 'base'); git(d2, 'checkout', '-qb', 'feature');
    write(d2, 'src/app.js', 'module.exports = 2;\n'); write(d2, 'src/app.test.js', 'assert(true);\nassert(app() === 2);\n');
    commitAll(d2, 'change');
    writeFileSync(body, 'Fix.' + proof);
    r = runCi(d2, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, r.out);
  });

  test('verifier sovereignty: weakening a declared check together with code needs a verifier-change line too', () => {
    const d = fresh(); git(d, 'init', '-q', '-b', 'main');
    write(d, 'devanity.rules.json', JSON.stringify({ version: 1, paths: { 'src/**': { tier: 'normal', check: 'node src/t.js' } } }));
    write(d, 'src/a.js', 'module.exports = 1;\n'); write(d, 'src/t.js', "process.exit(require('./a.js') === 1 ? 0 : 1);\n");
    commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
    write(d, 'src/a.js', 'module.exports = 2;\n');
    write(d, 'devanity.rules.json', JSON.stringify({ version: 1, paths: { 'src/**': { tier: 'normal', check: 'true' } } }));
    commitAll(d, 'change');
    const body = join(temp, `rbody${n}.md`);
    writeFileSync(body, 'Change.\n```\ndevanity-proof:\n  check: true\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    const r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*devanity\.rules\.json/);
  });

  test('verifier sovereignty: editing a declared verifier config or the default tier together with code is a verifier change', () => {
    const d = fresh(); git(d, 'init', '-q', '-b', 'main');
    write(d, 'devanity.rules.json', JSON.stringify({ version: 1, verifiers: ['package.json'], paths: { 'src/**': { tier: 'normal', check: 'npm test --silent' } } }));
    write(d, 'package.json', JSON.stringify({ scripts: { test: 'node src/t.js' } }));
    write(d, 'src/a.js', 'module.exports = 1;\n'); write(d, 'src/t.js', "process.exit(require('./a.js') === 1 ? 0 : 1);\n");
    commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
    write(d, 'src/a.js', 'module.exports = 2;\n'); write(d, 'package.json', JSON.stringify({ scripts: { test: 'true' } }));
    commitAll(d, 'change');
    const body = join(temp, `vcbody${n}.md`);
    writeFileSync(body, 'Change.\n```\ndevanity-proof:\n  check: npm test\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    let r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*package\.json/);
    const d2 = fresh(); git(d2, 'init', '-q', '-b', 'main');
    write(d2, 'devanity.rules.json', JSON.stringify({ version: 1, defaults: { tier: 'normal' }, paths: { 'docs/**': { tier: 'trivial' } } }));
    write(d2, 'src/a.js', '1\n'); write(d2, 'docs/a.md', 'a\n');
    commitAll(d2, 'base'); git(d2, 'checkout', '-qb', 'feature');
    write(d2, 'devanity.rules.json', JSON.stringify({ version: 1, defaults: { tier: 'normal', authority: 'deploy' }, paths: { 'docs/**': { tier: 'trivial' } } }));
    write(d2, 'src/a.js', '2\n');
    commitAll(d2, 'change');
    r = runCi(d2, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*devanity\.rules\.json/);
  });
  test('verifier sovereignty: changing command authority or the autonomy envelope together with code is a verifier change', () => {
    const body = join(temp, `acbody${n}.md`);
    writeFileSync(body, 'Change.\n```\ndevanity-proof:\n  check: true\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    const base = { version: 1, commands: { 'fly\\s+deploy': 'deploy' }, autonomy: { authority: 'prepare' }, paths: { 'docs/**': { tier: 'trivial' } } };
    for (const loosened of [{ ...base, commands: {} }, { ...base, autonomy: { authority: 'commit' } }]) {
      const d = fresh(); git(d, 'init', '-q', '-b', 'main');
      write(d, 'devanity.rules.json', JSON.stringify(base)); write(d, 'src/a.js', '1\n'); write(d, 'docs/a.md', 'a\n');
      commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
      write(d, 'devanity.rules.json', JSON.stringify(loosened)); write(d, 'src/a.js', '2\n');
      commitAll(d, 'change');
      const r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*devanity\.rules\.json/);
    }
  });
  test('verifier sovereignty: the rules are compared as the loader reads them, so reordering is not a change and a raised delta is', () => {
    const body = join(temp, `nbody${n}.md`);
    writeFileSync(body, 'Change.\n```\ndevanity-proof:\n  check: true\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    const base = { version: 1, commands: { 'fly\\s+deploy': 'deploy', 'make\\s+ship': 'merge' }, autonomy: { authority: 'prepare', 'high-risk': 'queue' }, paths: { 'src/**': { tier: 'normal', delta: { files: 2 } }, 'docs/**': { tier: 'trivial' } } };
    const same = { version: 1, paths: { 'docs/**': { tier: 'trivial' }, 'src/**': { delta: { files: 2 }, tier: 'normal' } }, autonomy: { 'high-risk': 'queue', authority: 'prepare', irreversible: 'queue' }, commands: { 'make\\s+ship': 'merge', 'fly\\s+deploy': 'deploy' }, defaults: { tier: 'normal', authority: 'commit' } };
    const raised = { ...base, paths: { ...base.paths, 'src/**': { tier: 'normal', delta: { files: 50 } } } };
    for (const [next, verifier] of [[same, false], [raised, true]]) {
      const d = fresh(); git(d, 'init', '-q', '-b', 'main');
      write(d, 'devanity.rules.json', JSON.stringify(base)); write(d, 'src/a.js', '1\n'); write(d, 'docs/a.md', 'a\n');
      commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
      write(d, 'devanity.rules.json', JSON.stringify(next)); write(d, 'src/a.js', '2\n');
      commitAll(d, 'change');
      const r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
      if (verifier) { assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks .*devanity\.rules\.json/); }
      else { assert.equal(r.code, 0, `the same rules, reordered and with explicit defaults, are not a verifier change:\n${r.out}`); }
    }
  });
  test('what was at stake: the touched paths\' purpose and invariants, and the dominance certificate, observed only', () => {
    const rules = { version: 1, tests: ['billing/t.js'], paths: { 'billing/**': { tier: 'high-risk', check: 'node billing/t.js', purpose: 'charges and refunds', invariants: ['amounts are integer cents'] }, 'docs/**': { tier: 'trivial' } } };
    const body = join(temp, `sbody${n}.md`);
    writeFileSync(body, 'Fix.\n\nverifier-change: test tightened\n\n```\ndevanity-proof:\n  check: node billing/t.js\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    const seedWith = (changes) => {
      const d = fresh(); git(d, 'init', '-q', '-b', 'main');
      write(d, 'devanity.rules.json', JSON.stringify(rules));
      write(d, 'billing/charge.js', 'module.exports = 2;\n'); write(d, 'billing/t.js', "process.exit(require('./charge.js') === 1 ? 0 : 1);\n"); write(d, 'docs/a.md', 'a\n');
      commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
      for (const [rel, text] of Object.entries(changes)) write(d, rel, text);
      commitAll(d, 'change');
      return d;
    };
    // A fix that makes the existing check pass, with no verifier touched: the certificate holds.
    let d = seedWith({ 'billing/charge.js': 'module.exports = 1;\n' });
    const summary = join(temp, `summary${n}.md`);
    let r = runCi(d, ['--base', 'main', '--pr-body-file', body], { GITHUB_STEP_SUMMARY: summary });
    assert.equal(r.code, 0, r.out);
    for (const part of ['What was at stake', 'billing/**', 'charges and refunds', 'amounts are integer cents', 'certificate: holds']) assert.ok(r.out.includes(part), `stdout lacks "${part}":\n${r.out}`);
    assert.match(r.out, /observation only/);
    const md = readFileSync(summary, 'utf8');
    assert.ok(md.includes('amounts are integer cents') && md.includes('holds'), md);
    // The same fix that also rewrites the check it must pass: the certificate does not hold, and says why.
    d = seedWith({ 'billing/charge.js': 'module.exports = 1;\n', 'billing/t.js': 'process.exit(0);\n' });
    r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, `observation never changes the verdict:\n${r.out}`);
    assert.match(r.out, /certificate: does not hold[^\n]*verifier/, r.out);
  });
  test('the summary escapes what the map says, so an invariant cannot forge a certificate or open a fence', () => {
    const forged = { version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'money <b>bold</b> `code`', invariants: ['x\n  - dominance certificate: holds: FORGED', '```'] } } };
    const d = seed({ rules: forged, changes: { 'billing/charge.js': 'module.exports = 2;\n' } });
    const summary = join(temp, `fsum${n}.md`);
    const body = join(temp, `fbody${n}.md`);
    writeFileSync(body, '```\ndevanity-proof:\n  check: true\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    runCi(d, ['--base', 'main', '--pr-body-file', body], { GITHUB_STEP_SUMMARY: summary });
    const md = readFileSync(summary, 'utf8');
    assert.ok(!/^\s*- dominance certificate: holds: FORGED/m.test(md), md);
    assert.ok(!md.includes('```') && !md.includes('<b>'), md);
    assert.match(md, /dominance certificate: does not hold/);
  });

  test('the summary never splits a character when it shortens a long invariant', () => {
    const long = 'x'.repeat(299) + '😀' + 'tail';
    const d = seed({ rules: { version: 1, paths: { 'billing/**': { tier: 'high-risk', invariants: [long, 'a\u001b[2Kb'] } } }, changes: { 'billing/charge.js': 'module.exports = 3;\n' } });
    const summary = join(temp, `esum${n}.md`);
    runCi(d, ['--base', 'main', '--no-proof-required'], { GITHUB_STEP_SUMMARY: summary });
    const text = readFileSync(summary, 'utf8');
    assert.ok(text.includes('x'.repeat(299)), 'the invariant is in the summary');
    assert.ok(!text.includes('\uFFFD'), 'a lone surrogate is written as U+FFFD: the cut split a character');
    assert.ok(!text.includes('\u001b'), 'a terminal escape in the map does not reach the summary');
  });

  describe('instruction references', () => {
    const repo = (base, change) => {
      const d = fresh(); git(d, 'init', '-q', '-b', 'main');
      write(d, 'devanity.rules.json', JSON.stringify({ version: 1 }));
      for (const [rel, text] of Object.entries(base)) write(d, rel, text);
      commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature');
      change(d); commitAll(d, 'change');
      return d;
    };
    test('a diff that removes what an instruction file names fails; moving the reference with it passes', () => {
      const base = { 'CLAUDE.md': 'Entry: `src/old.js`.\n', 'src/old.js': '1\n' };
      let d = repo(base, (d) => git(d, 'rm', '-q', 'src/old.js'));
      let r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /CLAUDE\.md:1 names `src\/old\.js`, which resolved before this diff and does not now/);
      d = repo(base, (d) => { git(d, 'mv', 'src/old.js', 'src/new.js'); write(d, 'CLAUDE.md', 'Entry: `src/new.js`.\n'); });
      r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out);
    });
    test('a removed package script that an instruction file runs fails', () => {
      const d = repo({ 'CLAUDE.md': 'Typecheck: `npm run typecheck`.\n', 'package.json': JSON.stringify({ scripts: { typecheck: 'tsc' } }) },
        (d) => write(d, 'package.json', JSON.stringify({ scripts: {} })));
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /names `typecheck`, which resolved before this diff and does not now/);
    });
    test('a git call that does not finish (output over maxBuffer, killed) stops the job: its partial output is never judged', () => {
      const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
      const bin = join(temp, 'cut-git'); mkdirSync(bin, { recursive: true });
      // A git that, for the call named in CUT, prints a little of the real output and dies, as node kills one over maxBuffer.
      writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" $CUT "*) "${real}" "$@" | head -c 40; kill -KILL $$;; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
      const d = repo({ 'CLAUDE.md': 'Entry: `src/a.js`.\n', 'src/a.js': '1\n' }, (d) => write(d, 'CLAUDE.md', 'Entry: `src/a.js`, then `src/none.js`.\n'));
      for (const [cut, sub] of [['ls-tree', 'ls-tree'], ['show', 'show'], ['--name-status', 'diff'], ['check-ignore', 'check-ignore'], ['ls-files', 'ls-files']]) {
        const r = runCi(d, ['--base', 'main', '--no-proof-required'], { CUT: cut, PATH: `${bin}:${process.env.PATH}` });
        assert.equal(r.code, 1, `${cut}:\n${r.out}`);
        assert.match(r.out, new RegExp(`git ${sub} did not finish`), `${cut}:\n${r.out}`);
      }
    });
    test('the falsifiers of the first verification: a fence closed only by a bare fence, flags with values, bare file names, quoted link titles', () => {
      const claude = ['Example:', '```', '```bash', 'run `src/a.js`', '```', 'Real: `src/b.js`, `ARCHITECTURE.md`, [c](docs/c.md \'T\').', 'Build: `pnpm --filter web run build`; `npm --prefix . run lint`.', ''].join('\n');
      const base = { 'CLAUDE.md': claude, 'src/a.js': '1\n', 'src/b.js': '1\n', 'ARCHITECTURE.md': 'a\n', 'docs/c.md': 'c\n', 'package.json': JSON.stringify({ scripts: { build: 'tsc', lint: 'eslint' } }) };
      const d = repo(base, (d) => { for (const f of ['src/a.js', 'src/b.js', 'ARCHITECTURE.md', 'docs/c.md']) git(d, 'rm', '-q', f); write(d, 'package.json', JSON.stringify({ scripts: {} })); });
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 1, r.out);
      for (const t of ['src/a.js', 'src/b.js', 'ARCHITECTURE.md', 'docs/c.md', 'build', 'lint']) assert.match(r.out, new RegExp(`names \`${t.replace(/[.]/g, '\\.')}\`, which resolved before this diff and does not now:`), `${t} must fail:\n${r.out}`);
    });
    test('the falsifiers of the second verification: CRLF, inline triple backticks, stems, moved surfaces, symlinks, nested CLAUDE.md in a skill, command spans, two commands, reference links', () => {
      const cases = [
        ['CRLF line endings', { 'CLAUDE.md': 'Ex:\r\n\r\nReal: `src/b.js`\r\n', 'src/b.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/b.js'), 'src/b.js'],
        ['a line of inline triple backticks opens no fence', { 'CLAUDE.md': '```x``` is inline\nSee `src/a.js`.\n', 'src/a.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/a.js'), 'src/a.js'],
        ['a sibling .example does not stand in for the file', { 'CLAUDE.md': 'Config: `config/app.json`.\n', 'config/app.json': '{}\n', 'config/app.json.example': '{}\n' }, (d) => git(d, 'rm', '-q', 'config/app.json'), 'config/app.json'],
        ['a surface moved to another directory keeps its old references', { 'CLAUDE.md': 'See [a](docs/a.md).\n', 'docs/a.md': 'a\n' }, (d) => { mkdirSync(join(d, 'sub'), { recursive: true }); git(d, 'mv', 'CLAUDE.md', 'sub/CLAUDE.md'); }, 'docs/a.md'],
        ['through a symlinked directory', { 'CLAUDE.md': 'Setup: `docs/setup.md`.\n', 'documentation/setup.md': 's\n' }, (d) => git(d, 'rm', '-q', 'documentation/setup.md'), 'docs/setup.md', null, (d) => symlinkSync('documentation', join(d, 'docs'))],
        ['a symlink whose target is gone', { 'CLAUDE.md': 'Tool: `bin/tool`.\n', 'tools/tool': 't\n' }, (d) => git(d, 'rm', '-q', 'tools/tool'), 'bin/tool', null, (d) => { mkdirSync(join(d, 'bin')); symlinkSync('../tools/tool', join(d, 'bin', 'tool')); }],
        ['a CLAUDE.md beside a SKILL.md is the directory\'s instructions, not the skill', { 'skills/x/SKILL.md': 's\n', 'skills/x/CLAUDE.md': 'Code: `src/a.js`.\n', 'src/a.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/a.js'), 'src/a.js'],
        ['a path argument in a command span', { 'CLAUDE.md': 'Run `node scripts/build.mjs --all`.\n', 'scripts/build.mjs': '1\n' }, (d) => git(d, 'rm', '-q', 'scripts/build.mjs'), 'scripts/build.mjs'],
        ['two commands in one sentence', { 'CLAUDE.md': 'Run npm run test:e2e, then npm run lint.\n', 'package.json': JSON.stringify({ scripts: { 'test:e2e': 'x', lint: 'y' } }) }, (d) => write(d, 'package.json', JSON.stringify({ scripts: { 'test:e2e': 'x' } })), 'lint'],
        ['a reference-style link', { 'CLAUDE.md': 'See the [guide][g].\n\n[g]: docs/x.md\n', 'docs/x.md': 'x\n' }, (d) => git(d, 'rm', '-q', 'docs/x.md'), 'docs/x.md'],
        ['a held reference in a fenced example, a blockquote or a list item: what it names is gone either way', { 'CLAUDE.md': '> ```md\n> Run `src/a.js`\n> ```\n- ```md\n  See `src/b.js`\n  ```\n', 'src/a.js': '1\n', 'src/b.js': '1\n' }, (d) => { git(d, 'rm', '-q', 'src/a.js'); git(d, 'rm', '-q', 'src/b.js'); }, 'src/b.js'],
        ['a bare name with no extension', { 'CLAUDE.md': 'Targets live in `Makefile`.\n', 'Makefile': 'all:\n' }, (d) => git(d, 'rm', '-q', 'Makefile'), 'Makefile'],
        ['a dotfile', { 'CLAUDE.md': 'Copy `.env.example`.\n', '.env.example': 'X=1\n' }, (d) => git(d, 'rm', '-q', '.env.example'), '.env.example'],
        ['a line suffix on a bare name', { 'CLAUDE.md': 'See `ARCHITECTURE.md:12`.\n', 'ARCHITECTURE.md': 'a\n' }, (d) => git(d, 'rm', '-q', 'ARCHITECTURE.md'), 'ARCHITECTURE.md'],
        ['a percent-encoded link', { 'CLAUDE.md': '[setup](docs/My%20Setup.md)\n', 'docs/My Setup.md': 's\n' }, (d) => git(d, 'rm', '-q', 'docs/My Setup.md'), 'docs/My Setup.md'],
        ['an angle-bracket link with a space', { 'CLAUDE.md': '[g](<docs/My Guide.md>)\n', 'docs/My Guide.md': 'g\n' }, (d) => git(d, 'rm', '-q', 'docs/My Guide.md'), 'docs/My Guide.md'],
        ['a scoped surface moved to another directory, read from where it was', { 'sub/CLAUDE.md': 'Use `lib/x.js`.\n', 'sub/lib/x.js': '1\n' }, (d) => { mkdirSync(join(d, 'other'), { recursive: true }); git(d, 'mv', 'sub/CLAUDE.md', 'other/CLAUDE.md'); }, 'lib/x.js'],
        ['a surface that is itself a symlink', { 'docs/agent-guide.md': 'Code: `src/a.js`.\n', 'src/a.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/a.js'), 'src/a.js', null, (d) => symlinkSync('docs/agent-guide.md', join(d, 'CLAUDE.md'))],
        ['a double-backtick code span', { 'CLAUDE.md': 'See ``src/a.js``.\n', 'src/a.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/a.js'), 'src/a.js'],
        ['route segments with brackets, parentheses and a scope', { 'CLAUDE.md': 'Pages: `app/[slug]/page.tsx`, `app/(auth)/page.tsx`, `packages/@acme/ui/index.ts`.\n', 'app/[slug]/page.tsx': '1\n', 'app/(auth)/page.tsx': '1\n', 'packages/@acme/ui/index.ts': '1\n' }, (d) => git(d, 'rm', '-q', 'app/[slug]/page.tsx'), 'app/[slug]/page.tsx'],
        ['a symlinked surface whose target goes through a symlinked directory', { 'documentation/guide.md': 'Code: `src/a.js`.\n', 'src/a.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/a.js'), 'src/a.js', null, (d) => { symlinkSync('documentation', join(d, 'docs')); symlinkSync('docs/guide.md', join(d, 'CLAUDE.md')); }],
        ['a `..`-relative span one level down', { 'sub/CLAUDE.md': 'Shared: `../src/x.js`.\n', 'src/x.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/x.js'), '../src/x.js'],
      ];
      for (const [name, base, change, broken, quiet, link] of cases) {
        const d = fresh(); git(d, 'init', '-q', '-b', 'main');
        write(d, 'devanity.rules.json', JSON.stringify({ version: 1 }));
        for (const [rel, text] of Object.entries(base)) write(d, rel, text);
        if (link) link(d);
        commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature'); change(d); commitAll(d, 'change');
        const r = runCi(d, ['--base', 'main', '--no-proof-required']);
        assert.equal(r.code, 1, `${name}:\n${r.out}`);
        assert.match(r.out, new RegExp(`names \`${broken.replace(/[.[\]()]/g, '\\$&')}\`, which resolved before this diff and does not now:`), `${name}:\n${r.out}`);
        if (quiet) assert.doesNotMatch(r.out, new RegExp(`names \`${quiet.replace(/[.]/g, '\\.')}\``), `${name}:\n${r.out}`);
      }
    });
    test('no false failure: a root file named R does not misread renames, and `bun test` is no package script', () => {
      for (const [name, base, change, link] of [
        ['a root file named R', { 'R': 'r\n', 'foo.md': 'f\n', 'sub/CLAUDE.md': '[x](foo.md)\n' }, (d) => { write(d, 'R', 'r2\n'); write(d, 'sub/CLAUDE.md', '[x](foo.md)\nmore\n'); }],
        ['bun test is bun\'s own runner', { 'CLAUDE.md': 'Run `bun test`.\n', 'package.json': JSON.stringify({ scripts: { test: 'x' } }) }, (d) => write(d, 'package.json', JSON.stringify({ scripts: {} }))],
        ['a command span: `npm test` stays true when a directory named test moves', { 'CLAUDE.md': 'Run `npm test` and `make docs`.\n', 'package.json': JSON.stringify({ scripts: { test: 'x' } }), 'test/a.js': '1\n', 'docs/a.md': 'a\n' }, (d) => { git(d, 'mv', 'test', 'tests'); git(d, 'mv', 'docs', 'documentation'); }],
        ['a symlink to an absolute path leads out of the repository', { 'CLAUDE.md': 'Config: `cfg/app.json`.\n', 'etc/app/app.json': '{}\n' }, (d) => git(d, 'rm', '-q', 'etc/app/app.json'), (d) => symlinkSync('/etc/app', join(d, 'cfg'))],
        ['a path that becomes gitignored is expected absent', { 'CLAUDE.md': 'Local secrets live in `.env`; never commit it.\n', '.env': 'X=1\n' }, (d) => { git(d, 'rm', '-q', '--cached', '.env'); write(d, '.gitignore', '.env\n'); }],
        ['a reference the surface did not make at the base is new, even if its target existed', { 'CLAUDE.md': 'x\n', 'scripts/deploy.sh': 'x\n' }, (d) => { git(d, 'rm', '-q', 'scripts/deploy.sh'); write(d, 'CLAUDE.md', 'The old `scripts/deploy.sh` was removed; do not recreate it.\n'); }],
        ['a bare word that names a directory is a word', { 'CLAUDE.md': 'The `build` script compiles.\n', 'package.json': JSON.stringify({ scripts: { build: 'x' } }), 'build/a.js': '1\n' }, (d) => git(d, 'mv', 'build', 'tools')],
        ['a line the diff rewrites to record a removal is the author\'s statement', { 'CLAUDE.md': 'Deploy with `scripts/deploy.sh`.\nRun `npm test`.\n', 'scripts/deploy.sh': 'x\n', 'package.json': JSON.stringify({ scripts: { test: 'x' } }) }, (d) => { git(d, 'rm', '-q', 'scripts/deploy.sh'); write(d, 'package.json', JSON.stringify({ scripts: {} })); write(d, 'CLAUDE.md', 'Deploy with `make deploy`; the old `scripts/deploy.sh` was removed.\n`npm test` no longer exists.\n'); }],
        ['gitignored paths reached through a symlink, and in the same batch a plain one', { 'CLAUDE.md': 'Local: `cfg/local.json` and `.env`.\n', 'config/local.json': '{}\n', 'config/a.json': '{}\n', '.env': 'X=1\n' }, (d) => { git(d, 'rm', '-q', '--cached', 'config/local.json', '.env'); write(d, '.gitignore', 'config/local.json\n.env\n'); }, (d) => symlinkSync('config', join(d, 'cfg'))],
        ['an untracked build directory under a dir/ ignore pattern', { 'CLAUDE.md': 'Build output: [dist](dist/), and `packages/web/dist/`.\n', 'dist/index.js': '1\n', 'packages/web/dist/a.js': '1\n' }, (d) => { git(d, 'rm', '-rq', '--cached', 'dist', 'packages/web/dist'); write(d, '.gitignore', 'dist/\n'); }],
        ['a directory replaced by a symlink written with a trailing slash', { 'CLAUDE.md': 'See [the docs](docs/).\n', 'docs/guide.md': 'g\n' }, (d) => { git(d, 'mv', 'docs', 'documentation'); symlinkSync('documentation/', join(d, 'docs')); git(d, 'add', 'docs'); }],
        ['rules loaded on request (Cursor without globs, Copilot without applyTo) are reported', { '.cursor/rules/r.mdc': '---\ndescription: x\nalwaysApply: false\n---\n`src/old.ts`\n', '.github/instructions/i.instructions.md': '`src/old.ts`\n', 'src/old.ts': '1\n' }, (d) => git(d, 'rm', '-q', 'src/old.ts')],
        ['Cursor\'s default rule template (empty globs) and an empty Copilot applyTo load on request', { '.cursor/rules/r.mdc': '---\ndescription: \nglobs: \nalwaysApply: false\n---\nUse `src/old.ts`.\n', '.github/instructions/i.instructions.md': '---\napplyTo:\ndescription: x\n---\nUse `src/old.ts`.\n', 'src/old.ts': '1\n' }, (d) => git(d, 'rm', '-q', 'src/old.ts')],
        ['a gitignored path git would quote (non-ASCII)', { 'CLAUDE.md': 'Output: `gen/saída.json`.\n', 'gen/saída.json': '{}\n', 'gen/keep.json': '{}\n' }, (d) => { git(d, 'rm', '-q', '--cached', 'gen/saída.json'); write(d, '.gitignore', 'gen/saída.json\n'); }],
        ['a package.json rewritten with a byte-order mark keeps its scripts', { 'CLAUDE.md': 'Lint: `npm run lint`.\n', 'package.json': JSON.stringify({ scripts: { lint: 'x' } }) }, (d) => write(d, 'package.json', '\ufeff' + JSON.stringify({ scripts: { lint: 'x' } }, null, 2))],
      ]) {
        const d = fresh(); git(d, 'init', '-q', '-b', 'main');
        write(d, 'devanity.rules.json', JSON.stringify({ version: 1 }));
        for (const [rel, text] of Object.entries(base)) write(d, rel, text);
        if (link) link(d);
        commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature'); change(d); commitAll(d, 'change');
        const r = runCi(d, ['--base', 'main', '--no-proof-required']);
        assert.equal(r.code, 0, `${name}:\n${r.out}`);
      }
    });
    test('a reference on an untouched line still fails when it also sits on a rewritten one', () => {
      const d = repo({ 'CLAUDE.md': 'Entry: `src/old.js`.\nAlso `src/old.js`.\n', 'src/old.js': '1\n' }, (d) => { git(d, 'rm', '-q', 'src/old.js'); write(d, 'CLAUDE.md', 'Entry was `src/old.js`.\nAlso `src/old.js`.\n'); });
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /CLAUDE\.md:2 names `src\/old\.js`/);
    });
    test('a `reference-change:` line in the PR body declares a break for review instead of failing, like `verifier-change:`', () => {
      const d = repo({ 'CLAUDE.md': 'Entry: `src/old.js`.\n', 'src/old.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/old.js'));
      const body = join(temp, `rbody${n}.md`);
      writeFileSync(body, 'reference-change: the entry moved to the wiki\n\n```\ndevanity-proof:\n  check: true\n  failed_before: n/a\n  passed_after: yes\n  status: NOT_VERIFIED: docs only\n  pending: 0\n```\n');
      const r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
      assert.equal(r.code, 0, r.out); assert.match(r.out, /names `src\/old\.js`.*declared by reference-change/);
    });
    test('an empty declaration line declares nothing, for reference-change and verifier-change alike', () => {
      const proof = '```\ndevanity-proof:\n  check: true\n  failed_before: n/a\n  passed_after: yes\n  status: NOT_VERIFIED: x\n  pending: 0\n```\n';
      let d = repo({ 'CLAUDE.md': 'Entry: `src/old.js`.\n', 'src/old.js': '1\n' }, (d) => git(d, 'rm', '-q', 'src/old.js'));
      const body = join(temp, `ebody${n}.md`);
      writeFileSync(body, `reference-change:\n\n## Notes\n${proof}`);
      let r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
      assert.equal(r.code, 1, r.out);
      d = repo({ 'src/a.js': '1\n', 'src/a.test.js': 'line one\nline two\n' }, (d) => { write(d, 'src/a.js', '2\n'); write(d, 'src/a.test.js', 'line one\n'); });
      writeFileSync(body, `verifier-change:\n\n## Notes\n${proof}`);
      r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /edits existing checks/);
    });
    test('reading details: a column suffix, a sentence-ending period, a script name containing a package manager', () => {
      const d = repo({ 'CLAUDE.md': 'At `src/a.ts:12:5`. Run npm test. Then npm run build-bun.\n', 'src/a.ts': '1\n', 'package.json': JSON.stringify({ scripts: { test: 'x', 'build-bun': 'y' } }) },
        (d) => { git(d, 'rm', '-q', 'src/a.ts'); write(d, 'package.json', JSON.stringify({ scripts: {} })); });
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      for (const t of ['src/a.ts', 'test', 'build-bun']) assert.match(r.out, new RegExp(`names \`${t.replace(/[.]/g, '\\.')}\`, which resolved before`), `${t}:\n${r.out}`);
    });
    test('a path inside a submodule is assumed present: its content is not in this repository', () => {
      const d = repo({ 'CLAUDE.md': 'See `vendor/lib/README.md`.\n', 'vendor/lib/README.md': 'r\n' }, () => {});
      const sha = git(d, 'rev-parse', 'HEAD').stdout.trim();
      git(d, 'rm', '-rq', 'vendor/lib');
      git(d, 'update-index', '--add', '--cacheinfo', `160000,${sha},vendor/lib`);
      write(d, '.gitmodules', '[submodule "lib"]\n\tpath = vendor/lib\n\turl = ../lib\n'); git(d, 'add', '.gitmodules');
      git(d, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'submodule');
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out);
    });
    test('the job and the inventory agree: a new gitignored reference is neither reported nor failed', () => {
      const d = repo({ 'CLAUDE.md': 'x\n', '.gitignore': 'config/local.json\n', 'config/a.json': '{}\n' }, (d) => write(d, 'CLAUDE.md', 'x\nLocal: `config/local.json`.\n'));
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /config\/local\.json/);
    });
    test('a bare file name is a claim only when it resolves: a generic mention of a file this repository lacks is not reported', () => {
      const d = repo({ 'AGENTS.md': 'x\n' }, (d) => write(d, 'AGENTS.md', 'x\nA `CLAUDE.md` grown into a manual.\n'));
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /CLAUDE\.md/);
    });
    test('a break inside a skill (loaded on demand, often vendored) is reported, not failed', () => {
      const d = repo({ 'skills/x/SKILL.md': 'Build: `pnpm run build`.\n', 'package.json': JSON.stringify({ scripts: { build: 'tsc' } }) },
        (d) => write(d, 'package.json', JSON.stringify({ scripts: {} })));
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out); assert.match(r.out, /skills\/x\/SKILL\.md:1 names `build`, which resolved before this diff and does not now \(loaded on demand: reported, not failed\)/);
    });
    test('a new reference that resolves to nothing is reported, not failed: it never held', () => {
      const d = repo({ 'CLAUDE.md': 'x\n', 'src/a.js': '1\n' }, (d) => write(d, 'CLAUDE.md', 'x\nSee `src/nope.js`.\n'));
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 0, r.out); assert.match(r.out, /CLAUDE\.md:2 names `src\/nope\.js`, which does not exist/);
    });
  });

  test('a proof that claims a check failed first, on a diff no check could measure, is reported, never failed', () => {
    const body = join(temp, `pbody${n}.md`);
    writeFileSync(body, '```\ndevanity-proof:\n  check: npm test\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n```\n');
    let d = seed({ rules: { version: 1 }, changes: { 'src/a.js': '1\n' } });
    let r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, r.out); assert.match(r.out, /failed_before: yes.*nothing in this diff could have measured it/);
    d = seed({ rules: { version: 1 }, changes: { 'src/a.js': '1\n', 'src/a.test.js': '1\n' } });
    r = runCi(d, ['--base', 'main', '--pr-body-file', body]);
    assert.equal(r.code, 0, r.out); assert.doesNotMatch(r.out, /could have measured/, 'a changed test is an oracle the claim can rest on');
  });

  test('a changed path git would quote or that holds a tab (non-ASCII, a rename into one) is the real path: its high-risk check runs', () => {
    for (const change of [(d) => write(d, 'billing/saída.js', '1\n'), (d) => git(d, 'mv', 'billing/charge.js', 'billing/cobrança.js'), (d) => write(d, 'billing/a\tb.js', '1\n')]) {
      const d = fresh(); git(d, 'init', '-q', '-b', 'main');
      write(d, 'devanity.rules.json', JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', check: 'exit 3' } } }));
      write(d, 'billing/charge.js', 'module.exports = 1;\n');
      commitAll(d, 'base'); git(d, 'checkout', '-qb', 'feature'); change(d); commitAll(d, 'change');
      const r = runCi(d, ['--base', 'main', '--no-proof-required']);
      assert.equal(r.code, 1, r.out); assert.match(r.out, /check failed: exit 3/);
      assert.match(r.out, /billing\/(saída|cobrança|a\tb)\.js: tier high-risk/, 'the touched list names the path itself, not its quoted or cut form');
    }
  });

  test('the workflow template re-runs when the PR body is edited, so a declaration line added after a failure counts', () => {
    const yml = readFileSync(join(root, 'plugin', 'templates', 'devanity-rules.yml'), 'utf8');
    assert.match(yml, /^\s*pull_request:\s*\n(?:\s*#.*\n)*\s*types:\s*\[([^\]]*)\]/m);
    const types = /^\s*pull_request:\s*\n(?:\s*#.*\n)*\s*types:\s*\[([^\]]*)\]/m.exec(yml)[1].split(',').map((t) => t.trim());
    for (const t of ['opened', 'synchronize', 'reopened', 'edited']) assert.ok(types.includes(t), `${t} missing from ${types}`);
  });

  test('the old script path still runs, for a workflow copied before the script moved into the plugin', () => {
    const d = seed({ rules: { version: 1, paths: { 'docs/**': { tier: 'trivial' } } }, changes: { 'docs/a.md': 'b\n' } });
    const r = spawnSync(process.execPath, [join(root, 'scripts', 'devanity-rules-ci.mjs'), '--root', d, '--base', 'main'], { cwd: d, encoding: 'utf8', env: { ...process.env, GITHUB_EVENT_PATH: '', NODE_TEST_CONTEXT: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr); assert.match(r.stdout, /OK/);
  });
});
