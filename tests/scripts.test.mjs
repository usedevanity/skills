// Tests for the computations the modes run instead of describing them: plugin/scripts/hotspots.mjs,
// plugin/scripts/calibrate.mjs and plugin/scripts/surfaces.mjs. node:test, no dependencies.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitIgnored } from '../plugin/scripts/surfaces.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOTSPOTS = join(root, 'plugin', 'scripts', 'hotspots.mjs');
const CALIBRATE = join(root, 'plugin', 'scripts', 'calibrate.mjs');
const SURFACES = join(root, 'plugin', 'scripts', 'surfaces.mjs');
const ENTROPY = join(root, 'plugin', 'scripts', 'entropy.mjs');

let temp;
before(() => { temp = mkdtempSync(join(tmpdir(), 'devanity-scripts-')); });
after(() => { rmSync(temp, { recursive: true, force: true }); });
let n = 0;
const git = (cwd, ...a) => spawnSync('git', a, { cwd, encoding: 'utf8' });
const commit = (cwd, files, msg) => {
  for (const [rel, text] of Object.entries(files)) { mkdirSync(dirname(join(cwd, rel)), { recursive: true }); writeFileSync(join(cwd, rel), text); }
  git(cwd, 'add', '-A'); git(cwd, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', msg);
};
const run = (script, args, opts = {}) => {
  const r = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...opts });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
// An environment whose git, for the call naming `cut`, prints a little of the real output and dies,
// as node kills one over maxBuffer; with `flood`, it exits 0 while a child writes past maxBuffer,
// so node sees the overflow after git exited (status 0, ENOBUFS).
const cutGit = (cut, flood = false) => {
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(temp, `cut-git${++n}`); mkdirSync(bin);
  const cutAction = flood ? 'head -c 67108900 /dev/zero & exit 0' : `"${real}" "$@" | head -c 40; kill -KILL $$`;
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" $CUT "*) ${cutAction};; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  return { ...process.env, CUT: cut, PATH: `${bin}:${process.env.PATH}` };
};

test('hotspots: change frequency over a fixed window from HEAD, tracked files only, frequency × lines, same HEAD same ranking', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'src/a.js': '1\n2\n3\n', 'src/b.js': '1\n', 'docs/x.md': 'x\n' }, 'one');
  commit(d, { 'src/a.js': '1\n2\n3\n4\n' }, 'two');
  commit(d, { 'src/a.js': '1\n2\n3\n4\n5\n', 'src/gone.js': 'x\n' }, 'three');
  git(d, 'rm', '-q', 'src/gone.js'); git(d, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'four');
  const r = run(HOTSPOTS, ['--json', '--', 'src'], { cwd: d });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.frequency, 'measured');
  assert.equal(j.commits, 4); assert.equal(j.whole_history, true, 'fewer commits than the window: the ranking covers the whole history');
  assert.deepEqual(j.files.map((f) => [f.path, f.commits, f.lines, f.priority]), [['src/a.js', 3, 5, 15], ['src/b.js', 1, 1, 1]], 'a deleted path drops out; docs is out of scope');
  assert.deepEqual(JSON.parse(run(HOTSPOTS, ['--json', '--', 'src'], { cwd: d }).out), j, 'deterministic for the same HEAD');
  const text = run(HOTSPOTS, ['--', 'src'], { cwd: d }).out;
  assert.match(text, /whole history/); assert.match(text, /src\/a\.js/);
});

test('hotspots: a shallow clone makes frequency UNKNOWN instead of extrapolating', () => {
  const src = join(temp, `r${++n}`); mkdirSync(src); git(src, 'init', '-q');
  for (let i = 0; i < 3; i++) commit(src, { 'a.js': `${i}\n` }, `c${i}`);
  const shallow = join(temp, `s${n}`);
  git(temp, 'clone', '-q', '--depth', '1', `file://${src}`, shallow);
  const j = JSON.parse(run(HOTSPOTS, ['--json'], { cwd: shallow }).out);
  assert.equal(j.frequency, 'UNKNOWN'); assert.deepEqual(j.files, []);
});

