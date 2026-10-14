#!/usr/bin/env node
'use strict';
// devanity — SessionStart and SubagentStart hook: injects the static kernel.
//
// SessionStart context never reaches subagents, so the same script serves both
// events and reads `hook_event_name` from the payload to pick the output shape.
// Scoping: agent_type verifier -> one-line note (its contract is
// agents/verifier.md); worker -> nothing; anything else, or an unknown/missing
// agent_type -> the kernel. State `off` -> nothing. Any read error -> the
// compact fallback kernel, never silence.
//
// After the kernel: the repository rules and, when the ledger holds an
// open change, its phase summary; the verifier's note then names the
// change to falsify. Everything stays under the host's 10,000-char stdout cap.
//
// Fail-open scoping and the never-block stdin path follow ponytail's
// hooks/ponytail-subagent.js (https://github.com/DietrichGebert/ponytail,
// (c) 2026 DietrichGebert, MIT License), rewritten for this contract.

const rt = require('./devanity-runtime');
const rulesMod = require('./devanity-rules');
const ledger = require('./devanity-ledger');

// The repository's own rules, compacted for the model.
// Only when devanity.rules.json is present and valid; hard cap of ~200 tokens.
const RULES_CONTEXT_MAX_CHARS = 1600;   // the map, ~400 tokens
// The open change (ledger contract not DONE/ABANDONED, declared within 24 h), ~120 tokens.
const CHANGE_CONTEXT_MAX_CHARS = 480;
const CHANGE_FIELD_MAX_CHARS = 60;
// The host caps plain SessionStart stdout at 10,000 chars; below this budget every section fits.
const OUTPUT_BUDGET_CHARS = 9500;

// The repository root for cwd (a session may start in a subdirectory), else cwd itself.
function repoRoot(cwd) {
  return rt.gitToplevel(cwd) || cwd;
}

function rulesContext(cwd) {
  const loaded = rulesMod.loadRules(repoRoot(cwd));
  if (!loaded.present || loaded.errors.length) return '';
  const r = loaded.rules;
  // The map: one line per path that has something to say (a purpose, invariants, the
  // high-risk tier, or core), so the agent knows where it is before it opens a file. The fixed lines
  // come first; entries are added whole while they fit, and the rest is named, never cut mid-line.
  const entry = (p) => {
    const parts = [p.rule.purpose, p.rule.invariants && p.rule.invariants.length ? `invariants: ${p.rule.invariants.map(rulesMod.invariantText).join('; ')}` : '', p.rule.check ? `check: ${p.rule.check}` : ''].filter(Boolean);
    return `- \`${p.glob}\` ${p.rule.tier || r.defaults.tier}${p.rule.core ? ' core' : ''}${parts.length ? `: ${parts.join('; ')}` : ''}`;
  };
  const rank = (p) => (p.rule.tier === 'high-risk' ? 2 : 0) + (p.rule.core ? 1 : 0);   // high-risk, then core: the entries never to miss
  const mapped = r.paths.filter((p) => rank(p) || p.rule.purpose || (p.rule.invariants && p.rule.invariants.length))
    .sort((x, y) => rank(y) - rank(x));
  const lines = [
    '## Repository rules (devanity.rules.json)',
    `Autonomy envelope: authority ${r.autonomy.authority}; high-risk ${r.autonomy['high-risk']}; irreversible ${r.autonomy.irreversible}`,
    `Guards: ${rt.guardsEnforcing(loaded) ? 'enforcing' : 'recording'}`,
    mapped.length ? 'Map (high-risk: rung 4, propose and stop; core: rung 5, its invariants survive pivots):' : 'Map: no path declares a purpose, invariants, core or the high-risk tier',
  ];
  let used = lines.join('\n').length;
  for (let k = 0; k < mapped.length; k++) {
    const line = entry(mapped[k]);
    const rest = mapped.length - k - 1;
    const tail = rest ? `\n… ${rest} more path(s) in devanity.rules.json`.length : 0;
    if (used + 1 + line.length + tail > RULES_CONTEXT_MAX_CHARS) { lines.push(`… ${mapped.length - k} more path(s) in devanity.rules.json`); break; }
    lines.push(line); used += 1 + line.length;
  }
  const text = lines.join('\n');
  return text.length > RULES_CONTEXT_MAX_CHARS ? text.slice(0, RULES_CONTEXT_MAX_CHARS - 1) + '…' : text;
}

// One ledger field on one line, clipped: a hand-edited ledger must not break the section shape.
const clip = (v, max = CHANGE_FIELD_MAX_CHARS) => rt.clip(v, max);

