/**
 * Tests for scripts/gate.sh, the gate-capture wrapper.
 *
 * Every case here corresponds to one of the three ways a gate's verdict has
 * actually been lost, so none of them is hypothetical:
 *
 *   1. `.tmp-gates/` not existing, a fresh worktree has no such directory, so
 *      the usual remedy (`npm test > .tmp-gates/out.txt`)
 *      fails at SHELL level before the gate runs, and bash's "No such file or
 *      directory" reads like the gate exploding. The wrapper must create it.
 *   2. The verdict landing only on stdout, in
 *      `npm test > .tmp-gates/out.txt 2>&1; echo "EXIT:$?"` the `echo` goes to
 *      the terminal, so the captured file has no verdict in it. The wrapper
 *      must write the verdict INTO the log.
 *   3. A backgrounded run's exit code being untrustworthy in both directions
 *      (three failing suites reported as exit 0). The wrapper cannot
 *      fix the harness, but the captured log must carry an unambiguous
 *      `EXIT:<n>` a reader can check against the exit code they were handed.
 *
 * The tests run the script against a COPY in a temp directory, because the
 * script resolves its `.tmp-gates/` from its own location, asserting that it
 * creates the directory is only meaningful where the directory is absent, and
 * the real worktree's may well exist.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Remove a scratch directory without ever throwing out of a `finally` (which would replace a
 * real assertion's message). Only "something still holds a handle" codes are swallowed, and
 * loudly; any other error is rethrown.
 */
function removeTempDir(dir, context = 'test') {
  if (!dir) return true;
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (err) {
    if (!['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES'].includes(err?.code)) throw err;
    process.stderr.write(`\n[cleanup] ${context}: could not remove scratch dir ${dir} (${err.code}); left on disk\n\n`);
    return false;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GATE_SH = path.join(HERE, 'gate.sh');

/** Copy gate.sh into a throwaway fake repo root and return that root. */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.copyFileSync(GATE_SH, path.join(root, 'scripts', 'gate.sh'));
  return root;
}

/** Same as fixture(), plus a package.json declaring the given npm `scripts`. */
function fixtureWithScripts(scripts) {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts }));
  return root;
}

/** Run the copied wrapper with `args`, from `root`. */
function runGate(root, args) {
  return spawnSync('bash', [path.join(root, 'scripts', 'gate.sh'), ...args], {
    cwd: root,
    encoding: 'utf8',
  });
}

