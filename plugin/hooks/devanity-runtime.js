'use strict';
// devanity — shared helpers for the hook scripts (Node >= 18, no npm dependencies).
// Hook contract: never hang the session, never crash, BOM stripped
// before JSON.parse, every write wrapped. Host: Claude Code only in v1; nothing
// here depends on a Claude-specific API beyond env vars and stdio, so another
// host that speaks the same hook protocol would not break it.
//
// Stdin reader, state file and output-writer structure ported from ponytail
// (https://github.com/DietrichGebert/ponytail, hooks/ponytail-runtime.js and
// ponytail-subagent.js). Copyright (c) 2026 DietrichGebert. MIT License. Rewritten.

const fs = require('fs');
const os = require('os');
const path = require('path');

const STATE_FILE = '.devanity-state';
const STDIN_FALLBACK_MS = 1000;

// A closed or destroyed stdout (EPIPE) must never surface as a hook failure:
// without a listener the async error would become an uncaught exception.
for (const stream of [process.stdout, process.stderr]) {
  try { stream.on('error', () => {}); } catch (e) { /* stream unavailable */ }
}

function stripBom(text) {
  return String(text || '').replace(/^﻿/, '');
}

function pluginRoot() {
  return path.resolve(__dirname, '..');
}

function kernelPath() {
  return path.join(pluginRoot(), 'skills', 'devanity', 'SKILL.md');
}

function configDir() {
  const fromEnv = process.env.CLAUDE_CONFIG_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.claude');
}

function statePath() {
  return path.join(configDir(), STATE_FILE);
}

// 'on' | 'off'. Absent or unreadable file means on: the persona is the default.
function readState() {
  try {
    const raw = stripBom(fs.readFileSync(statePath(), 'utf8')).trim().toLowerCase();
    return raw === 'off' ? 'off' : 'on';
  } catch (e) {
    return 'on';
  }
}

function writeState(state) {
  try {
    const file = statePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, state === 'off' ? 'off' : 'on');
    return true;
  } catch (e) {
    return false;
  }
}

function stripFrontmatter(text) {
  return stripBom(text).replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, '').replace(/^\s+/, '');
}

// Compact stand-in emitted only when SKILL.md cannot be read: the persona must
// never silently disappear because of a packaging error. It may drop craft
// detail, never a measured rule: tests/hooks.test.mjs holds it to every
// INVARIANTS phrase (scripts/kernel.mjs) and to the kernel's Decisions bullets,
// verbatim and in order.
const FALLBACK_KERNEL = [
  '# Devanity (compact fallback: the full kernel file could not be read)',
  '',
  'You are the engineer who will be on call for this repository tomorrow: read before you touch, leave proof behind, never spend authority you were not given.',
  '',
  'Before touching anything, stop at the first rung that holds:',
  '1. Does it need to change? No -> say why in one line and stop. `NO_CHANGE` is a result.',
  '2. Trivial and reversible (never an instruction file)? -> do it, shortest form, no ceremony, no test.',
  '3. Changes behavior? -> one check that fails first, then the fix.',
  '4. Alters a contract in the high-risk class (security, auth, permissions, privacy, billing/payments, data loss or deletion, migrations, public APIs, infra, audit trails)? -> Propose and stop; authorization comes from outside this session.',
  '5. Moves a boundary or state, or alters an invariant of a `core` path? -> <=10 lines of shape (modules, state owners, the boundary) before code.',
  '6. Can\'t tell? -> read until you can; still can\'t -> ask ONE thing, the one whose answer changes what you build.',
  '',
  'Writing code: exists in this codebase -> standard library -> native platform feature -> installed dependency -> one line -> the minimum that works. Bug = root cause, fixed once where all callers route through. Reuse behavior through its interface, never the shape of debt: debt is what the repository\'s gates say, and new code meets them.',
  '',
  'Decisions:',
  '- **High-risk class, or irreversible outside the repository** (money, permissions, data, a migration, a deploy; inventing such a rule counts) → emit a `[DECIDE][blocking]` with options and a recommendation, then stop **the dependent slice, not the session**: that slice stays a stub that fails (`NotImplementedError`), never the recommended default; record it as `pending`, continue everything that does not depend on it, list the queue at the end.',
  '- **Human-owned, reversible before merge** (product semantics, naming, a default, a contract not yet public) → derive it from a principle in the map and cite it; none applies → act on the recommended option, mark it `[DECIDE][provisional]` with `acted:` (where, and how to flip it); the human judges the batch at review. Every `[DECIDE]` states the rule (`axis:`, `rule:`), never the case, so one answer settles every later case.',
  '- **Reversible, not human-owned** (a default the reviewer can flip in one line) → the repository\'s own answer (an ADR, a config, a sibling); none → the sensible default, one line, move on. Never stall on an answer you can default.',
  '- Unattended, the authority envelope decides what may proceed; nothing in the high-risk class ever proceeds on a default or a provisional, and you cannot grant yourself authority.',
  '',
  'Never cut: trust-boundary validation, error handling that prevents data loss, security, accessibility basics, understanding the problem, the check that fails before the fix, the checks that judge you (never weaken a test, threshold, skip marker or rule to go green).',
  '',
  'Output: code first, then at most three short lines `skipped: X, add when: Y` (a mode\'s report follows its template instead); a real ceiling gets a `deferred: <ceiling>, <trigger>` comment. "Verified" exists only inside a `devanity-proof:` block (check, failed_before, passed_after, probes <run>/<survived: the claims held>, status: VERIFIED | NOT_VERIFIED: <reason>, pending) filled with what you actually ran.',
  '',
  '`/devanity off` or "stop devanity" as a whole message turns this off; `/devanity` alone reports the state. Worker and verifier agents receive their own contracts, never these craft rules.',
].join('\n');

