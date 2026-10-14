// Tests for hooks/devanity-oracle.js (the Stop proof oracle, F2.4) and the repository-rules
// context of hooks/devanity-inject.js (F2.5). node:test, no dependencies. Every oracle case spawns
// the hook as a real child process against a temporary git repository, the way the host runs it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ORACLE = join(root, 'plugin', 'hooks', 'devanity-oracle.js');
const INJECT = join(root, 'plugin', 'hooks', 'devanity-inject.js');
const MODE = join(root, 'plugin', 'hooks', 'devanity-mode.js');
const oracle = require(ORACLE);

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-oracle-test-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const fresh = (name = 'r') => { const d = join(temp, `${name}${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const commitAll = (cwd, msg = 'base') => { git(cwd, 'add', '-A'); return git(cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg); };
const initRepo = (cwd) => { git(cwd, 'init', '-q'); };

function baseEnv(extra = {}) {
  const env = { ...process.env };
  // NODE_TEST_CONTEXT is set by node's own runner for this process; a check like `node --test`
  // spawned under it would report to us instead of failing on its own.
  for (const k of ['DEVANITY_AUTONOMOUS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CI', 'CLAUDE_CONFIG_DIR', 'DEVANITY_GUARDS', 'DEVANITY_ORACLE_TIMEOUT_MS', 'NODE_TEST_CONTEXT']) delete env[k];
  env.HOME = temp; env.USERPROFILE = temp;
  env.CLAUDE_CONFIG_DIR = fresh('cfg');
  return { ...env, ...extra };
}

function runHook(script, { input = '', env, args = [], cwd, holdStdin = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env, cwd: cwd || temp, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(killer); resolvePromise({ code, signal, stdout, stderr, ms: Date.now() - started }); });
    if (input !== null) { child.stdin.on('error', () => {}); if (input) child.stdin.write(input); if (!holdStdin) child.stdin.end(); }
  });
}

const proofBlock = (fields) => ['devanity-proof:', ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
const stopPayload = (cwd, message, extra = {}) => JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: join(cwd, 'nope.jsonl'), stop_hook_active: false, last_assistant_message: message, ...extra });
const readLedger = (cwd, kind) => (existsSync(join(cwd, '.git', 'devanity', `${kind}.jsonl`)) ? readFileSync(join(cwd, '.git', 'devanity', `${kind}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
// The injected line that names a glob (empty when none does): assert what it carries, not its punctuation.
const lineOf = (text, glob) => text.split('\n').find((l) => l.includes(`\`${glob}\``)) ?? '';
const claimVerified = (check) => 'Done.\n\n```\n' + proofBlock({ ...(check ? { check } : {}), failed_before: 'yes', passed_after: 'yes', status: 'VERIFIED', pending: 0 }) + '\n```\n';
const TEST_FILE = "const t=require('node:test');const a=require('node:assert');t('add',()=>a.equal(require('./mod.js')(1,2),3));\n";

// A repository whose HEAD holds a buggy module; the working tree holds the fix and a new test.
// `check` is the check HEAD's rules declare for mod.js (the only one the oracle ever runs).
function seedBuggyRepo(check) {
  const d = fresh();
  initRepo(d);
  writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n');
  if (check) writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { tier: 'normal', check } } }));
  commitAll(d);
  writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
  writeFileSync(join(d, 'mod.test.js'), TEST_FILE);
  return d;
}

function parseBlock(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.decision, 'block', 'Stop blocking form is {"decision":"block","reason":…}');
  assert.equal(typeof out.reason, 'string');
  return out.reason;
}

describe('oracle: the cost of the change rides on every proof (A3.1)', () => {
  test('files, lines and map areas of the diff are recorded with the proof; stats gives the median per change', async () => {
    const d = seedBuggyRepo('node --test mod.test.js');   // mod.js: 1 line replaced (+1 −1); mod.test.js: 1 new line
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const p = readLedger(d, 'proofs')[0];
    assert.deepEqual({ files: p.files, lines: p.lines, areas: p.areas, unmapped: p.unmapped }, { files: 2, lines: 3, areas: ['mod.js'], unmapped: 1 });
    const honest = 'Not done.\n\n```\n' + proofBlock({ check: 'x', failed_before: 'no', passed_after: 'no', status: 'NOT_VERIFIED: check fails after', pending: 0 }) + '\n```\n';
    await runHook(ORACLE, { input: stopPayload(d, honest), env: baseEnv(), cwd: d });
    assert.equal(readLedger(d, 'proofs')[1].files, 2, 'an honest NOT_VERIFIED carries the cost too');
    const ledgerMod = require(join(root, 'plugin', 'hooks', 'devanity-ledger.js'));
    assert.deepEqual(ledgerMod.stats(d).cost, { changes: 1, median_files: 2, median_lines: 3, median_areas: 1, scoped_changes: 0, scoped_files: 0, in_scope: 0, scope_coverage: null });
  });
});

