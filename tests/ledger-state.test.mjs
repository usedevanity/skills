// Tests for the ledger's stateful half (PLAN F3.1, F3.2, F3.6, F3.7): contract records written by
// the Stop hook, 24 h expiry, phase-aware injection, `/devanity reset|status`, and the stats CLI.
// node:test, no dependencies; every hook case spawns the script as a child process against a
// temporary git repository, the way the host runs it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(root, 'plugin', 'hooks');
const ORACLE = join(hooksDir, 'devanity-oracle.js');
const INJECT = join(hooksDir, 'devanity-inject.js');
const MODE = join(hooksDir, 'devanity-mode.js');
const LEDGER = join(hooksDir, 'devanity-ledger.js');
const ledger = require(LEDGER);
const oracle = require(ORACLE);
const KERNEL_MARK = 'on call for this repository';
const CHANGE_HEADING = '## Open change';
const RULES_HEADING = '## Repository rules';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-state-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const fresh = (name = 'r') => { const d = join(temp, `${name}${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const repo = () => { const d = fresh(); git(d, 'init', '-q'); return d; };

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['DEVANITY_AUTONOMOUS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CI', 'CLAUDE_CONFIG_DIR', 'DEVANITY_GUARDS', 'DEVANITY_ORACLE_TIMEOUT_MS', 'NODE_TEST_CONTEXT']) delete env[k];
  env.HOME = temp; env.USERPROFILE = temp;
  env.CLAUDE_CONFIG_DIR = fresh('cfg');
  return { ...env, ...extra };
}

function run(script, { input = '', env, args = [], cwd, holdStdin = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], { env: env || baseEnv(), cwd: cwd || temp, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(killer); resolvePromise({ code, signal, stdout, stderr, ms: Date.now() - started }); });
    if (input !== null) { child.stdin.on('error', () => {}); if (input) child.stdin.write(input); if (!holdStdin) child.stdin.end(); }
  });
}

const block = (name, fields) => [`${name}:`, ...Object.entries(fields).map(([k, v]) => `  ${k}: ${v}`)].join('\n');
const contractBlock = (fields) => block('devanity-contract', { id: 'C-2026-09-24-1', phase: 'EXECUTE', intent: 'add retries to the uploader', scope: 'src/upload/**', forbidden: 'billing/**', proof: 'node --test tests/upload.test.js', pending: 0, ...fields });
const stopPayload = (cwd, message, extra = {}) => JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: join(cwd, 'nope.jsonl'), stop_hook_active: false, last_assistant_message: message, ...extra });
const sessionStart = (cwd, extra = {}) => JSON.stringify({ hook_event_name: 'SessionStart', source: 'startup', cwd, ...extra });
const subagent = (cwd, agent_type) => JSON.stringify({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type, cwd });
const prompt = (cwd, text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'h1', cwd, prompt: text });
const readKind = (cwd, kind) => ledger.read(cwd, kind);
const hoursAgo = (h) => new Date(Date.now() - h * 3600000).toISOString();
const seedContract = (cwd, fields, ts) => {
  const dir = ledger.ledgerDir(cwd); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'contracts.jsonl'), JSON.stringify({ ts: ts || new Date().toISOString(), session_id: 'old', id: 'C-1', phase: 'EXECUTE', intent: 'add retries', scope: 'src/upload/**', forbidden: 'billing/**', proof: 'node --test tests/upload.test.js', pending: '1', ...fields }) + '\n', { flag: 'a' });
};
const parseSubagent = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;

describe('contract block (F3.1)', () => {
  test('parser: first block wins, phase upper-cased, fence and spacing tolerated; no id or unknown phase -> null', () => {
    const text = 'Done.\n```\ndevanity-contract:\n   id :  C-9\n\tphase: execute\n  intent: x\n```\ndevanity-contract:\n  id: C-10\n  phase: DONE\n';
    const b = oracle.findContractBlock(text);
    assert.equal(b.fields.id, 'C-9'); assert.equal(b.fields.phase, 'EXECUTE'); assert.equal(b.fields.intent, 'x');
    assert.equal(oracle.findContractBlock('devanity-contract:\n  phase: EXECUTE\n'), null, 'no id');
    assert.equal(oracle.findContractBlock('devanity-contract:\n  id: C-1\n  phase: SHIPPING\n'), null, 'unknown phase');
    assert.equal(oracle.findContractBlock('devanity-proof:\n  status: VERIFIED\n'), null);
    assert.ok(ledger.KINDS.includes('contracts'));
  });

  test('Stop hook: a contract block alone is recorded, exit 0, no block on stdout; no proof written', async () => {
    const d = repo();
    const r = await run(ORACLE, { input: stopPayload(d, 'Framed.\n\n' + contractBlock({ phase: 'FRAME', proof: '' })), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, '');
    const cs = readKind(d, 'contracts');
    assert.equal(cs.length, 1);
    assert.equal(cs[0].id, 'C-2026-09-24-1'); assert.equal(cs[0].phase, 'FRAME'); assert.equal(cs[0].scope, 'src/upload/**'); assert.equal(cs[0].session_id, 's1');
    assert.equal('proof' in cs[0], false, 'an empty optional field is not stored');
    assert.deepEqual(readKind(d, 'proofs'), []);
  });

  test('Stop hook: contract and proof in one message -> both recorded, the proof linked to the contract id', async () => {
    const d = repo();
    const msg = contractBlock({ phase: 'VERIFY' }) + '\n\n' + block('devanity-proof', { check: 'true', failed_before: 'n/a', passed_after: 'no', status: 'NOT_VERIFIED: not run', pending: 0 });
    const r = await run(ORACLE, { input: stopPayload(d, msg), env: baseEnv({ DEVANITY_GUARDS: 'on' }), cwd: d });
    assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, '');
    assert.equal(readKind(d, 'contracts')[0].phase, 'VERIFY');
    assert.equal(readKind(d, 'proofs')[0].contract, 'C-2026-09-24-1');
  });

  test('latest phase per id wins; DONE closes; a second id can be open at the same time', async () => {
    const d = repo();
    for (const phase of ['FRAME', 'EXECUTE']) await run(ORACLE, { input: stopPayload(d, contractBlock({ phase })), cwd: d });
    assert.equal(ledger.contracts(d).length, 1);
    assert.equal(ledger.openContract(d).phase, 'EXECUTE');
    await run(ORACLE, { input: stopPayload(d, contractBlock({ phase: 'DONE' })), cwd: d });
    assert.equal(ledger.openContract(d), null, 'DONE is closed');
    assert.equal(ledger.contracts(d)[0].intent, 'add retries to the uploader', 'fields of earlier records survive the fold');
    await run(ORACLE, { input: stopPayload(d, contractBlock({ id: 'C-2', phase: 'PROVE' })), cwd: d });
    assert.equal(ledger.openContract(d).id, 'C-2');
  });

  test('24 h expiry: an unclosed contract older than 24 h is not open, is reported as expired, and a fresher one wins', () => {
    const d = repo();
    seedContract(d, { id: 'C-old' }, hoursAgo(25));
    assert.equal(ledger.openContract(d), null);
    assert.deepEqual(ledger.expiredContracts(d).map((c) => c.id), ['C-old']);
    seedContract(d, { id: 'C-new', phase: 'INSPECT' }, hoursAgo(23));
    assert.equal(ledger.openContract(d).id, 'C-new');
    assert.equal(ledger.stats(d).contracts.expired, 1);
    seedContract(d, { id: 'C-old', phase: 'DONE' });
    assert.deepEqual(ledger.expiredContracts(d), [], 'a later DONE record closes the expired one');
  });
});

const decideBlock = (id, question, extra = {}) => [
  `- **[DECIDE][${extra.status || 'blocking'}][${id}][rule] ${question}**`,
  '  - decision: how a refund is computed',
  '  - context: the ticket asks for refunds; no rule exists · anchors G-004',
  `  - options: ${extra.options || 'prorate by days used → partial refunds · full refund in 14 days → simple, costlier · no-op → refunds stay manual'}`,
  '  - recommendation: prorate, it matches the billing invariant',
  '  - if undecided: refund() stays a failing stub',
].join('\n');

describe('a [DECIDE] block becomes a pending decision a human can answer later', () => {
  test('the Stop hook records the question, options and recommendation; dormant and repeats are not recorded', async () => {
    const d = repo();
    const msg = `Done except the refund rule.\n\n${decideBlock('G-001', 'How are refunds computed?')}\n\n${decideBlock('G-002', 'Later: currency support', { status: 'dormant' })}\n`;
    let r = await run(ORACLE, { input: stopPayload(d, msg), cwd: d });
    assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, '', 'recording a decision never blocks the turn');
    let pending = ledger.pendingDecisions(d);
    assert.equal(pending.length, 1, JSON.stringify(pending));
    const q = pending[0];
    assert.equal(q.id, 'G-001'); assert.equal(q.by, 'agent'); assert.equal(q.status, 'pending');
    assert.equal(q.question, 'How are refunds computed?');
    assert.ok(q.options.includes('prorate by days used') && q.recommendation.startsWith('prorate'), JSON.stringify(q));
    r = await run(ORACLE, { input: stopPayload(d, msg), cwd: d });
    assert.equal(ledger.pendingDecisions(d).length, 1, 'the same question re-emitted is not queued twice');
    const ctx = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(/Pending human decisions \(1\): G-001 \(How are refunds computed\?\)/.test(ctx.stdout), 'the next session sees the question, not only the id');
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    for (const part of ['G-001', 'How are refunds computed?', 'prorate by days used', 'recommendation: prorate']) assert.ok(m.stdout.includes(part), `pending lacks "${part}":\n${m.stdout}`);
    const ans = await run(MODE, { input: prompt(d, '/devanity decide G-001 prorate'), cwd: d });
    assert.ok(ans.stdout.includes('G-001 = prorate') && ans.stdout.includes('authorizes no edit'), ans.stdout);
    assert.equal(ledger.pendingDecisions(d).length, 0);
    const answered = ledger.decisions(d).find((x) => x.id === 'G-001');
    assert.equal(answered.by, 'human'); assert.equal(answered.question, 'How are refunds computed?', 'the answer keeps its question');
    r = await run(ORACLE, { input: stopPayload(d, decideBlock('G-001', 'Which currencies are accepted?')), cwd: d });
    pending = ledger.pendingDecisions(d);
    assert.equal(pending.length, 1); assert.equal(pending[0].id, 'G-001-2', 'a new question never overwrites an answered id');
  });

  test('the parser is linear, ignores fenced examples, and never reopens an answered question', async () => {
    const started = Date.now();
    assert.deepEqual(oracle.findDecideBlocks(`- **[DECIDE][blocking][G-001][rule] ${' '.repeat(50000)}x`), []);
    assert.ok(Date.now() - started < 500, `a malformed headline must not backtrack: ${Date.now() - started} ms`);
    const d = repo();
    const fenced = 'An example of the form:\n\n```md\n' + decideBlock('G-003', 'Authorize a write to the money path?') + '\n```\n';
    await run(ORACLE, { input: stopPayload(d, fenced), cwd: d });
    assert.equal(ledger.pendingDecisions(d).length, 0, 'a block quoted inside a fence is an example, not a question');
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-001', 'Same?')), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-001 a'), cwd: d });
    await run(ORACLE, { input: stopPayload(d, `Recap:\n${decideBlock('G-001', 'Same?')}`), cwd: d });
    assert.equal(ledger.pendingDecisions(d).length, 0, 'a recap of an answered question does not reopen it');
  });

  test('a flood of [DECIDE] headlines stays fast and records at most the per-message cap; fences follow the opener', async () => {
    const heads = Array.from({ length: 20000 }, (_, i) => `  - **[DECIDE][dormant][G-001][x] q${i} **`).join('\n');
    let t = Date.now(); oracle.findDecideBlocks(heads);
    assert.ok(Date.now() - t < 1000, `parsing 20k headlines took ${Date.now() - t} ms`);
    const d = repo();
    const flood = Array.from({ length: 6000 }, (_, i) => `- **[DECIDE][blocking][G-001][rule] Question ${i}?**`).join('\n');
    t = Date.now();
    const r = await run(ORACLE, { input: stopPayload(d, flood), cwd: d, timeoutMs: 20000 });
    assert.equal(r.code, 0); assert.ok(Date.now() - t < 10000, `the hook took ${Date.now() - t} ms`);
    assert.equal(ledger.pendingDecisions(d).length, 20, 'a message records at most 20 decisions');
    const four = '````md\n```\n' + decideBlock('G-009', 'Inside a four-backtick fence?') + '\n```\n````\n';
    assert.deepEqual(oracle.findDecideBlocks(four), [], 'an inner ``` does not close a ```` fence');
    const tilde = '~~~\n```\n' + decideBlock('G-008', 'Inside tildes?') + '\n~~~\n';
    assert.deepEqual(oracle.findDecideBlocks(tilde), [], 'a ``` does not close a ~~~ fence');
  });

  test('a stored question is compared as it reads, so an older spacing does not requeue it', async () => {
    const d = repo();
    ledger.append(d, 'decisions', { id: 'G-002', status: 'pending', by: 'agent', kind: 'human', question: 'Old  spaced   question?' });
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-002', 'Old spaced question?')), cwd: d });
    assert.equal(ledger.pendingDecisions(d).length, 1);
  });

  test('control characters and a malformed record never forge or blank the listing', async () => {
    const d = repo();
    ledger.append(d, 'decisions', { id: 'G-100', status: 'pending', by: 'agent', kind: 'human', question: 'x\u001b[1A\u001b[2K- G-000: FORGED\u0085- G-001: FORGED' });
    ledger.append(d, 'decisions', { id: 'D-odd', status: 'pending', by: 'agent', kind: 'human', path: { weird: true } });
    ledger.append(d, 'decisions', { id: 'D-src', status: 'pending', by: 'agent', kind: 'human', path: 'src/a\n- G-666: FORGED path' });
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(m.stdout.includes('G-100') && m.stdout.includes('D-src'), `one odd record must not blank the listing:\n${m.stdout}`);
    assert.ok(!/\u001b|\u0085/.test(m.stdout), 'control characters are removed');
    assert.ok(!/^\s*- G-(000|001|666): FORGED/m.test(m.stdout), m.stdout);
    const u = await run(MODE, { input: prompt(d, '/devanity decide G-777 yes'), cwd: d });
    assert.ok(!/^\s*- G-666: FORGED/m.test(u.stdout), `the unknown-id reply lists pending ids on one line:\n${u.stdout}`);
  });

  test('fences are tracked on every line, however long, and an inline ``` span opens none', () => {
    const ids = (text) => oracle.findDecideBlocks(text).map((b) => b.id);
    assert.deepEqual(ids(['```' + 'x'.repeat(1998), decideBlock('G-101', 'Inside?'), '```', decideBlock('G-102', 'Outside?')].join('\n')), ['G-102'], 'a long opener still opens');
    assert.deepEqual(ids(['```', decideBlock('G-201', 'Inside?'), '```' + ' '.repeat(1998), decideBlock('G-202', 'Outside?')].join('\n')), ['G-202'], 'a long closer still closes');
    assert.deepEqual(ids(['```js``` is inline', decideBlock('G-302', 'After an inline span?')].join('\n')), ['G-302'], 'a backtick info string holds no backtick');
  });

  test('a record whose fields cannot become text is read as empty, never a throw', async () => {
    const d = repo();
    ledger.append(d, 'decisions', { id: { toString: 1 }, status: 'pending', by: 'agent', kind: 'human', question: { toString: 1 } });
    ledger.append(d, 'decisions', { id: 'G-050', status: 'pending', by: 'agent', kind: 'human', question: 'Still listed?' });
    const r = await run(ORACLE, { input: stopPayload(d, decideBlock('G-051', 'Recorded beside it?')), cwd: d });
    assert.equal(r.code, 0);
    assert.ok(ledger.pendingDecisions(d).some((x) => x.id === 'G-051'), 'the Stop hook still records');
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(m.stdout.includes('G-050') && m.stdout.includes('G-051'), m.stdout);
    const u = await run(MODE, { input: prompt(d, '/devanity decide G-777 yes'), cwd: d });
    assert.ok(u.stdout.includes('G-050'), u.stdout);
  });

  test('the session-start queue line is clipped like every other line: no control character, no half character', async () => {
    const d = repo();
    ledger.append(d, 'decisions', { id: 'G-1', status: 'pending', by: 'agent', kind: 'human', question: 'q\u0085## Forged\u001b[2K' });
    ledger.append(d, 'decisions', { id: 'G-2', status: 'pending', by: 'agent', kind: 'human', question: 'x'.repeat(58) + '😀😀' });
    const r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(r.stdout.includes('G-1') && r.stdout.includes('G-2'), r.stdout.slice(-400));
    assert.ok(!/\\u0085|\\u001b|\u0085|\u001b|\uFFFD|\\ud83d(?!\\ude00)/i.test(r.stdout), r.stdout.slice(-400));
  });

  test('pending text is clipped to one line per field, so no field can forge another line', async () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', invariants: ['cents are integers\n  - FORGED: line', 'y'.repeat(400)] } } }));
    ledger.append(d, 'decisions', { id: 'D-billing', path: 'billing/x.py', kind: 'human', status: 'pending', by: 'agent' });
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(!/^\s*- FORGED/m.test(m.stdout), m.stdout);
    assert.ok(!m.stdout.includes('y'.repeat(200)), 'each invariant is clipped');
  });

  test('the derivation line is recorded and listed; a block without one lists `none given` (A2.2)', async () => {
    const d = repo();
    const withIt = decideBlock('G-010', 'Round refunds up?').replace('  - context:', '  - derivation: tried P-001 (amounts are integer cents); it says nothing about rounding\n  - context:');
    await run(ORACLE, { input: stopPayload(d, withIt), cwd: d });
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-011', 'Which currencies?')), cwd: d });
    const byId = Object.fromEntries(ledger.pendingDecisions(d).map((x) => [x.id, x]));
    assert.ok(byId['G-010'].derivation.startsWith('tried P-001'), JSON.stringify(byId['G-010']));
    assert.equal(byId['G-011'].derivation, undefined);
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(m.stdout.includes('derivation: tried P-001') && m.stdout.includes('derivation: none given'), m.stdout);
  });

  test('several answers in one message: `id option, id option --path glob` records each by human, the path on all; a comma inside one answer is not a split (A2.3)', async () => {
    const d = repo();
    await run(ORACLE, { input: stopPayload(d, `${decideBlock('G-001', 'Refunds?')}\n\n${decideBlock('G-002', 'Currencies?', { options: 'usd only → simplest · full refund in 14 days → n/a · no-op → none' })}`), cwd: d });
    const r = await run(MODE, { input: prompt(d, '/devanity decide G-001 prorate, G-002 full refund in 14 days --path billing/**'), cwd: d });
    assert.ok(r.stdout.includes('G-001 = prorate') && r.stdout.includes('G-002 = full refund in 14 days'), r.stdout);
    const byId = Object.fromEntries(ledger.decisions(d).map((x) => [x.id, x]));
    for (const id of ['G-001', 'G-002']) { assert.equal(byId[id].status, 'decided'); assert.equal(byId[id].by, 'human'); assert.equal(byId[id].path, 'billing/**'); }
    assert.equal(byId['G-002'].option, 'full refund in 14 days');
    assert.equal(ledger.pendingDecisions(d).length, 0);
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-003', 'Rounding?')), cwd: d });
    const one = await run(MODE, { input: prompt(d, '/devanity decide G-003 no, prorate'), cwd: d });
    assert.ok(one.stdout.includes('REJECTED'), one.stdout);
    assert.equal(ledger.decisions(d).find((x) => x.id === 'G-003').chosen, 'no, prorate');
  });

  test('an answer given without --path says it authorizes no edit, and nothing else', async () => {
    const d = repo();
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-001', 'Refunds?')), cwd: d });
    const ans = await run(MODE, { input: prompt(d, '/devanity decide G-001 prorate'), cwd: d });
    assert.ok(ans.stdout.includes('authorizes no edit') && !/allowed/.test(ans.stdout), ans.stdout);
  });

  test('a guard-queued decision shows what the path guards when listed', async () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', invariants: ['amounts are integer cents'] } } }));
    ledger.append(d, 'decisions', { id: 'D-billing', path: 'billing/x.py', kind: 'human', status: 'pending', by: 'agent' });
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(m.stdout.includes('amounts are integer cents'), m.stdout);
  });
});

