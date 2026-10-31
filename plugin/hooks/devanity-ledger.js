#!/usr/bin/env node
'use strict';
// devanity — the local ledger: append-only JSONL under <git-common-dir>/devanity/,
// so it is shared by every worktree and subagent of one repository and can never be committed.
// Without git the ledger is disabled (every write is a no-op that reports false) and the guards
// then record nothing and block nothing.
//
// Kinds: contracts · decisions · proofs · events. Records carry ts and session_id; a
// concurrent writer (parallel subagents) appends whole lines with O_APPEND; readers tolerate a torn
// last line. Also a read-only CLI: `node hooks/devanity-ledger.js stats|prune [--cwd <p>] [--json]`.

const fs = require('fs');
const path = require('path');
const rulesMod = require('./devanity-rules');
const rt = require('./devanity-runtime');
const { spawnSync } = require('child_process');

const KINDS = ['contracts', 'decisions', 'proofs', 'events'];
const RETENTION_DAYS = 90;

// Contract lifecycle: the phases a `devanity-contract:` block may declare, the two that
// close a change, and how long an unclosed change stays "open" before an abandoned session stops
// pinning the next one to its phase.
const CONTRACT_PHASES = ['FRAME', 'INSPECT', 'PROVE', 'EXECUTE', 'VERIFY', 'ASSURE', 'DONE', 'ABANDONED'];
const CLOSED_PHASES = ['DONE', 'ABANDONED'];
const CONTRACT_TTL_MS = 24 * 3600000;

// The repository's common git dir for `cwd` (worktrees share it), or null outside git. Found once
// per directory in a hook's run: a command naming many guarded paths asks for each of them.
const commonDirs = new Map();
function gitCommonDir(cwd) {
  const key = cwd || process.cwd();
  if (!commonDirs.has(key)) { const dir = findCommonDir(key); if (dir) commonDirs.set(key, dir); else return null; }
  return commonDirs.get(key);
}

function findCommonDir(cwd) {
  try {
    const r = spawnSync('git', ['rev-parse', '--git-common-dir'], { cwd: cwd || process.cwd(), encoding: 'utf8', timeout: 3000 });
    if (r.status !== 0) return null;
    const out = r.stdout.trim();
    if (!out) return null;
    return path.resolve(cwd || process.cwd(), out);
  } catch (e) {
    return null;
  }
}

function ledgerDir(cwd) {
  const common = gitCommonDir(cwd);
  return common ? path.join(common, 'devanity') : null;
}

function fileFor(dir, kind) {
  if (!KINDS.includes(kind)) throw new Error(`unknown ledger kind: ${kind}`);
  return path.join(dir, `${kind}.jsonl`);
}

// Appends one record. Returns true when written, false when the ledger is unavailable.
function append(cwd, kind, record, sessionId) {
  const dir = ledgerDir(cwd);
  if (!dir) return false;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({ ts: new Date().toISOString(), session_id: sessionId || null, ...record }) + '\n';
    fs.appendFileSync(fileFor(dir, kind), line, { flag: 'a' });
    return true;
  } catch (e) {
    return false;
  }
}

// Every parseable record of a kind, oldest first; a torn last line is skipped, never thrown.
function read(cwd, kind) {
  const dir = ledgerDir(cwd);
  if (!dir) return [];
  let text;
  try { text = fs.readFileSync(fileFor(dir, kind), 'utf8'); } catch (e) { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch (e) { /* torn or foreign line */ }
  }
  return out;
}

// Records of a kind folded by id: the latest record per id wins field by field.
function latestById(cwd, kind) {
  const byId = new Map();
  for (const r of read(cwd, kind)) if (r && r.id) byId.set(r.id, { ...(byId.get(r.id) || {}), ...r });
  return [...byId.values()];
}

// Decisions are records {id, path?, kind: reversible|irreversible|human, status: pending|decided,
// by: agent-default|human, chosen?}. The latest record per id wins.
function decisions(cwd) {
  return latestById(cwd, 'decisions');
}