test('calibrate: median, p90 and max; the limit sits where only genuine outliers report, and they go to the baseline', () => {
  const lines = ['10 a.js', '12 b.js', '11 c.js', '13 d.js', '12 e.js', '11 f.js', '95 god.js'].join('\n');
  const j = JSON.parse(run(CALIBRATE, ['--json'], { input: lines }).out);
  assert.equal(j.n, 7); assert.equal(j.median, 12); assert.equal(j.max, 95);
  assert.equal(j.limit, 13, 'the largest value inside the fence: nothing but the outlier reports');
  assert.deepEqual(j.baseline, [{ value: 95, label: 'god.js' }]);
  const flat = JSON.parse(run(CALIBRATE, ['--json'], { input: '5 a\n6 b\n7 c\n' }).out);
  assert.equal(flat.limit, 7, 'no outliers: the limit is today\'s max'); assert.deepEqual(flat.baseline, []);
  const bad = run(CALIBRATE, [], { input: 'ten a.js\n' });
  assert.equal(bad.code, 1); assert.match(bad.err, /not a number/);
});

test('hotspots: non-ASCII and spaced names are counted, a subdirectory sees the same ranking, bad arguments are refused', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'src/é.js': '1\n2\n', 'src/a b.js': '1\n' }, 'one');
  commit(d, { 'src/é.js': '1\n2\n3\n' }, 'two');
  const top = JSON.parse(run(HOTSPOTS, ['--json', '--', 'src'], { cwd: d }).out);
  assert.deepEqual(top.files.map((f) => [f.path, f.commits, f.lines]), [['src/é.js', 2, 3], ['src/a b.js', 1, 1]]);
  const sub = JSON.parse(run(HOTSPOTS, ['--json'], { cwd: join(d, 'src') }).out);
  assert.deepEqual(sub.files.map((f) => f.path), ['src/é.js', 'src/a b.js'], 'paths are repository paths wherever it runs');
  for (const args of [['--window', 'abc'], ['--top'], ['--window', '0']]) {
    const r = run(HOTSPOTS, args, { cwd: d });
    assert.equal(r.code, 1, `${args.join(' ')} must be refused`); assert.match(r.err, /usage/);
  }
  const empty = join(temp, `e${n}`); mkdirSync(empty); git(empty, 'init', '-q');
  const r = run(HOTSPOTS, ['--json'], { cwd: empty });
  assert.equal(r.code, 0, r.err); assert.equal(JSON.parse(r.out).commits, 0);
});

test('calibrate: only decimal numbers are values', () => {
  for (const v of ['0x10', '0b101', '1e999', '']) {
    if (!v) continue;
    const r = run(CALIBRATE, [], { input: `${v} a\n` });
    assert.equal(r.code, 1, `${v} is not a decimal value`);
  }
  assert.equal(JSON.parse(run(CALIBRATE, ['--json'], { input: '-2.5 a\n1e2 b\n' }).out).max, 100);
});

test('hotspots: absolute and magic scopes from a subdirectory, names git would quote, and non-decimal numbers', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'src/q"uo\\te.js': '1\n2\n', 'src/t\tab.js': '1\n', 'lib/x.js': '1\n' }, 'one');
  const sub = join(d, 'lib');
  const abs = JSON.parse(run(HOTSPOTS, ['--json', '--', join(d, 'src')], { cwd: sub }).out);
  assert.deepEqual(abs.files.map((f) => [f.path, f.lines]).sort(), [['src/q"uo\\te.js', 2], ['src/t\tab.js', 1]]);
  // Magic pathspecs are git's to resolve, from where the command runs: `top` anchors at the root.
  const top = JSON.parse(run(HOTSPOTS, ['--json', '--', ':(top,glob)src/*.js'], { cwd: sub }).out);
  assert.equal(top.files.length, 2);
  const here = JSON.parse(run(HOTSPOTS, ['--json', '--', ':(glob)*.js'], { cwd: sub }).out);
  assert.deepEqual(here.files.map((f) => f.path), ['lib/x.js']);
  assert.equal(run(HOTSPOTS, ['--window', '0x10'], { cwd: d }).code, 1);
  assert.equal(run(HOTSPOTS, ['--window=2'], { cwd: d }).code, 1, 'an option it does not know is refused, not ignored');
});

test('hotspots: a name that starts with a newline keeps it, and an absolute scope through a symlink resolves', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { '\nfoo': 'a\n', 'foo': 'b\n' }, 'one');
  commit(d, { '\nfoo': 'a\nb\n' }, 'two');
  const j = JSON.parse(run(HOTSPOTS, ['--json'], { cwd: d }).out);
  assert.deepEqual(j.files.map((f) => [f.path, f.commits]).sort(), [['\nfoo', 2], ['foo', 1]]);
  const link = join(temp, `link${n}`); symlinkSync(d, link);
  const r = run(HOTSPOTS, ['--json', '--', join(link, 'foo')], { cwd: link });
  assert.equal(r.code, 0, r.err); assert.deepEqual(JSON.parse(r.out).files.map((f) => f.path), ['foo']);
  // A scope means what it means to git: a tracked symlink is the link, absolute or relative alike,
  // and a deleted path through the symlinked root is still history, not an error.
  symlinkSync('sub', join(d, 'link')); commit(d, { 'sub/s.txt': 's\n' }, 'link');
  const rel = JSON.parse(run(HOTSPOTS, ['--json', '--', 'link'], { cwd: d }).out);
  const abs = JSON.parse(run(HOTSPOTS, ['--json', '--', join(link, 'link')], { cwd: link }).out);
  assert.deepEqual(abs.files, rel.files); assert.deepEqual(rel.files.map((f) => f.path), ['link']);
  assert.equal(run(HOTSPOTS, ['--json', '--', join(link, 'gone', 'x.js')], { cwd: link }).code, 0);
});

