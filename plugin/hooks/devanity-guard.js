#!/usr/bin/env node
'use strict';
// devanity — PreToolUse guard for Edit, Write, MultiEdit,
// NotebookEdit and Bash.
//
//   (a) a file tool on a `high-risk` path with no human decision covering it in the ledger → block
//   (b) a Bash command that writes into such a path (redirect, tee, sed -i, mv, cp, rm, git
//       checkout --, git restore, truncate, dd of=, install) → same rule; read over what the shell
//       runs (rules.shellCommands), still a heuristic: a floor, the reference CI job is the ceiling
//   (c) a Bash command that needs more authority than the session holds → block
//
// Blocking form (Claude Code hooks reference, checked 2026-09-24 against 2.1.281): exit 2 blocks
// the call and stderr is shown to the model; a JSON `permissionDecision: "deny"` on stdout carries
// the same reason in structured form. Both are emitted: exit 2 blocks whether or not the JSON is
// parsed, and the JSON reason is what the host prefers when it is. A block is never silent.
//
// Enforcement: blocks only when the repository declares valid rules (or
// DEVANITY_GUARDS=on); otherwise the guard evaluates, records `would_block` and allows.
// DEVANITY_GUARDS=off or <config dir>/devanity/config.json {"guards": false} turns blocking off.
// Fail open by design: no payload, no git, invalid rules → allow and record what can be recorded.
//
// No self-grant path: nothing in this file writes a decision with by:'human'.
// The only writer of by:'human' in the whole plugin is the `/devanity decide` handler in
// hooks/devanity-mode.js (UserPromptSubmit). That event is trusted because its `prompt` is the
// text the human typed into the terminal; the model never authors a UserPromptSubmit payload,
// and no tool call reaches that hook. Env vars the agent could read (DEVANITY_AUTHORITY,
// DEVANITY_GUARDS) belong to the host process, not to the agent's Bash, and even so they can
// never raise an autonomous session past `commit` nor unblock a high-risk path. The rules file
// and the ledger itself are protected built-ins (see PROTECTED) so a tool call cannot rewrite them.

const path = require('path');
const fs = require('fs');
const rt = require('./devanity-runtime');
const rules = require('./devanity-rules');
const ledger = require('./devanity-ledger');

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Paths no rules file can demote: rewriting them is how an agent would grant itself authority.
const PROTECTED = [
  { glob: rules.FILE, re: rules.globToRegExp(rules.FILE) },
  { glob: '.git/devanity/**', re: rules.globToRegExp('.git/devanity/**') },
];
const DECIDE_HINT = '/devanity decide';

// The authority this session holds. An autonomous session never exceeds `commit`, whatever the
// env says.
function sessionAuthority(loaded, env) {
  const autonomous = rt.isAutonomous(env);
  const fromEnv = String(env.DEVANITY_AUTHORITY || '').trim().toLowerCase();
  let have;
  if (rules.AUTHORITIES.includes(fromEnv)) have = fromEnv;
  else if (autonomous) have = loaded.rules.autonomy.authority;
  else have = loaded.rules.defaults.authority;
  if (autonomous && !rules.AUTONOMY_AUTHORITIES.includes(have)) have = rules.AUTONOMY_AUTHORITIES[rules.AUTONOMY_AUTHORITIES.length - 1];
  return { have, autonomous, source: rules.AUTHORITIES.includes(fromEnv) ? 'DEVANITY_AUTHORITY' : (autonomous ? 'devanity.rules.json#autonomy.authority' : 'devanity.rules.json#defaults.authority') };
}

function ruleWithProtected(loaded, rel) {
  for (const p of PROTECTED) if (p.re.test(rel)) return { tier: 'high-risk', authority: loaded.rules.defaults.authority, glob: p.glob, builtin: true };
  return rules.ruleFor(loaded.rules, rel);
}

// Suggested decision id for a path: D-<first segment without extension>.
function suggestId(rel) {
  const seg = rel.split('/')[0].replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'path';
  return `D-${seg}`;
}

// ---- Bash write detection (heuristic; a floor) ----------------------------

const WRITERS = new Set(['tee', 'mv', 'cp', 'rm', 'truncate', 'install', 'dd', 'sed', 'git']);

