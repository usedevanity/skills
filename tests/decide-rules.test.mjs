// Tests for the decision loop as rules (the eigen step): a `[DECIDE]` is recorded whatever its id
// and also when provisional (acted on, judged at review); an answer writes its `rule:` into the map
// as a principle of the axis's area; `/devanity accept` answers the provisional batch with the
// recommendations; `/devanity allow <glob> --standing` authorizes for good. node:test, no
// dependencies; every hook case spawns the script against a temporary git repository.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(root, 'plugin', 'hooks');
const ORACLE = join(hooksDir, 'devanity-oracle.js');
const MODE = join(hooksDir, 'devanity-mode.js');
const GUARD = join(hooksDir, 'devanity-guard.js');
const ledger = require(join(hooksDir, 'devanity-ledger.js'));

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-rules-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const fresh = (name = 'r') => { const d = join(temp, `${name}${++n}`); mkdirSync(d, { recursive: true }); return d; };
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const MAP = { version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'charges and refunds' }, 'src/api/**': { tier: 'normal' } } };
const repo = (map = MAP) => { const d = fresh(); git(d, 'init', '-q'); if (map) writeFileSync(join(d, 'devanity.rules.json'), JSON.stringify(map, null, 2) + '\n'); return d; };
const readMap = (d) => JSON.parse(readFileSync(join(d, 'devanity.rules.json'), 'utf8'));

function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['DEVANITY_AUTONOMOUS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CI', 'CLAUDE_CONFIG_DIR', 'DEVANITY_GUARDS', 'DEVANITY_AUTHORITY', 'NODE_TEST_CONTEXT']) delete env[k];
  env.HOME = temp; env.USERPROFILE = temp; env.CLAUDE_CONFIG_DIR = fresh('cfg');
  return { ...env, ...extra };
}
function run(script, { input = '', env, cwd, timeoutMs = 20000 } = {}) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [script], { env: env || baseEnv(), cwd: cwd || temp, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code) => { clearTimeout(killer); done({ code, stdout, stderr }); });
    child.stdin.on('error', () => {}); child.stdin.write(input); child.stdin.end();
  });
}
const stopPayload = (cwd, message) => JSON.stringify({ hook_event_name: 'Stop', session_id: 's1', cwd, transcript_path: join(cwd, 'nope.jsonl'), stop_hook_active: false, last_assistant_message: message });
const prompt = (cwd, text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's1', cwd, prompt: text });
const edit = (cwd, rel) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's1', cwd, tool_name: 'Edit', tool_input: { file_path: join(cwd, rel) } });

const decideBlock = (status, id, question, fields = {}) => [
  `- **[DECIDE][${status}][${id}][rule] ${question}**`,
  ...Object.entries({
    axis: 'billing/** × proration',
    rule: 'a mid-cycle plan change is prorated by the day',
    derivation: 'none applies',
    context: 'the ticket asks for plan changes · anchors G-004',
    options: 'prorate → partial refunds by day · full → the whole period is refunded · none → no refund on change',
    recommendation: 'prorate p=0.8, it matches how invoices already round',
    ...fields,
  }).filter(([, v]) => v !== null).map(([k, v]) => `  - ${k.replace('_', ' ')}: ${v}`),
].join('\n');