test('surfaces: every instruction file with its load class and bytes, and each reference that resolves to nothing', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  const claude = [
    '# Repo', '',
    'Run `npm run test`, then `pnpm run -w lint`.',
    'Code lives in `src/app.js`; the old entry was `src/gone.js:12`.',
    'Base is `origin/main`; generated output is `src/gen.js`.',
    'See [the guide](docs/guide.md) and [the gone page](docs/missing.md#top).',
    '', '```text', 'src/inside-a-fence.js', '```', '',
  ].join('\n');
  commit(d, {
    'CLAUDE.md': claude,
    'src/app.js': '1\n', '.gitignore': 'src/gen.js\n', 'docs/guide.md': 'g\n',
    'package.json': JSON.stringify({ scripts: { test: 'node -e 0' } }),
    'packages/a/CLAUDE.md': 'scoped: `lib/none.js` is an example; no lib/ here or at the root\n',
    '.claude/rules/edit.md': '---\npaths:\n  - \'src/**\'\n---\nrule\n',
    '.claude/rules/always.md': 'rule\n',
    '.claude/CLAUDE.md': 'memory\n',
    'skills/s/SKILL.md': 'see [ref](ref.md)\n', 'skills/s/ref.md': 'r\n',
  }, 'one');
  const r = run(SURFACES, ['--json'], { cwd: d });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  assert.deepEqual(j.surfaces.map((s) => [s.path, s.load]), [
    ['.claude/CLAUDE.md', 'always'], ['.claude/rules/always.md', 'always'], ['.claude/rules/edit.md', 'scoped'], ['CLAUDE.md', 'always'],
    ['packages/a/CLAUDE.md', 'scoped'], ['skills/s/SKILL.md', 'on-demand'], ['skills/s/ref.md', 'on-demand'],
  ]);
  assert.equal(j.surfaces.find((s) => s.path === 'CLAUDE.md').bytes, Buffer.byteLength(claude));
  assert.equal(j.totals.always, Buffer.byteLength(claude) + 'rule\n'.length + 'memory\n'.length, '.claude/CLAUDE.md is project memory, loaded always');
  assert.deepEqual(j.unresolved.map((u) => [u.path, u.line, u.kind, u.target]), [
    ['CLAUDE.md', 3, 'script', 'lint'],
    ['CLAUDE.md', 4, 'path', 'src/gone.js'],
    ['CLAUDE.md', 6, 'path', 'docs/missing.md'],
  ], 'a ref outside the repository (origin/main), a nested example under no existing directory, and a gitignored path are not claims; fenced text is not a code span');
  assert.match(run(SURFACES, [], { cwd: d }).out, /CLAUDE\.md:4\s+path\s+src\/gone\.js/);
});

test('surfaces: with no package.json there is nothing to check a script against, so none is reported', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'AGENTS.md': 'Run `npm run build`.\n' }, 'one');
  assert.deepEqual(JSON.parse(run(SURFACES, ['--json'], { cwd: d }).out).unresolved, []);
});

test('surfaces: a git call that does not finish stops the inventory: partial output is never reported', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'AGENTS.md': 'See `src/gone.js`.\n', 'src/a.js': '1\n' }, 'one');
  for (const cut of ['ls-files', 'check-ignore']) {
    const r = run(SURFACES, [], { cwd: d, env: cutGit(cut) });
    assert.equal(r.code, 1, `${cut}:\n${r.out}`);
    assert.match(r.err, new RegExp(`git ${cut} did not finish`), `${cut}:\n${r.err}`);
  }
});

