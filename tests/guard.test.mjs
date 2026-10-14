// Tests for hooks/devanity-guard.js (PreToolUse) and the `/devanity decide|pending` handlers of
// hooks/devanity-mode.js. Every guard case spawns the hook as a child process against a temporary
// git repository carrying a devanity.rules.json, with a temporary CLAUDE_CONFIG_DIR.
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
const GUARD = join(hooksDir, 'devanity-guard.js');
const MODE = join(hooksDir, 'devanity-mode.js');
const ledger = require(join(hooksDir, 'devanity-ledger.js'));
// The guard's real ceiling: the host kills a PreToolUse hook past this (plugin/hooks/hooks.json).
// A time assertion that claims "inside the hook budget" measures against it, not a tighter guess:
// the costliest hostile input below reads in ~0.9 s idle, and a quadratic reader would take minutes.
const HOOK_BUDGET_MS = 1000 * JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8')).hooks.PreToolUse[0].hooks[0].timeout;

const RULES = {
  version: 1,
  defaults: { tier: 'normal', authority: 'commit' },
  paths: { 'billing/**': { tier: 'high-risk' }, 'docs/**': { tier: 'trivial' } },
  autonomy: { authority: 'commit', 'high-risk': 'queue', irreversible: 'queue' },
};

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-guard-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

let n = 0;
function freshDir(name) { const d = join(temp, `${name}-${++n}`); mkdirSync(d, { recursive: true }); return d; }
function repo({ rules = RULES, git = true } = {}) {
  const d = freshDir('repo');
  if (git) spawnSync('git', ['init', '-q'], { cwd: d });
  mkdirSync(join(d, 'billing'), { recursive: true }); mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'billing', 'x.py'), 'a\n'); writeFileSync(join(d, 'src', 'x.py'), 'a\n');
  if (rules !== null) writeFileSync(join(d, 'devanity.rules.json'), typeof rules === 'string' ? rules : JSON.stringify(rules));
  return d;
}
function baseEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['DEVANITY_AUTONOMOUS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CI', 'CLAUDE_CONFIG_DIR', 'DEVANITY_AUTHORITY', 'DEVANITY_GUARDS']) delete env[k];
  env.HOME = temp; env.USERPROFILE = temp; env.CLAUDE_CONFIG_DIR = freshDir('cfg');
  return { ...env, ...extra };
}

function run(script, { input = '', env = baseEnv(), cwd = temp, holdStdin = false, timeoutMs = 4000 } = {}) {
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script], { env, cwd, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (c) => { stdout += c; }); child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(killer); done({ code, signal, stdout, stderr, ms: Date.now() - started }); });
    if (input !== null) { child.stdin.on('error', () => {}); if (input) child.stdin.write(input); if (!holdStdin) child.stdin.end(); }
  });
}

const sid = 'sess-1';
const edit = (cwd, file, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd, tool_name: 'Edit', tool_input: { file_path: join(cwd, file), old_string: 'a', new_string: 'b' }, ...extra });
const bash = (cwd, command, extra = {}) => JSON.stringify({ hook_event_name: 'PreToolUse', session_id: sid, cwd, tool_name: 'Bash', tool_input: { command }, ...extra });
const prompt = (cwd, text) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: sid, cwd, prompt: text });
const events = (cwd) => ledger.read(cwd, 'events');
const lastAuthority = (cwd) => events(cwd).filter((e) => e.authority).at(-1).authority;

// Marks are the identifiers a person acts on (path, decision id, needed authority), never the
// surrounding prose: rewording a message is not a regression.
function assertBlocked(r, ...marks) {
  assert.equal(r.code, 2, `expected exit 2, got ${r.code}; stderr: ${r.stderr}`);
  for (const m of marks) assert.ok(r.stderr.includes(m), `stderr lacks "${m}":\n${r.stderr}`);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(out.hookSpecificOutput.permissionDecisionReason, r.stderr.trimEnd());
}
function assertAllowed(r) { assert.equal(r.code, 0, `expected allow, got ${r.code}: ${r.stderr}`); assert.equal(r.stdout, ''); }

describe('guard: file tools (a)', () => {
  test('Edit on a high-risk path blocks; the message names path, rule and the decide command', async () => {
    const d = repo();
    const r = await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d });
    assertBlocked(r, 'billing/x.py', '/devanity decide D-billing <option> --path billing/**');
    const ev = events(d);
    assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'blocked'); assert.equal(ev[0].path, 'billing/x.py'); assert.equal(ev[0].rule.glob, 'billing/**');
    for (const tool of ['Write', 'MultiEdit', 'NotebookEdit']) {
      const key = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      const rr = await run(GUARD, { input: JSON.stringify({ session_id: sid, cwd: d, tool_name: tool, tool_input: { [key]: join(d, 'billing/x.py') } }), cwd: d });
      assert.equal(rr.code, 2, `${tool} must block too`);
    }
    assertAllowed(await run(GUARD, { input: edit(d, 'src/x.py'), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, '../outside.py'), cwd: d }));
  });

  test('after /devanity decide via the mode hook the same Edit is allowed (b)', async () => {
    const d = repo();
    let m = await run(MODE, { input: prompt(d, '/devanity decide D-billing prorate'), cwd: d });
    assert.equal(m.code, 0);
    assert.ok(m.stdout.includes('not a known decision') && m.stdout.includes('--path'), `an unknown id without --path must be refused: ${m.stdout}`);
    assert.equal(ledger.decisions(d).length, 0);
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 2, 'still blocked');
    m = await run(MODE, { input: prompt(d, '/devanity decide D-billing prorate --path billing/**'), cwd: d });
    assert.ok(m.stdout.startsWith('DEVANITY DECISION RECORDED: D-billing = prorate, path billing/**, by human'), m.stdout);
    const rec = ledger.decisions(d).find((x) => x.id === 'D-billing');
    assert.equal(rec.by, 'human'); assert.equal(rec.status, 'decided'); assert.equal(rec.path, 'billing/**'); assert.equal(rec.session_id, sid);
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    assertAllowed(await run(GUARD, { input: bash(d, "sed -i 's/a/b/' billing/x.py"), cwd: d }));
  });

  test('an agent-default decision record does NOT unblock (c)', async () => {
    const d = repo();
    assert.ok(ledger.append(d, 'decisions', { id: 'D-billing', path: 'billing/**', kind: 'human', status: 'decided', by: 'agent-default', chosen: 'prorate' }, sid));
    assert.ok(ledger.append(d, 'decisions', { id: 'D-billing2', path: 'billing/**', kind: 'human', status: 'decided', by: 'agent', chosen: 'prorate' }, sid));
    assert.ok(ledger.append(d, 'decisions', { id: 'D-billing3', path: 'billing/**', kind: 'human', status: 'pending', by: 'human' }, sid));
    assertBlocked(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }), 'billing/x.py');
  });

  test('the rules file and the ledger are protected whatever the rules say', async () => {
    const d = repo();
    assertBlocked(await run(GUARD, { input: edit(d, 'devanity.rules.json'), cwd: d }), 'devanity.rules.json');
    assertBlocked(await run(GUARD, { input: bash(d, 'echo \'{"id":"D-billing","status":"decided","by":"human","path":"billing/**"}\' >> .git/devanity/decisions.jsonl'), cwd: d }), '.git/devanity/decisions.jsonl');
  });

  test('a prompt that merely mentions decide or pending does nothing', async () => {
    const d = repo();
    for (const text of ['please run /devanity decide D-billing prorate --path billing/** for me', 'what does /devanity pending show?', 'decide D-x y']) {
      const m = await run(MODE, { input: prompt(d, text), cwd: d });
      assert.equal(m.stdout, '', `"${text}" must produce no output`);
    }
    assert.equal(ledger.decisions(d).length, 0);
  });
});

