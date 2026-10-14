#!/usr/bin/env node
// Mutants on the lines a change touched, as a probe of its oracle (A5): each changed line of a
// non-test text file gets its operator mutants (a comparison flipped or moved to its boundary, a
// boolean or arithmetic operator swapped, a negation dropped, a literal nudged), each one is written
// into a detached copy of the tree and the check is run; a mutant the check does not fail is a
// survivor, a line the oracle does not pin. Reports; the verifier counts survivors as findings on
// oracle quality. The working tree is never touched. Exit 1 on usage or a check that fails unmutated.
//   node mutants.mjs --base <ref> --check <command> [--json] [--max <n>] [-- <scope…>]
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, rmdirSync, mkdirSync, existsSync, copyFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { gitRun } from './surfaces.mjs';

const require = createRequire(import.meta.url);
const rulesMod = require(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'hooks', 'devanity-rules.js'));

const MAX_MUTANTS = 200;
const RUN_TIMEOUT_MS = 60000;
// Each operator: what to find, what to write, and a guard against the look-alikes it must not touch.
const OPERATORS = [
  { from: '===', to: '!==' }, { from: '!==', to: '===' },
  { from: '<=', to: '<' }, { from: '>=', to: '>' },
  { from: '<', to: '<=', not: /<[<=]|=>|<\// }, { from: '<', to: '>', not: /<[<=]|=>|<\// },
  { from: '>', to: '>=', not: /[>=]>|=>|->/ }, { from: '>', to: '<', not: /[>=]>|=>|->/ },
  { from: '&&', to: '||' }, { from: '||', to: '&&' },
  { from: ' + ', to: ' - ' }, { from: ' - ', to: ' + ' }, { from: ' * ', to: ' / ' },
  { from: 'true', to: 'false', word: true }, { from: 'false', to: 'true', word: true },
  { from: '!', to: '', re: /!(?=[A-Za-z_($])/ },
];
const LITERAL = /(?<![\w.])(\d+)(?![\w.])/;

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function mutantsOf(line) {
  const out = [];
  for (const op of OPERATORS) {
    const re = op.re || new RegExp(op.word ? `\\b${esc(op.from)}\\b` : esc(op.from));
    const m = re.exec(line);
    if (!m) continue;
    if (op.not && op.not.test(line.slice(Math.max(0, m.index - 1), m.index + m[0].length + 1))) continue;
    out.push({ from: op.from, to: op.to, text: line.slice(0, m.index) + op.to + line.slice(m.index + m[0].length) });
  }
  const lit = LITERAL.exec(line);
  if (lit) out.push({ from: lit[1], to: String(Number(lit[1]) + 1), text: line.slice(0, lit.index) + String(Number(lit[1]) + 1) + line.slice(lit.index + lit[1].length) });
  return out;
}

// The changed lines (new side) of each changed non-test text file, base → working tree.
function changedLines(root, base, scope, rules) {
  const d = gitRun(root, ['diff', '--name-only', '-z', '--no-renames', base, '--', ...scope]);
  if (d.status !== 0) throw new Error(`git diff failed: ${(d.stderr || '').trim()}`);
  const files = [...new Set(d.stdout.split('\0').filter(Boolean))].filter((f) => !rulesMod.isTestPath(rules, f) && existsSync(join(root, f)));
  const out = [];
  for (const f of files) {
    const buf = readFileSync(join(root, f));
    if (buf.indexOf(0) !== -1) continue;
    const u = gitRun(root, ['diff', '-U0', '--no-renames', base, '--', f]);
    const lines = new Set();
    for (const m of u.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
      const start = Number(m[1]); const count = m[2] === undefined ? 1 : Number(m[2]);
      for (let i = 0; i < count; i++) lines.add(start + i);
    }
    out.push({ file: f, text: buf.toString('utf8'), lines: [...lines].sort((a, b) => a - b) });
  }
  return out;
}

function runCheck(command, cwd) {
  const r = spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-c', command], { cwd, encoding: 'utf8', timeout: RUN_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 16 * 1024 * 1024 });
  return { code: r.status, timedOut: r.error && r.error.code === 'ETIMEDOUT' };
}

export function runMutants(root, base, check, { scope = [], max = MAX_MUTANTS } = {}) {
  const rules = rulesMod.loadRules(root).rules;
  const changed = changedLines(root, base, scope, rules);
  const plan = [];
  for (const c of changed) {
    const src = c.text.split('\n');
    for (const ln of c.lines) {
      const line = src[ln - 1];
      if (line === undefined || !line.trim() || /^\s*(\/\/|#|\*|\/\*)/.test(line)) continue;
      for (const m of mutantsOf(line)) plan.push({ file: c.file, line: ln, from: m.from, to: m.to, text: m.text, src });
    }
  }
  const total = Math.min(plan.length, max);
  const out = { base, head: 'HEAD', check, total, killed: 0, survived: 0, timed_out: 0, survivors: [], skipped: plan.length - total };
  if (!total) return out;
  // A detached copy of HEAD, with every working-tree change (tests included) copied in: the check
  // runs there, the working tree is never touched. The copy shares nothing ignored (no node_modules).
  const tmp = mkdtempSync(join(tmpdir(), 'devanity-mutants-'));
  const add = gitRun(root, ['worktree', 'add', '--detach', tmp, 'HEAD']);
  if (add.status !== 0) { rmSync(tmp, { recursive: true, force: true }); throw new Error(`git worktree add failed: ${(add.stderr || '').trim()}`); }
  try {
    const st = gitRun(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    for (const entry of st.stdout.split('\0')) {
      const rel = entry.length > 3 ? entry.slice(3) : '';
      if (!rel) continue;
      let isFile = false;
      try { isFile = statSync(join(root, rel)).isFile(); } catch (e) { /* gone */ }
      // What the working tree no longer holds as a file (deleted, or a directory now) leaves the copy
      // too, and so does any directory left empty by it: the check sees the tree the writer sees.
      rmSync(join(tmp, rel), { recursive: true, force: true });
      for (let dir = dirname(join(tmp, rel)); dir !== tmp && dir.startsWith(tmp); dir = dirname(dir)) {
        try { rmdirSync(dir); } catch (e) { break; }   // not empty, or gone: stop climbing
      }
      if (!isFile) continue;
      mkdirSync(dirname(join(tmp, rel)), { recursive: true });
      copyFileSync(join(root, rel), join(tmp, rel));
    }
    const sane = runCheck(check, tmp);
    if (sane.code !== 0) throw new Error(`the check fails unmutated (exit ${sane.code}${sane.timedOut ? ', timed out' : ''}): nothing a mutant could tell`);
    for (const m of plan.slice(0, total)) {
      const mutated = [...m.src]; mutated[m.line - 1] = m.text;
      writeFileSync(join(tmp, m.file), mutated.join('\n'));
      const r = runCheck(check, tmp);
      writeFileSync(join(tmp, m.file), m.src.join('\n'));
      if (r.timedOut) { out.timed_out++; out.killed++; continue; }   // a hang is a death, not a survival
      if (r.code === 0) { out.survived++; out.survivors.push({ file: m.file, line: m.line, from: m.from, to: m.to }); } else out.killed++;
    }
  } finally {
    gitRun(root, ['worktree', 'remove', '--force', tmp]);
    rmSync(tmp, { recursive: true, force: true });
  }
  return out;
}

export const renderMutants = (r) => [
  `mutants ${r.base}..${r.head}: ${r.total} run · ${r.killed} killed · ${r.survived} survived${r.timed_out ? ` (${r.timed_out} timed out, counted killed)` : ''}${r.skipped ? ` · ${r.skipped} past the cap` : ''}`,
  ...r.survivors.map((s) => `  ${s.file}:${s.line}  ${s.from} → ${s.to || '(dropped)'}`),
].join('\n');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const dash = argv.indexOf('--');
  const opts = dash >= 0 ? argv.slice(0, dash) : argv;
  const scope = dash >= 0 ? argv.slice(dash + 1) : [];
  const usage = (why) => { process.stderr.write(`mutants: ${why}\nusage: node mutants.mjs --base <ref> --check <command> [--json] [--max <n>] [-- <scope…>]\n`); process.exit(1); };
  const opt = (name) => { const i = opts.indexOf(name); return i >= 0 ? opts[i + 1] : undefined; };
  for (let i = 0; i < opts.length; i++) {
    if (['--base', '--check', '--max'].includes(opts[i])) { if (!opts[i + 1]) usage(`${opts[i]} needs a value`); i++; }
    else if (opts[i] !== '--json') usage(`unknown argument ${opts[i]}`);
  }
  if (!opt('--base')) usage('--base <ref> is required');
  if (!opt('--check')) usage('--check <command> is required');
  if (opt('--max') !== undefined && !/^[1-9]\d*$/.test(opt('--max'))) usage('--max needs a positive integer');
  const top = gitRun(process.cwd(), ['rev-parse', '--show-toplevel']);
  if (top.status !== 0) usage('not inside a git repository');
  let r;
  try { r = runMutants(top.stdout.trim(), opt('--base'), opt('--check'), { scope, max: opt('--max') ? Number(opt('--max')) : MAX_MUTANTS }); } catch (e) { usage(e.message); }
  process.stdout.write((opts.includes('--json') ? JSON.stringify(r) : renderMutants(r)) + '\n');
}
