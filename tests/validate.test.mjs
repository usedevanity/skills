// Dependency-free self-test for the validator (node:test). Run: node --test tests/validate.test.mjs
// One test per invariant that breaks an install or a mode silently; the validator lints no prose.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { validate, checkRelativeLinks, checkSkillTotal, KERNEL_TOKEN_CAP } from '../scripts/validate.mjs';

const fm = (name, extra = '') => `---\nname: ${name}\ndescription: test skill\n${extra}---\n\n# ${name}\n`;

// Build a temp skills/ dir containing one skill, run fn(skillsDir), always clean up.
const withSkill = (name, skillMd, fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'skilltest-'));
  try {
    mkdirSync(join(dir, name, 'modes'), { recursive: true });
    mkdirSync(join(dir, name, 'reference'), { recursive: true });
    writeFileSync(join(dir, name, 'SKILL.md'), skillMd);
    fn(dir, (path, text) => writeFileSync(join(dir, name, path), text));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};
const failsWith = (errors, fragment) => assert.ok(errors.some((e) => e.includes(fragment)), `expected "${fragment}" in: ${errors.join('; ')}`);

test('a valid skill passes; an empty skills dir does not', () => {
  withSkill('foo', fm('foo'), (dir) => assert.deepEqual(validate(dir), []));
  const empty = mkdtempSync(join(tmpdir(), 'skilltest-'));
  try { failsWith(validate(empty), 'no skills found'); } finally { rmSync(empty, { recursive: true, force: true }); }
});

test('frontmatter name must match the directory', () => {
  withSkill('foo', fm('bar'), (dir) => failsWith(validate(dir), 'frontmatter name "bar"'));
});

test('a reference to a missing file fails; one inside a fence is an example, not a reference', () => {
  withSkill('foo', `${fm('foo')}\nSee \`reference/nope.md\`.\n`, (dir) => failsWith(validate(dir), 'missing reference/nope.md'));
  withSkill('foo', `${fm('foo')}\n\`\`\`\n\`reference/inside-fence.md\`\n\`\`\`\n`, (dir) => assert.deepEqual(validate(dir), []));
});

test('argument-hint must equal the mode set; a routed verb counts, a route to a missing file fails', () => {
  withSkill('foo', fm('foo', "argument-hint: 'plan|review [x]'\n"), (dir, write) => {
    write('modes/plan.md', '# plan\n');
    failsWith(validate(dir), '!= argument-hint');
    write('modes/review.md', '# review\n');
    assert.deepEqual(validate(dir), []);
  });
  const routed = (target) => `${fm('foo', "argument-hint: '[plan|debt] [args]'\n")}\n| Mode | Read |\n|---|---|\n| \`plan\` | \`${target}\` |\n`;
  withSkill('foo', routed('reference/plan.md'), (dir, write) => {
    write('modes/debt.md', '# debt\n');
    write('reference/plan.md', '# plan\n');
    assert.deepEqual(validate(dir), []);
  });
  withSkill('foo', routed('reference/ghost.md'), (dir, write) => {
    write('modes/debt.md', '# debt\n');
    failsWith(validate(dir), 'routes "plan" to missing reference/ghost.md');
  });
});

test('a mode may cite only the references its Load: line or table row declares', () => {
  withSkill('foo', fm('foo'), (dir, write) => {
    for (const f of ['a.md', 'b.md']) write(`reference/${f}`, '# r\n');
    write('modes/go.md', 'Load: `reference/a.md`, `reference/b.md`.\n\nSee `reference/a.md`.\n');
    write('modes/quiet.md', '# cites nothing, declares nothing\n');
    assert.deepEqual(validate(dir), [], 'declaring more than is cited passes');
    write('modes/go.md', 'Load: `reference/a.md`.\n\nSee `reference/b.md`.\n');
    failsWith(validate(dir), 'cites reference/b.md but its declaration');
    write('modes/go.md', 'See `reference/b.md`.\n');
    failsWith(validate(dir), 'declares none');
  });
});