describe('oracle: the declared scope over the real diff (A0.5), and the parent of a child change (A4.1)', () => {
  const contractBlock = (fields) => ['devanity-contract:', ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
  test('a proof under a change with a scope records how many changed paths fall inside it and outside; without a declared scope nothing is claimed; stats sums the coverage', async () => {
    const d = seedBuggyRepo('node --test mod.test.js');   // changed: mod.js (in scope), mod.test.js (outside)
    const msg = 'Done.\n\n```\n' + contractBlock({ id: 'C-7', phase: 'EXECUTE', intent: 'fix add', scope: 'mod.js', parent: 'C-0' }) + '\n\n' + proofBlock({ check: 'node --test mod.test.js', failed_before: 'yes', passed_after: 'yes', status: 'VERIFIED', pending: 0 }) + '\n```\n';
    let r = await runHook(ORACLE, { input: stopPayload(d, msg), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const p = readLedger(d, 'proofs')[0];
    assert.deepEqual({ contract: p.contract, in_scope: p.in_scope, out_of_scope: p.out_of_scope }, { contract: 'C-7', in_scope: 1, out_of_scope: 1 });
    assert.equal(readLedger(d, 'contracts')[0].parent, 'C-0', 'the child names its parent');
    // the next proof names the contract by id only: the scope comes from the ledger
    r = await runHook(ORACLE, { input: stopPayload(d, 'Again.\n\n```\n' + proofBlock({ contract: 'C-7', check: 'x', failed_before: 'no', passed_after: 'no', status: 'NOT_VERIFIED: check fails after', pending: 0 }) + '\n```\n'), env: baseEnv(), cwd: d });
    assert.equal(readLedger(d, 'proofs')[1].in_scope, 1, 'an honest NOT_VERIFIED under the same change carries the coverage too');
    r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    const adhoc = readLedger(d, 'proofs')[2];
    assert.ok(!('in_scope' in adhoc) && !('out_of_scope' in adhoc), 'no declared scope: no coverage fields');
    const ledgerMod = require(join(root, 'plugin', 'hooks', 'devanity-ledger.js'));
    assert.equal(ledgerMod.stats(d).cost.scope_coverage, 0.5);
    assert.match(spawnSync(process.execPath, [join(root, 'plugin', 'hooks', 'devanity-ledger.js'), 'stats'], { cwd: d, encoding: 'utf8' }).stdout, /^cost: .*scope coverage 0\.5 \(1 of 2 files\)$/m);
  });
});

describe('oracle: an impossible obligation is an honest NOT_VERIFIED that asks (A1.2)', () => {
  const impossible = (conflict) => 'Blocked.\n\n```\n' + proofBlock({ check: 'node --test mod.test.js', failed_before: 'n/a', passed_after: 'n/a', status: `NOT_VERIFIED: impossible: ${conflict}`, pending: 0 }) + '\n```\n';
  const prompt = (cwd, text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'h1', cwd, prompt: text });

  test('never blocks, never false_ready; queues one scope decision carrying the conflict, once; a plain NOT_VERIFIED queues nothing', async () => {
    const d = seedBuggyRepo('node --test mod.test.js');
    const env = baseEnv();
    const msg = impossible('the spec says refunds round up, the declared test pins round-half-even');
    let r = await runHook(ORACLE, { input: stopPayload(d, msg), env, cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'an honest NOT_VERIFIED is never blocked');
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.measured, null); assert.ok(p.status.startsWith('NOT_VERIFIED: impossible:'));
    assert.deepEqual(readLedger(d, 'events').filter((e) => e.kind === 'false_ready'), []);
    const pending = readLedger(d, 'decisions').filter((x) => x.status === 'pending');
    assert.equal(pending.length, 1, JSON.stringify(pending));
    assert.equal(pending[0].decide_kind, 'scope'); assert.equal(pending[0].by, 'agent');
    assert.ok(pending[0].id.startsWith('I-') && pending[0].question.includes('round-half-even'), JSON.stringify(pending[0]));
    r = await runHook(ORACLE, { input: stopPayload(d, msg), env, cwd: d });
    assert.equal(readLedger(d, 'decisions').filter((x) => x.status === 'pending').length, 1, 'the same conflict is not asked twice');
    const list = await runHook(MODE, { input: prompt(d, '/devanity pending'), env, cwd: d });
    assert.ok(list.stdout.includes('round-half-even'), list.stdout);
    const plain = 'Not done.\n\n```\n' + proofBlock({ check: 'x', failed_before: 'no', passed_after: 'no', status: 'NOT_VERIFIED: check fails after', pending: 0 }) + '\n```\n';
    r = await runHook(ORACLE, { input: stopPayload(d, plain), env, cwd: d });
    assert.equal(readLedger(d, 'decisions').filter((x) => x.status === 'pending').length, 1, 'a plain NOT_VERIFIED asks nothing');
  });
});

describe('oracle: parsing', () => {
  test('finds the FIRST block, any spacing, inside or outside a fence; pending_decisions aliases pending', () => {
    const text = 'prose\n```\ndevanity-proof:\n   check :  pytest -q tests/x\n\tfailed_before:yes\n  passed_after: yes\n  status: VERIFIED\n  pending_decisions: 2\n```\nlater\ndevanity-proof:\n  status: NOT_VERIFIED: second\n';
    const b = oracle.findProofBlock(text);
    assert.equal(b.fields.check, 'pytest -q tests/x');
    assert.equal(b.fields.failed_before, 'yes');
    assert.equal(b.fields.status, 'VERIFIED');
    assert.equal(b.fields.pending, '2');
    assert.equal(oracle.findProofBlock('no block here, but verified anyway'), null);
    assert.equal(oracle.findProofBlock('devanity-proof:\r\n  status: VERIFIED\r\n').fields.status, 'VERIFIED', 'CRLF tolerated');
  });

  test('falls back to the transcript when last_assistant_message is absent', () => {
    const d = fresh();
    const file = join(d, 't.jsonl');
    const line = (type, text) => JSON.stringify({ type, message: { content: [{ type: 'text', text }] } });
    writeFileSync(file, [line('user', 'hi'), line('assistant', 'first'), line('assistant', 'devanity-proof:\n  status: VERIFIED'), '{"torn'].join('\n'));
    assert.ok(oracle.lastAssistantFromTranscript(file).startsWith('devanity-proof:'));
    assert.equal(oracle.lastAssistantFromTranscript(join(d, 'missing.jsonl')), '');
  });
});

describe('oracle: verifier sovereignty (SPEC §0.5)', () => {
  // The oracle runs only the check the repository declares, as committed at HEAD. The check the agent
  // writes in its own proof block is recorded and never executed.
  const declare = (d, check) => { writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { tier: 'normal', check } } })); };

  test('the check the agent wrote is never executed; the declared one is measured and recorded', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n');
    declare(d, 'node --test mod.test.js');
    commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);
    const marker = join(d, 'agent-ran.marker');
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified(`node -e "require('fs').writeFileSync('${marker}','1')"`)), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(marker), false, 'the agent-authored check must not run');
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.check, 'node --test mod.test.js', 'the declared check is the one measured');
    assert.equal(p.status, 'VERIFIED'); assert.equal(p.measured, true);
    assert.ok(p.agent_check.includes('agent-ran.marker'), 'the agent check is kept as evidence of what it claimed');
  });

  test('a check added to the rules in the working tree is not declared: only HEAD counts', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n');
    declare(d, 'node --test mod.test.js');
    commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);
    const marker = join(d, 'wt-rules-ran.marker');
    declare(d, `node -e "require('fs').writeFileSync('${marker}','1')"`);
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified(null)), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(existsSync(marker), false, 'a working-tree edit of the rules must not choose the check');
    assert.equal(readLedger(d, 'proofs')[0].check, 'node --test mod.test.js');
  });

  test('no declared check for the change: recorded as unmeasured, never blocked, an unmeasured event for debt', async () => {
    const d = seedBuggyRepo();
    const marker = join(d, 'ran.marker');
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified(`node -e "require('fs').writeFileSync('${marker}','1')"`)), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'nothing the agent can do fixes a missing declared check: no block');
    assert.equal(existsSync(marker), false);
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.measured, null); assert.equal(p.reason, oracle.REASONS.noDeclaredCheck); assert.equal(p.status, 'VERIFIED');
    const ev = readLedger(d, 'events').filter((e) => e.kind === 'unmeasured');
    assert.equal(ev.length, 1);
  });
});