test('surfaces: a batch git refuses that outgrows the pipe buffer still falls back path by path (git finished: exit 128, EPIPE on its stdin)', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { '.gitignore': 'dist/\n', 'a.md': 'a\n' }, 'one');
  // A git whose first check-ignore refuses the batch before reading it, as git does on a path outside the repository.
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  const bin = join(temp, `refuse-git${n}`); mkdirSync(bin);
  writeFileSync(join(bin, 'git'), `#!/bin/sh\ncase " $* " in *" check-ignore "*) [ -e "$MARK" ] || { : > "$MARK"; exit 128; };; esac\nexec "${real}" "$@"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`; process.env.MARK = join(bin, 'refused');
  try {
    const paths = Array.from({ length: 300 }, (_, i) => `dist/${`${'a'.repeat(200)}/`.repeat(12)}${i}`);   // ~750 KB, past any pipe buffer
    assert.equal(gitIgnored(d)(paths).size, 300);
  } finally { process.env.PATH = PATH; delete process.env.MARK; }
});

test('hotspots: a git call that does not finish stops the ranking: no empty result stands in for it', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'a.js': '1\n' }, 'one');
  let r = run(HOTSPOTS, ['--json'], { cwd: d, env: cutGit('--verify') });
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /git rev-parse did not finish/);
  // git exited before node saw the overflow: status 0 beside ENOBUFS is still a cut output
  r = run(HOTSPOTS, ['--json'], { cwd: d, env: cutGit('ls-files', true) });
  assert.equal(r.code, 1, r.out);
  assert.match(r.err, /git ls-files did not finish \(ENOBUFS\)/);
});

test('surfaces: run through a symlinked path it still reports (an install path may hold a symlink)', () => {
  const d = join(temp, `r${++n}`); mkdirSync(d); git(d, 'init', '-q');
  commit(d, { 'AGENTS.md': 'See `src/gone.js`.\n', 'src/a.js': '1\n' }, 'one');
  const link = join(temp, `scripts-link${n}`); symlinkSync(dirname(SURFACES), link);
  const r = run(join(link, 'surfaces.mjs'), ['--json'], { cwd: d });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(JSON.parse(r.out).unresolved.map((u) => u.target), ['src/gone.js']);
});

test('entropy: duplication by 5-line window, new suppressions and new casts between two revisions, over the changed text files only (A3.2)', () => {
  const d = join(temp, `e${++n}`); mkdirSync(d); git(d, 'init', '-q', '-b', 'main');
  const block = ['const a = read(x);', 'if (!a) {', '  return fail(1);', '}', 'const b = parse(a);', 'return b.value;'].join('\n');
  // a Latin-1 text file (not UTF-8, no NUL) and a path with a newline sort before the changed file: neither may shift the batch parse
  commit(d, { 'README': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]), 'a\nb.js': 'const q = 1;\n', 'src/a.js': `${block}\nexport default 1;\n`, 'src/c.js': 'const c = 3;\n' }, 'base');
  commit(d, { 'src/b.js': `function g() {\n${block}\n}\n// eslint-disable-next-line no-console\nconsole.log(x as any);\n`, 'bin.dat': Buffer.from([0, 1, 2, 0, 3]), 'src/c.js': 'const c = 3;\n' }, 'change');
  let r = run(ENTROPY, ['--base', 'HEAD~1', '--json'], { cwd: d });
  assert.equal(r.code, 0, r.err);
  const j = JSON.parse(r.out);
  // b.js is the one changed text file (bin.dat is binary, c.js unchanged); its two 5-line windows both exist in a.js, so it carries 2 copied windows; before the change it did not exist
  assert.deepEqual({ files: j.files, dup: j.duplication, sup: j.suppressions, casts: j.casts, worse: j.worse }, { files: 1, dup: { before: 0, after: 2, delta: 2 }, sup: { before: 0, after: 1, delta: 1 }, casts: { before: 0, after: 1, delta: 1 }, worse: true });
  r = run(ENTROPY, ['--base', 'HEAD~1'], { cwd: d });
  assert.match(r.out, /entropy HEAD~1\.\.HEAD: 1 file · duplication 0 → 2 \(\+2\) · suppressions 0 → 1 \(\+1\) · casts 0 → 1 \(\+1\)/, r.out);
  commit(d, { 'src/b.js': 'function g() { return 1; }\n' }, 'cleanup');
  r = run(ENTROPY, ['--base', 'HEAD~1', '--json'], { cwd: d });
  assert.deepEqual(JSON.parse(r.out).duplication, { before: 2, after: 0, delta: -2 });
  assert.equal(JSON.parse(r.out).worse, false);
  r = run(ENTROPY, ['--base', 'HEAD~2', '--json', '--', 'src/c.js'], { cwd: d });
  assert.equal(JSON.parse(r.out).files, 0, 'a scope narrows the set to what changed under it');
  assert.equal(run(ENTROPY, ['--bogus'], { cwd: d }).code, 1);
});