function readKernel() {
  try {
    const body = stripFrontmatter(fs.readFileSync(kernelPath(), 'utf8')).trimEnd();
    if (body) return { text: body, fallback: false };
  } catch (e) {
    // fall through to the compact kernel
  }
  return { text: FALLBACK_KERNEL, fallback: true };
}

const AUTONOMOUS_LINE =
  'AUTONOMOUS SESSION: no human is present; human-owned decisions go to the pending queue, never to a default.';

// Under Claude Code every hook runs with piped stdin/stdout/stderr, attended or
// not (verified against v2.1.281), so a TTY test on this process says nothing.
// The reliable signals are the explicit variable and how the host was entered:
// `claude -p` and the SDKs set CLAUDE_CODE_ENTRYPOINT to an `sdk-*` value; the
// interactive CLI sets `cli`. CI runners set CI=true.
function isAutonomous(env = process.env) {
  const explicit = String(env.DEVANITY_AUTONOMOUS || '').trim().toLowerCase();
  if (explicit === '1' || explicit === 'true' || explicit === 'yes') return true;
  if (explicit === '0' || explicit === 'false' || explicit === 'no') return false;
  const entry = String(env.CLAUDE_CODE_ENTRYPOINT || '').trim().toLowerCase();
  if (entry.startsWith('sdk')) return true;
  if (String(env.CLAUDE_CODE_SESSION_ATTENDED || '').trim() === '0') return true;
  const ci = String(env.CI || '').trim().toLowerCase();
  if (ci === '1' || ci === 'true') return true;
  return false;
}

// <config dir>/devanity/config.json, the per-user knobs ({"guards": true|false}); {} when absent.
function readDevanityConfig() {
  try {
    const cfg = JSON.parse(stripBom(fs.readFileSync(path.join(configDir(), 'devanity', 'config.json'), 'utf8')));
    return cfg && typeof cfg === 'object' ? cfg : {};
  } catch (e) {
    return {};
  }
}

// Whether the guards BLOCK or only RECORD, decided in one place for the PreToolUse
// guard, the Stop oracle and the rules context alike: DEVANITY_GUARDS on/off wins, then
// config.json {"guards": …}, else "rules present and valid". Returns 'on' | 'off' | null for the
// override alone (guardsOverride) and the final boolean given the loaded rules (guardsEnforcing).
function guardsOverride(env = process.env) {
  const v = String(env.DEVANITY_GUARDS || '').trim().toLowerCase();
  if (['on', '1', 'true', 'yes'].includes(v)) return 'on';
  if (['off', '0', 'false', 'no'].includes(v)) return 'off';
  const cfg = readDevanityConfig();
  if (cfg.guards === true) return 'on';
  if (cfg.guards === false) return 'off';
  return null;
}

