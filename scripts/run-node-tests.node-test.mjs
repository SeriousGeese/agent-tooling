// Tests for the `node --test` attribution wrapper.
//
// The wrapper exists because a `npm run test:scripts` gate was once observed exiting 1
// while reporting `tests 318 / pass 318 / fail 0`, with nothing in the log to
// explain it. Two things must hold forever after:
//
//   1. The wrapper must never MASK a failure — a real failing test still exits
//      nonzero, and the exit code is passed straight through.
//   2. An exit code the summary does not explain must produce a loud, specific
//      banner rather than silence.
//
// The interesting case (nonzero exit + green summary) cannot be provoked on
// demand from a test file — node --test attributes every child-side failure to
// its file and counts it in `fail`, which is itself why the original sighting
// points at the runner's parent process. So the reconciliation logic lives in a
// pure module and is unit-tested directly, while the end-to-end tests cover the
// two shapes that CAN be provoked.
//
// Runs via `npm run test:scripts` -> scripts/*.node-test.mjs.

import { execFileSync, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

import { reconcileExit, teardownCrashCodes, teardownCrashRetryFiles } from './test-support/exit-reconcile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '..');
const WRAPPER = path.join(HERE, 'run-node-tests.mjs');

const tempDirs = [];

function makeFixtureDir(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-node-tests-fixture-'));
  tempDirs.push(dir);
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents, 'utf8');
  }
  return dir;
}

after(() => {
  // Cleanup is synchronous and individually guarded on purpose. An EPERM on
  // Windows (a lingering process still holding the directory)
  // must be reported, not swallowed, and must not itself fail the suite: a temp
  // dir left behind is a leak, not a product defect. And it must never throw
  // asynchronously, which is the exact class of bug this wrapper is about.
  for (const dir of tempDirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      console.error(`[run-node-tests.node-test] warning: could not remove ${dir}: ${err.message}`);
    }
  }
});

/**
 * Run the wrapper, returning { status, stdout, stderr } without throwing.
 *
 * NODE_TEST_CONTEXT must be stripped: node:test sets it in every test child, and
 * a nested `node --test` that sees it inherited assumes IT is the child too — it
 * then reports over the v8 serializer channel instead of running as a runner, so
 * the nested run silently produces no output and exits 0. That would make these
 * tests vacuous rather than failing, which is worse.
 */
