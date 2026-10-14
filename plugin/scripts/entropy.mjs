#!/usr/bin/env node
// Entropy delta between two revisions, for the reference CI job and the debt mode (A3.2): over the
// text files the change touched, how much of what they hold is copied (5-line windows that also
// occur elsewhere in the repository at that revision), how many suppressions they carry, how many
// `any`s and casts. Each as before → after → delta; `worse` when any delta is positive. The repository
// at each revision is read with one `git cat-file --batch`, never checked out. Exit 0: it reports;
// the ratchet that fails on it is the CI job's (`delta.entropy: ratchet`, A3.3).
//   node entropy.mjs --base <ref> [--head <ref>] [--json] [-- <scope…>]
import { gitRun } from './surfaces.mjs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const WINDOW = 5;
const SUPPRESSION = /eslint-disable|@ts-(?:ignore|expect-error|nocheck)|#\s*noqa|#\s*type:\s*ignore|pylint:\s*disable|@SuppressWarnings|\/\/\s*nolint|#\[allow\(/i;
const CAST = /\bas any\b|:\s*any\b|<any>|\bas unknown as\b/g;
const MAX_FILE = 1024 * 1024;

const isText = (buf) => buf.indexOf(0) === -1;
const normalized = (text) => text.split('\n').map((l) => l.trim().replace(/\s+/g, ' ')).filter(Boolean);
const windowsOf = (lines) => {
  const out = [];
  for (let i = 0; i + WINDOW <= lines.length; i++) out.push(createHash('sha1').update(lines.slice(i, i + WINDOW).join('\n')).digest('base64').slice(0, 16));
  return out;
};

// Every text blob at `rev` under `paths` (all tracked when empty): Map path → content. The batch is
// asked by object id (a path may hold a newline) and read as bytes (a blob need not be UTF-8).
function blobsAt(root, rev, paths) {
  const ls = gitRun(root, ['ls-tree', '-r', '-z', rev, '--', ...paths]);
  if (ls.status !== 0) return new Map();
  const entries = ls.stdout.split('\0').filter(Boolean).map((e) => /^\d+ (\S+) (\S+)\t([\s\S]+)$/.exec(e)).filter((m) => m && m[1] === 'blob');
  if (!entries.length) return new Map();
  const batch = spawnSync('git', ['cat-file', '--batch'], { cwd: root, input: entries.map((m) => `${m[2]}\n`).join(''), maxBuffer: 64 * 1024 * 1024 });
  if (batch.status === null || batch.error?.code === 'ENOBUFS') throw new Error(`git cat-file did not finish (${batch.error ? batch.error.code || batch.error.message : batch.signal})`);
  const out = new Map();
  let pos = 0; let k = 0;
  const buf = batch.stdout;
  while (pos < buf.length && k < entries.length) {
    const nl = buf.indexOf(10, pos);
    if (nl < 0) break;
    const m = /^\S+ (\S+) (\d+)$/.exec(buf.subarray(pos, nl).toString('latin1'));
    if (!m) { pos = nl + 1; k++; continue; }   // "missing": not at this revision
    const size = Number(m[2]);
    const body = buf.subarray(nl + 1, nl + 1 + size);
    if (m[1] === 'blob' && size <= MAX_FILE && isText(body)) out.set(entries[k][3], body.toString('utf8'));
    pos = nl + 1 + size + 1; k++;
  }
  return out;
}

function metricsAt(root, rev, changed) {
  // deferred: one full read of the tracked tree per revision (the 64 MiB cap in gitRun turns a larger one into "not measured"), revisit when a repository reports it
  const all = blobsAt(root, rev, []);
  const seen = new Map();
  for (const text of all.values()) for (const w of windowsOf(normalized(text))) seen.set(w, (seen.get(w) || 0) + 1);
  let duplication = 0; let suppressions = 0; let casts = 0; let files = 0;
  for (const p of changed) {
    const text = all.get(p);
    if (text === undefined) continue;
    files++;
    for (const w of windowsOf(normalized(text))) if (seen.get(w) >= 2) duplication++;
    for (const l of text.split('\n')) if (SUPPRESSION.test(l)) suppressions++;
    casts += (text.match(CAST) || []).length;
  }
  return { files, duplication, suppressions, casts };
}

// The changed text files between base and head (under `scope` when given), with the metrics at each.
export function measureEntropy(root, base, head = 'HEAD', scope = []) {
  const d = gitRun(root, ['diff', '--name-only', '-z', '--no-renames', base, head, '--', ...scope]);
  if (d.status !== 0) throw new Error(`git diff failed: ${(d.stderr || '').trim()}`);
  const changed = [...new Set(d.stdout.split('\0').filter(Boolean))];
  const before = metricsAt(root, base, changed);
  const after = metricsAt(root, head, changed);
  const pair = (k) => ({ before: before[k], after: after[k], delta: after[k] - before[k] });
  const out = { base, head, files: Math.max(before.files, after.files), duplication: pair('duplication'), suppressions: pair('suppressions'), casts: pair('casts') };
  out.worse = ['duplication', 'suppressions', 'casts'].some((k) => out[k].delta > 0);
  return out;
}

const sign = (n) => (n > 0 ? `+${n}` : String(n));
export const renderEntropy = (e) => `entropy ${e.base}..${e.head}: ${e.files} file${e.files === 1 ? '' : 's'} · duplication ${e.duplication.before} → ${e.duplication.after} (${sign(e.duplication.delta)}) · suppressions ${e.suppressions.before} → ${e.suppressions.after} (${sign(e.suppressions.delta)}) · casts ${e.casts.before} → ${e.casts.after} (${sign(e.casts.delta)})`;
// The metrics that got worse, as the ratchet names them: `duplication +4, casts +1`.
export const worseParts = (e) => ['duplication', 'suppressions', 'casts'].filter((k) => e[k].delta > 0).map((k) => `${k} ${sign(e[k].delta)}`).join(', ');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const opts = dash >= 0 ? argv.slice(0, dash) : argv;
  const scope = dash >= 0 ? argv.slice(dash + 1) : [];
  const usage = (why) => { process.stderr.write(`entropy: ${why}\nusage: node entropy.mjs --base <ref> [--head <ref>] [--json] [-- <scope…>]\n`); process.exit(1); };
  const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
  for (let i = 0; i < opts.length; i++) {
    if (opts[i] === '--base' || opts[i] === '--head') { if (!opts[i + 1]) usage(`${opts[i]} needs a ref`); i++; }
    else if (opts[i] !== '--json') usage(`unknown argument ${opts[i]}`);
  }
  if (!opt('--base')) usage('--base <ref> is required');
  const top = gitRun(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) usage('not inside a git repository');
  let e;
  try { e = measureEntropy(top.stdout.trim(), opt('--base'), opt('--head') || 'HEAD', scope); } catch (err) { usage(err.message); }
  process.stdout.write((opts.includes('--json') ? JSON.stringify(e) : renderEntropy(e)) + '\n');
}