test('creates .tmp-gates/ when it does not exist, the hole in the usual redirect-into-.tmp-gates remedy', () => {
  const root = fixture();
  try {
    assert.equal(fs.existsSync(path.join(root, '.tmp-gates')), false, 'precondition: no .tmp-gates yet');

    const res = runGate(root, ['--name', 'ok', 'bash', '-c', 'echo ran']);

    assert.equal(res.status, 0, `wrapper should pass the gate's exit through: ${res.stderr}`);
    assert.ok(fs.existsSync(path.join(root, '.tmp-gates', 'ok.log')), 'the log was created');
    assert.match(res.stdout, /\bran\b/, "the gate's own output still streams to stdout");
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('--name is a bounded plain slug: a path-shaped name is a usage error, never a stray write', () => {
  const root = fixture();
  try {
    for (const bad of ['../escape', 'a/b', '/abs', '.hidden', '..', 'x'.repeat(61), 'sp ace']) {
      const res = runGate(root, ['--name', bad, 'bash', '-c', 'echo should-not-run']);
      assert.equal(res.status, 2, `--name ${JSON.stringify(bad)} should be refused: ${res.stderr}`);
      assert.match(res.stderr, /--name must be/);
      assert.doesNotMatch(res.stdout, /should-not-run/, 'the gate must not run under a refused name');
    }
    assert.equal(fs.existsSync(path.join(root, 'escape.log')), false, 'nothing written outside .tmp-gates/');
    const ok = runGate(root, ['--name', 'Types-1.2_x', 'bash', '-c', 'echo ran']);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(fs.existsSync(path.join(root, '.tmp-gates', 'Types-1.2_x.log')));
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('the verdict lands INSIDE the log, not only on stdout', () => {
  const root = fixture();
  try {
    runGate(root, ['--name', 'verdict', 'bash', '-c', 'echo body; exit 7']);
    const log = fs.readFileSync(path.join(root, '.tmp-gates', 'verdict.log'), 'utf8');

    assert.match(log, /EXIT:7/, 'the captured artefact carries the verdict');
    assert.match(log, /\bbody\b/, "the gate's output is captured too");
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test("exits with the gate's own status, and says so on stdout as well", () => {
  const root = fixture();
  try {
    const ok = runGate(root, ['bash', '-c', 'exit 0']);
    assert.equal(ok.status, 0);
    assert.match(ok.stdout, /EXIT:0/);

    const bad = runGate(root, ['bash', '-c', 'exit 42']);
    assert.equal(bad.status, 42, 'a failing gate must not be laundered into a green wrapper');
    assert.match(bad.stdout, /EXIT:42/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('stderr is captured as well as stdout, a gate that only complains on stderr is still judged', () => {
  const root = fixture();
  try {
    runGate(root, ['--name', 'err', 'bash', '-c', 'echo boom >&2; exit 1']);
    const log = fs.readFileSync(path.join(root, '.tmp-gates', 'err.log'), 'utf8');

    assert.match(log, /boom/, 'stderr reached the log');
    assert.match(log, /EXIT:1/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('two different gates do not overwrite one another when --name is omitted', () => {
  const root = fixture();
  try {
    runGate(root, ['bash', '-c', 'echo first']);
    runGate(root, ['bash', '-c', 'echo second']);

    const logs = fs.readdirSync(path.join(root, '.tmp-gates'));
    assert.equal(logs.length, 2, `expected one log per distinct command, got ${logs.join(', ')}`);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('no arguments is a loud usage error, never a silent green', () => {
  const root = fixture();
  try {
    const res = runGate(root, []);
    assert.notEqual(res.status, 0, 'an empty invocation must not report success');
    assert.match(res.stderr, /usage:/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('the whole gate passed as ONE quoted string gets a usage hint, not exit 127', () => {
  const root = fixture();
  try {
    const res = runGate(root, ['npm run type-check:unit-tests']);

    assert.notEqual(res.status, 127, 'must not read like a broken gate');
    assert.equal(res.status, 2, 'a usage error, same convention as the other misuse checks');
    assert.match(res.stderr, /did you mean: bash scripts\/gate\.sh npm run type-check:unit-tests/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('a bare npm-script name gets a usage hint naming `npm run`, not exit 127', () => {
  const root = fixtureWithScripts({ build: "node -e \"console.log('ran')\"" });
  try {
    const res = runGate(root, ['build']);

    assert.notEqual(res.status, 127, 'must not read like a broken gate');
    assert.equal(res.status, 2, 'a usage error, same convention as the other misuse checks');
    assert.match(res.stderr, /did you mean: bash scripts\/gate\.sh npm run build/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('a bare script name that ALSO resolves on PATH (`test`) still gets the hint, not a silent exit 1', () => {
  const root = fixtureWithScripts({ test: "node -e \"console.log('ran')\"" });
  try {
    const res = runGate(root, ['test']);

    assert.equal(res.status, 2, `test(1) must not run and fail silently: ${res.stderr}`);
    assert.match(res.stderr, /did you mean: bash scripts\/gate\.sh npm run test/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('multiple bare npm script names get a one-command-per-invocation hint', () => {
  const root = fixtureWithScripts({ lint: 'echo lint-ran', 'type-check': 'echo type-check-ran' });
  try {
    const res = runGate(root, ['lint', 'type-check']);

    assert.equal(res.status, 2, 'a list of script names is a usage error');
    assert.match(res.stderr, /one command per invocation/);
    assert.match(res.stderr, /bash scripts\/gate\.sh --name lint npm run lint && bash scripts\/gate\.sh --name type-check npm run type-check/);
    assert.doesNotMatch(res.stdout, /lint-ran|type-check-ran/, 'neither listed script should run in the mistaken form');
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('a name that is NOT an npm script still falls through to the normal exec (real 127)', () => {
  const root = fixtureWithScripts({ build: 'echo building' });
  try {
    const res = runGate(root, ['definitely-not-a-real-command-or-script']);

    assert.notEqual(res.status, 2, 'only a real npm-script match gets the hint, not any unresolved word');
    assert.doesNotMatch(res.stderr, /did you mean/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

// Prints each of `lines` on its own line, then exits with `exitCode`, every
// fixture line travels as its own argv element (never interpolated into a
// shell string), so embedded `:`, `,` and whitespace can never be misparsed.
function printLinesThenExit(lines, exitCode) {
  return ['bash', '-c', `for l in "$@"; do printf '%s\\n' "$l"; done; exit ${Number(exitCode)}`, '_', ...lines];
}

test('a jest-shaped log gets its Test Suites/Tests summary echoed next to the verdict', () => {
  const root = fixture();
  try {
    const jestLines = [
      'PASS src/lib/foo.test.ts',
      'FAIL src/lib/bar.test.ts',
      '',
      'Test Suites: 1 failed, 1 passed, 2 total',
      'Tests:       2 failed, 10 passed, 12 total',
      'Time:        1.234 s',
    ];

    const res = runGate(root, ['--name', 'jest', ...printLinesThenExit(jestLines, 1)]);
    const log = fs.readFileSync(path.join(root, '.tmp-gates', 'jest.log'), 'utf8');

    assert.match(res.stdout, /Test Suites: 1 failed, 1 passed, 2 total/, 'summary reaches stdout, not just the log');
    assert.match(res.stdout, /Tests:\s+2 failed, 10 passed, 12 total/);
    assert.match(log, /Test Suites: 1 failed, 1 passed, 2 total/, 'summary is also captured in the log');
    assert.match(log, /Tests:\s+2 failed, 10 passed, 12 total/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('a node --test TAP-shaped log gets its # tests/# fail summary echoed next to the verdict', () => {
  const root = fixture();
  try {
    const tapLines = ['TAP version 13', 'ok 1 - some test', '1..1', '# tests 1', '# pass 1', '# fail 0'];

    const res = runGate(root, ['--name', 'tap', ...printLinesThenExit(tapLines, 0)]);
    const log = fs.readFileSync(path.join(root, '.tmp-gates', 'tap.log'), 'utf8');

    assert.match(res.stdout, /# tests 1/, 'TAP summary reaches stdout');
    assert.match(res.stdout, /# fail 0/);
    assert.match(log, /# tests 1/, 'TAP summary is also captured in the log');
    assert.match(log, /# fail 0/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('a log with neither jest nor TAP shape prints a clean verdict and fabricates no summary', () => {
  const root = fixture();
  try {
    const res = runGate(root, ['--name', 'lint', 'bash', '-c', "echo 'no problems found'"]);
    const log = fs.readFileSync(path.join(root, '.tmp-gates', 'lint.log'), 'utf8');

    assert.match(res.stdout, /=== GATE VERDICT: .*EXIT:0 ===/, 'a clean verdict is still printed');
    assert.doesNotMatch(res.stdout, /Test Suites:|# tests /, 'no fabricated summary for a non-test gate');
    assert.doesNotMatch(log, /Test Suites:|# tests /);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});

test('the correct multi-arg form (npm run <script>) still runs normally, no hint', () => {
  const root = fixtureWithScripts({ build: "node -e \"console.log('ran-ok')\"" });
  try {
    const res = runGate(root, ['npm', 'run', 'build']);

    assert.equal(res.status, 0, `expected the gate to actually run: ${res.stderr}`);
    assert.match(res.stdout, /ran-ok/);
    assert.doesNotMatch(res.stderr, /did you mean/);
  } finally {
    removeTempDir(root, 'gate.node-test');
  }
});
