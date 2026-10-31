#!/usr/bin/env node
'use strict';
// devanity — UserPromptSubmit hook: tracks the on/off state.
//
// Only a whole message switches state: `/devanity off`,
// `stop devanity`, `normal mode` -> off; `/devanity on` -> on (and the kernel is
// re-injected, since a session that started while off never received it);
// bare `/devanity` -> reports the state; `/devanity status` adds the open change
// and the pending queue; `/devanity reset` abandons the open change. Any other
// prompt -> no output.
// Matching is case-insensitive and ignores trailing punctuation; a prompt that
// merely contains one of the phrases ("add a normal mode toggle") never fires.
//
// Whole-message command matching and the never-hang stdin path follow
// ponytail's hooks/ponytail-mode-tracker.js (https://github.com/DietrichGebert/ponytail,
// (c) 2026 DietrichGebert, MIT License), rewritten for this contract.

const rt = require('./devanity-runtime');
const ledger = require('./devanity-ledger');
const rulesMod = require('./devanity-rules');

// Accepts the bare command and the plugin-scoped form Claude Code may show.
const COMMAND = /^\/(?:devanity:)?devanity(?:\s+(\S+))?$/;
// `decide`, `accept` and `allow` keep their arguments' case: matched on the raw prompt, still whole-message.
const DECIDE = /^\/(?:devanity:)?devanity\s+decide(?:\s+(.*))?$/i;
const ACCEPT = /^\/(?:devanity:)?devanity\s+accept(?:\s+(.*))?$/i;
const ALLOW = /^\/(?:devanity:)?devanity\s+allow(?:\s+(.*))?$/i;
// Argument-less verbs handled here, not by the skill. `pending`, `status` only read the ledger;
// `reset` writes only contract records with phase ABANDONED (never a decision, never
// by:'human' on a decision).
const VERBS = new Set(['off', 'on', 'pending', 'reset', 'status']);
const OFF_PHRASES = new Set(['stop devanity', 'normal mode']);

function normalize(prompt) {
  return String(prompt || '')
    .trim()
    .toLowerCase()
    .replace(/[\s.!?…,;:]+$/u, '')
    .replace(/\s+/g, ' ');
}

// Returns one of VERBS | 'report' | null.
function intentOf(prompt) {
  const text = normalize(prompt);
  if (!text) return null;
  if (OFF_PHRASES.has(text)) return 'off';
  const m = COMMAND.exec(text);
  if (!m) return null;
  const arg = m[1] || '';
  if (VERBS.has(arg)) return arg;
  if (arg === '') return 'report';
  return null; // `/devanity plan ...` and other mode verbs belong to the skill
}

function respond(intent) {
  if (intent === 'off') {
    rt.writeState('off');
    return 'DEVANITY OFF: the devanity rules injected earlier no longer apply for the rest of this session; new sessions and subagents receive nothing until `/devanity on`.';
  }
  if (intent === 'on') {
    const wasOff = rt.readState() === 'off';
    rt.writeState('on');
    const kernel = rt.readKernel().text;
    const body = rt.isAutonomous() ? rt.AUTONOMOUS_LINE + '\n\n' + kernel : kernel;
    return 'DEVANITY ON' + (wasOff ? ' (was off)' : '') + '. Apply the rules below from this turn on.\n\n' + body;
  }
  if (intent === 'report') {
    const state = rt.readState();
    return state === 'off'
      ? 'DEVANITY STATE: off (`/devanity on` turns it back on).'
      : 'DEVANITY STATE: on (`/devanity off` or "stop devanity" as a whole message turns it off).';
  }
  return '';
}

// ---- human decisions --------------------------------------------------------
//
// No self-grant path: this is the ONLY place in the plugin that writes a decision with by:'human'.
// It is trusted because the UserPromptSubmit payload's `prompt` is the text the human typed;
// the model cannot author that payload and no tool call reaches this hook. The PreToolUse guard
// (devanity-guard.js) only ever writes by:'agent' pending records and events. Do not add another
// writer of by:'human' anywhere, and do not expose this through a tool.