function runWrapper(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  try {
    const stdout = execFileSync(process.execPath, [WRAPPER, ...args], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return {
      status: typeof err.status === 'number' ? err.status : 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

// ---------------------------------------------------------------------------
// Pure reconciliation
// ---------------------------------------------------------------------------

test('reconcileExit passes a clean run straight through with no banner', () => {
  const result = reconcileExit({ label: 'x', code: 0, signal: null, summary: null });
  assert.equal(result.exitCode, 0);
  assert.equal(result.message, null);
});

test('reconcileExit fails a clean exit that ran zero tests (a glob that matched nothing)', () => {
  const zero = reconcileExit({ label: 'x', code: 0, signal: null, summary: { sawAnySummary: true, counts: { tests: 0, failed: 0 } } });
  assert.equal(zero.exitCode, 1);
  assert.match(zero.message, /ZERO tests/);
  const some = reconcileExit({ label: 'x', code: 0, signal: null, summary: { sawAnySummary: true, counts: { tests: 3, failed: 0 } } });
  assert.equal(some.exitCode, 0);
});

test('the runner exits nonzero end to end when its glob matches nothing', () => {
  const r = spawnSync(process.execPath, [WRAPPER, 'zero-match', 'no-such-dir/**/*.node-test.mjs'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0, `${r.stdout}${r.stderr}`);
});

// runWrapper drops stderr on a clean exit; the retry banner lives there.
function runWrapperWithStderr(args, cwd, extraEnv = {}) {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [WRAPPER, ...args], { cwd, env, encoding: 'utf8', timeout: 120_000 });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

const CRASH = 3221225477;
const crashSummary = (over = {}) => ({
  sawAnySummary: true,
  counts: { tests: 3, passed: 2, failed: 1 },
  failedFiles: ['/t/a.node-test.mjs'],
  fileExitCodes: { '/t/a.node-test.mjs': CRASH },
  failedSubtestsByFile: {},
  ...over,
});

test('teardownCrashRetryFiles retries only a file that crashed at exit with every subtest green', () => {
  assert.deepEqual(teardownCrashRetryFiles(crashSummary(), [CRASH]), ['/t/a.node-test.mjs']);
});

test('teardownCrashRetryFiles refuses when anything else failed (CI stays strict)', () => {
  assert.deepEqual(teardownCrashRetryFiles(crashSummary({ failedSubtestsByFile: { '/t/a.node-test.mjs': 1 } }), [CRASH]), []);
  assert.deepEqual(teardownCrashRetryFiles(crashSummary({ counts: { failed: 2 } }), [CRASH]), []);
  assert.deepEqual(teardownCrashRetryFiles(crashSummary({ fileExitCodes: { '/t/a.node-test.mjs': 1 } }), [CRASH]), []);
  assert.deepEqual(
    teardownCrashRetryFiles(crashSummary({ failedFiles: ['/t/a.node-test.mjs', '/t/b.node-test.mjs'], counts: { failed: 2 } }), [CRASH]),
    [],
    'one crashed file plus one really failing file is not retried',
  );
  assert.deepEqual(teardownCrashRetryFiles(null, [CRASH]), []);
  assert.deepEqual(teardownCrashRetryFiles(crashSummary(), []), []);
});

test('teardownCrashCodes defaults to 0xC0000005 and honours an override', () => {
  assert.deepEqual(teardownCrashCodes(undefined), [CRASH]);
  assert.deepEqual(teardownCrashCodes('77, 78'), [77, 78]);
  assert.deepEqual(teardownCrashCodes(''), []);
});

test('the runner retries a teardown-crash file once, loudly, and passes when the retry is clean', () => {
  const marker = path.join(os.tmpdir(), `rnt-crash-${process.pid}-${Date.now()}`);
  const dir = makeFixtureDir({
    'crash-once.node-test.mjs': `
      import test from 'node:test';
      import fs from 'node:fs';
      test('passes', () => {});
      if (!fs.existsSync(${JSON.stringify(marker)})) {
        fs.writeFileSync(${JSON.stringify(marker)}, '');
        process.on('exit', () => process.reallyExit(77));
      }
    `,
  });
  try {
    const r = runWrapperWithStderr(['crash-retry', path.join(dir, 'crash-once.node-test.mjs')], REPO_ROOT, {
      AGENT_TOOLING_TEARDOWN_CRASH_EXIT_CODES: '77',
    });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /TEARDOWN CRASH RETRY/);
    assert.match(r.stderr, /retry PASSED/);
  } finally {
    fs.rmSync(marker, { force: true });
  }
});

test('the runner fails when the retried file crashes again, and never retries a real failure', () => {
  const dir = makeFixtureDir({
    'crash-always.node-test.mjs': `
      import test from 'node:test';
      test('passes', () => {});
      process.on('exit', () => process.reallyExit(77));
    `,
    'real-fail.node-test.mjs': `
      import test from 'node:test';
      import assert from 'node:assert/strict';
      test('fails', () => { assert.equal(1, 2); });
    `,
  });
  const again = runWrapperWithStderr(['crash-twice', path.join(dir, 'crash-always.node-test.mjs')], REPO_ROOT, {
    AGENT_TOOLING_TEARDOWN_CRASH_EXIT_CODES: '77',
  });
  assert.notEqual(again.status, 0, `${again.stdout}${again.stderr}`);
  assert.match(again.stderr, /retry FAILED again/);
  const real = runWrapperWithStderr(['real-failure', path.join(dir, 'real-fail.node-test.mjs')], REPO_ROOT, {
    AGENT_TOOLING_TEARDOWN_CRASH_EXIT_CODES: '77',
  });
  assert.notEqual(real.status, 0);
  assert.doesNotMatch(real.stderr, /TEARDOWN CRASH RETRY/);
});

test('reconcileExit stays quiet when the failure IS attributable to a test', () => {
  const result = reconcileExit({
    label: 'test:scripts',
    code: 1,
    signal: null,
    summary: { sawAnySummary: true, counts: { tests: 318, passed: 317, failed: 1 } },
  });
  assert.equal(result.exitCode, 1, 'the runner exit code must never be rewritten');
  assert.equal(result.attributable, true);
  assert.match(result.message, /1 failing test\(s\)/);
  assert.doesNotMatch(result.message, /UNATTRIBUTED/);
});

test('reconcileExit shouts when a nonzero exit has a green summary (the unattributed-exit shape)', () => {
  const result = reconcileExit({
    label: 'test:scripts',
    code: 1,
    signal: null,
    summary: {
      sawAnySummary: true,
      counts: { tests: 318, passed: 318, failed: 0, cancelled: 0, skipped: 0 },
      diagnostics: [],
    },
  });
  assert.equal(result.exitCode, 1, 'the runner exit code must never be rewritten');
  assert.equal(result.attributable, false);
  assert.match(result.message, /UNATTRIBUTED TEST-RUNNER FAILURE/);
  assert.match(result.message, /reported NO failing tests/);
  // The banner must carry the counts and point at the parent process — that is
  // the whole thread the next person has to pull on.
  assert.match(result.message, /"failed":0/);
  assert.match(result.message, /PARENT process/);
  assert.match(result.message, /second sighting/);
});

test('reconcileExit reports an unreadable summary as its own signal', () => {
  const result = reconcileExit({ label: 'x', code: 1, signal: null, summary: null });
  assert.equal(result.attributable, false);
  assert.match(result.message, /summary could not be read/);
});

test('reconcileExit reports a run that never produced a summary event', () => {
  const result = reconcileExit({
    label: 'x',
    code: 1,
    signal: null,
    summary: { sawAnySummary: false, counts: null },
  });
  assert.match(result.message, /no summary event at all/);
});

test('reconcileExit maps a signal death to 128+signo so it stays nonzero', () => {
  const result = reconcileExit({ label: 'x', code: null, signal: 'SIGKILL', summary: null });
  assert.equal(result.exitCode, 128 + os.constants.signals.SIGKILL);
  assert.match(result.message, /on signal SIGKILL/);
});

test('reconcileExit surfaces error-shaped diagnostics in the banner', () => {
  const result = reconcileExit({
    label: 'x',
    code: 1,
    signal: null,
    summary: {
      sawAnySummary: true,
      counts: { tests: 1, passed: 1, failed: 0 },
      diagnostics: ['Error: something rejected late'],
    },
  });
  assert.match(result.message, /something rejected late/);
});

// ---------------------------------------------------------------------------
// End to end, through the real wrapper
// ---------------------------------------------------------------------------

test('the wrapper exits 0 and prints no banner for a fully passing run', () => {
  const dir = makeFixtureDir({
    'ok.node-test.mjs': "import { test } from 'node:test';\ntest('ok', () => {});\n",
  });
  const { status, stdout, stderr } = runWrapper(['probe', 'ok.node-test.mjs'], dir);
  assert.equal(status, 0, `expected exit 0, got ${status}\n${stdout}\n${stderr}`);
  assert.doesNotMatch(stderr, /UNATTRIBUTED/);
  assert.match(stdout, /# pass 1/);
});

test('the wrapper does NOT mask a real failing test', () => {
  const dir = makeFixtureDir({
    'bad.node-test.mjs':
      "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n" +
      "test('deliberately fails', () => { assert.equal(1, 2); });\n",
  });
  const { status, stdout, stderr } = runWrapper(['probe', 'bad.node-test.mjs'], dir);
  assert.equal(status, 1, 'a failing test must still fail the gate');
  assert.match(stderr, /1 failing test\(s\)/);
  assert.doesNotMatch(stderr, /UNATTRIBUTED/, 'an attributable failure must not shout');
  assert.match(stdout, /not ok/);
});

test('a post-test unhandled rejection is attributed with a reason and a stack', () => {
  // This is the class of bug the original report hypothesised: async activity that outlives
  // the test that started it. Node already fails the FILE for it; the
  // --import'd diagnostics hook adds the pid, the owning test file and the full
  // stack, none of which node's own message carries.
  const dir = makeFixtureDir({
    'late.node-test.mjs':
      "import { test } from 'node:test';\n" +
      "test('leaks an unawaited rejection', () => {\n" +
      "  setTimeout(() => { Promise.reject(new Error('late cleanup boom')); }, 20);\n" +
      '});\n',
  });
  const { status, stdout, stderr } = runWrapper(['probe', 'late.node-test.mjs'], dir);
  const combined = `${stdout}\n${stderr}`;
  assert.equal(status, 1, 'a leaked rejection must still fail the gate');
  assert.match(combined, /\[async-failure\] unhandledRejection/);
  assert.match(combined, /late cleanup boom/);
  assert.match(combined, /late\.node-test\.mjs/);
  // The stack frames are the part that was missing from the original sighting —
  // node's own message names the error but never says where it was created.
  assert.match(combined, /\[async-failure\]\s+at Timeout\._onTimeout/);
});

test('the wrapper refuses to run with no test files rather than silently passing', () => {
  const { status, stderr } = runWrapper(['probe'], REPO_ROOT);
  assert.equal(status, 2);
  assert.match(stderr, /usage:/);
});

test('the wrapper refuses a test file as its first argument (the label) instead of silently skipping it', () => {
  const dir = makeFixtureDir({
    'a.node-test.mjs': "import { test } from 'node:test';\ntest('a', () => {});\n",
    'b.node-test.mjs': "import { test } from 'node:test';\ntest('b', () => {});\n",
    'plain': 'not a js name, but a file on disk\n',
  });
  for (const first of ['a.node-test.mjs', 'scripts/*.node-test.mjs', 'plain']) {
    const { status, stdout, stderr } = runWrapper([first, 'b.node-test.mjs'], dir);
    assert.equal(status, 2, `"${first}" as label must exit 2\n${stdout}\n${stderr}`);
    assert.match(stderr, /first argument is a LABEL/);
    assert.match(stderr, /usage:/);
    assert.doesNotMatch(stdout, /# tests/, 'nothing may run');
  }
  // A real label, including the colon forms package.json uses, still runs both files.
  const ok = runWrapper(['test:probe', 'a.node-test.mjs', 'b.node-test.mjs'], dir);
  assert.equal(ok.status, 0, `${ok.stdout}\n${ok.stderr}`);
  assert.match(ok.stdout, /# pass 2/);
});

// ---------------------------------------------------------------------------
// Per-file deadline
// ---------------------------------------------------------------------------

test('a test file that never finishes is exited at its deadline and named, and later files still report', () => {
  // The CI shape: a test awaits something that never settles while a live handle (here a timer;
  // in CI, a child process) keeps the file's event loop alive. Without the deadline this run hangs
  // until the runner's own timeout, printing nothing.
  const dir = makeFixtureDir({
    'a-hang.node-test.mjs':
      "import { test } from 'node:test';\n" +
      "test('waits forever', async () => { await new Promise(() => { setInterval(() => {}, 1000); }); });\n",
    'b-after.node-test.mjs': "import { test } from 'node:test';\ntest('after the hang', () => {});\n",
  });
  const started = Date.now();
  const { status, stdout, stderr } = runWrapper(['probe', 'a-hang.node-test.mjs', 'b-after.node-test.mjs'], dir, {
    AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS: '1500',
  });
  const combined = `${stdout}\n${stderr}`;
  assert.ok(Date.now() - started < 60_000, `the hang must end at its deadline, not the 120 s harness timeout\n${combined}`);
  assert.equal(status, 1, `a file killed at its deadline must fail the gate\n${combined}`);
  assert.match(combined, /\[file-deadline\] \S*a-hang\.node-test\.mjs did not finish within 1500 ms/);
  assert.match(combined, /\[file-deadline\]\s+still alive: .*Timeout/, 'the banner says what kept the file alive');
  assert.match(stdout, /^not ok \d+ - \S*a-hang\.node-test\.mjs/m, 'node --test reports the file as a named failure');
  assert.match(stdout, /^ok \d+ - after the hang/m, 'the file after the hang still reports');
});

test('fileTimeoutMs reads AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS and ignores a value that is not a positive number', async () => {
  const { DEFAULT_FILE_TIMEOUT_MS, fileTimeoutMs } = await import('./test-support/file-deadline.mjs');
  assert.equal(fileTimeoutMs({}), DEFAULT_FILE_TIMEOUT_MS);
  assert.equal(fileTimeoutMs({ AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS: '2500' }), 2500);
  for (const bad of ['', '0', '-5', 'ten', 'Infinity']) {
    assert.equal(fileTimeoutMs({ AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS: bad }), DEFAULT_FILE_TIMEOUT_MS, `"${bad}"`);
  }
  // The default must leave room under the CI job's 45-minute cap, and far above a healthy file.
  assert.ok(DEFAULT_FILE_TIMEOUT_MS >= 5 * 60_000 && DEFAULT_FILE_TIMEOUT_MS <= 15 * 60_000);
});

test('deadlineBanner names the file, the budget and each live resource once with a count', async () => {
  const { deadlineBanner } = await import('./test-support/file-deadline.mjs');
  const banner = deadlineBanner({ file: '/r/scripts/x.node-test.mjs', ms: 600000, pid: 42, resources: ['ProcessWrap', 'PipeWrap', 'PipeWrap', 'Timeout'] });
  assert.match(banner, /\/r\/scripts\/x\.node-test\.mjs did not finish within 600000 ms; exiting it \(pid 42\)/);
  assert.match(banner, /still alive: ProcessWrap, PipeWrap x2, Timeout$/m);
  assert.match(deadlineBanner({ file: 'f', ms: 1, pid: 1, resources: [] }), /still alive: nothing reported/);
});

test('the deadline is unref\'d and armed only in a test child', () => {
  const src = fs.readFileSync(path.join(HERE, 'test-support', 'file-deadline.mjs'), 'utf8');
  assert.match(src, /if \(process\.env\.NODE_TEST_CONTEXT\) \{/, 'never armed in a process that is not a test child');
  assert.match(src, /timer\.unref\(\);/, 'a finished file must never be kept alive by its own deadline');
  const wrapper = fs.readFileSync(WRAPPER, 'utf8');
  assert.match(wrapper, /'--import',\s*pathToFileURL\(FILE_DEADLINE\)\.href,/, 'the wrapper imports it into every test child');
});

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

test('every node --test gate routes through the wrapper', () => {
  // A consumer's package.json may or may not exist, and may name its gates differently, so the rule
  // is stated over whatever is there: a conventionally named gate script (test:hooks, test:scripts,
  // test:ritual) and any script that already mentions the wrapper must be exactly
  // `node scripts/run-node-tests.mjs <label> ...`, and no script may call `node --test` directly.
  const pkgPath = path.join(REPO_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const scripts = pkg.scripts ?? {};
  const gates = new Set(['test:hooks', 'test:scripts', 'test:ritual'].filter((name) => name in scripts));
  for (const [name, script] of Object.entries(scripts)) {
    if (/run-node-tests\.mjs/.test(script) || /node --test/.test(script)) gates.add(name);
  }
  for (const name of gates) {
    const script = scripts[name];
    assert.match(
      script,
      /^node scripts\/run-node-tests\.mjs /,
      `${name} must run through scripts/run-node-tests.mjs, or an unattributed nonzero ` +
        `exit becomes invisible again. Got: ${script}`,
    );
    assert.doesNotMatch(
      script,
      /node --test/,
      `${name} must not call \`node --test\` directly. Got: ${script}`,
    );
  }
});