describe('oracle: HEAD rules decide the whole judgment (gate review)', () => {
  const declareCommit = (d, extra = {}) => { writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { tier: 'normal', check: 'node --test mod.test.js' } }, ...extra })); };
  test('a working-tree edit of the test globs does not turn a no-oracle claim into VERIFIED', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n'); declareCommit(d); commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('always green',()=>{});\n");
    declareCommit(d, { tests: ['nothing/**'] });
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified(null)), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(parseBlock(r.stdout).includes(oracle.REASONS.passedBefore), r.stdout);
  });
  test('deleting the rules file in the working tree does not switch enforcement off', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n'); declareCommit(d); commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('always green',()=>{});\n");
    rmSync(join(d, 'devanity.rules.json'));
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified(null)), env: baseEnv(), cwd: d });
    assert.ok(parseBlock(r.stdout).includes(oracle.REASONS.passedBefore), r.stdout || 'not measured');
  });
});

describe('oracle: measurement', () => {
  test('(a) a real oracle: the declared check fails on HEAD + tests overlay and passes now -> stays VERIFIED, proof recorded, no block', async () => {
    const d = seedBuggyRepo('node --test mod.test.js');
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'a true claim is not blocked');
    const proofs = readLedger(d, 'proofs');
    assert.equal(proofs.length, 1);
    assert.equal(proofs[0].status, 'VERIFIED');
    assert.equal(proofs[0].failed_before, true); assert.equal(proofs[0].passed_after, true);
    assert.equal(proofs[0].measured, true);
    assert.ok(proofs[0].head && proofs[0].head.length >= 40);
    assert.deepEqual(readLedger(d, 'events'), []);
    assert.equal(git(d, 'worktree', 'list', '--porcelain').stdout.trim().split('\n\n').length, 1, 'the temporary worktree was removed');
    assert.equal(git(d, 'status', '--porcelain').stdout.includes('devanity'), false, 'the ledger never shows in git status');
  });

  test('(b) the check passes on HEAD too -> corrected to NOT_VERIFIED, blocked once, second pass lets the turn end; false_ready recorded', async () => {
    const d = seedBuggyRepo('node --test mod.test.js');
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('always green',()=>{});\n");
    const env = baseEnv();
    const message = claimVerified('node --test mod.test.js');
    let r = await runHook(ORACLE, { input: stopPayload(d, message), env, cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('devanity-proof:'), reason);
    assert.ok(reason.includes(`status: NOT_VERIFIED: ${oracle.REASONS.passedBefore}`), reason);
    assert.ok(reason.includes('failed_before: no') && reason.includes('passed_after: yes'), reason);
    assert.ok(/re-emit/i.test(reason), 'tells the agent to re-emit the corrected block');
    // second pass: the host reports stop_hook_active true
    r = await runHook(ORACLE, { input: stopPayload(d, message, { stop_hook_active: true }), env, cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'never blocks twice');
    const events = readLedger(d, 'events').filter((e) => e.kind === 'false_ready');
    assert.equal(events.length, 2, 'both passes measured and both diverged');
    assert.equal(events[0].agent_status, 'VERIFIED');
    assert.ok(events[0].status.startsWith('NOT_VERIFIED'));
  });

  test('(d) greenfield floor: unborn repository, empty baseline + tests overlay -> the test fails before (module missing) and passes after -> VERIFIED', async () => {
    const d = fresh();
    initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { check: 'node --test mod.test.js' } } }));   // no HEAD yet: the working tree's rules
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.status, 'VERIFIED'); assert.equal(p.head, null); assert.equal(p.failed_before, true);
  });

  test('(e) outside git: no block, nothing to record', async () => {
    const d = fresh();
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('x',()=>{});\n");
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'a claim the oracle cannot measure is never enforced');
  });

  test('(f) no block in the message -> exit 0, silent, no ledger write', async () => {
    const d = seedBuggyRepo();
    const r = await runHook(ORACLE, { input: stopPayload(d, 'All tests pass, verified.'), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(join(d, '.git', 'devanity')), false);
  });

  test('(g) an honest NOT_VERIFIED is recorded and never re-run', async () => {
    const d = seedBuggyRepo();
    const marker = join(d, 'ran.marker');
    const check = `node -e "require('fs').writeFileSync('${marker}', '1')"`;
    const message = proofBlock({ check, failed_before: 'n/a', passed_after: 'no', status: 'NOT_VERIFIED: could not run the suite', pending: 1 });
    const r = await runHook(ORACLE, { input: stopPayload(d, message), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(existsSync(marker), false, 'the check must not have been executed');
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.status, 'NOT_VERIFIED: could not run the suite'); assert.equal(p.measured, null); assert.equal(p.pending, '1');
  });

  test('(j) probes travel: the proof record keeps the block\'s probes and a corrected block re-emits them in the kernel\'s order', async () => {
    const d = seedBuggyRepo();
    const message = proofBlock({ check: 'node --test t.test.js', failed_before: 'n/a', passed_after: 'no', probes: '5/4', status: 'NOT_VERIFIED: not run', pending: 0 });
    const r = await runHook(ORACLE, { input: stopPayload(d, message), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(readLedger(d, 'proofs')[0].probes, '5/4');
    const block = oracle.renderProofBlock({ check: 'x', failed_before: 'no', passed_after: 'yes', probes: '3/3', status: 'NOT_VERIFIED: r', pending: 0 });
    assert.equal(block, 'devanity-proof:\n  check: x\n  failed_before: no\n  passed_after: yes\n  probes: 3/3\n  status: NOT_VERIFIED: r\n  pending: 0');
    assert.ok(!oracle.renderProofBlock({ check: 'x', failed_before: 'no', passed_after: 'yes', status: 'VERIFIED', pending: 0 }).includes('probes'), 'no probes line when the agent wrote none');
  });

  test('(h) timeout -> NOT_VERIFIED: timeout, temporary worktree removed', async () => {
    const d = seedBuggyRepo('node -e "setTimeout(()=>{}, 30000)"');
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv({ DEVANITY_ORACLE_TIMEOUT_MS: '1500' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 8000, `took ${r.ms}ms`);
    assert.ok(parseBlock(r.stdout).includes(`NOT_VERIFIED: ${oracle.REASONS.timeout}`), r.stdout);
    assert.equal(git(d, 'worktree', 'list', '--porcelain').stdout.trim().split('\n\n').length, 1, 'worktree removed after timeout');
  });

  test('guards recording (no rules, no DEVANITY_GUARDS): a VERIFIED claim is recorded, not measured, never blocked', async () => {
    const d = seedBuggyRepo();
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('always green',()=>{});\n");
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.measured, null); assert.equal(p.enforce, false); assert.equal(p.status, 'VERIFIED');
  });

  test('DEVANITY_GUARDS=off silences enforcement even with valid rules; state off silences the hook', async () => {
    const d = seedBuggyRepo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1 }));
    writeFileSync(join(d, 'mod.test.js'), "const t=require('node:test');t('always green',()=>{});\n");
    let r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv({ DEVANITY_GUARDS: 'off' }), cwd: d });
    assert.equal(r.stdout, '');
    const env = baseEnv({ DEVANITY_GUARDS: 'on' });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, '.devanity-state'), 'off');
    r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env, cwd: d });
    assert.equal(r.stdout, '');
  });

  test('(i) never hang: no stdin, EOF-less stdin, BOM and broken JSON all exit 0 within 2s', async () => {
    const d = seedBuggyRepo();
    for (const opts of [{ input: null }, { input: stopPayload(d, 'x'), holdStdin: true }, { input: '﻿' + stopPayload(d, 'no block') }, { input: '{broken' }]) {
      const r = await runHook(ORACLE, { ...opts, env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.signal, null);
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    }
  });
});