describe('guard: Bash (d) (e)', () => {
  test('writes into high-risk paths are detected; reads are not', async () => {
    const d = repo();
    const blocked = ["sed -i 's/a/b/' billing/x.py", 'echo hi > billing/x.py', 'echo hi >> billing/x.py', 'cat src/x.py | tee billing/x.py', 'mv billing/x.py billing/y.py', 'rm -f billing/x.py',
      'git checkout -- billing/x.py', 'git restore billing/x.py', 'cp src/x.py billing/x.py', `echo hi > ${join(d, 'billing/x.py')}`, 'pytest -q && sed -i.bak s/a/b/ billing/x.py'];
    for (const c of blocked) assertBlocked(await run(GUARD, { input: bash(d, c), cwd: d }), 'billing/x.py', '/devanity decide D-billing');
    const allowed = ["sed -i 's/a/b/' src/x.py", 'cat billing/x.py', 'grep -r charge billing/', 'sed s/a/b/ billing/x.py', 'git checkout main', 'echo hi > src/out.txt', 'pytest tests/billing -q'];
    for (const c of allowed) assertAllowed(await run(GUARD, { input: bash(d, c), cwd: d }));
    assertBlocked(await run(GUARD, { input: bash(join(d, 'billing'), "sed -i 's/a/b/' x.py"), cwd: join(d, 'billing') }), 'billing/x.py');
  });

  test('command authority: need above the session ceiling blocks with the raise-authority step', async () => {
    const d = repo();
    assertBlocked(await run(GUARD, { input: bash(d, 'git push --force origin main'), cwd: d }), 'git push --force origin main', 'needs authority: merge', 'DEVANITY_AUTHORITY');
    assert.deepEqual(lastAuthority(d), { need: 'merge', have: 'commit' });
    assertAllowed(await run(GUARD, { input: bash(d, 'git push origin main'), cwd: d }));
    assertBlocked(await run(GUARD, { input: bash(d, 'git push origin main'), cwd: d, env: baseEnv({ DEVANITY_AUTHORITY: 'prepare' }) }), 'needs authority: commit');
    assert.deepEqual(lastAuthority(d), { need: 'commit', have: 'prepare' });
    assertAllowed(await run(GUARD, { input: bash(d, 'terraform apply'), cwd: d, env: baseEnv({ DEVANITY_AUTHORITY: 'deploy' }) }));
    const r = await run(GUARD, { input: bash(d, 'terraform apply'), cwd: d, env: baseEnv({ DEVANITY_AUTHORITY: 'deploy', DEVANITY_AUTONOMOUS: '1' }) });
    assertBlocked(r, 'needs authority: deploy');
    assert.deepEqual(lastAuthority(d), { need: 'deploy', have: 'commit' }, 'an autonomous session is capped at commit whatever the env says');
    assertAllowed(await run(GUARD, { input: bash(d, 'git push origin main'), cwd: d, env: baseEnv({ DEVANITY_AUTONOMOUS: '1' }) }));
    const ev = events(d).filter((e) => e.command);
    assert.ok(ev.every((e) => e.kind === 'blocked' && e.authority.need), JSON.stringify(ev));
  });
});

describe('guard: a block shows why the path is guarded', () => {
  test('the path\'s purpose and invariants ride the block; a path with nothing to say adds no line', async () => {
    const d = repo({ rules: { version: 1, paths: { 'billing/**': { tier: 'high-risk', purpose: 'charges and refunds', invariants: ['amounts are integer cents', 'a refund never exceeds its charge'] }, 'ops/**': { tier: 'high-risk' } } } });
    const r = await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d });
    assertBlocked(r, 'charges and refunds', 'amounts are integer cents', 'a refund never exceeds its charge');
    mkdirSync(join(d, 'ops'), { recursive: true }); writeFileSync(join(d, 'ops', 'x.sh'), 'a\n');
    const bare = await run(GUARD, { input: edit(d, 'ops/x.sh'), cwd: d });
    assert.equal(bare.code, 2);
    assert.ok(!/invariant|purpose/i.test(bare.stderr), `a path that declares nothing gets no empty reason line:\n${bare.stderr}`);
  });
});

describe('guard: the next step names what can actually raise the authority', () => {
  const nextStep = (r) => r.stderr.split('\n').find((l) => l.includes('Next step')) || '';
  test('attended: defaults.authority; autonomous: autonomy.authority up to commit, nothing for merge or deploy', async () => {
    const d = repo();
    const attended = nextStep(await run(GUARD, { input: bash(d, 'git push --force origin main'), cwd: d }));
    assert.ok(attended.includes('DEVANITY_AUTHORITY') && attended.includes('defaults.authority') && !attended.includes('autonomy'), attended);
    const prepare = baseEnv({ DEVANITY_AUTONOMOUS: '1', DEVANITY_AUTHORITY: 'prepare' });
    const raisable = nextStep(await run(GUARD, { input: bash(d, 'git push origin main'), cwd: d, env: prepare }));
    assert.ok(raisable.includes('autonomy.authority') && !raisable.includes('defaults.authority'), raisable);
    const never = nextStep(await run(GUARD, { input: bash(d, 'gh pr merge 12'), cwd: d, env: baseEnv({ DEVANITY_AUTONOMOUS: '1' }) }));
    assert.ok(never.includes('never available to an autonomous session'), never);
    assert.ok(!never.includes('DEVANITY_AUTHORITY') && !never.includes('autonomy.authority'), `no field raises merge unattended: ${never}`);
  });
});