function phaseLine(c) {
  if (c.phase === 'EXECUTE') return `EXECUTE: implement inside scope; the proof is ${clip(c.proof) || '<undeclared>'}; forbidden: ${clip(c.forbidden) || 'none declared'}.`;
  if (c.phase === 'VERIFY') return `VERIFY: you are verifying, not writing: falsify the claims of ${c.id}.`;
  return `${c.phase}: continue from ${c.phase}.`;
}

// The "Open change" section for SessionStart and non-verifier subagents, or '' without one.
function changeContext(cwd) {
  const c = ledger.openContract(cwd);
  if (!c) return '';
  const lines = [`## Open change ${clip(c.id)}`, `phase: ${c.phase} · pending: ${clip(c.pending) || '0'}`];
  for (const k of ['parent', 'intent', 'scope', 'forbidden', 'proof']) if (c[k]) lines.push(`${k}: ${clip(c[k])}`);
  lines.push(phaseLine(c));
  const text = lines.join('\n');
  return text.length > CHANGE_CONTEXT_MAX_CHARS ? text.slice(0, CHANGE_CONTEXT_MAX_CHARS - 1) + '…' : text;
}

// The queue an unattended session left: its own section, placed before the rules and
// the change, and the last one ever dropped for size.
function queueContext(cwd) {
  const pending = ledger.pendingDecisions(cwd);
  if (!pending.length) return '';
  const named = pending.slice(0, 5).map((d) => `${clip(d.id, 30)} (${clip(d.question, 60) || (typeof d.path === 'string' && clip(d.path, 60)) || 'no path'})`).join(', ');
  return `Pending human decisions (${pending.length}): ${named}${pending.length > 5 ? ', …' : ''}. Record one with /devanity decide <id> <option>.`;
}

// The verifier's note, still one line, naming what to falsify when a change is open.
function verifierNote(cwd) {
  const c = ledger.openContract(cwd);
  if (!c) return rt.VERIFIER_NOTE;
  return `${rt.VERIFIER_NOTE} Open change ${clip(c.id)}: falsify its claims; its proof is ${clip(c.proof) || '<undeclared>'}.`;
}

function contextFor(payload) {
  if (rt.readState() === 'off') return '';
  const role = rt.agentRole(payload.agent_type);
  if (role === 'worker') return '';
  const cwd = typeof payload.cwd === 'string' && payload.cwd ? payload.cwd : process.cwd();
  if (role === 'verifier') {
    try { return verifierNote(cwd); } catch (e) { return rt.VERIFIER_NOTE; }
  }
  const kernel = rt.readKernel().text;
  let rules = '';
  try { rules = rulesContext(cwd); } catch (e) { rules = ''; }
  let change = '';
  try { change = changeContext(cwd); } catch (e) { change = ''; }
  let queue = '';
  try { queue = queueContext(cwd); } catch (e) { queue = ''; }
  const head = rt.isAutonomous() ? rt.AUTONOMOUS_LINE + '\n\n' : '';
  const assemble = (parts) => head + parts.filter(Boolean).join('\n\n');
  // Never exceed the host's cap: drop the change section first, then the rules, and say so.
  const dropped = [];
  let out = assemble([kernel, queue, rules, change]);
  if (out.length > OUTPUT_BUDGET_CHARS && change) { dropped.push('change'); out = assemble([kernel, queue, rules]); }
  if (out.length > OUTPUT_BUDGET_CHARS && rules) { dropped.push('rules'); out = assemble([kernel, queue]); }
  if (out.length > OUTPUT_BUDGET_CHARS && queue) { dropped.push('queue'); out = assemble([kernel]); }
  if (dropped.length) {
    try { ledger.append(cwd, 'events', { kind: 'inject_truncated', dropped, chars: out.length, event: payload.hook_event_name || null }, payload.session_id || null); } catch (e) { /* recorded best effort */ }
  }
  return out;
}

function main() {
  rt.readStdinJson((payload) => {
    let event = String(payload.hook_event_name || '').trim();
    if (event !== 'SubagentStart' && event !== 'SessionStart') {
      // No usable event name (host swallowed stdin): SubagentStart only reads
      // JSON and SessionStart accepts JSON too, so the JSON form is the safe
      // default when the caller told us nothing. The hooks.json entry passes
      // the event as argv[2] so this path is rarely reached.
      event = process.argv[2] === 'SessionStart' ? 'SessionStart' : 'SubagentStart';
    }
    let context = '';
    try { context = contextFor(payload); } catch (e) { context = rt.FALLBACK_KERNEL; }
    rt.emit(event, context);
  });
}

try {
  main();
} catch (e) {
  rt.exitSoon(0);
}