function pendingDecisions(cwd) {
  return decisions(cwd).filter((d) => d.status === 'pending');
}

// A human decision that authorizes edits under `rel` in this repository: status decided, by
// human, its path (a glob or a prefix) covers rel, and it is still in scope: the change it was
// given for is open, or it is younger than DECISION_TTL_MS. The guard never widens this.
const DECISION_TTL_MS = 24 * 3600 * 1000;
function inScope(d, open, now = Date.now()) {
  if (d.standing === true) return true;             // `/devanity allow <glob> --standing`: a human said for good
  if (d.contract) return open.has(d.contract);   // given for a change: lives exactly as long as it is open
  const t = Date.parse(d.ts || '');
  return Number.isFinite(t) && now - t <= DECISION_TTL_MS;
}
function humanDecisionFor(cwd, rel, globToRegExp) {
  const open = new Set(openContracts(cwd).map((c) => c.id));
  for (const d of decisions(cwd)) {
    if (d.status !== 'decided' || d.by !== 'human' || !d.path || !inScope(d, open)) continue;
    const re = globToRegExp ? globToRegExp(d.path) : null;
    if ((re && re.test(rel)) || rel === d.path || rel.startsWith(d.path.replace(/\/?$/, '/'))) return d;
  }
  return null;
}

// Contracts are records {id, phase, intent, scope, forbidden?, proof?, pending?}, a compact
// projection of the Change Contract (skills/devanity/reference/change.schema.json). The latest
// record per id wins; `ts` is then the time of the latest phase declaration.
function contracts(cwd) {
  return latestById(cwd, 'contracts');
}

function contractAge(c, now) {
  const t = c.ts ? Date.parse(c.ts) : NaN;
  return Number.isNaN(t) ? Infinity : now - t;
}

function isClosed(c) {
  return CLOSED_PHASES.includes(String(c.phase || '').toUpperCase());
}

// Unclosed contracts declared within the last 24 h, newest first.
function openContracts(cwd, now = Date.now()) {
  // newest first; two declared in the same millisecond, the later written first
  const written = new Map();
  read(cwd, 'contracts').forEach((r, k) => { if (r && r.id) written.set(r.id, k); });
  return contracts(cwd)
    .filter((c) => !isClosed(c) && contractAge(c, now) <= CONTRACT_TTL_MS)
    .sort((a, b) => contractAge(a, now) - contractAge(b, now) || written.get(b.id) - written.get(a.id));
}

// The one open contract the next session continues from (the most recently declared), or null.
function openContract(cwd, now = Date.now()) {
  return openContracts(cwd, now)[0] || null;
}

// Unclosed contracts older than 24 h: no longer injected, reported by `stats` as expired.
function expiredContracts(cwd, now = Date.now()) {
  return contracts(cwd).filter((c) => !isClosed(c) && contractAge(c, now) > CONTRACT_TTL_MS);
}

// Drops records older than RETENTION_DAYS from every kind. Best effort; never throws.
function prune(cwd, now = Date.now()) {
  const dir = ledgerDir(cwd);
  if (!dir) return false;
  const cutoff = now - RETENTION_DAYS * 86400000;
  let tmp = null;
  try {
    for (const kind of KINDS) {
      const file = fileFor(dir, kind);
      if (!fs.existsSync(file)) continue;
      const kept = read(cwd, kind).filter((r) => !r.ts || Date.parse(r.ts) >= cutoff);
      // Rewrite through a temp file and a rename, so a prune that dies mid-write loses nothing.
      // deferred: a hook that appends between the read and the rename loses its line (no lock);
      // revisit if prune ever runs automatically rather than by hand.
      tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + (kept.length ? '\n' : ''));
      fs.renameSync(tmp, file);
      tmp = null;
    }
    return true;
  } catch (e) {
    if (tmp) try { fs.unlinkSync(tmp); } catch (_) { /* already gone */ }
    return false;
  }
}

// ---------------------------------------------------------------- option labels

