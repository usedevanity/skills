// Tests for hooks/devanity-rules.js and hooks/devanity-ledger.js (node:test, no dependencies).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rules = require(join(root, 'plugin', 'hooks', 'devanity-rules.js'));
const ledger = require(join(root, 'plugin', 'hooks', 'devanity-ledger.js'));

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-rules-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const fresh = () => { const d = join(temp, `r${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

const SAMPLE = {
  version: 1,
  defaults: { tier: 'normal', authority: 'commit' },
  paths: {
    'billing/**': { tier: 'high-risk', check: 'pytest tests/billing -q', delta: { files: 3 } },
    'billing/README.md': { tier: 'trivial' },
    'docs/**': { tier: 'trivial' },
    'migrations/**': { tier: 'high-risk' },
  },
  tests: ['spec/**', '*.spec.js'],
  commands: { 'fly\\s+deploy': 'deploy' },
  autonomy: { authority: 'commit', 'high-risk': 'queue', irreversible: 'queue' },
};

describe('rules: loading', () => {
  test('absent file: not present, usable defaults, guards would only record', () => {
    const r = rules.loadRules(fresh());
    assert.equal(r.present, false);
    assert.deepEqual(r.errors, []);
    assert.deepEqual(rules.ruleFor(r.rules, 'anything/x.py'), { tier: 'normal', glob: null });
  });

  test('valid file loads; invalid file reports errors and falls back to defaults', () => {
    const d = fresh();
    writeFileSync(join(d, 'devanity.rules.json'), '﻿' + JSON.stringify(SAMPLE));   // BOM tolerated
    let r = rules.loadRules(d);
    assert.equal(r.present, true); assert.deepEqual(r.errors, []);
    assert.equal(rules.ruleFor(r.rules, 'billing/charge.py').tier, 'high-risk');
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 2, paths: { 'a/**': { tier: 'lethal' } }, autonomy: { authority: 'deploy' } }));
    r = rules.loadRules(d);
    assert.equal(r.present, true);
    assert.ok(r.errors.some((e) => e.includes('version')), r.errors.join('; '));
    assert.ok(r.errors.some((e) => e.includes('tier')), r.errors.join('; '));
    assert.ok(r.errors.some((e) => e.includes('autonomy')), 'deploy is never grantable unattended');
    assert.equal(rules.ruleFor(r.rules, 'a/x').tier, 'normal', 'invalid rules must not block anything');
    writeFileSync(join(d, 'devanity.rules.json'), '{not json');
    r = rules.loadRules(d);
    assert.ok(r.errors[0].includes('not valid JSON'));
  });
});

describe('rules: the published schemas and the loader agree', () => {
  // A consumer's editor validates devanity.rules.json against the schema; the hooks validate it with
  // the loader. The same vocabulary lives in both, and a drift passes one and fails the other.
  const schema = (name) => JSON.parse(readFileSync(join(root, 'plugin', 'skills', 'devanity', 'reference', name), 'utf8'));
  test('tiers, the authority ladder, the unattended ceiling and the purpose limit are the same values', () => {
    const r = schema('rules.schema.json');
    assert.deepEqual(r.$defs.tier.enum, rules.TIERS);
    assert.deepEqual(r.$defs.authority.enum, rules.AUTHORITIES, 'same ladder, same order');
    assert.deepEqual(r.properties.autonomy.properties.authority.enum, rules.AUTONOMY_AUTHORITIES);
    assert.deepEqual(schema('change.schema.json').properties.authority.properties.ceiling.enum, rules.AUTHORITIES);
    const max = r.properties.paths.additionalProperties.properties.purpose.maxLength;
    assert.deepEqual(rules.validate({ version: 1, paths: { 'a/**': { purpose: 'x'.repeat(max) } } }), []);
    assert.ok(rules.validate({ version: 1, paths: { 'a/**': { purpose: 'x'.repeat(max + 1) } } }).some((e) => e.includes('purpose')));
  });
});

describe('rules: a path carries no authority', () => {
  // No hook ever applied a per-path authority: accepting the field let a map promise a restriction
  // nothing enforced. Command authority is per session and per command.
  test('authority on a path is an error that names where command authority is set', () => {
    const errors = rules.validate({ version: 1, paths: { 'billing/**': { tier: 'high-risk', authority: 'prepare' } } });
    assert.ok(errors.some((e) => e.includes('paths["billing/**"]') && e.includes('authority') && e.includes('defaults.authority') && e.includes('commands')), errors.join('; '));
  });
});

describe('rules: the repository map (SPEC §0.4)', () => {
  test('a path may carry purpose and invariants; bad shapes are errors', () => {
    const ok = { version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'charges and refunds', invariants: ['amounts are integer cents', 'refunds never exceed the charge'] } } };
    assert.deepEqual(rules.validate(ok), []);
    const loaded = rules.parseRules(JSON.stringify(ok)).rules;
    const r = rules.ruleFor(loaded, 'billing/x.py');
    assert.equal(r.purpose, 'charges and refunds'); assert.deepEqual(r.invariants, ok.paths['billing/**'].invariants);
    for (const [bad, what] of [[{ purpose: '' }, 'purpose'], [{ purpose: 3 }, 'purpose'], [{ invariants: 'one' }, 'invariants'], [{ invariants: [''] }, 'invariants'], [{ purpose: 'x'.repeat(161) }, 'purpose']]) {
      const errors = rules.validate({ version: 1, paths: { 'a/**': bad } });
      assert.ok(errors.some((e) => e.includes(what)), `${JSON.stringify(bad)} -> ${errors.join('; ')}`);
    }
  });

  test('an invariant may be a principle object {id, rule, kind?, from|declared, check?}; ids are unique across the map (A2.1)', () => {
    const P = { id: 'P-001', rule: 'amounts are integer cents', kind: 'product', from: ['G-031'], check: 'npm test -- money' };
    const ok = { version: 1, paths: { 'billing/**': { tier: 'high-risk', invariants: ['refunds never exceed the charge', P] }, 'ledger/**': { invariants: [{ id: 'P-002', rule: 'entries are append-only', declared: true }] } } };
    assert.deepEqual(rules.validate(ok), []);
    const loaded = rules.parseRules(JSON.stringify(ok)).rules;
    assert.deepEqual(rules.ruleFor(loaded, 'billing/x.py').invariants[1], P, 'the object is kept as written');
    assert.equal(rules.invariantText(P), 'P-001: amounts are integer cents');
    assert.equal(rules.invariantText('plain'), 'plain');
    for (const [bad, what] of [
      [{ 'a/**': { invariants: [{ id: 'P-1', rule: 'x' }] } }, 'from'],                       // neither derived nor declared
      [{ 'a/**': { invariants: [{ id: 'P-1', rule: 'x', from: [] }] } }, 'from'],
      [{ 'a/**': { invariants: [{ id: 'P-1', from: ['G-1'] }] } }, 'rule'],
      [{ 'a/**': { invariants: [{ rule: 'x', from: ['G-1'] }] } }, 'id'],
      [{ 'a/**': { invariants: [{ id: 'P-1', rule: 'x', from: ['G-1'], extra: 1 }] } }, 'extra'],
      [{ 'a/**': { invariants: [{ id: 'P-1', rule: 'x', declared: true }] }, 'b/**': { invariants: [{ id: 'P-1', rule: 'y', declared: true }] } }, 'P-1'],   // one id, two rules
      [{ 'a/**': { invariants: [{ id: 'P-1', rule: 'x', declared: true }, { id: 'P-1', rule: 'x', declared: true }] } }, 'P-1'],
    ]) {
      const errors = rules.validate({ version: 1, paths: bad });
      assert.ok(errors.some((e) => e.includes(what)), `${JSON.stringify(bad)} -> ${errors.join('; ')}`);
    }
    const schema = JSON.parse(readFileSync(join(root, 'plugin', 'skills', 'devanity', 'reference', 'rules.schema.json'), 'utf8'));
    const items = schema.properties.paths.additionalProperties.properties.invariants.items;
    assert.ok(Array.isArray(items.anyOf) && items.anyOf.some((t) => t.type === 'object' && t.required.includes('id') && t.required.includes('rule')), 'the published schema accepts the object form');
  });

  test('a path may be declared core: a boolean, orthogonal to its tier', () => {
    const ok = { version: 1, paths: { 'core/events.py': { tier: 'normal', core: true, invariants: ['fields are never renamed'] } } };
    assert.deepEqual(rules.validate(ok), []);
    assert.equal(rules.ruleFor(rules.parseRules(JSON.stringify(ok)).rules, 'core/events.py').core, true);
    for (const bad of ['yes', 1, null]) {
      const errors = rules.validate({ version: 1, paths: { 'a/**': { core: bad } } });
      assert.ok(errors.some((e) => e.includes('core')), `${JSON.stringify(bad)} -> ${errors.join('; ')}`);
    }
  });
});

describe('rules: instruction files are never trivial (SPEC §0.3)', () => {
  test('a trivial glob that covers an instruction file is an error; one that does not is fine', () => {
    for (const glob of ['**/*.md', '**', 'CLAUDE.md', 'skills/**', '.claude/**', 'agents/*.md']) {
      const errors = rules.validate({ version: 1, paths: { [glob]: { tier: 'trivial' } } });
      assert.ok(errors.some((e) => e.includes('instruction')), `${glob} -> ${errors.join('; ')}`);
    }
    for (const glob of ['docs/**', 'README.md', 'evals/results/**']) assert.deepEqual(rules.validate({ version: 1, paths: { [glob]: { tier: 'trivial' } } }), [], glob);
    assert.deepEqual(rules.validate({ version: 1, paths: { '**/*.md': { tier: 'normal' } } }), [], 'normal is fine');
  });
});

describe('rules: the loader enforces the schema (confirming gate)', () => {
  test('unknown keys, a scalar delta, a trivial default and a nested CLAUDE.md under trivial are errors', () => {
    for (const [raw, what] of [
      [{ version: 1, paths: { 'a/**': { tier: 'normal', owner: 'x' } } }, 'owner'],
      [{ version: 1, extra: 1 }, 'extra'],
      [{ version: 1, paths: { 'a/**': { delta: 5 } } }, 'delta'],
      [{ version: 1, defaults: { tier: 'trivial' } }, 'instruction'],
      [{ version: 1, paths: { 'packages/**': { tier: 'trivial' } } }, 'instruction'],
    ]) {
      const errors = rules.validate(raw);
      assert.ok(errors.some((e) => e.includes(what)), `${JSON.stringify(raw)} -> ${errors.join('; ')}`);
    }
    assert.deepEqual(rules.validate({ version: 1, verifiers: ['package.json', 'pytest.ini'] }), [], 'verifiers is a known key');
  });
});

describe('rules: matching', () => {
  const R = rules.loadRules.bind(null);
  let loaded;
  before(() => { const d = fresh(); writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify(SAMPLE)); loaded = R(d).rules; });

  test('the most specific glob wins; ** crosses directories; * does not', () => {
    assert.equal(rules.ruleFor(loaded, 'billing/charge.py').tier, 'high-risk');
    assert.equal(rules.ruleFor(loaded, 'billing/deep/er/refund.py').tier, 'high-risk');
    assert.equal(rules.ruleFor(loaded, 'billing/README.md').tier, 'trivial', 'literal path beats billing/**');
    assert.equal(rules.ruleFor(loaded, 'docs/guide/x.md').tier, 'trivial');
    assert.equal(rules.ruleFor(loaded, 'src/app.py').tier, 'normal');
    assert.ok(rules.globToRegExp('src/*.py').test('src/a.py'));
    assert.ok(!rules.globToRegExp('src/*.py').test('src/sub/a.py'));
    assert.ok(rules.globToRegExp('src/**/*.py').test('src/a.py'), '**/ matches zero directories too');
  });

  test('relPath normalizes and rejects escapes', () => {
    const d = fresh();
    assert.equal(rules.relPath(d, join(d, 'a', 'b.py')), 'a/b.py');
    assert.equal(rules.relPath(d, 'a/b.py'), 'a/b.py');
    assert.equal(rules.relPath(d, join(d, '..', 'outside.py')), null);
    assert.equal(rules.relPath(d, '/etc/passwd'), null);
  });

  test('test paths: declared globs, plus basename globs anywhere; defaults when undeclared', () => {
    assert.ok(rules.isTestPath(loaded, 'spec/x.js'));
    assert.ok(rules.isTestPath(loaded, 'deep/dir/thing.spec.js'));
    assert.ok(!rules.isTestPath(loaded, 'test_x.py'), 'declared globs replace the defaults');
    const def = rules.loadRules(fresh()).rules;
    for (const p of ['test_x.py', 'pkg/test_x.py', 'x_test.go', 'a.test.ts', 'b.spec.ts', 'tests/unit/y.py']) assert.ok(rules.isTestPath(def, p), p);
    assert.ok(!rules.isTestPath(def, 'src/tester.py'));
  });

  test('command authority: built-ins plus declared patterns, highest wins', () => {
    assert.equal(rules.commandAuthority(loaded, 'git push origin main'), 'commit');
    assert.equal(rules.commandAuthority(loaded, 'git push --force origin main'), 'merge');
    assert.equal(rules.commandAuthority(loaded, 'terraform apply -auto-approve'), 'deploy');
    assert.equal(rules.commandAuthority(loaded, 'fly deploy'), 'deploy');
    assert.equal(rules.commandAuthority(loaded, 'pytest -q'), null);
    assert.ok(rules.authorityRank('deploy') > rules.authorityRank('commit'));
  });
});

describe('ledger', () => {
  test('outside git: disabled, writes report false, reads are empty', () => {
    const d = fresh();
    assert.equal(ledger.ledgerDir(d), null);
    assert.equal(ledger.append(d, 'events', { kind: 'x' }), false);
    assert.deepEqual(ledger.read(d, 'events'), []);
  });

  test('prune that dies mid-write leaves the ledger as it was (the rewrite is atomic)', () => {
    const d = fresh(); git(d, 'init', '-q');
    ledger.append(d, 'events', { kind: 'kept-1' }); ledger.append(d, 'events', { kind: 'kept-2' });
    const file = join(ledger.ledgerDir(d), 'events.jsonl');
    const before = readFileSync(file, 'utf8');
    const fs = require('fs'); const write = fs.writeFileSync;
    fs.writeFileSync = (f, data, ...rest) => { write(f, String(data).slice(0, 7), ...rest); throw new Error('disk full'); };
    try { assert.equal(ledger.prune(d), false); } finally { fs.writeFileSync = write; }
    assert.equal(readFileSync(file, 'utf8'), before, 'a failed prune must not truncate the ledger');
    assert.deepEqual(require('fs').readdirSync(ledger.ledgerDir(d)).filter((f) => f.includes('.tmp')), [], 'no temp file left behind');
  });

  test('inside git: lives under the common dir, shared by a worktree, append-only, torn line tolerated', () => {
    const d = fresh();
    git(d, 'init', '-q'); writeFileSync(join(d, 'f'), '1'); git(d, 'add', '-A'); git(d, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'base');
    assert.ok(ledger.append(d, 'events', { kind: 'blocked', path: 'billing/x.py' }, 's1'));
    const dir = ledger.ledgerDir(d);
    assert.ok(dir.startsWith(join(d, '.git')), `ledger must live under .git, got ${dir}`);
    assert.equal(git(d, 'status', '--porcelain').stdout.trim(), '', 'nothing under .git shows in status');
    const wt = join(temp, `wt${n}`);
    git(d, 'worktree', 'add', '-q', wt, '-b', 'side');
    assert.equal(ledger.ledgerDir(wt), dir, 'a worktree shares the same ledger');
    assert.ok(ledger.append(wt, 'events', { kind: 'blocked', path: 'y' }, 's2'));
    writeFileSync(join(dir, 'events.jsonl'), readFileSync(join(dir, 'events.jsonl'), 'utf8') + '{"torn": tr');   // a writer died mid-line
    const evs = ledger.read(d, 'events');
    assert.equal(evs.length, 2);
    assert.equal(evs[0].session_id, 's1'); assert.ok(evs[0].ts);
    assert.equal(ledger.append(d, 'nope', {}), false, 'an unknown kind is a programming error, but a hook never throws: it reports false');
  });
});