function pendingList(cwd) {
  const pending = ledger.pendingDecisions(cwd);
  if (!pending.length) return 'DEVANITY PENDING: none.';
  // What the one who decides needs: the question and its options when an agent asked one, and what
  // the path guards (from the map) when the guard queued it.
  const root = rt.gitToplevel(cwd) || cwd;
  const loaded = rulesMod.loadRules(root);
  // A record is data someone else wrote: a field of the wrong type reads as absent, never as a throw
  // that blanks the whole listing.
  const str = (v) => (typeof v === 'string' ? v : '');
  const lines = pending.map((d) => {
    const path = str(d.path);
    const head = `- ${rt.clip(d.id, 40)}${d.provisional === true ? ' [provisional]' : ''}${str(d.question) ? `: ${rt.clip(d.question, 300)}` : ''}  path: ${rt.clip(path || '(none)', 120)}  queued by: ${rt.clip(str(d.by) || '?', 20)}  at: ${rt.clip(str(d.ts) || '?', 30)}`;
    const rule = path && !loaded.errors.length ? rulesMod.ruleFor(loaded.rules, path) : null;
    const detail = [
      str(d.axis) && `    axis: ${rt.clip(d.axis, 160)}`,
      str(d.rule) && `    rule: ${rt.clip(d.rule, 400)}`,
      str(d.question) && `    derivation: ${rt.clip(str(d.derivation) || 'none given', 400)}`,   // what was tried before asking (A2.2)
      str(d.acted) && `    acted: ${rt.clip(d.acted, 400)}`,
      str(d.options) && `    options: ${rt.clip(d.options, 400)}`,
      str(d.recommendation) && `    recommendation: ${rt.clip(d.recommendation, 400)}`,
      str(d.if_undecided) && `    if undecided: ${rt.clip(d.if_undecided, 400)}`,
      rule && Array.isArray(rule.invariants) && rule.invariants.length && `    never changes: ${rule.invariants.slice(0, 3).map((v) => rt.clip(rulesMod.invariantText(v), 160)).join('; ')}${rule.invariants.length > 3 ? '; …' : ''}`,
    ].filter(Boolean);
    return [head, ...detail].join('\n');
  });
  const provisional = pending.filter((d) => d.provisional === true).length;
  return `DEVANITY PENDING: ${pending.length} decision(s) waiting for a human (record one with \`/devanity decide <id> <option> [--path <glob>]\`${provisional ? `; \`/devanity accept [--except <id> <option>, …]\` answers the ${provisional} provisional with their recommendation` : ''}):\n${lines.join('\n')}`;
}

// `/devanity decide <id> <option> [--path <glob>]`. An unknown id must name what it authorizes.
const REJECT = /^(?:no|n|nope|não|nao|reject(?:ed)?|deny|denied|refuse[ds]?|decline[ds]?|rejeit(?:ar|o|ad[oa])|negad[oa]|negar|recus(?:ar|o|ad[oa]))$/i;   // the first word
const REJECT_PHRASE = /^(?:no way|not now|do not|don't)\b/i;
// Several answers in one message (A2.3): `G-1 prorate, G-2 usd only --path billing/**`. A comma
// starts a new answer only when a decision id follows it, so `no, prorate` stays one answer.
const ID_TOKEN = /^[A-Za-z]{1,2}-\S+$/;
function decideAll(args, cwd, sessionId, opts = {}) {
  const toks = String(args || '').trim().split(/\s+/).filter(Boolean);
  let pathGlob = null;
  const p = toks.indexOf('--path');
  if (p >= 0) { pathGlob = toks[p + 1] || null; toks.splice(p, 2); }
  const answers = [[]];
  for (const t of toks) {
    const m = /^(.*),$/.exec(t);
    if (m) { if (m[1]) answers[answers.length - 1].push(m[1]); answers.push([]); }
    else answers[answers.length - 1].push(t);
  }
  const parts = [];
  for (const a of answers) {
    if (parts.length && (!a.length || !ID_TOKEN.test(a[0]))) { parts[parts.length - 1].push(',', ...a); continue; }   // not a new answer: the comma was part of the text
    parts.push(a);
  }
  return parts.map((part) => decide(part, pathGlob, cwd, sessionId, opts)).join('\n');
}

// `/devanity allow <glob> [--standing]`: authority, not a choice. A human names what may be edited,
// for the open change (the default, as `decide --path`) or for good (`--standing`, never expiring).
// It is `decide` with a `yes` under an `A-` id, so the one writer of by:'human' stays one.
function allow(args, cwd, sessionId) {
  const toks = String(args || '').trim().split(/\s+/).filter(Boolean);
  const standing = toks.includes('--standing');
  const glob = toks.find((t) => !t.startsWith('--')) || null;
  if (!glob) return 'DEVANITY ALLOW: usage is `/devanity allow <glob> [--standing]`.';
  const id = `A-${glob.split('/')[0].replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_-]+/g, '-') || 'path'}`;
  return decide([id, 'yes'], glob, cwd, sessionId, { standing });
}

// `/devanity accept [--except <id> <option>, <id> <option>]`: the review batch. Every pending
// provisional decision is answered with the label its recommendation named; the exceptions are
// answered as given (a `no` rejects: the slice is reverted by the agent, the rule is not written).
function accept(args, cwd, sessionId) {
  if (!ledger.ledgerDir(cwd)) return 'DEVANITY ACCEPT: no ledger here (not a git repository); nothing recorded.';
  const text = String(args || '').trim();
  const m = /^(?:--except\s+(.*))?$/s.exec(text);
  if (!m) return 'DEVANITY ACCEPT: usage is `/devanity accept [--except <id> <option>, <id> <option>]`.';
  const out = [];
  const excepted = new Set();
  if (m[1]) {
    for (const part of m[1].split(/,\s*(?=[A-Za-z]{1,2}-\S+)/)) {
      const id = part.trim().split(/\s+/)[0];
      if (id) excepted.add(id);
    }
    out.push(decideAll(m[1], cwd, sessionId));
  }
  const provisional = ledger.pendingDecisions(cwd).filter((d) => d.provisional === true && !excepted.has(d.id));
  for (const d of provisional) {
    const label = ledger.labelOf(d.options, d.recommendation) || String(d.recommendation || '').trim().split(/[\s,;:!?.]+/)[0];
    out.push(label ? decide([d.id, label], null, cwd, sessionId, {}) : `DEVANITY ACCEPT: ${rt.clip(d.id, 40)} names no recommendation; answer it with \`/devanity decide ${rt.clip(d.id, 40)} <option>\`.`);
  }
  if (!provisional.length && !m[1]) return 'DEVANITY ACCEPT: no provisional decision pending.';
  return out.join('\n');
}

// The answer becomes a principle of its area (the eigen step): the `rule:` the block carried, written
// into the map under the axis's area with `from: [id]`, so the next question on that axis is derived
// instead of asked. Only a valid map with an entry for the area takes it; anything else is said.
function writePrinciple(cwd, known, id) {
  const rule = typeof known.rule === 'string' ? known.rule.trim() : '';
  if (!rule) return '';
  const root = rt.gitToplevel(cwd) || cwd;
  const loaded = rulesMod.loadRules(root);
  if (!loaded.present || loaded.errors.length || !loaded.raw) return ` The rule is recorded in the ledger only: no valid ${rulesMod.FILE} to write it into.`;
  const axisArea = typeof known.axis === 'string' ? known.axis.split(/\s*[×x]\s*/)[0].trim() : '';
  const area = axisArea && loaded.raw.paths && loaded.raw.paths[axisArea] ? axisArea : (typeof known.path === 'string' && known.path ? rulesMod.ruleFor(loaded.rules, known.path).glob : null);
  if (!area || !loaded.raw.paths || !loaded.raw.paths[area]) return ` The rule is recorded in the ledger only: the map has no entry for ${rt.clip(axisArea || 'its area', 80)}; add one to codify it.`;
  const entry = loaded.raw.paths[area];
  const inv = Array.isArray(entry.invariants) ? entry.invariants : (entry.invariants === undefined ? (entry.invariants = []) : null);
  if (!inv) return ` The rule is recorded in the ledger only: ${rt.clip(area, 80)} has invariants the loader could not read.`;
  const same = inv.find((v) => (v && typeof v === 'object' ? v.rule : v) === rule);
  if (same) return ` The map already holds it${same && typeof same === 'object' ? ` as ${same.id}` : ''}.`;
  let max = 0;
  for (const p of Object.values(loaded.raw.paths)) for (const v of (Array.isArray(p.invariants) ? p.invariants : [])) { const m = v && typeof v === 'object' ? /^P-(\d+)$/.exec(String(v.id)) : null; if (m && Number(m[1]) > max) max = Number(m[1]); }
  const pid = `P-${String(max + 1).padStart(3, '0')}`;
  inv.push({ id: pid, rule, kind: typeof known.decide_kind === 'string' && known.decide_kind ? known.decide_kind : 'rule', from: [id] });
  if (rulesMod.parseRules(JSON.stringify(loaded.raw)).errors.length) { inv.pop(); return ' The rule is recorded in the ledger only: the map would not validate with it.'; }
  try { require('fs').writeFileSync(loaded.file, JSON.stringify(loaded.raw, null, 2) + '\n'); } catch (e) { inv.pop(); return ` The rule is recorded in the ledger only: ${rulesMod.FILE} could not be written.`; }
  return ` Written to the map as ${pid} under ${area}: the next question on that axis is derived, not asked. Commit ${rulesMod.FILE}.`;
}
// One answer; the only writer of by:'human' in the plugin (see the note above).
function decide(toks, pathGlob, cwd, sessionId, opts = {}) {
  const [id, ...rest] = toks;
  const chosen = rest.join(' ').replace(/\s+,/g, ',');
  if (!id || !chosen) return 'DEVANITY DECIDE: usage is `/devanity decide <id> <option> [--path <glob>]`, or several: `<id> <option>, <id> <option> [--path <glob>]`.';
  if (!ledger.ledgerDir(cwd)) return 'DEVANITY DECIDE: no ledger here (not a git repository); nothing recorded.';
  const known = ledger.decisions(cwd).find((d) => d.id === id);
  if (!known && !pathGlob) {
    const ids = ledger.pendingDecisions(cwd).map((d) => `${rt.clip(d.id, 40)} (${typeof d.path === 'string' && d.path ? rt.clip(d.path, 120) : 'no path'})`);
    return `DEVANITY DECIDE: "${rt.clip(id, 40)}" is not a known decision; a human decision must name what it authorizes. Re-run with \`--path <glob>\`, or pick a pending id: ${ids.length ? ids.join(', ') : 'none pending'}.`;
  }
  // A "no" answers the question and authorizes nothing: recorded as rejected, never as decided.
  const rejected = REJECT.test(chosen.trim().toLowerCase().replace(/[.!?,;:]+$/, '').split(/[\s,;:!?.]+/)[0] || '') || REJECT_PHRASE.test(chosen.trim());
  const record = { id, status: rejected ? 'rejected' : 'decided', by: 'human', chosen, kind: (known && known.kind) || 'human' };
  if (pathGlob) record.path = pathGlob;
  if (opts.standing && pathGlob && !rejected) record.standing = true;   // never expires; only a typed `allow --standing` sets it
  // The answer as typed stays in `chosen`; `option` is the offered label it names, when it names
  // exactly one, so `stats` can score the recommendation against it (A0.2).
  const option = !rejected && known ? ledger.labelOf(known.options, chosen) : null;
  if (option) record.option = option;
  // Scope: the decision serves the open change (and lives as long as it is open), else it expires
  // after ledger.DECISION_TTL_MS; it never authorizes every later session.
  const change = ledger.openContract(cwd);
  record.contract = record.standing ? null : (change ? change.id : null);   // null, not absent: the ledger merges field by field
  if (!ledger.append(cwd, 'decisions', record, sessionId)) return 'DEVANITY DECIDE: the ledger could not be written; nothing recorded.';
  const scope = pathGlob || (known && known.path) || null;
  if (rejected) return `DEVANITY DECISION REJECTED: ${id} = ${chosen}, by human. ${scope ? `Guarded edits under ${scope} stay blocked.` : 'It authorizes no edit.'}${known && known.provisional === true ? ' Revert the provisional slice it names.' : ''}`;
  const principle = known ? writePrinciple(cwd, known, id) : '';
  if (!scope) return `DEVANITY DECISION RECORDED: ${id} = ${chosen}, by human. It records the answer and authorizes no edit; \`/devanity allow <glob>\` authorizes edits.${principle}`;
  const lasts = record.standing ? 'until a human revokes it (standing)' : change ? `while change ${change.id} is open` : `for ${Math.round(ledger.DECISION_TTL_MS / 3600000)} h`;
  return `DEVANITY DECISION RECORDED: ${id} = ${chosen}, path ${scope}, by human. Guarded edits under that path are allowed ${lasts}.${principle}`;
}