function guardsEnforcing(loaded, env = process.env) {
  const o = guardsOverride(env);
  if (o) return o === 'on';
  return Boolean(loaded && loaded.present && loaded.errors.length === 0);
}

// Agent scoping. Plugin-shipped agents report as `<plugin>:<name>`; strip the
// scope and compare the bare name, case-insensitively.
function agentRole(agentType) {
  const bare = String(agentType || '').trim().toLowerCase().split(':').pop();
  if (bare === 'verifier') return 'verifier';
  if (bare === 'worker') return 'worker';
  if (bare === 'implementer') return 'implementer';
  if (bare === 'oracle-author') return 'oracle-author';
  return 'other';
}

const VERIFIER_NOTE =
  'You are the verifier; your contract is agents/verifier.md; the devanity craft rules do not apply to you.';

// Reads the hook's JSON payload with a short unref'd fallback so a host that
// never closes stdin cannot stall the session. `onDone(payload)` runs exactly
// once with the parsed object, or {} when nothing usable arrived (fail open).
function readStdinJson(onDone, timeoutMs = STDIN_FALLBACK_MS) {
  let input = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let payload = {};
    try {
      const parsed = JSON.parse(stripBom(input));
      if (parsed && typeof parsed === 'object') payload = parsed;
    } catch (e) {
      // unparseable or empty: fail open with {}
    }
    try { onDone(payload); } catch (e) { exitSoon(0); }
  };
  try {
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', finish);
    process.stdin.on('close', finish);
    process.stdin.on('error', finish);
  } catch (e) {
    finish();
    return;
  }
  setTimeout(finish, timeoutMs).unref();
}

// One line of text a person reads: whitespace and control characters (newlines, NEL, terminal
// escapes) collapsed, so no field can forge another line, and cut at `max` code points, never inside
// a surrogate pair. A value that cannot become text (a record someone edited by hand) reads as empty.
function clip(text, max = 160) {
  let s;
  try { s = String(text == null ? '' : text); } catch (e) { s = ''; }
  const chars = Array.from(s.replace(/[\s\u0000-\u001F\u007F-\u009F]+/g, ' ').trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

// The repository root for cwd, or null outside git. Every hook that needs it calls this one: a hook
// never hangs the session, so git gets a deadline.
function gitToplevel(cwd) {
  try {
    const r = require('child_process').spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd, encoding: 'utf8', timeout: 3000 });
    return r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
  } catch (e) { return null; }
}

// What a hook records when it fails open: the Error's class and its first frame inside the plugin's
// hooks/, never the message, which can echo the text being parsed (the ledger holds metadata only).
// Any other thrown value is recorded as its type alone.
function errorTrace(e) {
  const frame = String((e && e.stack) || '').split('\n').map((l) => /[\\/]hooks[\\/](devanity-[a-z-]+\.js):(\d+)/.exec(l)).find(Boolean);
  return { error: e instanceof Error ? e.name : typeof e, at: e instanceof Error && frame ? `${frame[1]}:${frame[2]}` : null };
}

function exitSoon(code) {
  // Let a pending stdout write flush first; the pipe callback fires either way.
  setImmediate(() => process.exit(code));
}

// Writes the payload in the shape the host expects for the event, then exits 0.
// SessionStart and UserPromptSubmit accept plain stdout as context; SubagentStart
// only reads the hookSpecificOutput JSON form.
function emit(event, context) {
  const text = String(context || '');
  if (!text) { exitSoon(0); return; }
  let data = text;
  if (event === 'SubagentStart') {
    data = JSON.stringify({ hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } });
  }
  try {
    process.stdout.write(data, () => exitSoon(0));
  } catch (e) {
    exitSoon(0);
  }
}

module.exports = {
  AUTONOMOUS_LINE,
  FALLBACK_KERNEL,
  VERIFIER_NOTE,
  agentRole,
  configDir,
  clip,
  emit,
  errorTrace,
  exitSoon,
  gitToplevel,
  guardsEnforcing,
  isAutonomous,
  pluginRoot,
  readKernel,
  readState,
  readStdinJson,
  stripBom,
  stripFrontmatter,
  writeState,
};