function looksLikePath(tok) {
  if (!tok || tok.startsWith('-') || /^[a-z]+:\/\//i.test(tok) || tok === '/dev/null') return false;
  return tok.includes('/') || /\.[A-Za-z0-9]+$/.test(tok);
}

// Repository-relative paths a command may write to, over each simple command the shell runs
// (rules.shellCommands: a heredoc body or a quoted argument is data, a later line or `$( )` runs):
// redirect targets always count; for writer commands, every path-like argument counts (sed only
// with -i; git only for checkout -- / restore; dd only of=; cp, install and mv their destination, and
// mv its sources).
function writtenPaths(command) {
  const out = new Set();
  for (const c of rules.shellCommands(command).commands) {
    c.writes.forEach((t) => out.add(t));
    const toks = c.words.map((w) => w.value);
    const k = c.at;
    const cmd = toks[k];
    if (!WRITERS.has(cmd)) continue;
    const args = toks.slice(k + 1);
    if (cmd === 'sed') {
      if (!args.some((a) => /^-[a-zA-Z]*i|^--in-place/.test(a))) continue;
      // The script (`s/a/b/`) contains slashes: skip it. It follows -e/--expression, or is the
      // first non-flag argument when neither -e nor -f is given.
      const files = [];
      let scriptSeen = args.some((a) => /^-[a-zA-Z]*[ef]|^--(expression|file)/.test(a));
      for (let j = 0; j < args.length; j++) {
        const a = args[j];
        if (/^-[a-zA-Z]*[ef]$|^--(expression|file)$/.test(a)) { j++; continue; }
        if (a.startsWith('-')) continue;
        if (!scriptSeen) { scriptSeen = true; continue; }
        files.push(a);
      }
      files.filter(looksLikePath).forEach((a) => out.add(a));
    } else if (cmd === 'git') {
      const sub = args[0];
      if (sub === 'checkout') { const d = args.indexOf('--'); if (d >= 0) args.slice(d + 1).filter(looksLikePath).forEach((a) => out.add(a)); }
      else if (sub === 'restore') args.slice(1).filter((a) => looksLikePath(a) && !a.startsWith('--source')).forEach((a) => out.add(a));
    } else if (cmd === 'cp' || cmd === 'install' || cmd === 'mv') {
      // the destination is written, and mv also removes its sources. A destination may be a
      // directory, named with or without its `/`: each source by its name in it.
      const { sources, dest } = rules.copyTargets(args);
      if (cmd === 'mv') sources.filter(looksLikePath).forEach((a) => out.add(a));
      if (dest) {
        if (looksLikePath(dest)) out.add(dest);
        if (args.some((a) => a === '-t' || a.startsWith('--target-directory')) || sources.length > 1 || !/\.[A-Za-z0-9]+$/.test(dest)) sources.forEach((src) => out.add(path.posix.join(dest, path.posix.basename(src))));
      }
    } else if (cmd === 'dd') {
      args.filter((a) => a.startsWith('of=')).forEach((a) => out.add(a.slice(3)));
    } else {
      args.filter(looksLikePath).forEach((a) => out.add(a));
    }
  }
  return [...out];
}

// ---- messages ---------------------------------------------------------------------------------

const clip = (text) => rt.clip(text, 160);

const header = (tool, rel, via) => `devanity: blocked ${tool} on ${rel}${via ? ` (via: ${via})` : ''}`;

function pathMessage(tool, rel, rule, via) {
  const id = suggestId(rel);
  const scope = rule.glob || rel;
  return [
    header(tool, rel, via),
    `  rule: ${rule.glob ? `${rule.glob} → tier ${rule.tier}` : `tier ${rule.tier}`}${rule.builtin ? ' (built-in: protects the rules and the ledger)' : ' (devanity.rules.json)'}`,
    // Why the path is guarded, from the map a human wrote: the one who decides sees what is at stake.
    ...(rule.purpose ? [`  what it is: ${clip(rule.purpose)}`] : []),
    ...(Array.isArray(rule.invariants) && rule.invariants.length ? [`  never changes: ${rule.invariants.slice(0, 3).map((v) => clip(rules.invariantText(v))).join('; ')}${rule.invariants.length > 3 ? '; …' : ''}`] : []),
    '  A high-risk path needs a human decision recorded in the ledger before any tool may write to it.',
    `  Next step: Record the human decision with: ${DECIDE_HINT} ${id} <option> --path ${scope}`,
    '  (typed by the human as a whole message; the agent does not record it — propose the change and stop)',
  ].join('\n');
}

function authorityMessage(command, need, auth) {
  // Name the field that can raise this session's authority; an unattended session never reaches
  // merge or deploy, so there it names none.
  const unreachable = auth.autonomous && !rules.AUTONOMY_AUTHORITIES.includes(need);
  const field = auth.autonomous ? 'devanity.rules.json#autonomy.authority' : 'devanity.rules.json#defaults.authority';
  return [
    `devanity: blocked Bash command: ${command}`,
    `  needs authority: ${need}; this session has: ${auth.have} (${auth.source})`,
    unreachable
      ? '  Next step: none in this session — merge and deploy are never available to an autonomous session; a human runs it'
      : `  Next step: raise DEVANITY_AUTHORITY or ${field}`,
    '  (a human does this outside the session; the agent does not raise its own authority)',
  ].join('\n');
}

// A role's write boundary (A1.3): the implementer never writes a test file, the oracle-author
// writes only test files. Who is who comes from the host's agent_type; a human decision on the
// path lifts it, like every other block.
function roleMessage(tool, rel, role, via) {
  const why = role === 'implementer'
    ? 'the implementer never writes a test file; the oracle-author does (plugin/agents/oracle-author.md)'
    : 'the oracle-author writes only test files (devanity.rules.json#tests); the implementer writes the rest';
  return [
    header(tool, rel, via),
    `  role: ${role} (agent_type): ${why}`,
    `  Next step: hand the file to the other role, or record the human decision with: ${DECIDE_HINT} ${suggestId(rel)} <option> --path ${rel}`,
  ].join('\n');
}

// The approved scope (A1.4): once a human decision with a path is tied to the open change, the
// union of those paths and the change's declared scope is the write ceiling. An agent-declared
// scope alone limits nothing: the authority is the human's `decide --path`.
function approvedScope(root) {
  const c = ledger.openContract(root);
  if (!c) return null;
  const granted = ledger.decisions(root).filter((d) => d.status === 'decided' && d.by === 'human' && d.path && d.contract === c.id);
  if (!granted.length) return null;
  const declared = String(c.scope || '').split(/[,\s]+/).filter(Boolean);
  return { contract: c.id, decisions: granted.map((d) => d.id), approved: [...new Set([...granted.map((d) => d.path), ...declared])] };
}
function inApproved(ceiling, rel) {
  return ceiling.approved.some((g) => rules.globToRegExp(g).test(rel) || rel === g || rel.startsWith(g.replace(/\/?$/, '/')));
}
function scopeMessage(tool, rel, ceiling, via) {
  return [
    header(tool, rel, via),
    `  outside the scope approved for change ${ceiling.contract}: ${ceiling.approved.join(', ')} (decision ${ceiling.decisions.join(', ')} and the change's scope)`,
    `  Next step: a human widens it with: ${DECIDE_HINT} S-${suggestId(rel).slice(2)} <option> --path <glob>, or the change closes`,
  ].join('\n');
}

// ---- evaluation -------------------------------------------------------------------------------

// Returns null (allow) or {message, event, pending?}.
function evaluate(payload, env) {
  const tool = String(payload.tool_name || '');
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const cwd = payload.cwd && String(payload.cwd).trim() ? String(payload.cwd) : process.cwd();
  const root = rt.gitToplevel(cwd);
  if (!root) return { allow: true, reason: 'no git' };            // no ledger: record nothing, block nothing
  const loaded = rules.loadRules(root);
  const sid = payload.session_id || null;

  if (loaded.errors.length) {
    const seen = ledger.read(root, 'events').some((e) => e.kind === 'rules_invalid' && e.session_id === sid);
    if (!seen) ledger.append(root, 'events', { kind: 'rules_invalid', errors: loaded.errors }, sid);
    return { allow: true, reason: 'rules invalid' };
  }

  const enforce = rt.guardsEnforcing(loaded, env);   // one decision for guard, oracle and rules context
  const auth = sessionAuthority(loaded, env);
  const role = rt.agentRole(payload.agent_type);
  const ceiling = approvedScope(root);
  const findings = [];

  const checkPath = (target, via) => {
    const rel = rules.relPath(root, path.isAbsolute(target) ? target : path.join(cwd, target));
    if (!rel) return;
    if (ledger.humanDecisionFor(root, rel, rules.globToRegExp)) return;   // a human decision on the path lifts every block below
    const queued = { id: suggestId(rel), path: rel, kind: 'human', status: 'pending', by: 'agent', scope: rel };
    const isTest = rules.isTestPath(loaded.rules, rel);
    if ((role === 'implementer' && isTest) || (role === 'oracle-author' && !isTest)) {
      findings.push({ message: roleMessage(tool, rel, role, via), event: { tool, path: rel, role }, pending: queued });
    }
    if (ceiling && !inApproved(ceiling, rel)) {
      findings.push({ message: scopeMessage(tool, rel, ceiling, via), event: { tool, path: rel, scope: { contract: ceiling.contract, approved: ceiling.approved } }, pending: queued });
    }
    const rule = ruleWithProtected(loaded, rel);
    if (rule.tier !== 'high-risk') return;
    findings.push({
      message: pathMessage(tool, rel, rule, via),
      event: { tool, path: rel, rule: { glob: rule.glob, tier: rule.tier } },
      pending: { id: suggestId(rel), path: rel, kind: 'human', status: 'pending', by: 'agent', scope: rule.glob || rel },
    });
  };

  if (FILE_TOOLS.has(tool)) {
    const target = input.file_path || input.notebook_path;
    if (target) checkPath(String(target));
  } else if (tool === 'Bash') {
    const command = String(input.command || '');
    // one guarded path blocks the command: past 50 found, the rest are only counted
    let more = 0;
    for (const p of writtenPaths(command)) { if (findings.length >= 50) more++; else checkPath(p, command.slice(0, 120)); }
    if (more) findings[findings.length - 1].message += `\n  (and ${more} more path(s) in this command not checked one by one)`;
    const need = rules.commandAuthority(loaded.rules, command);
    if (need && rules.authorityRank(need) > rules.authorityRank(auth.have)) {
      findings.push({ message: authorityMessage(command, need, auth), event: { tool, command, authority: { need, have: auth.have } } });
    }
  }
  if (!findings.length) return { allow: true };

  for (const f of findings) {
    ledger.append(root, 'events', { kind: enforce ? 'blocked' : 'would_block', ...f.event }, sid);
    // Autonomy envelope: a blocked high-risk edit joins the pending queue so
    // the end-of-session summary can list it. `by: agent` marks who queued it; it authorizes nothing.
    if (enforce && auth.autonomous && f.pending) {
      const all = ledger.decisions(root);
      const exists = all.some((d) => d.status === 'pending' && (d.path === f.pending.path || d.id === f.pending.id));
      // Never append over an answered id: a later pending record with the same id would become the
      // latest and silently revoke the human's decision (latest per id wins).
      let id = f.pending.id;
      for (let k = 2; all.some((d) => d.id === id && (d.status !== 'pending' || d.path !== f.pending.path)); k++) id = `${f.pending.id}-${k}`;
      if (!exists) ledger.append(root, 'decisions', { ...f.pending, id }, sid);
    }
  }
  if (!enforce) return { allow: true, reason: 'not enforcing' };
  return { allow: false, message: findings.map((f) => f.message).join('\n\n') };
}

function block(message) {
  const json = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: message } });
  try { process.stderr.write(message + '\n'); } catch (e) { /* closed */ }
  try { process.stdout.write(json, () => rt.exitSoon(2)); } catch (e) { rt.exitSoon(2); }
}

function main() {
  rt.readStdinJson((payload) => {
    if (!payload.tool_name) {
      // A guard that cannot read its payload cannot know the path. Failing closed here would
      // block every tool call whenever the host hiccups; fail open and leave a trace instead.
      ledger.append(process.cwd(), 'events', { kind: 'guard_payload_missing' }, payload.session_id || null);
      rt.exitSoon(0);
      return;
    }
    let verdict;
    try { verdict = evaluate(payload, process.env); } catch (e) {
      // Fail open, as with an unreadable payload, and leave the same kind of trace.
      ledger.append(payload.cwd || process.cwd(), 'events', { kind: 'guard_error', ...rt.errorTrace(e) }, payload.session_id || null);
      verdict = { allow: true, reason: 'guard error' };
    }
    if (verdict.allow) rt.exitSoon(0);
    else block(verdict.message);
  });
}

if (require.main === module) {
  try { main(); } catch (e) { rt.exitSoon(0); }
}