describe('a [DECIDE] is recorded whatever its id, provisional included', () => {
  test('a provisional block under a D- id is queued with its axis, rule and acted; pending shows it as provisional', async () => {
    const d = repo();
    const msg = `Done.\n\n${decideBlock('provisional', 'D-111c', 'Prorate on plan change?', { acted: 'prorate (src/billing/change.ts:41; flip PRORATION in config.ts)' })}\n`;
    const r = await run(ORACLE, { input: stopPayload(d, msg), cwd: d });
    assert.equal(r.code, 0, r.stderr); assert.equal(r.stdout, '', 'a provisional decision never blocks the turn');
    const pending = ledger.pendingDecisions(d);
    assert.equal(pending.length, 1, JSON.stringify(pending));
    const q = pending[0];
    assert.equal(q.id, 'D-111c'); assert.equal(q.provisional, true); assert.equal(q.decide_kind, 'rule');
    assert.equal(q.axis, 'billing/** × proration'); assert.equal(q.rule, 'a mid-cycle plan change is prorated by the day');
    assert.ok(q.acted.startsWith('prorate (src/billing/change.ts:41'), q.acted);
    const m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d });
    for (const part of ['D-111c [provisional]', 'axis: billing/** × proration', 'rule: a mid-cycle', 'acted: prorate', '/devanity accept']) assert.ok(m.stdout.includes(part), `pending lacks "${part}":\n${m.stdout}`);
    assert.ok(!ledger.read(d, 'events').some((e) => e.kind === 'decide_unparsed'), 'a well-formed block is not unparsed');
  });

  test('a headline that reads as a decision but not as the form leaves a decide_unparsed trace instead of vanishing', async () => {
    const d = repo();
    const msg = 'Done.\n\n- **[DECIDE] Prorate on plan change?**\n  - options: a · b\n- **[DECIDE][blocking][no-id][rule] Second?**\n';
    const r = await run(ORACLE, { input: stopPayload(d, msg), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(ledger.pendingDecisions(d).length, 0);
    const ev = ledger.read(d, 'events').filter((e) => e.kind === 'decide_unparsed');
    assert.equal(ev.length, 1); assert.equal(ev[0].count, 2);
    const fenced = 'Example:\n```md\n- **[DECIDE] not a question**\n```\n';
    await run(ORACLE, { input: stopPayload(d, fenced), cwd: d });
    assert.equal(ledger.read(d, 'events').filter((e) => e.kind === 'decide_unparsed').length, 1, 'a fenced example is not a lost question');
  });
});

describe('an answer is a rule: it is written into the map as a principle of its axis\'s area', () => {
  test('/devanity decide on a blocking G- block writes P-001 under the axis\'s area with from: [id]; the same rule is never written twice', async () => {
    const d = repo();
    await run(ORACLE, { input: stopPayload(d, decideBlock('blocking', 'G-001', 'Prorate on plan change?')), cwd: d });
    const ans = await run(MODE, { input: prompt(d, '/devanity decide G-001 prorate'), cwd: d });
    assert.ok(ans.stdout.includes('G-001 = prorate') && ans.stdout.includes('Written to the map as P-001 under billing/**'), ans.stdout);
    const map = readMap(d);
    assert.deepEqual(map.paths['billing/**'].invariants, [{ id: 'P-001', rule: 'a mid-cycle plan change is prorated by the day', kind: 'rule', from: ['G-001'] }]);
    assert.equal(map.paths['billing/**'].purpose, 'charges and refunds', 'the rest of the entry is kept');
    const rec = ledger.decisions(d).find((x) => x.id === 'G-001');
    assert.equal(rec.by, 'human'); assert.equal(rec.option, 'prorate'); assert.equal(rec.status, 'decided');
    await run(ORACLE, { input: stopPayload(d, decideBlock('blocking', 'G-002', 'Prorate on plan change, again?')), cwd: d });
    const again = await run(MODE, { input: prompt(d, '/devanity decide G-002 prorate'), cwd: d });
    assert.ok(again.stdout.includes('already holds it as P-001'), again.stdout);
    assert.equal(readMap(d).paths['billing/**'].invariants.length, 1);
  });

  test('a rejection writes nothing into the map; an area the map lacks, or no map, keeps the rule in the ledger and says so', async () => {
    const d = repo();
    await run(ORACLE, { input: stopPayload(d, decideBlock('blocking', 'G-001', 'Prorate?')), cwd: d });
    const no = await run(MODE, { input: prompt(d, '/devanity decide G-001 no'), cwd: d });
    assert.ok(no.stdout.includes('REJECTED'), no.stdout);
    assert.equal(readMap(d).paths['billing/**'].invariants, undefined);
    await run(ORACLE, { input: stopPayload(d, decideBlock('blocking', 'G-002', 'Which currency?', { axis: 'payments/** × currency' })), cwd: d });
    const elsewhere = await run(MODE, { input: prompt(d, '/devanity decide G-002 prorate'), cwd: d });
    assert.ok(elsewhere.stdout.includes('no entry for payments/**'), elsewhere.stdout);
    assert.equal(readMap(d).paths['billing/**'].invariants, undefined);
    const bare = repo(null);
    await run(ORACLE, { input: stopPayload(bare, decideBlock('blocking', 'G-003', 'Prorate?')), cwd: bare });
    const r = await run(MODE, { input: prompt(bare, '/devanity decide G-003 prorate'), cwd: bare });
    assert.ok(r.stdout.includes('RECORDED') && r.stdout.includes('no valid devanity.rules.json'), r.stdout);
  });
});