describe('phase-aware injection (F3.2)', () => {
  test('no open contract -> no section; expired -> no section', async () => {
    const d = repo();
    let r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(KERNEL_MARK) && !r.stdout.includes(CHANGE_HEADING));
    seedContract(d, {}, hoursAgo(30));
    r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(!r.stdout.includes(CHANGE_HEADING), 'an expired change must not pin the session');
  });

  test('EXECUTE: the section follows the kernel (and the rules), carries every field and the implement line, within 480 chars', async () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk' } } }));
    seedContract(d, {});
    const r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const k = r.stdout.indexOf(KERNEL_MARK); const ru = r.stdout.indexOf(RULES_HEADING); const c = r.stdout.indexOf(CHANGE_HEADING);
    assert.ok(k >= 0 && ru > k && c > ru, `order kernel < rules < change, got ${k} ${ru} ${c}`);
    const section = r.stdout.slice(c);
    assert.ok(section.length <= 480, `section is ${section.length} chars`);
    assert.ok(section.startsWith('## Open change C-1'));
    for (const s of ['phase: EXECUTE', 'pending: 1', 'intent: add retries', 'scope: src/upload/**', 'forbidden: billing/**', 'proof: node --test tests/upload.test.js']) assert.ok(section.includes(s), `missing "${s}" in:\n${section}`);
    assert.ok(/EXECUTE: implement inside scope/.test(section), section);
    assert.ok(r.stdout.length <= 10000);
    assert.ok(!section.includes('parent:'), 'a change with no parent shows none');
  });

  test('a child change names its parent in the section (A4.1)', async () => {
    const d = repo();
    seedContract(d, { id: 'C-2', parent: 'C-1' });
    const r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    const section = r.stdout.slice(r.stdout.indexOf(CHANGE_HEADING));
    assert.ok(section.startsWith('## Open change C-2') && section.includes('parent: C-1'), section);
  });

  test('VERIFY: the falsify line; other phases: continue from <phase>; long fields are clipped', async () => {
    const d = repo();
    seedContract(d, { phase: 'VERIFY' });
    let r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(/VERIFY: .*falsify the claims of C-1/.test(r.stdout), r.stdout.slice(r.stdout.indexOf(CHANGE_HEADING)));
    seedContract(d, { id: 'C-2', phase: 'INSPECT', intent: 'x'.repeat(300), scope: 'y'.repeat(300), forbidden: 'z'.repeat(300), proof: 'p'.repeat(300) });
    r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    const section = r.stdout.slice(r.stdout.indexOf(CHANGE_HEADING));
    assert.ok(section.includes('continue from INSPECT'), section);
    assert.ok(section.length <= 480, `section is ${section.length} chars`);
    assert.ok(!section.includes('x'.repeat(61)), 'fields are clipped to 60 chars');
  });

  test('SubagentStart: the verifier note gains the contract id and proof and stays one line; the worker gets nothing; others get the section', async () => {
    const d = repo();
    seedContract(d, {});
    let r = await run(INJECT, { input: subagent(d, 'verifier'), cwd: d });
    const note = parseSubagent(r.stdout);
    assert.equal(note.split('\n').length, 1);
    assert.ok(note.includes('agents/verifier.md') && note.includes('C-1') && note.includes('node --test tests/upload.test.js'), note);
    assert.ok(!note.includes(KERNEL_MARK) && !note.includes(CHANGE_HEADING) && !note.includes('rung'), 'never the craft ladder');
    r = await run(INJECT, { input: subagent(d, 'worker'), cwd: d });
    assert.equal(r.stdout, '');
    r = await run(INJECT, { input: subagent(d, 'Explore'), cwd: d });
    const ctx = parseSubagent(r.stdout);
    assert.ok(ctx.includes(KERNEL_MARK) && ctx.includes(CHANGE_HEADING) && ctx.includes('EXECUTE: implement inside scope'));
    for (const type of ['devanity:implementer', 'oracle-author']) {   // the writing roles get the kernel and the change, like any non-verifier (A1.3)
      const role = parseSubagent((await run(INJECT, { input: subagent(d, type), cwd: d })).stdout);
      assert.ok(role.includes(KERNEL_MARK) && role.includes(CHANGE_HEADING), type);
    }
    const plain = await run(INJECT, { input: subagent(fresh(), 'verifier') });
    const bare = parseSubagent(plain.stdout);
    assert.ok(bare.includes('agents/verifier.md') && !bare.includes('C-1'), 'without an open change the note names no change');
  });

  test('budget: over 9,500 chars the change section is dropped first, then the rules; inject_truncated is recorded', async () => {
    const stray = (kernelChars) => {
      const p = join(temp, `stray-${kernelChars}`);
      cpSync(hooksDir, join(p, 'hooks'), { recursive: true });
      mkdirSync(join(p, 'skills', 'devanity'), { recursive: true });
      writeFileSync(join(p, 'skills', 'devanity', 'SKILL.md'), '# Devanity\n\n' + 'k'.repeat(kernelChars - 12) + '\n');
      return join(p, 'hooks', 'devanity-inject.js');
    };
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk' } } }));
    seedContract(d, {});
    // kernel + rules fit; kernel + rules + change does not -> only the change goes
    let r = await run(stray(9150), { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.length <= 9500 && r.stdout.includes(RULES_HEADING) && !r.stdout.includes(CHANGE_HEADING), `len ${r.stdout.length}`);
    let evs = readKind(d, 'events').filter((e) => e.kind === 'inject_truncated');
    assert.equal(evs.length, 1); assert.deepEqual(evs[0].dropped, ['change']);
    // kernel alone nearly fills the budget -> both go, the kernel is still emitted whole
    r = await run(stray(9400), { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.length <= 9500 && r.stdout.startsWith('# Devanity') && !r.stdout.includes(RULES_HEADING) && !r.stdout.includes(CHANGE_HEADING), `len ${r.stdout.length}`);
    evs = readKind(d, 'events').filter((e) => e.kind === 'inject_truncated');
    assert.equal(evs.length, 2); assert.deepEqual(evs[1].dropped, ['change', 'rules']);
    // with everything fitting nothing is recorded
    r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(r.stdout.includes(CHANGE_HEADING));
    assert.equal(readKind(d, 'events').filter((e) => e.kind === 'inject_truncated').length, 2);
  });
});