// ---- open change --------------------------------------------------

// `/devanity reset`: every open contract (unclosed, declared within 24 h) is marked ABANDONED with
// reason `reset` (only this handler writes that reason, and only a typed whole message reaches it).
// Expired ones are already out of the way and stay counted as expired in `stats`.
function reset(cwd, sessionId) {
  if (!ledger.ledgerDir(cwd)) return 'DEVANITY RESET: no ledger here (not a git repository); nothing to reset.';
  const open = ledger.openContracts(cwd);
  let n = 0;
  for (const c of open) if (ledger.append(cwd, 'contracts', { id: c.id, phase: 'ABANDONED', reason: 'reset' }, sessionId)) n++;
  const ids = open.slice(0, n).map((c) => `${c.id} (${c.phase})`);
  return `DEVANITY RESET: ${n} open change(s) marked abandoned${ids.length ? `: ${ids.join(', ')}` : ''}.`;
}

// `/devanity status`: read-only; state, the open change, the pending queue size.
function status(cwd) {
  const state = rt.readState();
  if (!ledger.ledgerDir(cwd)) return `DEVANITY STATUS: state ${state}; no ledger here (not a git repository).`;
  const c = ledger.openContract(cwd);
  const change = c ? `${c.id} in ${c.phase}${c.intent ? ` (${String(c.intent).replace(/\s+/g, ' ').trim()})` : ''}` : 'none';
  return `DEVANITY STATUS: state ${state}; open change: ${change}; pending decisions: ${ledger.pendingDecisions(cwd).length}.`;
}

