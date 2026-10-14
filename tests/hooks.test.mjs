// Hook tests for devanity (node:test, no dependencies). Run: node --test tests/*.test.mjs
// Every case spawns the hook as a real child process with a temporary
// CLAUDE_CONFIG_DIR, the way the host runs it.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { INVARIANTS } from '../scripts/kernel.mjs';

const { FALLBACK_KERNEL } = createRequire(import.meta.url)('../plugin/hooks/devanity-runtime.js');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hooksDir = join(root, 'plugin', 'hooks');
const INJECT = join(hooksDir, 'devanity-inject.js');
const MODE = join(hooksDir, 'devanity-mode.js');
const KERNEL_MARK = 'on call for this repository';
const AUTONOMOUS_MARK = 'AUTONOMOUS SESSION:';

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-hooks-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });

let counter = 0;
function freshConfigDir(name = 'cfg') {
  const dir = join(temp, `${name}-${++counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// The suite itself may run under `claude -p` or CI, where the host's own
// signals would mark every session autonomous; start from a clean slate.
function baseEnv(configDir) {
  const env = { ...process.env };
  for (const k of ['DEVANITY_AUTONOMOUS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ATTENDED', 'CI', 'CLAUDE_CONFIG_DIR']) {
    delete env[k];
  }
  env.HOME = temp;
  env.USERPROFILE = temp;
  env.CLAUDE_CONFIG_DIR = configDir;
  return env;
}

// Spawns a hook. `input` null = stdin never opened; `holdStdin` = data written
// but EOF never sent; `destroyStdout` = the read end closed before the hook writes.
function runHook(script, { input = '', env, args = [], cwd, holdStdin = false, destroyStdout = false, timeoutMs = 4000 } = {}) {
  return new Promise((resolvePromise) => {
    const started = Date.now();
    const child = spawn(process.execPath, [script, ...args], {
      env,
      cwd: cwd || temp,
      stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (destroyStdout) child.stdout.destroy();
    else child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    const killer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(killer);
      resolvePromise({ code, signal, stdout, stderr, ms: Date.now() - started });
    });
    if (input !== null) {
      child.stdin.on('error', () => {});
      if (input) child.stdin.write(input);
      if (!holdStdin) child.stdin.end();
    }
  });
}

const payload = (obj) => JSON.stringify(obj);
const sessionStart = (extra = {}) => payload({ hook_event_name: 'SessionStart', source: 'startup', ...extra });
const subagent = (agent_type) => payload({ hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type });
const prompt = (text) => payload({ hook_event_name: 'UserPromptSubmit', prompt: text });
const readState = (dir) => (existsSync(join(dir, '.devanity-state')) ? readFileSync(join(dir, '.devanity-state'), 'utf8') : null);

function parseSubagent(stdout) {
  const out = JSON.parse(stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SubagentStart');
  assert.equal(typeof out.hookSpecificOutput.additionalContext, 'string');
  return out.hookSpecificOutput.additionalContext;
}

describe('SessionStart', () => {
  test('emits the kernel as plain stdout, frontmatter stripped', async () => {
    const cfg = freshConfigDir();
    const r = await runHook(INJECT, { input: sessionStart(), env: baseEnv(cfg), args: ['SessionStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(KERNEL_MARK), 'kernel body missing');
    assert.ok(r.stdout.startsWith('# Devanity'), `stdout must start with the kernel heading, got: ${r.stdout.slice(0, 40)}`);
    assert.ok(!/^---/m.test(r.stdout.slice(0, 5)) && !r.stdout.includes('license: CC-BY-NC-4.0'), 'frontmatter leaked');
    assert.ok(!r.stdout.includes(AUTONOMOUS_MARK), 'autonomous line must not appear in an attended session');
    assert.ok(r.stdout.length <= 10000, 'plain stdout is capped at 10,000 chars by the host');
  });

  test('emits nothing, to the session or a subagent, when the state is off', async () => {
    const cfg = freshConfigDir();
    writeFileSync(join(cfg, '.devanity-state'), 'off');
    for (const [input, args] of [[sessionStart(), ['SessionStart']], [subagent('Explore'), []]]) {
      const r = await runHook(INJECT, { input, env: baseEnv(cfg), args });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
    }
  });

  test('resolves the kernel relative to the hook file, not the cwd', async () => {
    const cfg = freshConfigDir();
    const elsewhere = join(temp, 'elsewhere');
    mkdirSync(elsewhere, { recursive: true });
    const r = await runHook(INJECT, { input: sessionStart(), env: baseEnv(cfg), args: ['SessionStart'], cwd: elsewhere });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes(KERNEL_MARK));
  });

  test('falls back to the compact kernel when SKILL.md is unreadable', async () => {
    const cfg = freshConfigDir();
    const stray = join(temp, 'stray-plugin');
    cpSync(hooksDir, join(stray, 'hooks'), { recursive: true });
    const r = await runHook(join(stray, 'hooks', 'devanity-inject.js'), { input: sessionStart(), env: baseEnv(cfg), args: ['SessionStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.includes('fallback'), 'fallback must say it is one');
    assert.ok(r.stdout.includes(FALLBACK_KERNEL), 'the hook must emit the whole compact kernel');
    assert.ok(FALLBACK_KERNEL.split('\n').length <= 25, 'fallback must stay within 25 lines');
  });

  // The fallback is the kernel a packaging error leaves the model with, so it may lose craft
  // detail but never a measured rule: every kernel invariant, and the Decisions bullets verbatim,
  // in the kernel's order (human-owned before reversible: the reversed order is the one that let
  // a billing rule be defaulted in the 2026-09-24 round).
  test('the compact fallback carries every kernel invariant and the kernel\'s Decisions verbatim, in order', () => {
    for (const phrase of INVARIANTS) assert.ok(FALLBACK_KERNEL.includes(phrase), `fallback lacks invariant "${phrase}"`);
    const kernel = readFileSync(join(root, 'plugin', 'skills', 'devanity', 'SKILL.md'), 'utf8');
    const decisions = kernel.split('## Decisions')[1].split('\n## ')[0].split('\n').filter((l) => l.startsWith('- '));
    assert.ok(decisions.length >= 3, 'kernel Decisions section not found');
    let at = -1;
    for (const bullet of decisions) {
      const i = FALLBACK_KERNEL.indexOf(bullet);
      assert.ok(i >= 0, `fallback lacks the kernel Decisions bullet: ${bullet.slice(0, 60)}…`);
      assert.ok(i > at, `fallback reorders the kernel Decisions: ${bullet.slice(0, 60)}…`);
      at = i;
    }
  });
});

describe('SubagentStart', () => {
  test('verifier gets the one-line note, never the kernel', async () => {
    const cfg = freshConfigDir();
    for (const type of ['verifier', 'devanity:verifier', 'Verifier']) {
      const r = await runHook(INJECT, { input: subagent(type), env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      const ctx = parseSubagent(r.stdout);
      assert.ok(ctx.includes('agents/verifier.md'), `verifier note missing for ${type}`);
      assert.ok(!ctx.includes(KERNEL_MARK), `kernel leaked to ${type}`);
      assert.equal(ctx.split('\n').length, 1, 'the verifier note is one line');
    }
  });

  test('worker gets nothing', async () => {
    const cfg = freshConfigDir();
    for (const type of ['worker', 'devanity:worker']) {
      const r = await runHook(INJECT, { input: subagent(type), env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '', `worker (${type}) must receive nothing`);
    }
  });

  test('any other agent gets the kernel in hookSpecificOutput form', async () => {
    const cfg = freshConfigDir();
    for (const type of ['Explore', 'general-purpose', 'Plan', 'my-plugin:reviewer']) {
      const r = await runHook(INJECT, { input: subagent(type), env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.trim().startsWith('{') && r.stdout.trim().endsWith('}'), 'SubagentStart output must be one JSON object');
      assert.ok(parseSubagent(r.stdout).includes(KERNEL_MARK), `kernel missing for ${type}`);
    }
  });

  test('missing or unparseable agent_type fails open to the kernel', async () => {
    const cfg = freshConfigDir();
    for (const input of [payload({ hook_event_name: 'SubagentStart' }), 'not json at all', '']) {
      const r = await runHook(INJECT, { input, env: baseEnv(cfg), args: ['SubagentStart'] });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(parseSubagent(r.stdout).includes(KERNEL_MARK));
    }
  });

  test('no stdin at all: exits within 2s and emits the kernel', async () => {
    const cfg = freshConfigDir();
    const r = await runHook(INJECT, { input: null, env: baseEnv(cfg), args: ['SubagentStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    assert.ok(parseSubagent(r.stdout).includes(KERNEL_MARK));
  });

  test('stdin that never sends EOF: exits within 2s with what arrived', async () => {
    const cfg = freshConfigDir();
    const r = await runHook(INJECT, { input: subagent('verifier'), holdStdin: true, env: baseEnv(cfg), args: ['SubagentStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.signal, null, 'the hook had to be killed');
    assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    assert.ok(parseSubagent(r.stdout).includes('agents/verifier.md'));
  });
});

describe('UserPromptSubmit', () => {
  test('the three off phrases switch the state off, whole message only', async () => {
    for (const text of ['/devanity off', 'stop devanity', 'normal mode', 'Stop Devanity.', 'NORMAL MODE!', '  /devanity off  ', '/devanity:devanity off']) {
      const cfg = freshConfigDir();
      const r = await runHook(MODE, { input: prompt(text), env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      assert.ok(r.stdout.startsWith('DEVANITY OFF'), `"${text}" -> ${r.stdout.slice(0, 40)}`);
      assert.equal(readState(cfg), 'off', `"${text}" must write off`);
    }
  });

  test('/devanity on switches the state on and re-injects the kernel', async () => {
    const cfg = freshConfigDir();
    writeFileSync(join(cfg, '.devanity-state'), 'off');
    const r = await runHook(MODE, { input: prompt('/devanity on'), env: baseEnv(cfg) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith('DEVANITY ON'), r.stdout.slice(0, 40));
    assert.ok(r.stdout.includes(KERNEL_MARK), 'a session that started off never saw the kernel; on must deliver it');
    assert.equal(readState(cfg), 'on');
  });

  test('bare /devanity reports the state without changing it', async () => {
    const cfg = freshConfigDir();
    let r = await runHook(MODE, { input: prompt('/devanity'), env: baseEnv(cfg) });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^DEVANITY STATE: on/);
    assert.equal(readState(cfg), null, 'a report must not create the state file');
    writeFileSync(join(cfg, '.devanity-state'), 'off');
    r = await runHook(MODE, { input: prompt('/devanity'), env: baseEnv(cfg) });
    assert.match(r.stdout, /^DEVANITY STATE: off/);
    assert.equal(readState(cfg), 'off');
  });

  test('a prompt that merely contains a phrase does not trigger', async () => {
    const cfg = freshConfigDir();
    for (const text of ['add a normal mode toggle next to dark mode', 'please stop devanity from nagging', 'run /devanity off later', '/devanity plan the migration', 'write a function']) {
      const r = await runHook(MODE, { input: prompt(text), env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '', `"${text}" must produce no output`);
      assert.equal(readState(cfg), null, `"${text}" must not touch the state`);
    }
  });

  test('BOM-prefixed stdin parses', async () => {
    const cfg = freshConfigDir();
    const r = await runHook(MODE, { input: '﻿' + prompt('/devanity off'), env: baseEnv(cfg) });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith('DEVANITY OFF'));
    assert.equal(readState(cfg), 'off');
  });

  test('empty, unparseable or EOF-less stdin stays silent and exits within 2s', async () => {
    const cfg = freshConfigDir();
    for (const opts of [{ input: '' }, { input: '{broken' }, { input: null }, { input: prompt('write code'), holdStdin: true }]) {
      const r = await runHook(MODE, { ...opts, env: baseEnv(cfg) });
      assert.equal(r.code, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.ok(r.ms < 2000, `took ${r.ms}ms`);
    }
  });
});

describe('never crash', () => {
  test('stdout closed early does not produce a non-zero exit', async () => {
    const cfg = freshConfigDir();
    const cases = [
      [INJECT, { input: sessionStart(), args: ['SessionStart'] }],
      [INJECT, { input: subagent('Explore') }],
      [MODE, { input: prompt('/devanity off') }],
    ];
    for (const [script, opts] of cases) {
      const r = await runHook(script, { ...opts, env: baseEnv(cfg), destroyStdout: true });
      assert.equal(r.code, 0, `${script} exited ${r.code} (${r.signal}): ${r.stderr}`);
      assert.equal(r.signal, null);
    }
  });
});

describe('autonomous session', () => {
  test('DEVANITY_AUTONOMOUS=1 prepends the autonomous line to the kernel', async () => {
    const cfg = freshConfigDir();
    const env = { ...baseEnv(cfg), DEVANITY_AUTONOMOUS: '1' };
    let r = await runHook(INJECT, { input: sessionStart(), env, args: ['SessionStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith(AUTONOMOUS_MARK), r.stdout.slice(0, 60));
    assert.ok(r.stdout.includes('pending queue') && r.stdout.includes(KERNEL_MARK));
    r = await runHook(INJECT, { input: subagent('Explore'), env });
    assert.ok(parseSubagent(r.stdout).startsWith(AUTONOMOUS_MARK), 'subagents inherit the autonomous line');
    r = await runHook(INJECT, { input: subagent('verifier'), env });
    assert.ok(!parseSubagent(r.stdout).includes(AUTONOMOUS_MARK), 'the verifier note stays one line');
  });

  test('a non-interactive host entrypoint counts as autonomous; DEVANITY_AUTONOMOUS=0 overrides it', async () => {
    const cfg = freshConfigDir();
    let r = await runHook(INJECT, { input: sessionStart(), env: { ...baseEnv(cfg), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli' }, args: ['SessionStart'] });
    assert.ok(r.stdout.startsWith(AUTONOMOUS_MARK), 'sdk-cli entrypoint (claude -p) must be autonomous');
    r = await runHook(INJECT, { input: sessionStart(), env: { ...baseEnv(cfg), CLAUDE_CODE_ENTRYPOINT: 'cli' }, args: ['SessionStart'] });
    assert.ok(!r.stdout.includes(AUTONOMOUS_MARK), 'the interactive cli must not be autonomous');
    r = await runHook(INJECT, { input: sessionStart(), env: { ...baseEnv(cfg), CLAUDE_CODE_ENTRYPOINT: 'sdk-cli', DEVANITY_AUTONOMOUS: '0' }, args: ['SessionStart'] });
    assert.ok(!r.stdout.includes(AUTONOMOUS_MARK), 'the explicit variable wins');
  });
});

describe('manifests', () => {
  // Commands are `node "<path>" [arg]` and nothing else: PowerShell runs them too, and ponytail broke
  // there on `exec` and shell metacharacters (their #527/#569). Verified by construction; this suite
  // has not run on Windows.
  test('hooks.json wires the events to existing scripts, shell-neutrally, with a timeout and status message', () => {
    const cfg = JSON.parse(readFileSync(join(hooksDir, 'hooks.json'), 'utf8')).hooks;
    assert.deepEqual(Object.keys(cfg).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop', 'UserPromptSubmit']);
    assert.equal(cfg.PreToolUse[0].matcher, 'Edit|Write|MultiEdit|NotebookEdit|Bash');
    for (const s of ['startup', 'resume', 'clear', 'compact']) assert.ok(cfg.SessionStart[0].matcher.split('|').includes(s), `SessionStart matcher lacks ${s}`);
    for (const [event, groups] of Object.entries(cfg)) {
      for (const group of groups) for (const h of group.hooks) {
        assert.equal(h.type, 'command', event);
        // Injection hooks answer in milliseconds; the Stop oracle runs the declared check twice
        // within its own 120 s budget (DEVANITY_ORACLE_TIMEOUT_MS), so its host timeout must exceed it.
        if (event === 'Stop' || event === 'SubagentStop') assert.ok(h.timeout > 120, `${event} timeout must exceed the oracle budget`);
        else assert.equal(h.timeout, 5, event);
        assert.ok(h.statusMessage, `${event} lacks statusMessage`);
        const m = /^node "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([a-z-]+\.js)"( [A-Za-z]+)?$/.exec(h.command);
        assert.ok(m, `${event} command is not node "\${CLAUDE_PLUGIN_ROOT}/hooks/<script>.js" [arg]: ${h.command}`);
        assert.ok(existsSync(join(hooksDir, m[1])), `${m[1]} does not exist`);
      }
    }
  });

  test('CRLF line endings in the kernel file and the state file are handled', async () => {
    const cfg = freshConfigDir();
    const crlf = join(temp, 'crlf-plugin');
    cpSync(hooksDir, join(crlf, 'hooks'), { recursive: true });
    mkdirSync(join(crlf, 'skills', 'devanity'), { recursive: true });
    const kernel = readFileSync(join(root, 'plugin', 'skills', 'devanity', 'SKILL.md'), 'utf8').replace(/\r?\n/g, '\r\n');
    writeFileSync(join(crlf, 'skills', 'devanity', 'SKILL.md'), kernel);
    let r = await runHook(join(crlf, 'hooks', 'devanity-inject.js'), { input: sessionStart(), env: baseEnv(cfg), args: ['SessionStart'] });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(r.stdout.startsWith('# Devanity'), 'CRLF frontmatter must be stripped');
    assert.ok(!r.stdout.includes('fallback'), 'a CRLF kernel is a valid kernel, not a fallback case');
    writeFileSync(join(cfg, '.devanity-state'), 'off\r\n');
    r = await runHook(join(crlf, 'hooks', 'devanity-inject.js'), { input: sessionStart(), env: baseEnv(cfg), args: ['SessionStart'] });
    assert.equal(r.stdout, '', 'a CRLF-terminated "off" is still off');
  });

  test('plugin.json names devanity, carries the kernel version and points at hooks.json', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8'));
    const kernel = readFileSync(join(root, 'plugin', 'skills', 'devanity', 'SKILL.md'), 'utf8');
    const version = /^\s*version:\s*(\S+)/m.exec(kernel)[1];
    assert.equal(manifest.name, 'devanity');
    assert.equal(manifest.version, version);
    assert.ok(manifest.description && !/claude|anthropic|openai|cursor|copilot/i.test(manifest.description), 'description: one sentence, no vendor names');
    assert.ok(manifest.author && manifest.author.name);
    assert.equal(manifest.hooks, './hooks/hooks.json');
    assert.ok(existsSync(join(root, 'plugin', manifest.hooks)), 'the manifest resolves hooks from the plugin root');
  });
});