describe('inject: repository rules context (F2.5)', () => {
  const sessionStart = (cwd) => JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd });
  const HEADING = '## Repository rules (devanity.rules.json)';

  test('no rules file -> nothing appended; invalid rules -> nothing appended', async () => {
    const d = fresh();
    let r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(!r.stdout.includes(HEADING));
    writeFileSync(join(d, 'devanity.rules.json'), '{"version": 2}');
    r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    assert.ok(!r.stdout.includes(HEADING), 'an invalid file is not context');
  });

  test('valid rules -> high-risk globs with their check, the autonomy envelope and the guard state, after the kernel', async () => {
    const d = fresh();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', check: 'pytest tests/billing -q' }, 'migrations/**': { tier: 'high-risk' }, 'docs/**': { tier: 'trivial' } }, autonomy: { authority: 'commit' } }));
    let r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const i = r.stdout.indexOf(HEADING);
    assert.ok(i > 0 && r.stdout.indexOf('on call for this repository') < i, 'rules come after the kernel');
    const section = r.stdout.slice(i);
    assert.ok(/high-risk.*pytest tests\/billing -q/.test(lineOf(section, 'billing/**')), section);
    assert.ok(lineOf(section, 'migrations/**').includes('high-risk'), section);
    assert.equal(lineOf(section, 'docs/**'), '', 'trivial paths are not listed');
    assert.ok(/authority commit.*high-risk queue.*irreversible queue/.test(section), section);
    assert.ok(section.includes('Guards: enforcing'), section);
    assert.ok(section.length <= 1600, `section is ${section.length} chars`);
    r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv({ DEVANITY_GUARDS: 'off' }), args: ['SessionStart'], cwd: d });
    assert.ok(r.stdout.includes('Guards: recording'));
    r = await runHook(INJECT, { input: JSON.stringify({ hook_event_name: 'SubagentStart', agent_type: 'verifier', cwd: d }), env: baseEnv(), cwd: d });
    assert.ok(!r.stdout.includes('Repository rules'), 'the verifier never receives rules context');
  });

  test('the map: every path with something to say is injected with it, high-risk first, then core (SPEC §0.4)', async () => {
    const d = fresh();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: {
      'src/ui/**': { tier: 'normal', purpose: 'React views; no data access here' },
      'core/events.py': { core: true },
      'billing/**': { tier: 'high-risk', check: 'pytest tests/billing', purpose: 'charges and refunds', invariants: ['amounts are integer cents'] },
      'docs/**': { tier: 'trivial' } } }));
    const r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const ctx = r.stdout;
    const billing = lineOf(ctx, 'billing/**');
    for (const part of ['high-risk', 'charges and refunds', 'amounts are integer cents', 'pytest tests/billing']) assert.ok(billing.includes(part), `billing line lacks "${part}": ${billing}`);
    assert.ok(lineOf(ctx, 'src/ui/**').includes('React views; no data access here'), ctx);
    assert.ok(lineOf(ctx, 'core/events.py').includes('core'), ctx);
    assert.ok(ctx.includes('rung 5'), 'the header names the rung a core path triggers');
    assert.equal(lineOf(ctx, 'docs/**'), '', 'a path with nothing to say is not injected');
    const [hr, core, ui] = ['billing/**', 'core/events.py', 'src/ui/**'].map((g) => ctx.indexOf(`\`${g}\``));
    assert.ok(hr > 0 && core > hr && ui > core, ctx);
  });

  test('pending human decisions are listed at session start; a session in a subdirectory still gets the map', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'charges' } } }));
    mkdirSync(join(d, 'billing', 'sub'), { recursive: true });
    const dir = join(d, '.git', 'devanity'); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'decisions.jsonl'), JSON.stringify({ ts: new Date().toISOString(), id: 'D-billing', status: 'pending', by: 'agent', path: 'billing/**' }) + '\n');
    const sub = join(d, 'billing', 'sub');
    const r = await runHook(INJECT, { input: JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd: sub }), env: baseEnv(), args: ['SessionStart'], cwd: sub });
    assert.ok(r.stdout.includes('`billing/**` high-risk: charges'), 'the map is found from the repository root');
    assert.ok(/Pending human decisions.*D-billing.*billing\/\*\*/.test(r.stdout), r.stdout.slice(-400));
  });

  test('the pending queue survives a full open change and comes before the map', async () => {
    const d = fresh(); initRepo(d);
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'charges' } } }));
    const dir = join(d, '.git', 'devanity'); mkdirSync(dir, { recursive: true });
    const now = new Date().toISOString(); const long = 'x'.repeat(200);
    writeFileSync(join(dir, 'contracts.jsonl'), JSON.stringify({ ts: now, id: 'C-1', phase: 'EXECUTE', intent: long, scope: long, forbidden: long, proof: long }) + '\n');
    writeFileSync(join(dir, 'decisions.jsonl'), [1, 2, 3, 4, 5].map((k) => JSON.stringify({ ts: now, id: `D-${k}`, status: 'pending', by: 'agent', path: `billing/f${k}.py` })).join('\n') + '\n');
    const r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    const q = r.stdout.search(/Pending human decisions.*D-1/);
    assert.ok(q > 0, r.stdout.slice(-600));
    assert.ok(q < r.stdout.indexOf(HEADING), 'the queue comes before the repository rules');
  });

  test('size cap: many globs are hard-truncated at 1600 chars with an ellipsis', async () => {
    const d = fresh();
    const paths = {};
    for (let i = 0; i < 80; i++) paths[`services/payments/region-${i}/**`] = { tier: 'high-risk', check: `pytest tests/payments/region_${i} -q` };
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths }));
    const r = await runHook(INJECT, { input: sessionStart(d), env: baseEnv(), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const section = r.stdout.slice(r.stdout.indexOf(HEADING)).trimEnd();
    assert.ok(section.length <= 1600, `section is ${section.length} chars`);
    assert.ok(section.includes('Autonomy envelope') && section.includes('Guards:'), 'the fixed lines are never the ones cut');
    assert.match(section, /… \d+ more path\(s\) in devanity\.rules\.json$/, 'whole entries only, the rest named');
  });
});