// Every human prompt is one attention event (A0.1): its type, its size and the change it lands in.
// The text itself never enters the ledger. Best effort, like every ledger write.
function recordTurn(cwd, raw, type, sessionId, decisionId) {
  try {
    const c = ledger.openContract(cwd);
    const rec = { kind: 'human_turn', type, chars: raw.length, contract: c ? c.id : null, phase: c ? c.phase : null };
    if (decisionId) rec.decision = decisionId;
    ledger.append(cwd, 'events', rec, sessionId);
  } catch (e) { /* measurement never costs the command it measures */ }
}

function main() {
  rt.readStdinJson((payload) => {
    let out = '';
    try {
      const raw = String(payload.prompt || '').trim();
      const cwd = payload.cwd && String(payload.cwd).trim() ? String(payload.cwd) : process.cwd();
      const d = DECIDE.exec(raw);
      const a = ACCEPT.exec(raw);
      const w = ALLOW.exec(raw);
      const intent = intentOf(raw);
      if (raw) recordTurn(cwd, raw, d || a ? 'decide' : raw.startsWith('/') ? 'command' : 'message', payload.session_id, d ? String(d[1] || '').trim().split(/\s+/)[0] : null);
      if (d) out = decideAll(d[1], cwd, payload.session_id);
      else if (a) out = accept(a[1], cwd, payload.session_id);
      else if (w) out = allow(w[1], cwd, payload.session_id);
      else if (intent === 'pending') out = pendingList(cwd);
      else if (intent === 'reset') out = reset(cwd, payload.session_id);
      else if (intent === 'status') out = status(cwd);
      else out = respond(intent);
    } catch (e) { out = ''; }
    rt.emit('UserPromptSubmit', out);
  });
}

try {
  main();
} catch (e) {
  rt.exitSoon(0);
}