describe('/devanity accept answers the provisional batch', () => {
  test('every provisional is answered with the label its recommendation names, exceptions as given; blocking ones stay', async () => {
    const d = repo();
    const msg = [
      decideBlock('provisional', 'G-001', 'Prorate on plan change?', { acted: 'prorate (src/billing/change.ts:41)' }),
      decideBlock('provisional', 'G-002', 'Round invoices half-even?', { axis: 'src/api/** × rounding', rule: 'invoice totals round half to even', options: 'half-even → bankers rounding · half-up → school rounding', recommendation: 'half-even p=0.6', acted: 'half-even (src/api/round.ts:3)' }),
      decideBlock('blocking', 'G-003', 'Delete the legacy ledger table?', { axis: 'billing/** × retention', rule: 'legacy rows are kept', options: 'keep → rows stay · drop → rows are deleted', recommendation: 'keep p=0.9' }),
    ].join('\n');
    await run(ORACLE, { input: stopPayload(d, msg), cwd: d });
    assert.equal(ledger.pendingDecisions(d).length, 3);
    const r = await run(MODE, { input: prompt(d, '/devanity accept --except G-002 no'), cwd: d });
    assert.ok(r.stdout.includes('G-002 = no') && r.stdout.includes('REJECTED') && r.stdout.includes('Revert the provisional slice'), r.stdout);
    assert.ok(r.stdout.includes('G-001 = prorate') && r.stdout.includes('P-001 under billing/**'), r.stdout);
    const byId = Object.fromEntries(ledger.decisions(d).map((x) => [x.id, x]));
    assert.equal(byId['G-001'].status, 'decided'); assert.equal(byId['G-001'].by, 'human'); assert.equal(byId['G-001'].option, 'prorate');
    assert.equal(byId['G-002'].status, 'rejected');
    assert.equal(byId['G-003'].status, 'pending', 'a blocking decision is never accepted in batch');
    assert.deepEqual(readMap(d).paths['billing/**'].invariants.map((p) => p.id), ['P-001']);
    assert.equal(readMap(d).paths['src/api/**'].invariants, undefined, 'a rejected rule is not written');
    const none = await run(MODE, { input: prompt(d, '/devanity accept'), cwd: d });
    assert.equal(none.stdout.trim(), 'DEVANITY ACCEPT: no provisional decision pending.');
    assert.equal((await run(MODE, { input: prompt(d, 'please run /devanity accept for me'), cwd: d })).stdout, '', 'whole message only');
  });
});

describe('/devanity allow is authority, apart from any choice', () => {
  test('allow <glob> authorizes for the open change like decide --path; --standing never expires and never ties to a change', async () => {
    const d = repo();
    mkdirSync(join(d, 'billing'), { recursive: true }); writeFileSync(join(d, 'billing', 'x.py'), 'a\n');
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 2, 'high-risk: blocked before any allow');
    const r = await run(MODE, { input: prompt(d, '/devanity allow billing/** --standing'), cwd: d });
    assert.ok(r.stdout.includes('A-billing = yes') && r.stdout.includes('standing'), r.stdout);
    const rec = ledger.decisions(d).find((x) => x.id === 'A-billing');
    assert.equal(rec.by, 'human'); assert.equal(rec.standing, true); assert.equal(rec.path, 'billing/**'); assert.equal(rec.contract, null);
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 0);
    // 25 hours later, no open change: a standing grant still authorizes; a plain one no longer does.
    const dir = ledger.ledgerDir(d);
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    writeFileSync(join(dir, 'decisions.jsonl'), [
      { ts: old, id: 'A-billing', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/**', standing: true, contract: null },
      { ts: old, id: 'D-api', status: 'decided', by: 'human', chosen: 'yes', path: 'src/api/**', contract: null },
    ].map((x) => JSON.stringify(x)).join('\n') + '\n');
    mkdirSync(join(d, 'src', 'api'), { recursive: true }); writeFileSync(join(d, 'src', 'api', 'x.ts'), 'a\n');
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 0, 'standing: still allowed after 24 h');
    const plain = await run(MODE, { input: prompt(d, '/devanity allow src/api/**'), cwd: d });
    assert.ok(plain.stdout.includes('for 24 h') && !plain.stdout.includes('standing'), plain.stdout);
    assert.equal(ledger.decisions(d).find((x) => x.id === 'A-src').standing, undefined);
    assert.equal((await run(MODE, { input: prompt(d, '/devanity allow'), cwd: d })).stdout.trim(), 'DEVANITY ALLOW: usage is `/devanity allow <glob> [--standing]`.');
  });
});