test('the kernel over its token cap fails, and a typographic character is a whole token', () => {
  withSkill('foo', fm('foo') + 'x'.repeat((KERNEL_TOKEN_CAP + 200) * 4) + '\n', (dir) => failsWith(validate(dir), 'kernel max'));
  // By chars/4 these would be ~500 tokens and pass; counted 1:1 they are over the cap.
  withSkill('foo', `${fm('foo')}\n${'—'.repeat(KERNEL_TOKEN_CAP + 200)}\n`, (dir) => failsWith(validate(dir), 'kernel max'));
});

test('a rung cited by number must exist in the kernel ladder; inline code is not a citation', () => {
  const ladder = `${fm('foo')}\n1. **Does it need to change?** No.\n2. **Trivial?** Do it.\n3. **Behavior?** Test first.\n`;
  withSkill('foo', ladder, (dir, write) => {
    write('modes/go.md', '# go\n\nWatch it fail (kernel rung 3); `rung 9` is quoted.\n');
    assert.deepEqual(validate(dir), []);
    write('modes/go.md', '# go\n\nPropose and stop (kernel rung 4).\n');
    failsWith(validate(dir), 'modes/go.md:3 cites "rung 4"');
  });
});

test('a README command must name an existing mode; prose mentions are not commands', () => {
  withSkill('foo', fm('foo'), (dir, write) => {
    write('modes/plan.md', '# plan\n');
    write('README.md', 'Run /foo on any PR, or `/foo plan x`.\n');
    assert.deepEqual(validate(dir), []);
    write('README.md', 'Run `/foo bogus` to start.\n');
    failsWith(validate(dir), '/foo bogus');
  });
});