describe('guard: honest-error holes closed (SPEC §0.5)', () => {
  test('a human "no" in any common spelling is recorded as a rejection and authorizes nothing', async () => {
    for (const answer of ['no', 'reject', 'não', 'deny', 'nope', 'rejeitar', 'Rejeito.', 'negado', 'No!', 'no way', 'decline', 'nope!!']) {
      const d = repo();
      const m = await run(MODE, { input: prompt(d, `/devanity decide D-billing ${answer} --path billing/**`), cwd: d });
      assert.ok(m.stdout.includes('REJECTED'), `"${answer}" must read as a rejection: ${m.stdout}`);
      const rec = ledger.decisions(d).find((x) => x.id === 'D-billing');
      assert.equal(rec.status, 'rejected'); assert.equal(rec.by, 'human');
      assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 2, `after "${answer}" the edit stays blocked`);
      assert.equal(ledger.pendingDecisions(d).length, 0, 'a rejection answers the pending question');
    }
  });

  test('merge and push in any spelling need their authority; git commit needs commit', async () => {
    const d = repo();
    const prepare = baseEnv({ DEVANITY_AUTHORITY: 'prepare' });
    for (const [cmd, need] of [['gh pr merge 12 --squash --admin', 'merge'], ['git -C . push origin HEAD', 'commit'], ['git -c user.name=x push', 'commit'], ['git commit -am x', 'commit'], ['git -C sub merge main', 'merge']]) {
      assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d, env: prepare }), `needs authority: ${need}`);
    }
    assertBlocked(await run(GUARD, { input: bash(d, 'gh pr merge 12'), cwd: d, env: baseEnv({ DEVANITY_AUTONOMOUS: '1' }) }), 'needs authority: merge', 'never available to an autonomous session');
    assertAllowed(await run(GUARD, { input: bash(d, 'git status && git log -1'), cwd: d, env: prepare }));
  });

  test('a human decision expires: older than 24 h it authorizes nothing, unless the change it was given for is still open', async () => {
    const d = repo();
    const old = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const dir = ledger.ledgerDir(d); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'decisions.jsonl'), JSON.stringify({ ts: old, session_id: 'old', id: 'D-old', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/**' }) + '\n');
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 2, 'a 25-hour-old decision no longer authorizes');
    writeFileSync(join(dir, 'contracts.jsonl'), JSON.stringify({ ts: new Date().toISOString(), id: 'C-1', phase: 'EXECUTE' }) + '\n');
    writeFileSync(join(dir, 'decisions.jsonl'), JSON.stringify({ ts: old, session_id: 'old', id: 'D-old', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/**', contract: 'C-1' }) + '\n');
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    const m = await run(MODE, { input: prompt(d, '/devanity decide D-new yes --path billing/**'), cwd: d });
    assert.equal(ledger.decisions(d).find((x) => x.id === 'D-new').contract, 'C-1', 'a decision is tied to the open change');
    assert.ok(m.stdout.includes('C-1'), m.stdout);
  });
});

describe('guard: gate-review fixes (phase V)', () => {
  const at = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const seedLedger = (d, rows) => { const dir = ledger.ledgerDir(d); mkdirSync(dir, { recursive: true }); for (const [kind, recs] of Object.entries(rows)) writeFileSync(join(dir, `${kind}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

  test('a decision given for a change stops authorizing when that change closes, even inside 24 h', async () => {
    const d = repo();
    seedLedger(d, {
      contracts: [{ ts: at(2), id: 'C-1', phase: 'EXECUTE' }, { ts: at(1), id: 'C-1', phase: 'DONE' }, { ts: at(0.5), id: 'C-2', phase: 'EXECUTE' }],
      decisions: [{ ts: at(1.5), session_id: 'x', id: 'D-billing', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/**', contract: 'C-1' }],
    });
    assert.equal((await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d })).code, 2, 'C-1 is closed: its decision authorizes nothing');
  });

  test('autonomous re-queues never overwrite a human decision with the same id, nor each other', async () => {
    const d = repo();
    seedLedger(d, { decisions: [{ ts: at(0.1), session_id: 'x', id: 'D-billing', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/x.py' }] });
    for (const f of ['y.py', 'z.py']) writeFileSync(join(d, 'billing', f), 'a\n');
    const env = baseEnv({ DEVANITY_AUTONOMOUS: '1' });
    assert.equal((await run(GUARD, { input: edit(d, 'billing/y.py'), cwd: d, env })).code, 2);
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d, env }));
    assert.equal(ledger.decisions(d).find((x) => x.id === 'D-billing').status, 'decided', 'the human record is still the latest for its id');
    assert.equal(ledger.pendingDecisions(d).length, 1, 'the new block is queued under its own id');
    await run(GUARD, { input: edit(d, 'billing/z.py'), cwd: d, env });
    const pending = ledger.pendingDecisions(d);
    assert.equal(new Set(pending.map((x) => x.id)).size, pending.length, 'distinct ids');
    assert.equal(ledger.decisions(d).find((x) => x.id === 'D-billing').status, 'decided');
  });

  test('honest commands are not blocked by look-alike words; the real ones still need their authority', async () => {
    const d = repo();
    for (const cmd of ['cat docs/deploy.md', 'npm install --force', 'rm --force build/x', 'grep -r deploy src', 'echo "-f"']) assertAllowed(await run(GUARD, { input: bash(d, cmd), cwd: d }));
    const prepare = baseEnv({ DEVANITY_AUTHORITY: 'prepare' });
    for (const [cmd, need] of [['./deploy.sh prod', 'deploy'], ['npm run deploy', 'deploy'], ['make deploy', 'deploy'], ['git push --force origin main', 'merge'], ['git push -f origin main', 'merge'], ['git -P push', 'commit'], ['git --git-dir .git push', 'commit'], ['git -C "my dir" push', 'commit']]) {
      assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d, env: prepare }), `needs authority: ${need}`);
    }
  });
});

describe('guard: confirming-gate fixes (phase V)', () => {
  const at = (h) => new Date(Date.now() - h * 3600 * 1000).toISOString();
  const seedLedger = (d, rows) => { const dir = ledger.ledgerDir(d); mkdirSync(dir, { recursive: true }); for (const [kind, recs] of Object.entries(rows)) writeFileSync(join(dir, `${kind}.jsonl`), recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };

  test('re-deciding an id after its change closed authorizes as the reply says', async () => {
    const d = repo();
    seedLedger(d, {
      contracts: [{ ts: at(2), id: 'C-1', phase: 'EXECUTE' }, { ts: at(1), id: 'C-1', phase: 'DONE' }],
      decisions: [{ ts: at(1.5), session_id: 'x', id: 'D-billing', status: 'decided', by: 'human', chosen: 'yes', path: 'billing/**', contract: 'C-1' }],
    });
    const m = await run(MODE, { input: prompt(d, '/devanity decide D-billing yes --path billing/**'), cwd: d });
    assert.ok(m.stdout.includes('for 24 h'), m.stdout);
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
  });

  test('a command word inside a quoted argument does not need authority; a forced push in any spelling needs merge', async () => {
    const d = repo();
    const prepare = baseEnv({ DEVANITY_AUTHORITY: 'prepare' });
    for (const cmd of ['grep -rn "git push" docs', 'echo "remember to git commit"', "git log --grep='git push'"]) assertAllowed(await run(GUARD, { input: bash(d, cmd), cwd: d, env: prepare }));
    for (const [cmd, need] of [['git push -fu origin main', 'merge'], ['git push origin +main', 'merge'], ['bash deploy.sh', 'deploy'], ['bash -c "git push"', 'commit']]) {
      assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d, env: prepare }), `needs authority: ${need}`);
    }
  });
});

describe('guard: what the shell runs, not what the text says (field report: 5 of 8 blocks were false)', () => {
  test('heredoc bodies, comments, quoted text and look-alike subcommands are data: nothing to block', async () => {
    const d = repo();
    for (const cmd of [
      "cat > docs/ops.md <<'EOF'\nAfter merge, run pnpm deploy:vm.\nEOF",
      "cat > src/ci.yml <<'EOF'\n      - run: git push --force origin verified\nEOF",
      'git fetch origin main && git merge-base origin/main HEAD',
      'node -e "console.log(1)"   # never git push --force here',
      'bash test/static.sh && grep -n "git push --force" src/x.py',
      "git commit -m \"$(cat <<'EOF'\nci: deploy gate; don't git push --force\nEOF\n)\"",
      "cat > docs/ops.md <<'EOF'\nRestore: cp src/x.py billing/x.py\necho hi > billing/x.py\nEOF",
      'grep -n "=> billing/x.py" src/x.py',
      "cat > docs/ops.md <<'EOF'\nRun pnpm deploy:vm.\nEOF\ngit add docs/ops.md && cat docs/ops.md",
      'grep -rn ssh scripts/ deploy',
      'pytest -k eval deploy',
      "cat > x.sh <<'EOF'\ngit push --force\nEOF\nbash -n x.sh",
      'echo "git push --force is banned" && which bash',
      'grep -rln "git push --force" . | head; type zsh',
      'man bash; echo "pnpm deploy:vm"',
      'cp billing/x.py /tmp/x.bak',
      'cp -p billing/x.py src/x.py',
      'source .venv/bin/activate && pytest tests/ -k "deploy or billing" -q',
      '. ~/.nvm/nvm.sh && npm test -- -t "deploy"',
      'eval "$(pyenv init -)" && pytest -k "deploy"',
      'eval "$(conda shell.bash hook)" && conda activate env && pytest -k "deploy or billing"',
      'eval "$(direnv export bash)"; npm test -- -t \'deploy\'',
      'ssh host "rm billing/x.py"',
      "ssh host <<'EOF'\nrm billing/x.py\nEOF",
      'ssh -fN -L 5432:localhost:5432 bastion && git commit -m "fix: git merge conflict"',
      'ssh -T git@github.com; git commit -m "chore: npm publish notes"',
      'docker compose exec -T app bash scripts/test.sh && git commit -m "fix: git merge conflict check"',
      'apt-get install -y bash curl && grep -rn "git merge" docs/',
      'grep -rl "git push --force" scripts/ | xargs grep -L bash',
      "git ls-files '*.sh' | xargs shellcheck -s bash; grep -rn 'git push --force' docs",
      'rsync -avz -e ssh dist/ host:/srv/app/ && git commit -m "release: note git merge order"',
    ]) assertAllowed(await run(GUARD, { input: bash(d, cmd), cwd: d }));
  });

  test('an ssh that runs something from this command counts it raw, for authority only (documented over-read)', async () => {
    const d = repo();
    for (const [cmd, need] of [
      ['ssh host "grep -rn \'git merge\' /srv/app/log"', 'merge'],
      ["git commit -m \"docs: git merge notes\" && ssh host <<'EOF'\nuptime\nEOF", 'merge'],
      ["echo 'git push --force' > s.sh && ssh host bash < s.sh", 'merge'],
      ["ssh host 'cat > /tmp/r.sh' <<'EOF'\ngit push --force\nEOF\nssh host 'bash /tmp/r.sh'", 'merge'],
      ['ssh host -t ./deploy.sh', 'deploy'],
      ["printf 'git push --force\\n' | ssh host", 'merge'],
    ]) assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d }), `needs authority: ${need}`);
    for (const cmd of ['ssh host "rm billing/x.py"', "ssh host <<'EOF'\nrm billing/x.py\nEOF"]) assertAllowed(await run(GUARD, { input: bash(d, cmd), cwd: d }));
  });

  test('what the shell does run still counts: a later line, a substitution, a script fed to a shell or ssh', async () => {
    const d = repo();
    for (const [cmd, need] of [
      ['cd src\n./deploy.sh prod', 'deploy'],
      ['echo "$(git push --force origin main)"', 'merge'],
      ["cat <<'EOF' | bash\ngit push --force origin main\nEOF", 'merge'],
      ["ssh host <<'EOF'\n./deploy.sh\nEOF", 'deploy'],
      ["bash -c 'npm run deploy'", 'deploy'],
      ['bash -lc "pnpm deploy:vm"', 'deploy'],
      ['if true; then ./deploy.sh; fi', 'deploy'],
      ["cat > run.sh <<'EOF'\n./deploy.sh prod\nEOF\nbash run.sh", 'deploy'],
      ["{ cat <<'EOF'\ngit push --force\nEOF\n} | bash", 'merge'],
      ["(cat <<'EOF'\ngit push --force\nEOF\n) | bash", 'merge'],
      ['echo "git push --force" | bash', 'merge'],
      ["printf 'git push --force\\n' | sh", 'merge'],
      ["git commit -m \"$(cat <<'EOF'\nmsg\nEOF)\" && git push --force", 'merge'],
      ["bash -c \"$(cat <<'EOF'\ngit push --force origin main\nEOF\n)\"", 'merge'],
      ['"bash" -c "git push --force"', 'merge'],
      ["tee x.sh <<'EOF'\n./deploy.sh\nEOF\nbash -o pipefail x.sh", 'deploy'],
      ["cat > x.sh <<'EOF'\n./deploy.sh\nEOF\nbash < x.sh", 'deploy'],
      ["ssh host bash <<'EOF'\ngit push --force\nEOF", 'merge'],
      ...['source x.sh', '. ./x.sh', 'timeout 60 bash x.sh', 'bash -c "$(cat x.sh)"', 'eval "$(cat x.sh)"', 'docker exec -i c bash < x.sh', 'ssh host < x.sh', 'bash <(cat x.sh)']
        .map((run) => [`cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\n${run}`, 'merge']),
      ['echo "git push --force" > p.sh && bash p.sh', 'merge'],
      ['bash <(echo "git push --force")', 'merge'],
      ...['sudo ./deploy.sh', 'FOO=1 ./deploy.sh', 'env FOO=1 ./deploy.sh', 'time ./deploy.sh', 'nohup ./deploy.sh', 'nice -n 5 ./deploy.sh', 'timeout 60 ./deploy.sh', '"./deploy.sh"'].map((cmd) => [cmd, 'deploy']),
      ['"git" push --force', 'merge'],
      ['$(pwd)/deploy.sh prod', 'deploy'],
      ['`pwd`/deploy.sh', 'deploy'],
      ...['stdbuf -oL bash x.sh', 'setsid bash x.sh', 'flock /tmp/l bash x.sh', 'echo x.sh | xargs bash', 'cat x.sh | busybox sh', 'cd scripts && bash x.sh', 'mv x.sh d/ && bash d/x.sh']
        .map((run) => [`cat > ./scripts/x.sh <<'EOF'\ngit push --force origin main\nEOF\n${run}`, 'merge']),
      ...['trap "git push --force" EXIT', 'echo "git push --force" | at now', 'env -S "git push --force"', 'su -c "git push --force"', 'echo "git push --force" | su -c bash', 'git rebase -x "git push --force" main']
        .map((cmd) => [cmd, 'merge']),
      ['command bash -c "git push --force origin main"', 'merge'],
      ['echo "git push --force" | command bash', 'merge'],
      ['xargs "bash" -c "git push --force"', 'merge'],
      ["cat > env.sh <<'EOF'\ngit push --force origin main\nEOF\nsource env.sh", 'merge'],
      ['source <(echo "git push --force")', 'merge'],
      ["bash -eo pipefail -c 'git merge main'", 'merge'],
      ["bash -euxo pipefail -c 'git merge main'", 'merge'],
      ["cat > x.sh <<'EOF'\ngit merge main\nEOF\nbash -euo pipefail x.sh", 'merge'],
      ['eval "$(echo git push --force)"', 'merge'],
      ["cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\neval \"$(cat x.sh)\"", 'merge'],
      ...['bash -c "$(< s.sh)"', 'eval "$(<s.sh)"', 'bash -c "$(sed -n p s.sh)"', "eval \"$(grep -v '^#' s.sh)\""]
        .map((run) => [`cat > s.sh <<'EOF'\ngit merge main\nEOF\n${run}`, 'merge']),
      ["cat > g.py <<'EOF'\nprint('git merge main')\nEOF\neval \"$(python3 g.py)\"", 'merge'],
      ["echo 'git merge main' | (docker exec -i c bash)", 'merge'],
      ['ssh host ./deploy.sh prod', 'deploy'],
      ['ssh -p 22 deploy@host "cd app && ./deploy.sh"', 'deploy'],
      ['ssh host "git push --force origin main"', 'merge'],
      ["ssh host 'bash -s' < <(echo 'git push --force')", 'merge'],
      ["sudo -i <<'EOF'\ngit push --force\nEOF", 'merge'],
      ...["cp /dev/stdin x.sh <<'EOF'\ngit push --force origin main\nEOF\nbash x.sh", "dd of=x.sh <<'EOF'\ngit push --force origin main\nEOF\nbash x.sh"].map((cmd) => [cmd, 'merge']),
      ['(( y = 1 << 2 ))\ngit push --force', 'merge'],
      ['echo $(( 1 << 2 )); git push --force origin main', 'merge'],
      ['n=$(( $(git push --force origin main | wc -l) + 1 ))', 'merge'],
      ['let x=1<<2\ngit merge x', 'merge'],
      ['echo $[1<<2]\ngit merge x', 'merge'],
      ...['./release@v2/deploy.sh', '/opt/app+1/deploy.sh', 'bash ./ops:prod/deploy.sh'].map((cmd) => [cmd, 'deploy']),
      ...['/usr/bin/env bash -c "git push --force origin main"', '/usr/bin/sudo bash -c "git merge main"', 'sudo -iu app bash -c "git merge main"',
        'docker run --rm --platform linux/amd64 img sh -c "git push --force origin main"', 'docker run --env-file .env -m 512m --net host img sh -c "git merge main"',
        'docker exec -itu root app sh -c "git merge main"', 'flock --timeout 5 /tmp/l bash -c "git merge main"'].map((cmd) => [cmd, 'merge']),
      ['xargs -I{} ssh {} "git merge main"', 'merge'],
      ["ssh host 'bash -s' <<'EOF'\ngit push --force\nEOF", 'merge'],
      ["ssh host \"cd /srv && bash\" <<'EOF'\ngit merge main\nEOF", 'merge'],
      ...["ssh host 'bash -s' < x.sh", 'ssh host "sudo bash" < x.sh', "cat x.sh | ssh host 'bash -s'", 'ssh host "$(cat x.sh)"', 'ssh host "$(< x.sh)"',
        'cp x.sh y.sh && ssh host bash < y.sh', 'mv x.sh y.sh && cat y.sh | ssh host bash', 'scp x.sh host:/tmp/ && ssh host bash /tmp/x.sh',
        'ssh host -- bash -s < x.sh', "ssh host 'sudo -i' < x.sh", "ssh host 'bash /dev/stdin' < x.sh", 'ssh host "docker exec -i c sh" < x.sh', 'ssh jump ssh host bash -s < x.sh']
        .map((run) => [`cat > x.sh <<'EOF'\ngit push --force origin main\nEOF\n${run}`, 'merge']),
      ...['cp a.sh b.sh && bash b.sh', 'mv a.sh b.sh && bash b.sh', 'install -m 755 a.sh bin/run && bin/run', 'ln -s a.sh run && ./run']
        .map((run) => [`cat > a.sh <<'EOF'\ngit push --force origin main\nEOF\n${run}`, 'merge']),
    ]) assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d }), `needs authority: ${need}`);
    for (const cmd of ['true\nrm billing/x.py', "bash <<'EOF'\nrm billing/x.py\nEOF", 'echo "$(rm billing/x.py)"', 'cp src/x.py billing/x.py', 'cp -t billing/ src/x.py', 'install -m 644 src/x.py billing/x.py', 'mv billing/x.py src/x.py',
      'cp src/x.py billing', 'mv src/x.py billing/', 'mv src/x.py billing', 'rm billing/x.py; cp a -t', 'install src/x.py billing/x.py -m 644', 'cp src/x.py billing/x.py -S .bak', 'install src/x.py billing/x.py --owner root', 'cp src/x.py billing/x.py --suffix .bak',
      'echo ' + '"$('.repeat(20) + 'x' + ')"'.repeat(20) + '; rm billing/x.py']) {
      assertBlocked(await run(GUARD, { input: bash(d, cmd), cwd: d }), 'billing/x.py');
    }
    assertBlocked(await run(GUARD, { input: bash(d, 'cp -r src billing'), cwd: d }), 'billing/src');
  });
});

describe('guard: the shell reader stays inside the hook budget', () => {
  test('deep nesting, long chains, repeated heredocs and option runs: an answer in time, never a throw', { timeout: 30000 }, () => {
    const rules = require(join(hooksDir, 'devanity-rules.js'));
    const loaded = rules.parseRules(JSON.stringify(RULES)).rules;
    for (const [cmd, need] of [
      ['echo ' + '"$('.repeat(3000) + 'git push --force origin main' + ')"'.repeat(3000), 'merge'],
      ['eval '.repeat(3000) + 'git push --force', 'merge'],
      ["cat > a.sh <<'E'\nx\nE\n".repeat(4000) + 'git push --force', 'merge'],
      ['x <<< a '.repeat(20000) + '; git push --force origin main', 'merge'],
      ['cat <<E '.repeat(20000) + '\n' + 'E\n'.repeat(20000) + 'git push', 'commit'],
      ['git' + ' --git-dir=a'.repeat(12) + ' push', 'commit'],
      ['git' + ' -c'.repeat(24) + ' push', 'commit'],
      ['git' + ' --git-dir=a'.repeat(40) + ' push', null],   // past 16 global options: no pattern rescans the run
      ['git push x '.repeat(16000), 'commit'],
      ['make a '.repeat(100000), null],
      ['ssh h '.repeat(3000) + 'git push --force origin main', 'merge'],
      ["cat > x.sh <<'E'\n" + 'echo a\n'.repeat(150000) + 'E\n' + 'ssh h<x.sh;'.repeat(600) + '\ngit push --force origin main', 'merge'],
      ['echo "a" | ' + 'ssh h bash | '.repeat(16000) + 'cat; git push --force origin main', 'merge'],
      ['git' + ' -git'.repeat(20000), null],
      [' -c git'.repeat(20000), null],
    ]) {
      const started = Date.now();
      assert.equal(rules.commandAuthority(loaded, cmd), need);
      assert.ok(Date.now() - started < HOOK_BUDGET_MS, `${cmd.slice(0, 30)}…: ${Date.now() - started} ms`);
    }
  });
});

describe('guard: a command naming many guarded paths', () => {
  test('100000 high-risk paths block inside the hook budget: the first 50 decide it', async () => {
    const d = repo();
    const started = Date.now();
    const r = await run(GUARD, { input: bash(d, `rm ${Array.from({ length: 100000 }, (_, k) => `billing/f${k}.py`).join(' ')}`), cwd: d, timeoutMs: 15000 });
    assertBlocked(r, 'billing/f0.py', 'more');
    assert.ok(Date.now() - started < HOOK_BUDGET_MS, `${Date.now() - started} ms`);
  });

  test('300 high-risk paths block in about the time of one: the ledger is located once per run', async () => {
    const d = repo();
    const started = Date.now();
    const r = await run(GUARD, { input: bash(d, `rm ${Array.from({ length: 300 }, (_, k) => `billing/f${k}.py`).join(' ')}`), cwd: d, timeoutMs: 10000 });
    assertBlocked(r, 'billing/f0.py', 'billing/f49.py', '250 more');
    assert.ok(Date.now() - started < 2000, `${Date.now() - started} ms`);
  });
});

describe('guard: enforcement by install origin (f) (g) (h)', () => {
  test('no rules file: everything is normal, nothing blocks, no event', async () => {
    const d = repo({ rules: null });
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    assert.deepEqual(events(d), []);
    assertAllowed(await run(GUARD, { input: bash(d, 'git push --force'), cwd: d }));
    assert.equal(events(d).length, 1, 'built-in command authority still applies as a would_block note');
    assert.equal(events(d)[0].kind, 'would_block');
  });

  test('DEVANITY_GUARDS=off and config.json {"guards": false}: allow, would_block recorded; =on forces blocking', async () => {
    const d = repo();
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d, env: baseEnv({ DEVANITY_GUARDS: 'off' }) }));
    const env = baseEnv(); mkdirSync(join(env.CLAUDE_CONFIG_DIR, 'devanity'), { recursive: true });
    writeFileSync(join(env.CLAUDE_CONFIG_DIR, 'devanity', 'config.json'), '{"guards": false}');
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d, env }));
    const ev = events(d);
    assert.equal(ev.length, 2); assert.ok(ev.every((e) => e.kind === 'would_block' && e.path === 'billing/x.py'), JSON.stringify(ev));
    const bare = repo({ rules: null });
    assertBlocked(await run(GUARD, { input: bash(bare, 'git push --force'), cwd: bare, env: baseEnv({ DEVANITY_GUARDS: 'on' }) }), 'needs authority: merge');
  });

  test('invalid rules: allow, rules_invalid recorded once per session', async () => {
    const d = repo({ rules: '{"version": 2, "paths": {"billing/**": {"tier": "lethal"}}}' });
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    const ev = events(d);
    assert.equal(ev.length, 1); assert.equal(ev[0].kind, 'rules_invalid'); assert.equal(ev[0].session_id, sid);
    assert.ok(ev[0].errors.some((e) => e.includes('version')));
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py', { session_id: 'other' }), cwd: d }));
    assert.equal(events(d).length, 2, 'a second session records its own notice');
  });

  test('outside git: allow, no crash, nothing recorded', async () => {
    const d = repo({ git: false });
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }));
    assertAllowed(await run(GUARD, { input: bash(d, 'git push --force'), cwd: d }));
    assert.equal(ledger.ledgerDir(d), null);
  });

  test('never hangs: no stdin, EOF-less stdin, garbage, closed stdout → exit 0 within 2s, payload-missing noted', async () => {
    const d = repo();
    for (const opts of [{ input: null }, { input: edit(d, 'billing/x.py'), holdStdin: true }, { input: '{broken' }, { input: '' }]) {
      const r = await run(GUARD, { ...opts, cwd: d });
      assert.equal(r.signal, null, 'the hook had to be killed');
      assert.ok(r.ms < 2000, `took ${r.ms}ms`);
      if (opts.holdStdin) assert.equal(r.code, 2, 'the payload arrived; the guard must still block');
      else { assert.equal(r.code, 0); assert.equal(r.stdout, ''); }
    }
    assert.ok(events(d).some((e) => e.kind === 'guard_payload_missing'), 'a guard that could not read its payload leaves a trace');
    const child = spawn(process.execPath, [GUARD], { env: baseEnv(), cwd: d, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.destroy(); child.stdin.on('error', () => {}); child.stdin.end(edit(d, 'billing/x.py'));
    const code = await new Promise((res) => child.on('close', res));
    assert.equal(code, 2, 'a closed stdout must not turn a block into a crash');
    assert.ok(events(d).some((e) => e.kind === 'blocked' && e.path === 'billing/x.py'));
  });
});

describe('failure paths leave a trace (map invariant for hooks/**)', () => {
  test('errorTrace keeps only an Error class and a hook frame; any other thrown value is its type', () => {
    const rt = require(join(hooksDir, 'devanity-runtime.js'));
    assert.deepEqual(rt.errorTrace({ name: 'sk-live-secret' }), { error: 'object', at: null });
    assert.deepEqual(rt.errorTrace('sk-live-secret'), { error: 'string', at: null });
    assert.deepEqual(rt.errorTrace(null), { error: 'object', at: null });
    const e = new RangeError('sk-live-secret'); e.stack = 'RangeError: sk-live-secret\n    at x (C:\\p\\hooks\\devanity-rules.js:10:3)\n    at y (/p/hooks/devanity-guard.js:170:5)';
    assert.deepEqual(rt.errorTrace(e), { error: 'RangeError', at: 'devanity-rules.js:10' });
  });

  // The error's message can echo what was being parsed (Node prints the start of invalid JSON), and
  // the ledger holds metadata only: the event names the error class and where in the hook, never the text.
  test('a guard or oracle that throws still allows, and records where it failed, never the message', async () => {
    const d = repo();
    const preload = join(freshDir('preload'), 'throw.cjs');
    writeFileSync(preload, `const r = require(${JSON.stringify(join(hooksDir, 'devanity-rules.js'))}); r.loadRules = r.parseRules = () => { throw new TypeError('boom sk-live-secret'); };\n`);
    const withPreload = (script, input) => new Promise((done) => {
      const child = spawn(process.execPath, ['-r', preload, script], { env: baseEnv(), cwd: d, stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = ''; child.stdout.on('data', (c) => { stdout += c; });
      child.on('close', (code) => done({ code, stdout }));
      child.stdin.end(input);
    });
    const g = await withPreload(GUARD, edit(d, 'billing/x.py'));
    assert.equal(g.code, 0, 'fail open'); assert.equal(g.stdout, '');
    const stop = JSON.stringify({ hook_event_name: 'Stop', session_id: sid, cwd: d, stop_hook_active: false, last_assistant_message: 'devanity-proof:\n  check: true\n  failed_before: yes\n  passed_after: yes\n  status: VERIFIED\n  pending: 0\n' });
    const o = await withPreload(join(hooksDir, 'devanity-oracle.js'), stop);
    assert.equal(o.code, 0, 'fail open'); assert.equal(o.stdout, '');
    for (const [kind, file] of [['guard_error', 'devanity-guard.js'], ['oracle_error', 'devanity-oracle.js']]) {
      const ev = events(d).find((e) => e.kind === kind);
      assert.ok(ev, `${kind} missing: ${JSON.stringify(events(d))}`);
      assert.equal(ev.error, 'TypeError');
      assert.match(ev.at, new RegExp(`^${file.replace('.', '\\.')}:\\d+$`), `${kind} names the hook frame: ${ev.at}`);
    }
    assert.ok(!JSON.stringify(events(d)).includes('sk-live-secret'), 'the message never reaches the ledger');
  });
});

describe('guard: the principle of a path reaches the writer once (A5)', () => {
  test('an allowed write under a map entry with invariants carries them as additionalContext, once per entry per session; a path with none, and a block, are unchanged', async () => {
    const d = repo({ rules: { ...RULES, paths: { ...RULES.paths, 'src/**': { tier: 'normal', invariants: [{ id: 'P-1', rule: 'events are never renamed', declared: true }, 'no data access here'] } } } });
    writeFileSync(join(d, 'src', 'x.py'), 'a\n');
    let r = await run(GUARD, { input: edit(d, 'src/x.py'), cwd: d });
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    assert.equal(out.hookEventName, 'PreToolUse');
    assert.ok(out.additionalContext.includes('src/**') && out.additionalContext.includes('P-1: events are never renamed') && out.additionalContext.includes('no data access here'), out.additionalContext);
    assert.ok(!('permissionDecision' in out), 'context never decides');
    r = await run(GUARD, { input: edit(d, 'src/x.py'), cwd: d });
    assertAllowed(r);   // the same session saw it: silent
    r = await run(GUARD, { input: JSON.stringify({ ...JSON.parse(edit(d, 'src/y.py')), session_id: 'other' }), cwd: d });
    assert.ok(JSON.parse(r.stdout).hookSpecificOutput.additionalContext.includes('P-1'), 'another session sees it once too');
    assert.equal(events(d).filter((e) => e.kind === 'principle_injected').length, 2);
    writeFileSync(join(d, 'README.md'), 'a\n');
    assertAllowed(await run(GUARD, { input: edit(d, 'README.md'), cwd: d }));   // no entry, no invariants
    assertBlocked(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d }), 'billing/x.py');
  });
});

describe('guard: one writer per area (A4.2)', () => {
  const as = (id) => ({ agent_type: 'devanity:implementer', agent_id: id });
  const child = (d, fields) => ledger.append(d, 'contracts', { id: 'C-1', phase: 'EXECUTE', parent: 'C-0', agent: 'a1', scope: 'src/**', intent: 'retries', ...fields }, 's1');
  test('a write into the scope an open child change holds blocks every other writer, naming the child and its agent; the holder, a closed child, and a human decision on the path pass', async () => {
    const d = repo();
    ledger.append(d, 'contracts', { id: 'C-0', phase: 'EXECUTE', scope: 'src/** docs/**', intent: 'milestone' }, 's1');
    child(d, {});
    writeFileSync(join(d, 'src', 'x.py'), 'a\n');
    assertBlocked(await run(GUARD, { input: edit(d, 'src/x.py', as('a2')), cwd: d }), 'src/x.py', 'C-1', 'a1');
    assertBlocked(await run(GUARD, { input: edit(d, 'src/x.py'), cwd: d }), 'C-1');   // the main session is another writer too
    assertAllowed(await run(GUARD, { input: edit(d, 'src/x.py', as('a1')), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, 'docs/x.md', as('a2')), cwd: d }));   // outside the held area
    assert.equal(events(d).filter((e) => e.kind === 'blocked' && e.held).length, 2);
    await run(MODE, { input: prompt(d, '/devanity decide D-src fix --path src/x.py'), cwd: d });
    assertAllowed(await run(GUARD, { input: edit(d, 'src/x.py', as('a2')), cwd: d }));
    child(d, { phase: 'DONE' });
    writeFileSync(join(d, 'src', 'y.py'), 'a\n');
    assertAllowed(await run(GUARD, { input: edit(d, 'src/y.py', as('a2')), cwd: d }), 'a closed child holds nothing');
  });
});

describe('guard: roles by agent_type (A1.3)', () => {
  const as = (type) => ({ agent_type: type, agent_id: 'a1' });
  test('the implementer never writes a test file; the oracle-author writes only test files; a human decision on the path lifts either', async () => {
    const d = repo();
    mkdirSync(join(d, 'tests'), { recursive: true }); writeFileSync(join(d, 'tests', 'x.test.js'), 'a\n');
    let r = await run(GUARD, { input: edit(d, 'tests/x.test.js', as('devanity:implementer')), cwd: d });
    assertBlocked(r, 'tests/x.test.js', 'implementer', 'oracle-author', '--path tests/x.test.js');
    assert.equal(events(d).at(-1).kind, 'blocked'); assert.equal(events(d).at(-1).role, 'implementer');
    assertAllowed(await run(GUARD, { input: edit(d, 'src/x.py', as('devanity:implementer')), cwd: d }));
    r = await run(GUARD, { input: bash(d, 'echo x > tests/x.test.js', as('implementer')), cwd: d });
    assertBlocked(r, 'tests/x.test.js', 'implementer');
    r = await run(GUARD, { input: edit(d, 'src/x.py', as('devanity:oracle-author')), cwd: d });
    assertBlocked(r, 'src/x.py', 'oracle-author');
    assertAllowed(await run(GUARD, { input: edit(d, 'tests/x.test.js', as('oracle-author')), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, 'tests/x.test.js', as('Explore')), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, 'tests/x.test.js'), cwd: d }), 'no agent_type: the main session, no role');
    await run(MODE, { input: prompt(d, '/devanity decide D-tests fix-helper --path tests/x.test.js'), cwd: d });
    assertAllowed(await run(GUARD, { input: edit(d, 'tests/x.test.js', as('devanity:implementer')), cwd: d }));
  });
});

describe('guard: the approved scope is the write ceiling (A1.4)', () => {
  const seed = (d) => ledger.append(d, 'contracts', { id: 'C-1', phase: 'EXECUTE', intent: 'retries', scope: 'src/upload/**', proof: 'npm test' }, sid);
  test('with a human decision tied to the open change, writes outside its paths and the change scope block and name both; without one, nothing changes', async () => {
    const d = repo();
    mkdirSync(join(d, 'src', 'upload'), { recursive: true }); mkdirSync(join(d, 'src', 'api'), { recursive: true });
    seed(d);
    assertAllowed(await run(GUARD, { input: edit(d, 'src/other.py'), cwd: d }), 'an agent-declared scope alone limits nothing');
    await run(MODE, { input: prompt(d, '/devanity decide G-1 approve --path src/api/**'), cwd: d });
    assertAllowed(await run(GUARD, { input: edit(d, 'src/upload/a.py'), cwd: d }));
    assertAllowed(await run(GUARD, { input: edit(d, 'src/api/b.py'), cwd: d }));
    let r = await run(GUARD, { input: edit(d, 'src/other.py'), cwd: d });
    assertBlocked(r, 'src/other.py', 'C-1', 'G-1', 'src/api/**', 'src/upload/**', '--path');
    const e = events(d).at(-1); assert.equal(e.kind, 'blocked'); assert.equal(e.scope.contract, 'C-1');
    r = await run(GUARD, { input: bash(d, 'sed -i s/a/b/ src/other.py', {}), cwd: d });
    assertBlocked(r, 'src/other.py', 'C-1');
    ledger.append(d, 'contracts', { id: 'C-1', phase: 'DONE' }, sid);
    assertAllowed(await run(GUARD, { input: edit(d, 'src/other.py'), cwd: d }), 'the ceiling ends with the change');
  });
});

describe('guard: autonomous session without a human (i)', () => {
  test('a blocked high-risk edit leaves one pending decision; /devanity pending lists it; the session is not stalled', async () => {
    const d = repo();
    const env = baseEnv({ DEVANITY_AUTONOMOUS: '1' });
    assertBlocked(await run(GUARD, { input: edit(d, 'billing/x.py'), env, cwd: d }), 'D-billing');
    assertBlocked(await run(GUARD, { input: bash(d, 'echo x > billing/x.py'), env, cwd: d }), 'D-billing');
    const pending = ledger.pendingDecisions(d);
    assert.equal(pending.length, 1, 'queued once, not per attempt');
    assert.deepEqual({ id: pending[0].id, path: pending[0].path, kind: pending[0].kind, by: pending[0].by }, { id: 'D-billing', path: 'billing/x.py', kind: 'human', by: 'agent' });
    assertAllowed(await run(GUARD, { input: edit(d, 'src/x.py'), env, cwd: d }));   // unrelated work continues
    let m = await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d, env });
    assert.match(m.stdout, /^DEVANITY PENDING: 1 decision/); assert.ok(m.stdout.includes('D-billing') && m.stdout.includes('billing/x.py'), m.stdout);
    m = await run(MODE, { input: prompt(d, '/devanity decide D-billing prorate'), cwd: d, env: baseEnv() });
    assert.ok(m.stdout.startsWith('DEVANITY DECISION RECORDED: D-billing = prorate, path billing/x.py'), 'a known id inherits its path: ' + m.stdout);
    assert.equal(ledger.pendingDecisions(d).length, 0);
    assertAllowed(await run(GUARD, { input: edit(d, 'billing/x.py'), env, cwd: d }));
    assert.equal((await run(MODE, { input: prompt(d, '/devanity pending'), cwd: d })).stdout, 'DEVANITY PENDING: none.');
    const attended = repo();
    assertBlocked(await run(GUARD, { input: edit(attended, 'billing/x.py'), cwd: attended }), 'D-billing');
    assert.equal(ledger.pendingDecisions(attended).length, 0, 'an attended session does not queue: the human is there to decide');
  });
});

describe('guardrail 12: no self-grant path (j)', () => {
  test("by:'human' is written only by the /devanity decide handler in devanity-mode.js", () => {
    const humanWrite = /by\s*:\s*['"]human['"]/g;
    const guard = readFileSync(join(hooksDir, 'devanity-guard.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.equal(guard.match(humanWrite), null, 'the guard must never write by:human');
    for (const f of ['devanity-runtime.js', 'devanity-inject.js', 'devanity-rules.js']) {
      assert.equal(readFileSync(join(hooksDir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n').match(humanWrite), null, `${f} must not write by:human`);
    }
    const ledgerSrc = readFileSync(join(hooksDir, 'devanity-ledger.js'), 'utf8');
    assert.ok(!/append\([^)]*human/.test(ledgerSrc), 'the ledger module only compares against human, never appends it');
    const mode = readFileSync(join(hooksDir, 'devanity-mode.js'), 'utf8');
    const code = mode.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const hits = code.match(humanWrite) || [];
    assert.equal(hits.length, 1, `expected exactly one by:'human' write in devanity-mode.js, found ${hits.length}`);
    const start = code.indexOf('function decide(');
    const end = code.indexOf('\nfunction ', start + 1);
    const inDecide = code.slice(start, end);
    assert.ok(humanWrite.test(inDecide), "the single by:'human' must live inside decide()");
    assert.ok(/UserPromptSubmit/.test(code) && !/PreToolUse|tool_name/.test(code), 'the mode hook serves UserPromptSubmit only; no tool reaches decide()');
    const manifest = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8')).hooks;
    for (const [event, groups] of Object.entries(manifest)) for (const g of groups) for (const h of g.hooks) {
      if (h.command.includes('devanity-mode.js')) assert.equal(event, 'UserPromptSubmit', 'devanity-mode.js may only be wired to UserPromptSubmit');
    }
  });

  test('env readable by the agent cannot unblock a high-risk path or lift an autonomous session past commit', async () => {
    const d = repo();
    const env = baseEnv({ DEVANITY_AUTHORITY: 'deploy', DEVANITY_AUTONOMOUS: '1' });
    assertBlocked(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d, env }), 'D-billing');
    assertBlocked(await run(GUARD, { input: bash(d, 'git push --force'), cwd: d, env }), 'needs authority: merge');
    assert.equal(lastAuthority(d).have, 'commit');
    // authority never substitutes for a human decision on a path
    assertBlocked(await run(GUARD, { input: edit(d, 'billing/x.py'), cwd: d, env: baseEnv({ DEVANITY_AUTHORITY: 'deploy' }) }), 'D-billing');
  });
});