// A [DECIDE] block's `options:` line is `<label> → consequence · <label> → consequence`; the label
// is the id a human answers with and the one the recommendation names. `labelOf` maps free text
// (an answer, a recommendation) onto one of those labels: the whole text, or its first word when
// exactly one label starts with it. Null when nothing matches or the match is ambiguous.
const norm = (s) => String(s || '').toLowerCase().replace(/[.!?,;:]+$/, '').replace(/\s+/g, ' ').trim();
const firstWord = (s) => norm(s).split(/[\s,:;.!?]+/)[0] || '';
function optionLabels(options) {
  return String(options || '').split('·').map((o) => norm(o.split('→')[0])).filter(Boolean);
}
function labelOf(options, text) {
  const labels = optionLabels(options);
  const t = norm(text);
  if (!labels.length || !t) return null;
  const exact = labels.find((l) => l === t);
  if (exact) return exact;
  const w = firstWord(t);
  const byWord = labels.filter((l) => firstWord(l) === w);
  return byWord.length === 1 ? byWord[0] : null;
}

// ---------------------------------------------------------------- stats

// The repository's numbers over the retention window. Read-only; null outside git.
function stats(cwd, now = Date.now()) {
  const dir = ledgerDir(cwd);
  if (!dir) return null;
  const cutoff = now - RETENTION_DAYS * 86400000;
  const inWindow = (r) => !r.ts || Date.parse(r.ts) >= cutoff;
  const count = (list, pred) => list.filter(pred).length;
  const dec = decisions(cwd).filter(inWindow);
  const proofs = read(cwd, 'proofs').filter(inWindow);
  const events = read(cwd, 'events').filter(inWindow);
  const all = contracts(cwd).filter(inWindow);
  const open = openContracts(cwd, now).filter(inWindow);
  const expired = expiredContracts(cwd, now).filter(inWindow);
  const phase = (c) => String(c.phase || '').toUpperCase();
  return {
    ledger: dir,
    window_days: RETENTION_DAYS,
    decisions: {
      pending: count(dec, (d) => d.status === 'pending'),
      decided_human: count(dec, (d) => d.status === 'decided' && d.by === 'human'),
      decided_agent_default: count(dec, (d) => d.status === 'decided' && d.by === 'agent-default'),
    },
    proofs: {
      verified: count(proofs, (p) => /^VERIFIED\b/i.test(String(p.status || ''))),
      not_verified: count(proofs, (p) => /^NOT_VERIFIED\b/i.test(String(p.status || ''))),
      false_ready: count(events, (e) => e.kind === 'false_ready'),
    },
    contracts: {
      open: open.length,
      done: count(all, (c) => phase(c) === 'DONE'),
      abandoned: count(all, (c) => phase(c) === 'ABANDONED'),
      expired: expired.length,
    },
    events: {
      blocked: count(events, (e) => e.kind === 'blocked'),
      would_block: count(events, (e) => e.kind === 'would_block'),
    },
    attention: attention(events, open),
    recommendation: recommendation(dec),
    principles: principles(cwd, dec),
    cost: cost(proofs),
  };
}

// What a change costs here (A3.1): the latest proof per contract carries the diff's files, lines
// and map areas; the medians say what an intent costs in this repository.
function cost(proofs) {
  const last = new Map();
  for (const p of proofs) if (p && typeof p.files === 'number') last.set(p.contract || 'adhoc', p);
  const rows = [...last.values()];
  const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  // Scope coverage (A0.5): over the changes that declared a scope, the share of changed paths it covered.
  const scoped = rows.filter((r) => typeof r.in_scope === 'number');
  const inScope = scoped.reduce((n, r) => n + r.in_scope, 0);
  const scopedFiles = scoped.reduce((n, r) => n + r.in_scope + (r.out_of_scope || 0), 0);
  return {
    changes: rows.length, median_files: median(rows.map((r) => r.files)), median_lines: median(rows.map((r) => r.lines)), median_areas: median(rows.map((r) => (Array.isArray(r.areas) ? r.areas.length : 0))),
    scoped_changes: scoped.length, scoped_files: scopedFiles, in_scope: inScope, scope_coverage: scopedFiles ? Math.round((inScope / scopedFiles) * 100) / 100 : null,
  };
}