describe('oracle: tests that existed at HEAD are frozen (A1.1)', () => {
  // HEAD holds a correct module and its test; the working tree breaks the module and bends the
  // old test to match. The overlay alone would call that VERIFIED: the bent test fails on HEAD
  // and passes now. The oracle must refuse it: an old test that changed is a contract question.
  const seedTamperedRepo = () => {
    const d = fresh();
    initRepo(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { tier: 'normal', check: 'node --test mod.test.js' } } }));
    commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n');
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE.replace('3)', '-1)'));
    return d;
  };
  const prompt = (cwd, text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'h1', cwd, prompt: text });

  test('an old test edited to pass -> NOT_VERIFIED: old test changed (<path>), blocked once with the path named, false_ready and a scope decision queued; the check is not run', async () => {
    const d = seedTamperedRepo();
    const env = baseEnv();
    const message = claimVerified('node --test mod.test.js');
    let r = await runHook(ORACLE, { input: stopPayload(d, message), env, cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes(`status: NOT_VERIFIED: ${oracle.REASONS.oldTestChanged} (mod.test.js)`), reason);
    assert.ok(reason.includes('failed_before: n/a') && reason.includes('passed_after: n/a'), 'nothing was measured: ' + reason);
    assert.ok(/\[DECIDE\]/.test(reason) && reason.includes('--path mod.test.js'), 'the agent is told how a contract change is answered: ' + reason);
    const p = readLedger(d, 'proofs')[0];
    assert.equal(p.reason, oracle.REASONS.oldTestChanged); assert.deepEqual(p.paths, ['mod.test.js']);
    assert.equal(p.failed_before, null); assert.equal(p.passed_after, null);
    const fr = readLedger(d, 'events').filter((e) => e.kind === 'false_ready');
    assert.equal(fr.length, 1); assert.equal(fr[0].reason, oracle.REASONS.oldTestChanged);
    const pending = readLedger(d, 'decisions').filter((x) => x.status === 'pending');
    assert.equal(pending.length, 1, JSON.stringify(pending));
    assert.equal(pending[0].path, 'mod.test.js'); assert.equal(pending[0].decide_kind, 'scope'); assert.equal(pending[0].by, 'agent');
    assert.equal(git(d, 'worktree', 'list', '--porcelain').stdout.trim().split('\n\n').length, 1, 'no worktree was made');
    r = await runHook(ORACLE, { input: stopPayload(d, message), env, cwd: d });
    assert.equal(readLedger(d, 'decisions').filter((x) => x.status === 'pending').length, 1, 'the same question is not queued twice');
    r = await runHook(ORACLE, { input: stopPayload(d, message, { stop_hook_active: true }), env, cwd: d });
    assert.equal(r.stdout, '', 'never blocks twice');
  });

  test('a human decision on the test path lifts the freeze: the overlay measures as before', async () => {
    const d = seedTamperedRepo();
    const env = baseEnv();
    const message = claimVerified('node --test mod.test.js');
    parseBlock((await runHook(ORACLE, { input: stopPayload(d, message), env, cwd: d })).stdout);
    const id = readLedger(d, 'decisions').find((x) => x.status === 'pending').id;
    const ans = await runHook(MODE, { input: prompt(d, `/devanity decide ${id} contract-change --path mod.test.js`), env, cwd: d });
    assert.ok(ans.stdout.includes('by human'), ans.stdout);
    const r = await runHook(ORACLE, { input: stopPayload(d, message), env, cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '', 'with the change authorized the bent test is the new contract, and the claim measures VERIFIED');
    const last = readLedger(d, 'proofs').at(-1);
    assert.equal(last.status, 'VERIFIED'); assert.equal(last.failed_before, true);
  });

  test('a staged rename of the old test (git mv, then bend the copy) is a changed old test too', async () => {
    const d = seedTamperedRepo();
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);   // back as at HEAD, then renamed and bent under the new name
    git(d, 'mv', 'mod.test.js', 'mod2.test.js');
    writeFileSync(join(d, 'mod2.test.js'), TEST_FILE.replace('3)', '-1)'));
    git(d, 'add', 'mod2.test.js');
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod2.test.js')), env: baseEnv(), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(parseBlock(r.stdout).includes(`${oracle.REASONS.oldTestChanged} (mod.test.js)`), 'the HEAD test left the tree under a rename: ' + r.stdout);
    assert.equal(readLedger(d, 'proofs')[0].status.startsWith('VERIFIED'), false);
  });

  test('two frozen tests whose names collide get two decisions with distinct ids, and pending counts both', async () => {
    const d = fresh();
    initRepo(d);
    mkdirSync(join(d, 'tests'), { recursive: true });
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a + b;\n');
    writeFileSync(join(d, 'tests', 'mod.test.js'), TEST_FILE.replace("'./mod.js'", "'../mod.js'"));
    writeFileSync(join(d, 'tests', 'mod.test.cjs'), TEST_FILE.replace("'./mod.js'", "'../mod.js'"));
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'mod.js': { tier: 'normal', check: 'node --test tests/' } } }));
    commitAll(d);
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => a - b;\n');
    for (const f of ['mod.test.js', 'mod.test.cjs']) writeFileSync(join(d, 'tests', f), TEST_FILE.replace("'./mod.js'", "'../mod.js'").replace('3)', '-1)'));
    const r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test tests/')), env: baseEnv(), cwd: d });
    const reason = parseBlock(r.stdout);
    assert.ok(reason.includes('pending: 2'), reason);
    const pending = readLedger(d, 'decisions').filter((x) => x.status === 'pending');
    assert.deepEqual(pending.map((x) => x.path).sort(), ['tests/mod.test.cjs', 'tests/mod.test.js']);
    assert.equal(new Set(pending.map((x) => x.id)).size, 2, JSON.stringify(pending));
  });

  test('a deleted old test is a changed one; a new test file is not', async () => {
    const d = seedTamperedRepo();
    writeFileSync(join(d, 'mod.test.js'), TEST_FILE);   // the old test back as at HEAD
    writeFileSync(join(d, 'mod.js'), 'module.exports = (a, b) => b + a;\n');   // still changed, so mod.js's check applies
    writeFileSync(join(d, 'extra.test.js'), "const t=require('node:test');t('x',()=>{});\n");
    let r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.ok(!r.stdout.includes(oracle.REASONS.oldTestChanged), 'an added test never freezes: ' + r.stdout);
    rmSync(join(d, 'mod.test.js'));
    r = await runHook(ORACLE, { input: stopPayload(d, claimVerified('node --test mod.test.js')), env: baseEnv(), cwd: d });
    assert.ok(parseBlock(r.stdout).includes(`${oracle.REASONS.oldTestChanged} (mod.test.js)`), r.stdout);
  });
});