describe('/devanity reset and status (F3.6)', () => {
  test('status reports state, the open change and the pending queue, read-only', async () => {
    const d = repo();
    let r = await run(MODE, { input: prompt(d, '/devanity status'), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^DEVANITY STATUS: state on;.*open change: none;.*pending decisions: 0/);
    seedContract(d, {});
    ledger.append(d, 'decisions', { id: 'D1', path: 'billing/**', kind: 'human', status: 'pending', by: 'agent' });
    r = await run(MODE, { input: prompt(d, '/devanity:devanity status.'), cwd: d });
    assert.match(r.stdout, /open change: C-1 in EXECUTE.*pending decisions: 1/);
    assert.equal(readKind(d, 'contracts').length, 1, 'status writes nothing');
    const off = baseEnv(); writeFileSync(join(off.CLAUDE_CONFIG_DIR, '.devanity-state'), 'off');
    r = await run(MODE, { input: prompt(d, '/devanity status'), cwd: d, env: off });
    assert.ok(r.stdout.startsWith('DEVANITY STATUS: state off;'));
    r = await run(MODE, { input: prompt(fresh(), '/devanity status') });
    assert.ok(r.stdout.includes('no ledger here'));
  });

  test('reset marks every open change ABANDONED (reason reset); expired and closed ones are untouched; whole-message only', async () => {
    const d = repo();
    seedContract(d, { id: 'C-1' });
    seedContract(d, { id: 'C-2', phase: 'VERIFY' });
    seedContract(d, { id: 'C-done', phase: 'DONE' });
    seedContract(d, { id: 'C-old' }, hoursAgo(48));
    let r = await run(MODE, { input: prompt(d, 'please /devanity reset now'), cwd: d });
    assert.equal(r.stdout, '', 'a prompt that merely contains the command does nothing');
    r = await run(MODE, { input: prompt(d, '/devanity reset'), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^DEVANITY RESET: 2 open change\(s\) marked abandoned: C-2 \(VERIFY\), C-1 \(EXECUTE\)\.$/);
    assert.equal(ledger.openContract(d), null);
    const byId = Object.fromEntries(ledger.contracts(d).map((c) => [c.id, c]));
    assert.equal(byId['C-1'].phase, 'ABANDONED'); assert.equal(byId['C-1'].reason, 'reset'); assert.equal(byId['C-1'].intent, 'add retries', 'the fold keeps the earlier fields');
    assert.equal(byId['C-2'].phase, 'ABANDONED'); assert.equal(byId['C-done'].phase, 'DONE'); assert.equal(byId['C-old'].phase, 'EXECUTE');
    assert.equal(readKind(d, 'contracts').filter((c) => c.reason === 'reset').length, 2);
    assert.equal(readKind(d, 'decisions').length, 0, 'reset never writes a decision');
    assert.ok(!readKind(d, 'contracts').some((c) => c.by === 'human'), 'a contract record never carries by:human; only /devanity decide writes that');
    r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(!r.stdout.includes(CHANGE_HEADING), 'the next session starts clean');
    r = await run(MODE, { input: prompt(d, '/devanity reset'), cwd: d });
    assert.equal(r.stdout, 'DEVANITY RESET: 0 open change(s) marked abandoned.');
    r = await run(MODE, { input: prompt(fresh(), '/devanity reset') });
    assert.ok(r.stdout.startsWith('DEVANITY RESET: no ledger here'));
  });
});

describe('ledger CLI (F3.7)', () => {
  test('stats --json shape and the counts behind it; text form renders every line', async () => {
    const d = repo();
    seedContract(d, { id: 'C-open' });
    seedContract(d, { id: 'C-done', phase: 'DONE' });
    seedContract(d, { id: 'C-ab', phase: 'ABANDONED' });
    seedContract(d, { id: 'C-exp' }, hoursAgo(25));
    ledger.append(d, 'decisions', { id: 'D1', status: 'pending', by: 'agent' });
    ledger.append(d, 'decisions', { id: 'D2', status: 'pending', by: 'agent' });
    ledger.append(d, 'decisions', { id: 'D2', status: 'decided', by: 'human', chosen: 'a' });
    ledger.append(d, 'decisions', { id: 'D3', status: 'decided', by: 'agent-default', chosen: 'b' });
    ledger.append(d, 'proofs', { kind: 'proof', status: 'VERIFIED' });
    ledger.append(d, 'proofs', { kind: 'proof', status: 'NOT_VERIFIED: no check' });
    ledger.append(d, 'proofs', { kind: 'proof', status: 'NOT_VERIFIED: timeout' });
    ledger.append(d, 'events', { kind: 'false_ready' });
    ledger.append(d, 'events', { kind: 'blocked', path: 'billing/x' });
    ledger.append(d, 'events', { kind: 'would_block', path: 'billing/y' });
    ledger.append(d, 'events', { kind: 'would_block', path: 'billing/z' });
    assert.equal(ledger.append(d, 'deferrals', { path: 'src/a.py' }), false, 'no reserved kind without a writer: debt reads deferred: markers in the code');
    const dir = ledger.ledgerDir(d);
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: new Date(Date.now() - 100 * 86400000).toISOString(), kind: 'blocked' }) + '\n', { flag: 'a' });
    let r = await run(LEDGER, { args: ['stats', '--cwd', d, '--json'] });
    assert.equal(r.code, 0, r.stderr);
    const s = JSON.parse(r.stdout);
    assert.deepEqual(s, {
      ledger: dir,
      window_days: 90,
      decisions: { pending: 1, decided_human: 1, decided_agent_default: 1 },
      proofs: { verified: 1, not_verified: 2, false_ready: 1 },
      contracts: { open: 1, done: 1, abandoned: 1, expired: 1 },
      events: { blocked: 1, would_block: 2 },
      attention: { human_turns: 0, decide: 0, command: 0, message: 0, in_open_change: 0 },
      recommendation: { decided: 1, scored: 0, matched: 0, by_kind: {} },
      principles: { candidates: [] },
      cost: { changes: 0, median_files: null, median_lines: null, median_areas: null, scoped_changes: 0, scoped_files: 0, in_scope: 0, scope_coverage: null },
    });
    r = await run(LEDGER, { args: ['stats'], cwd: d });
    assert.equal(r.code, 0);
    for (const topic of ['decisions', 'proofs', 'contracts', 'guards', 'attention', 'recommendation', 'principles', 'cost']) assert.match(r.stdout, new RegExp(`^${topic}: `, 'm'), `text form lacks the ${topic} line`);
    r = await run(LEDGER, { args: ['stats', '--json'], cwd: fresh() });
    assert.equal(r.stdout.trim(), 'null');
    r = await run(LEDGER, { args: ['stats'], cwd: fresh() });
    assert.ok(r.stdout.includes('no ledger here'));
  });

  test('prune via CLI drops records older than the retention window in every kind; bad usage exits 1', async () => {
    const d = repo();
    const dir = ledger.ledgerDir(d); mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 100 * 86400000).toISOString();
    writeFileSync(join(dir, 'contracts.jsonl'), JSON.stringify({ ts: old, id: 'C-x', phase: 'DONE' }) + '\n');
    writeFileSync(join(dir, 'events.jsonl'), JSON.stringify({ ts: old, kind: 'old' }) + '\n');
    ledger.append(d, 'events', { kind: 'new' });
    let r = await run(LEDGER, { args: ['prune', '--cwd', d, '--json'] });
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { pruned: true, window_days: 90 });
    assert.deepEqual(readKind(d, 'contracts'), []);
    assert.deepEqual(readKind(d, 'events').map((e) => e.kind), ['new']);
    assert.ok(existsSync(join(dir, 'contracts.jsonl')));
    r = await run(LEDGER, { args: ['prune'], cwd: d });
    assert.ok(r.stdout.startsWith('devanity prune:'));
    r = await run(LEDGER, { args: ['frobnicate'] });
    assert.equal(r.code, 1); assert.ok(r.stdout.startsWith('usage:'));
    r = await run(LEDGER, { args: [] });
    assert.equal(r.code, 1);
  });
});