// Principle candidates (A2.4): three or more human decisions of one kind under one map area are
// the regularity `debt` turns into a proposed principle (the map entry's `invariants`, `from` the
// decisions). Measured here; the proposal stays the mode's, the acceptance the human's.
const PRINCIPLE_MIN = 3;
function principles(cwd, dec) {
  // The map is the checkout's (a worktree has its own), never the common dir's parent.
  const loaded = rulesMod.loadRules(rt.gitToplevel(cwd) || cwd);
  if (!loaded.present || loaded.errors.length) return { candidates: [] };
  const groups = new Map();
  for (const d of dec) {
    if (d.status !== 'decided' || d.by !== 'human' || typeof d.path !== 'string' || !d.path) continue;
    const area = rulesMod.ruleFor(loaded.rules, d.path).glob;
    if (!area) continue;
    const key = `${area}\u0000${d.decide_kind || 'unknown'}`;
    if (!groups.has(key)) groups.set(key, { area, kind: d.decide_kind || 'unknown', decisions: [] });
    groups.get(key).decisions.push(d.id);
  }
  const candidates = [...groups.values()].filter((g) => g.decisions.length >= PRINCIPLE_MIN)
    .sort((a, b) => a.area.localeCompare(b.area) || a.kind.localeCompare(b.kind));
  return { candidates };
}

// Human turns (A0.1): what the developer's attention was spent on, and how much of it landed
// inside the open change.
function attention(events, open) {
  const turns = events.filter((e) => e.kind === 'human_turn');
  const openIds = new Set(open.map((c) => c.id));
  const of = (type) => turns.filter((t) => t.type === type).length;
  return { human_turns: turns.length, decide: of('decide'), command: of('command'), message: of('message'), in_open_change: turns.filter((t) => openIds.has(t.contract)).length };
}

// How often the agent's recommendation was the answer the human gave (A0.2): scored only where the
// answer matched an offered label and the recommendation named one; per decide kind.
function recommendation(dec) {
  const decided = dec.filter((d) => d.status === 'decided' && d.by === 'human');
  const out = { decided: decided.length, scored: 0, matched: 0, by_kind: {}, log_loss: { scored: 0, mean: null } };
  const loss = { n: 0, sum: 0 };
  for (const d of decided) {
    const rec = d.option ? labelOf(d.options, d.recommendation) : null;
    if (!rec) continue;
    const kind = d.decide_kind || 'unknown';
    const k = out.by_kind[kind] || (out.by_kind[kind] = { scored: 0, matched: 0, log_loss: { scored: 0, mean: null }, _loss: { n: 0, sum: 0 } });
    out.scored++; k.scored++;
    if (rec === d.option) { out.matched++; k.matched++; }
    // Log-loss (A5): `p=<0–1>` on the recommendation is the agent's probability that its pick is the
    // answer; the rest is spread evenly over the other options. The loss is -ln of the probability
    // the human's answer was given, so a confident miss costs more than a hedge.
    const p = probabilityOf(d.recommendation);
    const n = optionLabels(d.options).length;
    if (p === null || n < 2) continue;
    const q = Math.max(rec === d.option ? p : (1 - p) / (n - 1), 1e-3);
    const l = -Math.log(q);
    loss.n++; loss.sum += l; k._loss.n++; k._loss.sum += l;
  }
  const mean = (x) => (x.n ? Math.round((x.sum / x.n) * 100) / 100 : null);
  out.log_loss = { scored: loss.n, mean: mean(loss) };
  for (const k of Object.values(out.by_kind)) { k.log_loss = { scored: k._loss.n, mean: mean(k._loss) }; delete k._loss; }
  return out;
}
function probabilityOf(text) {
  const m = /\bp\s*=\s*(0?\.\d+|1(?:\.0+)?|0)(?![\d.])/.exec(String(text || ''));   // the whole number: `p=1.5` is not `p=1`
  if (!m) return null;
  const p = Number(m[1]);
  return p > 0 && p <= 1 ? p : null;
}