test('a relative link to a missing path fails; external, anchor and fenced links pass', () => {
  const dir = mkdtempSync(join(tmpdir(), 'linktest-'));
  try {
    const file = join(dir, 'README.md');
    writeFileSync(file, '[gone](templates/kit)\n');
    failsWith(checkRelativeLinks(file), 'links to missing templates/kit');
    writeFileSync(file, '[self](README.md) [site](https://example.com) [below](#x)\n```md\n[example](does/not/exist.md)\n```\n');
    assert.deepEqual(checkRelativeLinks(file), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill total over its ratchet budget fails; within passes; a missing entry fails', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ratchet-'));
  try {
    mkdirSync(join(dir, 'foo', 'reference'), { recursive: true });
    writeFileSync(join(dir, 'foo', 'SKILL.md'), 'x'.repeat(600));
    writeFileSync(join(dir, 'foo', 'reference', 'big.md'), 'y'.repeat(600));
    failsWith(checkSkillTotal(dir, { foo: 1000 }), 'raise SKILL_TOTAL_BUDGETS');
    assert.deepEqual(checkSkillTotal(dir, { foo: 2000 }), []);
    failsWith(checkSkillTotal(dir, {}), 'no total-size budget');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- the repository around the skill (checkRepository), on a mutated copy of this repository ---
import { cpSync, readFileSync as readText, appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { checkRepository } from '../scripts/validate.mjs';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..');
const withRepoCopy = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'repotest-'));
  try {
    for (const f of spawnSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' }).stdout.trim().split('\n')) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(repoRoot, f), join(dir, f));
    }
    fn(dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
};

test('a blocking [DECIDE] example in a skill file carries its derivation line; one without fails; a dormant one-liner needs none (A2.2)', () => {
  const block = (extra) => ['- **[DECIDE][blocking][G-001][rule] Round refunds up?**', '  - decision: how refunds round', extra, '  - context: the ticket asks; no rule exists · anchors G-002', '  - options: up → simpler · half-even → fairer · no-op → manual', '  - recommendation: up; one line of code', '  - if undecided: refund() stays a failing stub'].filter(Boolean).join('\n');
  withSkill('foo', fm('foo'), (dir, write) => { write('reference/x.md', `# x\n\n${block('  - derivation: tried P-001 (amounts are integer cents); it says nothing about rounding')}\n`); assert.deepEqual(validate(dir), []); });
  withSkill('foo', fm('foo'), (dir, write) => { write('reference/x.md', `# x\n\n${block('')}\n`); failsWith(validate(dir), 'derivation'); });
  withSkill('foo', fm('foo'), (dir, write) => { write('reference/x.md', '# x\n\n- [DECIDE][dormant][G-003][trade] Later — worth doing when it hurts — anchors K\n'); assert.deepEqual(validate(dir), []); });
});

test('the repository copy passes; each way of pointing outside the installed plugin fails', () => {
  withRepoCopy((dir) => {
    assert.deepEqual(checkRepository(dir), []);
    const hook = join(dir, 'plugin/hooks/devanity-mode.js');
    const original = readText(hook, 'utf8');
    for (const line of ['// GUARDRAIL 13', '// Guardrail 13 applies', '// see PLAN.', '// (F2.2b)', '// the grammar is in docs/hooks.md', '// see CONTRIBUTING.md',
      '// node "${CLAUDE_PLUGIN_ROOT}/../scripts/validate.mjs"', '// node "$CLAUDE_PLUGIN_ROOT/scripts/nope.mjs"', '// ${CLAUDE_PLUGIN_ROOT}/scripts/../../scripts/kernel.mjs',
      '// guardrail  12', '// guardrail-12', '// Guardrails #12', '// node "${CLAUDE_PLUGIN_ROOT}"/scripts/nope.mjs',
      '// "command": "node \\"${CLAUDE_PLUGIN_ROOT}\\"/../scripts/validate.mjs"', '// ${CLAUDE_PLUGIN_ROOT}//../hooks/devanity-mode.js', '// ${CLAUDE_PLUGIN_ROOT:-.}/../x.mjs',
      '// ${CLAUDE_PLUGIN_ROOT:-${HOME}}/../x.mjs', '// node ${CLAUDE_PLUGIN_ROOT:?unset}/../scripts/validate.mjs', '// node ${CLAUDE_PLUGIN_ROOT-.}/../scripts/validate.mjs', '// ${CLAUDE_PLUGIN_ROOT%/}/../x.mjs',
      `// \${CLAUDE_PLUGIN_ROOT:-${'d'.repeat(120)}}/../x.mjs`, '// the grammar is in ./docs/hooks.md', '// see docs/hooks for the grammar', '// guard-rail 12', '// see evals/RUNBOOK.md', '// evals/kernel-sentences.md']) {
      writeFileSync(hook, original); appendFileSync(hook, `\n${line}\n`);
      assert.ok(checkRepository(dir).some((e) => e.includes('plugin/hooks/devanity-mode.js')), `not caught: ${line}`);
    }
    writeFileSync(hook, original);
    for (const ok of ['// the plan mode, then /devanity plan', '// an F1 score, press F5', '// https://github.com/usedevanity/skills/tree/main/evals/harness', '// Deterministic Guardrails',
      '// Keep your own evals/ directory next to the code.', '// see docs/adr/0001-queue.md', '// press [F5] to reload, (F1) is help', '// Guardrails 2026 edition',
      '// node ${CLAUDE_PLUGIN_ROOT:-/opt/x}/hooks/devanity-mode.js', '// node ${CLAUDE_PLUGIN_ROOT:-$HOME/.x}/hooks/devanity-mode.js',
      "// const env = {ROOT:'${CLAUDE_PLUGIN_ROOT}',BIN:'/usr/bin'}", '// ${CLAUDE_PLUGIN_ROOT_DIR}/elsewhere/x.mjs', '// Write the decision record under your own docs/.', '// Keep the cases in your evals/...']) {
      writeFileSync(hook, original); appendFileSync(hook, `\n${ok}\n`);
      assert.deepEqual(checkRepository(dir), [], `false positive: ${ok}`);
    }
    writeFileSync(hook, original);
    // A hostile line stays linear: no pattern scans ahead from every `${`.
    appendFileSync(hook, `\n// \${CLAUDE_PLUGIN_ROOT:-${'${'.repeat(40000)}\n`);
    const t = Date.now(); checkRepository(dir);
    assert.ok(Date.now() - t < 1500, `validation took ${Date.now() - t} ms`);
    writeFileSync(hook, original);
    // Every file that installs is read, whatever its extension.
    writeFileSync(join(dir, 'plugin/scripts/probe.js'), '// GUARDRAIL 12, see docs/hooks.md\n');
    assert.ok(checkRepository(dir).some((e) => e.includes('plugin/scripts/probe.js')), 'a .js file under plugin/ is read');
  });
});