describe('never hang, never crash', () => {
  test('contract-bearing Stop, inject with a torn contracts file, and reset with broken stdin all exit 0 quickly', async () => {
    const d = repo();
    seedContract(d, {});
    writeFileSync(join(ledger.ledgerDir(d), 'contracts.jsonl'), '{"torn": tr', { flag: 'a' });
    const cases = [
      [ORACLE, { input: stopPayload(d, contractBlock({})), holdStdin: true, cwd: d }],
      [INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d }],
      [INJECT, { input: subagent(d, 'verifier'), cwd: d }],
      [MODE, { input: '{broken', cwd: d }],
      [MODE, { input: null, cwd: d }],
    ];
    for (const [script, opts] of cases) {
      const r = await run(script, opts);
      assert.equal(r.code, 0, `${script}: ${r.stderr}`);
      assert.equal(r.signal, null);
      assert.ok(r.ms < 3000, `${script} took ${r.ms}ms`);
    }
    const r = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(r.stdout.includes(CHANGE_HEADING), 'the torn line is skipped, the record before it still counts');
  });
});

describe('principles in the map (A2.1)', () => {
  test('a principle object renders as `id: rule` wherever an invariant is shown: the injected map and the guard block', async () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk', invariants: ['refunds never exceed the charge', { id: 'P-001', rule: 'amounts are integer cents', from: ['G-031'] }] } } }));
    const ctx = await run(INJECT, { input: sessionStart(d), args: ['SessionStart'], cwd: d });
    assert.ok(ctx.stdout.includes('P-001: amounts are integer cents') && !ctx.stdout.includes('[object'), ctx.stdout);
    mkdirSync(join(d, 'billing'), { recursive: true });
    const g = await run(join(hooksDir, 'devanity-guard.js'), { input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd: d, tool_name: 'Edit', tool_input: { file_path: join(d, 'billing', 'x.py') } }), cwd: d });
    assert.equal(g.code, 2); assert.ok(g.stderr.includes('P-001: amounts are integer cents'), g.stderr);
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    assert.ok(!m.stdout.includes('[object'), m.stdout);
  });
});