function renderStats(s) {
  if (!s) return 'devanity stats: no ledger here (not a git repository).';
  return [
    `devanity stats (${s.ledger}, last ${s.window_days} days)`,
    `decisions: ${s.decisions.pending} pending · ${s.decisions.decided_human} decided by human · ${s.decisions.decided_agent_default} decided by agent-default`,
    `proofs: ${s.proofs.verified} VERIFIED · ${s.proofs.not_verified} NOT_VERIFIED · ${s.proofs.false_ready} false_ready`,
    `contracts: ${s.contracts.open} open · ${s.contracts.done} done · ${s.contracts.abandoned} abandoned · ${s.contracts.expired} expired`,
    `guards: ${s.events.blocked} blocked · ${s.events.would_block} would_block`,
    `attention: ${s.attention.human_turns} human turns · ${s.attention.decide} decide · ${s.attention.command} command · ${s.attention.message} message · ${s.attention.in_open_change} in the open change`,
    `recommendation: ${s.recommendation.scored} of ${s.recommendation.decided} decided answers scored · ${s.recommendation.matched} matched the recommendation${renderKinds(s.recommendation.by_kind)}${s.recommendation.log_loss.scored ? ` · log-loss ${s.recommendation.log_loss.mean} over ${s.recommendation.log_loss.scored}` : ''}`,
    s.principles.candidates.length
      ? `principles: ${s.principles.candidates.length} candidate${s.principles.candidates.length > 1 ? 's' : ''} · ${s.principles.candidates.map((c) => `${c.area} ${c.kind} ×${c.decisions.length} (${c.decisions.join(', ')})`).join(' · ')}`
      : 'principles: no candidate',
    s.cost.changes ? `cost: ${s.cost.changes} change${s.cost.changes > 1 ? 's' : ''} · median ${s.cost.median_files} files · ${s.cost.median_lines} lines · ${s.cost.median_areas} map areas${s.cost.scope_coverage === null ? '' : ` · scope coverage ${s.cost.scope_coverage} (${s.cost.in_scope} of ${s.cost.scoped_files} files)`}` : 'cost: no measured change',
  ].join('\n');
}

function renderKinds(byKind) {
  const parts = Object.entries(byKind).map(([k, v]) => `${k} ${v.matched}/${v.scored}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

// ---------------------------------------------------------------- CLI

const USAGE = 'usage: node hooks/devanity-ledger.js stats [--cwd <path>] [--json] | prune [--cwd <path>] [--json]';

function cli(argv) {
  const [sub, ...rest] = argv;
  let cwd = process.cwd();
  let json = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--cwd' && rest[i + 1]) cwd = path.resolve(rest[++i]);
    else if (rest[i] === '--json') json = true;
    else return { code: 1, out: USAGE };
  }
  if (sub === 'stats') {
    const s = stats(cwd);
    return { code: 0, out: json ? JSON.stringify(s) : renderStats(s) };
  }
  if (sub === 'prune') {
    const ok = prune(cwd);
    return { code: 0, out: json ? JSON.stringify({ pruned: ok, window_days: RETENTION_DAYS }) : (ok ? `devanity prune: records older than ${RETENTION_DAYS} days dropped.` : 'devanity prune: no ledger here (not a git repository).') };
  }
  return { code: 1, out: USAGE };
}

module.exports = {
  CONTRACT_PHASES, KINDS,
  DECISION_TTL_MS, append, contracts, decisions, expiredContracts, humanDecisionFor, labelOf, ledgerDir,
  openContract, openContracts, pendingDecisions, prune, read, stats,
};

if (require.main === module) {
  let r;
  try { r = cli(process.argv.slice(2)); } catch (e) { r = { code: 1, out: `devanity ledger: ${e && e.message || e}` }; }
  process.stdout.write(r.out + '\n');
  process.exitCode = r.code;
}