describe('principle candidates (A2.4)', () => {
  test('three or more human decisions of one kind under one map area are a candidate principle; fewer, mixed kinds or unmapped paths are not', () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk' }, 'src/api/**': { tier: 'normal' } } }));
    const dec = (id, kind, path, extra = {}) => ledger.append(d, 'decisions', { id, status: 'decided', by: 'human', decide_kind: kind, path, chosen: 'a', ...extra });
    dec('G-1', 'rule', 'billing/a.py'); dec('G-2', 'rule', 'billing/b.py'); dec('G-3', 'rule', 'billing/sub/c.py');
    dec('G-4', 'scope', 'billing/d.py'); dec('G-5', 'scope', 'billing/e.py');            // two: below the line
    dec('G-6', 'rule', 'src/api/x.ts'); dec('G-7', 'rule', 'src/api/y.ts'); dec('G-8', 'rule', 'src/api/z.ts', { by: 'agent-default' });   // one is not human
    dec('G-9', 'rule', 'elsewhere/x'); dec('G-10', 'rule', 'elsewhere/y'); dec('G-11', 'rule', 'elsewhere/z');   // no map area
    const s = ledger.stats(d);
    assert.deepEqual(s.principles, { candidates: [{ area: 'billing/**', kind: 'rule', decisions: ['G-1', 'G-2', 'G-3'] }] });
    const r = spawnSync(process.execPath, [LEDGER, 'stats'], { cwd: d, encoding: 'utf8' });
    assert.match(r.stdout, /^principles: 1 candidate · billing\/\*\* rule ×3 \(G-1, G-2, G-3\)$/m, r.stdout);
  });

  test('inside a git worktree the map read is the worktree\'s, as every other hook reads it (the ledger stays the shared one)', () => {
    const d = repo();
    writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'billing/**': { tier: 'high-risk' } } }));
    git(d, 'add', '.'); git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'map');
    const wt = fresh('wt'); rmSync(wt, { recursive: true, force: true });
    git(d, 'worktree', 'add', '-q', wt);
    writeFileSync(join(wt, 'devanity.rules.json'), JSON.stringify({ version: 1, paths: { 'src/api/**': { tier: 'normal' } } }));
    for (const [id, p] of [['G-1', 'billing/a.py'], ['G-2', 'billing/b.py'], ['G-3', 'billing/c.py'], ['G-4', 'src/api/x.ts'], ['G-5', 'src/api/y.ts'], ['G-6', 'src/api/z.ts']]) ledger.append(wt, 'decisions', { id, status: 'decided', by: 'human', decide_kind: 'rule', path: p, chosen: 'a' });
    assert.deepEqual(ledger.stats(wt).principles.candidates.map((c) => c.area), ['src/api/**']);
    assert.deepEqual(ledger.stats(d).principles.candidates.map((c) => c.area), ['billing/**'], 'the main checkout still reads its own map');
  });
});

describe('attention ledger (A0.1, A0.2)', () => {
  test('every human prompt is one human_turn event: its type, size and the open change, never its text', async () => {
    const d = repo();
    seedContract(d, { id: 'C-1' });
    await run(ORACLE, { input: stopPayload(d, decideBlock('G-001', 'Refunds?')), cwd: d });
    await run(MODE, { input: prompt(d, 'please add retries to the uploader'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity status'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-001 prorate'), cwd: d });
    await run(MODE, { input: prompt(d, '   '), cwd: d });
    const turns = readKind(d, 'events').filter((e) => e.kind === 'human_turn');
    assert.deepEqual(turns.map((t) => [t.type, t.contract, t.phase]), [['message', 'C-1', 'EXECUTE'], ['command', 'C-1', 'EXECUTE'], ['decide', 'C-1', 'EXECUTE']], JSON.stringify(turns));
    assert.ok(turns.every((t) => t.chars > 0 && !JSON.stringify(t).includes('uploader')), 'the prompt text stays out of the ledger');
    assert.equal(turns[2].decision, 'G-001');
    const none = await run(MODE, { input: prompt(fresh(), 'hello'), cwd: fresh() });
    assert.equal(none.code, 0, 'no ledger: nothing recorded, nothing thrown');
    const s = ledger.stats(d);
    assert.deepEqual(s.attention, { human_turns: 3, decide: 1, command: 1, message: 1, in_open_change: 3 });
  });

  test('a chosen answer is matched to a label the block offered, and the recommendation is scored against it', async () => {
    const d = repo();
    const opts = 'prorate by days used → partial refunds · full refund in 14 days → costlier · no-op → refunds stay manual';
    ledger.append(d, 'decisions', { id: 'G-1', status: 'pending', by: 'agent', decide_kind: 'rule', options: opts, recommendation: 'prorate, it matches the billing invariant' });
    ledger.append(d, 'decisions', { id: 'G-2', status: 'pending', by: 'agent', decide_kind: 'rule', options: opts, recommendation: 'prorate, same basis' });
    ledger.append(d, 'decisions', { id: 'G-3', status: 'pending', by: 'agent', decide_kind: 'scope', options: 'absorb → one unit · split → its own change', recommendation: 'split: it is its own unit' });
    ledger.append(d, 'decisions', { id: 'G-4', status: 'pending', by: 'agent', decide_kind: 'trade' });
    ledger.append(d, 'decisions', { id: 'G-5', status: 'pending', by: 'agent', decide_kind: 'scope', options: 'full credit → a · full refund → b', recommendation: 'full credit' });
    await run(MODE, { input: prompt(d, '/devanity decide G-1 Prorate it.'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-2 full refund in 14 days'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-3 no'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-4 whatever'), cwd: d });
    await run(MODE, { input: prompt(d, '/devanity decide G-5 full'), cwd: d });
    const byId = Object.fromEntries(ledger.decisions(d).map((x) => [x.id, x]));
    assert.equal(byId['G-1'].option, 'prorate by days used', 'first word of the answer matches a unique label');
    assert.equal(byId['G-1'].chosen, 'Prorate it.', 'the answer is kept as typed');
    assert.equal(byId['G-2'].option, 'full refund in 14 days', 'exact label');
    assert.equal(byId['G-3'].option, undefined, 'a rejection is not a chosen option');
    assert.equal(byId['G-4'].option, undefined, 'no options to match');
    assert.equal(byId['G-5'].option, undefined, 'an ambiguous first word matches nothing');
    assert.deepEqual(ledger.stats(d).recommendation, { decided: 4, scored: 2, matched: 1, by_kind: { rule: { scored: 2, matched: 1 } } });
    const r = await run(LEDGER, { args: ['stats'], cwd: d });
    assert.match(r.stdout, /^recommendation: 2 of 4 decided answers scored · 1 matched the recommendation \(rule 1\/2\)$/m, r.stdout);
  });
});
