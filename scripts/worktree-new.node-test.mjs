#!/usr/bin/env node
// Concurrency tests for `scripts/worktree-new.sh`.
//
// All worktrees of a repo share ONE .git/config, and git guards every write to
// it with a create-exclusive .git/config.lock that git itself never retries. So
// concurrent worktree creation collides on it, and that is not an exotic path:
// an orchestrator that creates a whole wave of worktrees up front, so their
// installs overlap, makes it the normal path.
//
// Measured against the pre-fix script in this exact harness, 8 concurrent runs:
//
//   * 7 of 8 died with "could not lock config file", each AFTER `git worktree
//     add` had already created the branch ref, leaving a branch with no
//     worktree, which `git worktree list` does not show and the toplevel
//     isolation check cannot see. Six orphan refs from one wave.
//   * Of the runs that "succeeded", 6 of 8 published their branch with NO
//     upstream at all: `git push -u` reports its lost config-lock write on
//     stderr and still EXITS 0, so the script printed "(published)" over a
//     branch that would answer `git pull` with "no tracking information".
//
// These tests pin both halves. Everything runs against a local bare "origin",
// so there is no network and no dependency install (--no-install).

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  realpathSync,
  existsSync,
  rmSync,
  statSync,
  utimesSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { removeTempDir } from './test-support/cleanup.mjs';
import { copyTemplate, disposeTemplates } from './test-support/git-fixture-template.mjs';

const execFileAsync = promisify(execFile);
const script = path.resolve('scripts/worktree-new.sh');

// The consumer hint every dependency test runs under: the packages a gate needs, and one native
// package that ships a prebuilt binding. A consumer keeps this in scripts/worktree-new.hint.sh;
// the suite points WORKTREE_NEW_HINT_FILE at its own copy so it never depends on one.
const HINT_DIR = mkdtempSync(path.join(tmpdir(), 'wtnew-hint-'));
const HINT_FILE = path.join(HINT_DIR, 'worktree-new.hint.sh').split(path.sep).join('/');
writeFileSync(
  HINT_FILE,
  'WORKTREE_NEW_REQUIRED_PACKAGES="jest next typescript native-widget"\nWORKTREE_NEW_NATIVE_PREBUILDS="native-widget"\n',
);
// A hint path that does not exist: the script must then use its neutral defaults.
const NO_HINT_FILE = path.join(HINT_DIR, 'absent.hint.sh').split(path.sep).join('/');

function fixtureEnv(source = process.env) {
  const env = { ...source };
  // Ambient GIT_CONFIG_COUNT/KEY_n/VALUE_n entries can override repo-local settings and make fixture
  // controls (especially the fsmonitor-on baseline) silently vacuous. Individual
  // tests that exercise caller-provided entries pass them explicitly to `run`.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  }
  return env;
}

const ENV = {
  ...fixtureEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  // The script reads these from config, and a CI runner may have none set.
  GIT_CONFIG_GLOBAL: '/dev/null',
  WORKTREE_NEW_HINT_FILE: HINT_FILE,
};

test('fixture Git environment drops inherited fsmonitor=false overrides', () => {
  const env = fixtureEnv({
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
  });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(Object.keys(env).some((key) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)), false);
});
// Bare fixture slugs must stay beside their temporary primary checkout. A host's
// configured root would leak fixtures into real worktrees and defeat cleanup.
// The relocation cases below supply their own root explicitly.
for (const key of Object.keys(ENV)) {
  if (key.toUpperCase() === 'AGENT_TOOLING_WORKTREE_ROOT') delete ENV[key];
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * `env` with `binDir` first on PATH. Windows spells the key `Path` under PowerShell and `PATH`
 * under Git Bash; writing a second spelling beside the first leaves the child two PATHs and no
 * defined winner, so prepend to whichever key is already there.
 */
function withBinFirst(env, binDir) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: binDir + path.delimiter + (env[key] ?? '') };
}

/**
 * A bare origin plus a `primary` checkout on main with one pushed commit. Built once per file and
 * copied per test: seven git processes per test became a file copy, and
 * git-fixture-template.mjs rewrites the absolute paths git records, so each copy is the same repo
 * a fresh build would be.
 */
function fixture() {
  const root = copyTemplate('wtnew-base', (r) => {
    const origin = path.join(r, 'origin.git');
    const primary = path.join(r, 'primary');
    git(r, 'init', '--bare', '-q', '-b', 'main', origin);
    git(r, 'init', '-q', '-b', 'main', primary);
    writeFileSync(path.join(primary, 'README.md'), 'base\n');
    git(primary, 'add', '.');
    git(primary, 'commit', '-q', '-m', 'base');
    git(primary, 'remote', 'add', 'origin', origin);
    git(primary, 'push', '-q', '-u', 'origin', 'main');
    git(primary, 'fetch', '-q', 'origin', 'main');
  }, 'wtnew-');
  return { root, origin: path.join(root, 'origin.git'), primary: path.join(root, 'primary') };
}
after(() => {
  disposeTemplates((dir) => removeTempDir(dir, 'worktree-new.node-test'));
  removeTempDir(HINT_DIR, 'worktree-new.node-test');
});

function run(primary, args, env = ENV) {
  return execFileAsync('bash', [script, ...args], { cwd: primary, encoding: 'utf8', env });
}

/**
 * Run the script and expose its live ChildProcess alongside the completion
 * promise, so a test can poll ACCUMULATED output for a specific line instead
 * of racing a fixed-duration side effect against however long the process
 * takes to get scheduled. `util.promisify`'s built-in
 * `child_process.execFile` implementation attaches the ChildProcess to the
 * returned promise as `.child` (documented Node behaviour), so this reuses
 * `run()`'s plumbing rather than introducing a second way to invoke the
 * script.
 */
function runObserving(primary, args, env = ENV) {
  const promise = run(primary, args, env);
  const child = promise.child;
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let settled = null;
  promise.then(
    (value) => { settled = { value }; },
    (error) => { settled = { error }; },
  );
  return {
    promise,
    child,
    getStdout: () => stdout,
    getStderr: () => stderr,
    get settled() { return settled; },
  };
}

/**
 * Wait until `observed`'s accumulated stdout matches `pattern`, polling
 * rather than guessing a fixed delay, the same anchor-to-observed-progress
 * technique as `holdLockUntilContended` below, applied to a child process's
 * OUTPUT instead of a bare repo's ref state. A test that instead frees an
 * external resource (a lock, a marker file) on a fixed JS timer races the
 * child's own startup and scheduling delay: under CPU load a slow-to-start
 * child can still be sitting before the very check it needs the resource
 * for when the timer fires and clears it out from under it, so the child
 * never observes the resource at all and the expected line never appears
 *. Waiting for the line here means the external resource is
 * only ever released once the child has PROVEN it is depending on it.
 *
 * Fails loudly, naming the captured output, if the process settles before
 * the pattern appears (proving the line was never going to show up) or if
 * `ceilingMs` elapses. `ceilingMs` is a loud upper bound on a hung run,
 * never a thing under assertion.
 */
async function waitForOutput(observed, pattern, { ceilingMs = 60_000 } = {}) {
  const started = Date.now();
  while (!pattern.test(observed.getStdout())) {
    if (observed.settled) {
      throw new Error(
        `the process ended before its output matched ${pattern}:\n` +
          `${observed.getStdout()}${observed.getStderr()}`,
      );
    }
    if (Date.now() - started >= ceilingMs) {
      throw new Error(`output did not match ${pattern} within ${ceilingMs}ms:\n${observed.getStdout()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** Branch refs that have no worktree checked out, the orphan fingerprint. */
function orphanBranches(primary) {
  const checkedOut = new Set(
    git(primary, 'worktree', 'list', '--porcelain')
      .split('\n')
      .filter((l) => l.startsWith('branch '))
      .map((l) => l.slice('branch refs/heads/'.length)),
  );
  return git(primary, 'branch', '--format=%(refname:short)')
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .filter((b) => !checkedOut.has(b));
}

/**
 * Has the run reached the config write yet?
 *
 * The script publishes the branch and only THEN sets the upstream, so a branch
 * present in the bare origin means `push -u` has run, and with .git/config.lock
 * held, its own config write cannot have landed, so the run is now inside
 * `retry_config_write`. Read from the bare repo, which has no `origin` remote to
 * resolve and therefore no config of ours to consult.
 */
function publishedToOrigin(f, branch) {
  return git(f.origin, 'for-each-ref', '--format=%(refname:short)', `refs/heads/${branch}`) !== '';
}

/**
 * Hold .git/config.lock until the run is DEMONSTRABLY contending for it, then
 * for `extraHoldMs` beyond that, then release.
 *
 * The point is that the hold is anchored to the script's observed progress
 * rather than to a wall clock started at spawn. A fixed timer measures the
 * machine: on a loaded box it can elapse before the run ever reaches the config
 * write, and the test then passes having exercised no retry at all, a vacuous
 * green, which is the failure mode a flaky guardrail hides behind.
 *
 * `ceilingMs` is an absolute bound so a script that never publishes fails LOUDLY
 * here instead of hanging the gate. It is never what any assertion rests on.
 */
async function holdLockUntilContended(f, branch, running, { extraHoldMs = 0, ceilingMs = 120_000 } = {}) {
  let settled = null;
  running.then(
    (value) => { settled = { value }; },
    (error) => { settled = { error }; },
  );

  const started = Date.now();
  while (!publishedToOrigin(f, branch)) {
    if (settled) {
      // The run finished without ever publishing: surface ITS failure, which is
      // the real diagnosis, rather than a timeout that buries it.
      throw new Error(
        `the run ended before publishing ${branch}, so the config-lock retry was never exercised:\n` +
          `${settled.error?.stderr ?? settled.error?.message ?? settled.value?.stdout ?? ''}`,
      );
    }
    if (Date.now() - started >= ceilingMs) {
      throw new Error(`${branch} was not published within ${ceilingMs}ms, the run never reached the config write`);
    }
    // 50ms: each poll is a `git` spawn, and this loop runs on the very box whose
    // contention it is measuring around.
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (extraHoldMs > 0) await new Promise((resolve) => setTimeout(resolve, extraHoldMs));
}

// The script's own retry budget is a WALL-CLOCK deadline (CONFIG_RETRY_SECONDS,
// 60s by default), which makes it a second variable in any test that races real
// processes for the lock, and on a saturated CI runner it is the variable that
// moves. Exhausting it is correct script behaviour and a WRONG test verdict:
// the run then exits 1 loudly and the assertion reports a machine that was busy
// as a script that is broken.
//
// So the contention tests pin the budget to the test's OWN patience instead of
// leaving it at the production default. It is not a guess about how slow a
// runner might be, it says "the budget is not what this test is about", and it
// leaves exactly one way for these assertions to fail: a config write that was
// genuinely lost, or an orphan branch ref. Exhaustion keeps its own dedicated,
// deterministic test below, which forces the budget to 0.
const TEST_RETRY_SECONDS = '600';
const CONTENTION_ENV = { ...ENV, WORKTREE_NEW_CONFIG_RETRY_SECONDS: TEST_RETRY_SECONDS };
// A loud upper bound on a hung run, never a thing under assertion.
const CONTENTION_TIMEOUT_MS = 300_000;

test('a fresh worktree has an empty .tmp-gates/ so a log can be redirected into it before --await', async () => {
  const f = fixture();
  try {
    await run(f.primary, ['gates', 'feat/gates-dir', '--no-install']);
    const dest = path.join(f.root, 'primary-gates');
    assert.ok(existsSync(path.join(dest, '.tmp-gates')), '.tmp-gates/ was not created');
    const { stdout } = await execFileAsync(
      'bash', ['-c', `bash "${script}" --await "${dest}" > "${dest}/.tmp-gates/await-test.log" 2>&1; echo $?`],
      { cwd: f.primary, encoding: 'utf8', env: ENV },
    );
    assert.equal(stdout.trim(), '0', 'the redirect into .tmp-gates/ must succeed and --await must run');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('N concurrent invocations all succeed, with no config-lock failure and no orphan branch ref', { timeout: CONTENTION_TIMEOUT_MS }, async () => {
  const f = fixture();
  const N = 8;
  try {
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) => run(f.primary, [`s${i}`, `feat/b${i}`, '--no-install'], CONTENTION_ENV)),
    );

    const failed = results
      .map((r, i) => ({ i, r }))
      .filter(({ r }) => r.status === 'rejected')
      .map(({ i, r }) => `  #${i}: ${(r.reason?.stderr || r.reason?.message || '').trim()}`);
    assert.equal(failed.length, 0, `${failed.length}/${N} concurrent runs failed:\n${failed.join('\n')}`);

    // The specific error under test must not appear even as a warning:
    // every config write either wins the lock or is retried until it does.
    const output = results.map((r) => `${r.value.stdout}${r.value.stderr}`).join('\n');
    assert.ok(
      !output.includes('could not lock config file'),
      `a config-lock error survived to the operator:\n${output}`,
    );

    // Every branch created is checked out in a worktree, the half-provisioned
    // "branch exists, worktree does not" state is what this test is about.
    assert.deepEqual(orphanBranches(f.primary), []);
    for (let i = 0; i < N; i += 1) {
      assert.ok(existsSync(path.join(f.root, `primary-s${i}`)), `worktree primary-s${i} is missing`);
    }
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('every concurrently-created branch is published with its OWN upstream, not main and not none', { timeout: CONTENTION_TIMEOUT_MS }, async () => {
  const f = fixture();
  const N = 8;
  try {
    await Promise.all(
      Array.from({ length: N }, (_, i) => run(f.primary, [`s${i}`, `feat/b${i}`, '--no-install'], CONTENTION_ENV)),
    );

    for (let i = 0; i < N; i += 1) {
      const branch = `feat/b${i}`;
      assert.equal(
        git(f.primary, 'config', '--get', `branch.${branch}.remote`),
        'origin',
        `${branch} lost its upstream remote to the config-lock race`,
      );
      // refs/heads/main here is the pre-fix `worktree add -b <b> origin/main`
      // tracking, which pointed every feature branch at main.
      assert.equal(
        git(f.primary, 'config', '--get', `branch.${branch}.merge`),
        `refs/heads/${branch}`,
        `${branch} tracks the wrong ref`,
      );
    }
    assert.equal(git(f.primary, 'ls-remote', '--heads', 'origin').split('\n').length, N + 1);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The test above races real processes, so which of them collides is up to the
// scheduler. This one removes the timing: hold .git/config.lock exactly the way
// git does, and every config write in the run is guaranteed to lose it.
test('a config.lock already held by another writer is retried through, not fatal', { timeout: CONTENTION_TIMEOUT_MS }, async () => {
  const f = fixture();
  const lock = path.join(f.primary, '.git', 'config.lock');
  try {
    writeFileSync(lock, '', { flag: 'wx' });
    const run1 = run(f.primary, ['held', 'feat/held', '--no-install']);
    // Released once the run is provably inside the retry loop, not on a timer.
    // This is the assertion the flaky-release report was filed on: with a fixed 600ms release,
    // whether the run had even reached the config write by then was a property
    // of the runner's load, not of the script.
    try {
      await holdLockUntilContended(f, 'feat/held', run1);
      rmSync(lock, { force: true });
      await run1;
    } finally {
      rmSync(lock, { force: true });
    }

    assert.equal(git(f.primary, 'config', '--get', `branch.feat/held.merge`), 'refs/heads/feat/held');
    assert.deepEqual(orphanBranches(f.primary), []);
    assert.ok(existsSync(path.join(f.root, 'primary-held')));
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The two tests above pass against the OLD budget too, a brief hold
// is well inside it. This one is sized to the measurement that identified the
// flake: holding .git/config.lock and varying the hold, the old budget (10
// attempts, 0.1-0.4s apart) survived 4000ms and gave up at ~4700ms, losing the
// upstream while still exiting 0. Eight seconds is past that cliff and far
// inside the new 60s deadline, so this fails against the old script and passes
// against the new one, which is the only reason it earns its ~8s of runtime.
//
// The eight seconds are counted from the moment the run is provably CONTENDING,
// not from spawn. Counted from spawn they also cover process start,
// `git worktree add` and the push, so on a loaded runner the actual contention
// is some unknown fraction of the hold, and the test quietly stops reaching
// past the cliff it exists to clear, without ever going red about it.
const OLD_BUDGET_CLIFF_MS = 8000;
test('a config.lock held past the OLD retry budget is still waited out', { timeout: CONTENTION_TIMEOUT_MS }, async () => {
  const f = fixture();
  const lock = path.join(f.primary, '.git', 'config.lock');
  try {
    writeFileSync(lock, '', { flag: 'wx' });
    const run1 = run(f.primary, ['slow', 'feat/slow', '--no-install']);
    try {
      await holdLockUntilContended(f, 'feat/slow', run1, { extraHoldMs: OLD_BUDGET_CLIFF_MS });
      rmSync(lock, { force: true });
      await run1;
    } finally {
      rmSync(lock, { force: true });
    }

    assert.equal(git(f.primary, 'config', '--get', 'branch.feat/slow.remote'), 'origin');
    assert.equal(git(f.primary, 'config', '--get', 'branch.feat/slow.merge'), 'refs/heads/feat/slow');
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The other half of the retry-budget fix, and the half that made the flake so hard to read:
// exhausting the budget used to print a WARNING and exit 0 under "Worktree ready
// … (published)". CI run 33631203019 therefore showed 8 processes all exiting 0
// and a single assertion failing on a missing branch.<b>.remote, with nothing in
// any run's output naming the cause. Exhaustion must fail LOUDLY, and must not
// take the already-published branch or the worktree down with it, since both are
// real and the operator's fix is one command.
test('exhausting the retry budget fails loudly and leaves the published branch intact', async () => {
  const f = fixture();
  const lock = path.join(f.primary, '.git', 'config.lock');
  try {
    writeFileSync(lock, '', { flag: 'wx' });
    await assert.rejects(
      execFileAsync('bash', [script, 'starved', 'feat/starved', '--no-install'], {
        cwd: f.primary,
        encoding: 'utf8',
        env: { ...ENV, WORKTREE_NEW_CONFIG_RETRY_SECONDS: '0' },
      }),
      (err) => {
        assert.match(err.stderr, /NO upstream/);
        assert.match(err.stderr, /--set-upstream-to=origin\/feat\/starved/);
        assert.doesNotMatch(err.stdout, /Worktree ready/, 'a starved run must not report success');
        return true;
      },
    );

    rmSync(lock, { force: true });
    // The loud failure must not undo real work: the push landed, so the branch is
    // on the remote and the worktree is on disk. Tearing either down here would
    // strand a remote ref (and cleanup_partial used to be armed at this point).
    assert.ok(
      git(f.primary, 'ls-remote', '--heads', 'origin', 'feat/starved'),
      'the loud failure destroyed a branch that had already reached the remote',
    );
    assert.ok(existsSync(path.join(f.root, 'primary-starved')), 'the loud failure removed a usable worktree');
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    rmSync(lock, { force: true });
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The OTHER race in this script, and not the config lock. Found by the test
// above on CI, runs 33581801987 and 33582652613, on two different runners:
//
//   fatal: bad object worktrees/wt-s0/HEAD
//   error: <remote> did not send all necessary objects
//
// git enumerates EVERY worktree's HEAD to work out what it already has, so a
// worktree created moments ago whose .git/worktrees/<name>/HEAD is not written
// yet breaks an UNRELATED transfer. Nothing about that command involves wt-s0.
// It hits `git fetch origin main`, where it is FATAL under set -e, killing the
// run before the worktree exists, and `git push -u` alike.
//
// Reproduced with a `git` shim ahead of PATH that fails the first fetch/push
// and delegates everything else to the real git. PATH is built with Node's
// path.delimiter, never a shell `export PATH=`, that is silently
// MSYS-rewritable and fails upward into a green result. Built that
// way it holds under Git Bash too: these ran green on Windows 11 / Git Bash
// once their old "not reliable under MSYS" skips came off and
// each asserts the shim's call count, so a shim git never reached fails.
const CONCURRENCY_FAILURE = [
  'echo "fatal: bad object worktrees/wt-other/HEAD" >&2',
  'echo "error: origin did not send all necessary objects" >&2',
].join('\n      ');
const AUTH_FAILURE =
  `echo "fatal: could not read Username for 'https://github.com': No such device or address" >&2`;

// A shell function intercepts the real script's post-creation reads, so these
// regressions also run on Windows without a PATH shim. The rest of creation,
// isolation, publication and cleanup still use real Git against a local origin.
async function postCreationReadFixture(f, { verb, transient = true, budget = TEST_RETRY_SECONDS }) {
  const counter = path.join(f.root, 'read-count');
  const injected = path.join(f.root, 'worktree-new-read-fault.sh');
  const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;
  let source = readFileSync(script, 'utf8');
  const directoryLine = /^SCRIPT_DIR=.*$/m;
  assert.equal(source.match(/^SCRIPT_DIR=.*$/gm)?.length, 1);
  source = source.replace(directoryLine, `SCRIPT_DIR=${shellQuote(toBashPath(path.dirname(script)))}`);
  const anchor = '# Isolation check. `toplevel == cwd` proves this is A worktree;';
  assert.equal(source.split(anchor).length - 1, 1);
  source = source.replace(anchor, `git() {
  if [ "$1" = "-C" ] && [ "$3" = "${verb}" ] && { [ "${verb}" != 'rev-parse' ] || [ "\${4:-}" = '--show-toplevel' ]; }; then
    local n
    n=$(cat "$READ_FAULT_COUNTER" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "$READ_FAULT_COUNTER"
    if [ "$n" -eq 1 ]; then
      ${transient
        ? `printf '%s\\n' "warning: unable to access '.git/config': Permission denied" "fatal: unknown error occurred while reading the configuration files" >&2`
        : `printf '%s\\n' 'fatal: not a git repository' >&2`}
      return 128
    fi
    printf '%s\\n' 'warning: successful read diagnostic' >&2
  fi
  command git "$@"
}

${anchor}`);
  writeFileSync(injected, source);
  const result = await execFileAsync('bash', [injected, 'read-fault', 'feat/read-fault', '--no-install'], {
    cwd: f.primary, encoding: 'utf8',
    env: { ...ENV, READ_FAULT_COUNTER: toBashPath(counter), WORKTREE_NEW_CONFIG_RETRY_SECONDS: budget },
  }).then(value => ({ value }), error => ({ error }));
  return { ...result, calls: Number(readFileSync(counter, 'utf8').trim()) };
}

for (const verb of ['rev-parse', 'ls-files']) {
  test(`post-creation ${verb} retries a config reader race and preserves stdout`, async () => {
    const f = fixture();
    try {
      const result = await postCreationReadFixture(f, { verb });
      assert.equal(result.error, undefined, result.error?.stderr);
      assert.equal(result.calls, 2, 'one denied read and one successful retry');
      assert.match(result.value.stdout, /\(published\)/);
      assert.match(result.value.stderr, /successful read diagnostic/);
      assert.doesNotMatch(result.value.stderr, /Permission denied/);
      assert.ok(existsSync(path.join(f.root, 'primary-read-fault')));
      assert.ok(git(f.primary, 'ls-remote', '--heads', 'origin', 'feat/read-fault'));
      assert.deepEqual(orphanBranches(f.primary), []);
    } finally {
      removeTempDir(f.root, 'worktree-new.node-test');
    }
  });
}

for (const options of [{ transient: false }, { transient: true, budget: '0' }]) {
  test(`post-creation read preserves fatal errors (${options.transient ? 'retry budget exhausted' : 'not a sharing race'})`, async () => {
    const f = fixture();
    try {
      const result = await postCreationReadFixture(f, { verb: 'rev-parse', ...options });
      assert.equal(result.calls, 1, 'a permanent error or expired budget must not retry');
      assert.equal(result.error?.code, 128);
      assert.match(result.error.stderr, options.transient ? /Permission denied/ : /not a git repository/);
      assert.match(result.error.stderr, /Removing the half-provisioned worktree/);
      assert.equal(existsSync(path.join(f.root, 'primary-read-fault')), false);
      assert.deepEqual(orphanBranches(f.primary), []);
    } finally {
      removeTempDir(f.root, 'worktree-new.node-test');
    }
  });
}
// The third race, reproduced by racing 8 real creations on a
// saturated box: `git worktree add` prunes the worktree admin area on every
// invocation, so a sibling's prune can delete this run's half-built
// .git/worktrees/<name>/ before it has written the `locked` marker into it.
const WORKTREE_ADD_RACE =
  `echo "fatal: could not open '.git/worktrees/wt-raced/locked' for writing: No such file or directory" >&2`;

/**
 * Write a `git` shim that fails the first `$verb` with `$failure`, counts its
 * invocations, then delegates to the real git. Returns the env to run with.
 */
function gitShim(root, verb, failure, failTimes = 1) {
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  const counter = path.join(root, `${verb}-count`);
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  writeFileSync(
    path.join(binDir, 'git'),
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "${verb}" ]; then
    n=$(cat "${counter}" 2>/dev/null || echo 0)
    n=$((n + 1)); echo "$n" > "${counter}"
    if [ "$n" -le ${failTimes} ]; then
      ${failure}
      exit 1
    fi
  fi
done
exec "${realGit}" "$@"
`,
    { mode: 0o755 },
  );
  return {
    env: withBinFirst(ENV, binDir),
    calls: () => Number(readFileSync(counter, 'utf8').trim()),
  };
}

test('a FETCH broken by a concurrent worktree creation is retried, not fatal', async () => {
  const f = fixture();
  try {
    const shim = gitShim(f.root, 'fetch', CONCURRENCY_FAILURE);
    const { stdout, stderr } = await execFileAsync(
      'bash',
      [script, 'wtf', 'feat/wtf', '--no-install'],
      { cwd: f.primary, encoding: 'utf8', env: shim.env },
    );

    assert.match(stdout + stderr, /\(published\)/);
    assert.equal(shim.calls(), 2, 'expected exactly one retry');
    assert.ok(existsSync(path.join(f.root, 'primary-wtf')));
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a PUSH broken by a concurrent worktree creation is retried, not downgraded to a warning', async () => {
  const f = fixture();
  try {
    const shim = gitShim(f.root, 'push', CONCURRENCY_FAILURE);
    const { stdout, stderr } = await execFileAsync(
      'bash',
      [script, 'shim', 'feat/shim', '--no-install'],
      { cwd: f.primary, encoding: 'utf8', env: shim.env },
    );

    // The retry has to actually publish it, an unpublished branch reopens the
    // collision window this script exists to close.
    assert.match(stdout + stderr, /\(published\)/);
    assert.doesNotMatch(stderr, /could not publish/);
    assert.equal(shim.calls(), 2, 'expected exactly one retry');
    assert.ok(git(f.primary, 'ls-remote', '--heads', 'origin', 'feat/shim'), 'branch never reached the remote');
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a WORKTREE ADD broken by a concurrent creation is retried, not fatal', async () => {
  const f = fixture();
  try {
    const shim = gitShim(f.root, 'add', WORKTREE_ADD_RACE);
    const { stdout, stderr } = await execFileAsync(
      'bash',
      [script, 'raced', 'feat/raced', '--no-install'],
      { cwd: f.primary, encoding: 'utf8', env: shim.env },
    );

    assert.match(stdout + stderr, /\(published\)/);
    assert.equal(shim.calls(), 2, 'expected exactly one retry');
    assert.ok(existsSync(path.join(f.root, 'primary-raced')));
    // The add is the one step that runs BEFORE cleanup_partial is armed, so a
    // failure there is exactly where an orphan branch ref comes from.
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a worktree add that fails for a NON-race reason is not retried', async () => {
  const f = fixture();
  try {
    // The counterweight to the retry above: a real breakage must not be turned
    // into the same error arriving a minute later, and must leave no orphan.
    const shim = gitShim(f.root, 'add', AUTH_FAILURE, 99);
    await assert.rejects(
      execFileAsync('bash', [script, 'nope', 'feat/nope', '--no-install'], {
        cwd: f.primary,
        encoding: 'utf8',
        env: shim.env,
      }),
      (err) => {
        assert.match(err.stderr, /could not create the worktree/);
        assert.match(err.stderr, /could not read Username/, 'the real error must reach the operator');
        return true;
      },
    );
    assert.equal(shim.calls(), 1, 'a non-race add failure must not be retried');
    assert.deepEqual(orphanBranches(f.primary), []);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a failure that is NOT the concurrency shape is reported at once, not retried', async () => {
  const f = fixture();
  try {
    // Retrying an auth failure would only produce the same error more slowly,
    // and would bury the one line the operator needs.
    const shim = gitShim(f.root, 'push', AUTH_FAILURE, 99);
    const { stderr } = await execFileAsync(
      'bash',
      [script, 'auth', 'feat/auth', '--no-install'],
      { cwd: f.primary, encoding: 'utf8', env: shim.env },
    );

    assert.match(stderr, /could not publish/);
    assert.match(stderr, /could not read Username/, 'the real error must reach the operator');
    assert.equal(shim.calls(), 1, 'an auth failure must not be retried');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// `--await` used to read "no install recorded" as unconditional
// success, even when node_modules was missing or out of sync with
// package-lock.json (a worktree rebased across a commit that added a
// dependency). A gate run in that state silently resolves modules against
// whatever OTHER checkout npm's lockfile-root heuristic finds, producing a
// false red (or green) in files the branch never touched. These tests target
// `--await`/`--install` directly against a plain directory, no real worktree
// or npm install needed, since the no-PID branch never shells out to npm.
//
// The same branch was later extended: "in sync with package-lock.json" is not
// the same claim as "usable". One provisioning wave produced a tree that exited
// NONZERO and was perfectly fine (a native package's implicit node-gyp rebuild
// failed after everything was unpacked), and another that exited ZERO with MORE
// directories than a healthy install and no jest, next or typescript at all. So
// markInstalled() lays down the artefacts a gate actually reaches for, and the
// tests below drive each way they can be missing.
const CORE_PACKAGES = ['jest', 'next', 'typescript', 'native-widget'];
const PREBUILD = `${process.platform}-${process.arch}.node`;

// What package-lock.json wants. playwright-core is in here because it is the
// package that actually drifted on 2026-09-05 (1.56.0 on disk against a lockfile
// wanting 1.62.1), the drift check must not be limited to the four packages
// deps_missing_reason() asserts, since the one that bit was none of them.
const LOCK_VERSIONS = {
  jest: '30.2.0',
  next: '16.0.4',
  typescript: '5.9.3',
  'native-widget': '13.0.3',
  'playwright-core': '1.62.1',
};

/** A minimal but REAL npm lockfile shape, both files use it, keyed by path. */
function lockJson(versions) {
  const packages = { '': { name: 'fixture', version: '0.1.0' } };
  for (const [name, version] of Object.entries(versions)) {
    packages[`node_modules/${name}`] = { version, resolved: `https://example.invalid/${name}` };
  }
  return `${JSON.stringify({ name: 'fixture', lockfileVersion: 3, packages }, null, 2)}\n`;
}

function markInstalled(
  dest,
  { stale = false, omit = [], binding = 'prebuild', installedVersions = {} } = {},
) {
  mkdirSync(path.join(dest, 'node_modules'), { recursive: true });
  for (const pkg of CORE_PACKAGES) {
    if (omit.includes(pkg)) continue;
    mkdirSync(path.join(dest, 'node_modules', pkg), { recursive: true });
  }
  if (binding === 'prebuild') {
    // The real layout: prebuilds/<platform>-<arch>.node, shipped for all 8
    // platforms and resolved at require time. NOTE there is deliberately no
    // build/ directory here, a SUCCESSFUL install has none either.
    const prebuilds = path.join(dest, 'node_modules', 'native-widget', 'prebuilds');
    mkdirSync(prebuilds, { recursive: true });
    writeFileSync(path.join(prebuilds, PREBUILD), '');
  } else if (binding === 'compiled') {
    // The other legitimate shape: a machine that DOES have a compiler built it.
    const release = path.join(dest, 'node_modules', 'native-widget', 'build', 'Release');
    mkdirSync(release, { recursive: true });
    writeFileSync(path.join(release, 'better_sqlite3.node'), '');
  }
  const recordPath = path.join(dest, 'node_modules', '.package-lock.json');
  writeFileSync(recordPath, lockJson({ ...LOCK_VERSIONS, ...installedVersions }));
  const lockPath = path.join(dest, 'package-lock.json');
  writeFileSync(lockPath, lockJson(LOCK_VERSIONS));
  const older = new Date(Date.now() - 60_000);
  const newer = new Date();
  if (stale) {
    utimesSync(recordPath, older, older);
    utimesSync(lockPath, newer, newer);
  } else {
    utimesSync(lockPath, older, older);
    utimesSync(recordPath, newer, newer);
  }
}

// resolve_dest() in the script decides "is this argument a full path or a
// bare slug" by looking for a separator. It now recognizes BACKSLASH
// separators too and normalizes them (a documented Windows
// shell hazard): interactive callers pass forward-slash paths, but a script building the
// argument with path.join() on win32 hands over backslashes, which used to
// fall silently through to the SLUG branch and resolve to nonsense. Tests
// still pass the canonical forward-slash shape everywhere except the test
// that pins the normalization itself.
const toBashPath = (p) => p.replace(/\\/g, '/');

// The inverse shape: what path.join() emits on win32. Synthesized on every
// platform so the normalization branch is exercised on Linux CI too.
const toBackslashPath = (p) => toBashPath(p).replace(/\//g, '\\');

test('resolve_dest treats a backslash-separated path as a PATH, not a slug', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-backslash');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  try {
    // Before the fix this fell into the slug branch (../<repo>-C:\...), which for
    // --await meant probing a nonexistent sibling and failing on its missing
    // node_modules instead of reporting THIS worktree's healthy state.
    const { stdout } = await run(f.primary, ['--await', toBackslashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when no install is recorded and node_modules is missing entirely', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-missing');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package-lock.json'), '{}\n');
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /missing or stale/);
      assert.match(err.stderr, /--install/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when node_modules predates a rebased package-lock.json', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-stale');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { stale: true });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /missing or stale/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await succeeds when node_modules is genuinely in sync and no install is recorded', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-fresh');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await exits 0 when there is no package-lock.json at all (--no-install case)', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-noinstall');
  mkdirSync(target, { recursive: true });
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /--no-install/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--install skips a genuinely up-to-date node_modules without shelling out to npm', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-install-fresh');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  markInstalled(target);
  try {
    const { stdout } = await run(f.primary, ['--install', toBashPath(target)]);
    assert.match(stdout, /already present and up to date/);
    assert.equal(existsSync(path.join(target, '.npm-install.pid')), false);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('background install escapes the caller process group when setsid is available', { timeout: 15_000 }, async (t) => {
  try {
    execFileSync('bash', ['-c', 'command -v setsid'], { encoding: 'utf8', env: ENV, stdio: 'ignore' });
  } catch {
    return t.skip('setsid is unavailable; use --wait for foreground install provisioning');
  }

  const f = fixture();
  const target = path.join(f.root, 'target-detached-install');
  const bin = path.join(f.root, 'fake-bin');
  const started = path.join(f.root, 'install-started');
  const completed = path.join(f.root, 'install-completed');
  mkdirSync(target, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(target, 'package-lock.json'), '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n');
  const fakeNpm = path.join(bin, 'npm');
  writeFileSync(fakeNpm, '#!/usr/bin/env bash\nprintf started > "$TEST_INSTALL_STARTED"\nsleep 1\nprintf completed > "$TEST_INSTALL_COMPLETED"\n');
  chmodSync(fakeNpm, 0o755);

  const env = {
    ...ENV,
    PATH: `${bin}:${ENV.PATH}`,
    TEST_INSTALL_STARTED: started,
    TEST_INSTALL_COMPLETED: completed,
  };
  const command = 'bash "$1" --install "$2"; for _ in {1..200}; do [[ -f "$3" ]] && break; sleep 0.02; done; kill -TERM -- "-$$"';
  const shell = spawn('bash', ['-c', command, 'bash', script, target, started], {
    cwd: f.primary,
    env,
    detached: true,
    stdio: 'ignore',
  });

  try {
    await new Promise((resolve, reject) => {
      shell.once('error', reject);
      shell.once('close', resolve);
    });

    const deadline = Date.now() + 3_000;
    while (!existsSync(completed) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(existsSync(started), true, 'the background installer should have started before the caller exits');
    assert.equal(existsSync(completed), true, 'the installer should finish after its caller process group is terminated');
  } finally {
    try { process.kill(-shell.pid, 'SIGKILL'); } catch { /* the caller group may already be gone */ }
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// --- the verdict is the TREE, not the exit code or the log ------

/** A pid that has certainly exited, so `--await`'s wait loop falls straight through. */
function deadPid() {
  return execFileSync('bash', ['-c', 'echo $$'], { encoding: 'utf8', env: ENV }).trim();
}

function recordFinishedInstall(dest, log) {
  writeFileSync(path.join(dest, '.npm-install.pid'), `${deadPid()}\n`);
  writeFileSync(path.join(dest, '.npm-install.log'), log);
}

/**
 * A short-lived background pid, recorded the same way the script itself
 * records npm ci's, `$!` from INSIDE a bash job-control table, not a
 * Windows-level pid handed back by Node's own `child_process.spawn()`. That
 * distinction matters on this platform: a `kill -0` run by one bash instance
 * cannot reliably resolve a pid that Node's spawn reports for a DIFFERENT
 * bash instance (MSYS `/proc` pids differ from native vs MSYS-aware
 * pids). `nohup` matters too, without it, the backgrounded sleep died the
 * moment its launching `bash -c` exited (measured: the wait loop fell
 * straight through with no heartbeat). Backgrounding this way gets a pid in
 * the same namespace the script's own `kill -0` checks and survives its
 * launcher's exit, exactly how `nohup bash … & echo $!` in install_deps()
 * does it.
 */
async function backgroundedPid(seconds) {
  const { stdout } = await execFileAsync(
    'bash',
    ['-c', `nohup sleep ${seconds} >/dev/null 2>&1 & echo $!`],
    { encoding: 'utf8', env: ENV },
  );
  return stdout.trim();
}

// the `--await` wait loop used to be silent from "Waiting for npm
// ci…" until the pid exited, and a real install routinely runs past
// an agent harness's 600s no-stream-progress watchdog, which killed two of
// three workers in one wave on 2026-09-09 while the install was
// actually still healthy. This pins that the loop now emits a heartbeat while
// it waits on a LIVE pid, using AGENT_TOOLING_AWAIT_HEARTBEAT_SECS to shorten the
// interval so the test does not have to wait out the real 30s default.
//
// the original version raced a FIXED 6-second pid against however
// long this test itself took to reach the wait loop. On a box busy with
// concurrent jest/tsc/eslint that race is lost: if spawning bash and getting
// scheduled took long enough, the pid could exit before the `while kill -0`
// loop ever ran once, so no heartbeat was ever printed and the assertion
// failed having exercised nothing, a flake, not a bug in the script. Rather
// than widen the margin and hope, the pid now lives until the test has
// PROVEN a heartbeat fired (via `waitForOutput`, polling the child's actual
// stdout), then is killed to let the run finish. That makes the pass/fail
// outcome independent of scheduling: a loaded box just takes longer to reach
// the same, deterministic proof.
test('--await emits a heartbeat while waiting on a live pid', { timeout: 120_000 }, async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-heartbeat');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  const pid = await backgroundedPid(600);
  writeFileSync(path.join(target, '.npm-install.pid'), `${pid}\n`);
  writeFileSync(path.join(target, '.npm-install.log'), 'unpacking widget\nunpacking gadget\n');
  const observed = runObserving(f.primary, ['--await', toBashPath(target)], {
    ...ENV,
    AGENT_TOOLING_AWAIT_HEARTBEAT_SECS: '1',
  });
  try {
    await waitForOutput(observed, /still waiting on npm ci \(pid \d+\), \d+s elapsed/);
    // Proven: let the wait loop's `kill -0 "$PID"` start failing so the run
    // can finish.
    execFileSync('bash', ['-c', `kill -9 ${pid} 2>/dev/null || true`], { env: ENV });
    const { stdout } = await observed.promise;
    assert.match(stdout, /still waiting on npm ci \(pid \d+\), \d+s elapsed/);
    // The log detail rides along on the heartbeat line.
    assert.match(stdout, /unpacking gadget/);
    assert.match(stdout, /Dependencies ready/);
  } finally {
    execFileSync('bash', ['-c', `kill -9 ${pid} 2>/dev/null || true`], { env: ENV });
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await passes on a prebuilt native-widget even though there is no build/ directory', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-prebuilt');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  try {
    // The false signal this pins: an agent seeing no build/ concludes the
    // install failed and starts repairing a working machine. A successful
    // install has no build/ either.
    assert.equal(existsSync(path.join(target, 'node_modules', 'native-widget', 'build')), false);
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await passes on a locally COMPILED native-widget with no prebuilds/', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-compiled');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'compiled' });
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when native-widget has no native binding at all', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-nobinding');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'none' });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /INCOMPLETE/);
      assert.match(err.stderr, /native-widget has no native binding/);
      assert.match(err.stderr, /--install/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when node_modules is in sync with the lockfile but jest is absent', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-nojest');
  mkdirSync(target, { recursive: true });
  // End state 4: two overlapping installs exit ZERO and leave more directories
  // than a healthy install, with the packages every gate needs missing.
  markInstalled(target, { omit: ['jest'] });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /node_modules\/jest is missing/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await keeps a USABLE tree whose install log reported npm errors', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-noisy-log');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  recordFinishedInstall(target, 'npm error code 1\nnpm error gyp ERR! find VS\n');
  try {
    const { stdout, stderr } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /Dependencies ready/);
    assert.match(stderr, /WARNING: npm reported errors, but the tree verifies as complete/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails on a finished install that left no native binding, and shows the log', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-finished-broken');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'none' });
  recordFinishedInstall(target, 'npm error gyp ERR! configure error\n');
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /did not leave a usable tree/);
      assert.match(err.stderr, /gyp ERR! configure error/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// --- the mtime check cannot see a lockfile rewritten MID-INSTALL ---
//
// The SessionStart [worktree-refresh] fast-forward rewrites package-lock.json
// while the provisioning npm ci is still running. The install finishes
// afterwards, so npm's record (node_modules/.package-lock.json) is NEWER than
// the lockfile and deps_stale() reads the tree as fresh, while it holds the
// previous lock's package versions. Every fixture below is deliberately built in
// exactly that shape: record newer, versions different. Before the fix `--await`
// printed "Dependencies ready" for all of them.

test('--await fails on a version-drifted tree even though npm record is NEWER than the lockfile', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-drift');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { installedVersions: { 'playwright-core': '1.56.0' } });
  try {
    // The mtime ordering that fooled deps_stale(): npm's record is the newer file.
    const record = statSync(path.join(target, 'node_modules', '.package-lock.json')).mtimeMs;
    const lock = statSync(path.join(target, 'package-lock.json')).mtimeMs;
    assert.ok(record > lock, 'fixture must reproduce the record-newer-than-lockfile ordering');
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /DIFFERENT package-lock\.json/);
      assert.match(err.stderr, /playwright-core 1\.56\.0 installed, 1\.62\.1 wanted/);
      assert.match(err.stderr, /--install/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails after a FINISHED install whose lockfile was rewritten underneath it', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-drift-finished');
  mkdirSync(target, { recursive: true });
  // The observed 2026-09-05 shape: the install ran to completion and exited
  // cleanly, so nothing in the log or the artefact checks says anything is wrong.
  markInstalled(target, { installedVersions: { 'playwright-core': '1.56.0', jest: '30.0.0' } });
  recordFinishedInstall(target, 'added 1500 packages in 2m\n');
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /finished against a DIFFERENT package-lock\.json/);
      assert.match(err.stderr, /2 package\(s\) do not match/);
      assert.match(err.stderr, /jest 30\.0\.0 installed, 30\.2\.0 wanted/);
      assert.match(err.stderr, /playwright-core 1\.56\.0 installed, 1\.62\.1 wanted/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await stays green on a finished install whose versions all match', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-drift-none');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  recordFinishedInstall(target, 'added 1500 packages in 2m\n');
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /Dependencies ready/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('deps_version_drift gives NO verdict when the lockfiles are not readable JSON', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-drift-unparseable');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  // Never invent a failure out of an unreadable file, the same discipline
  // deps_missing_reason() applies to a missing `node`.
  writeFileSync(path.join(target, 'node_modules', '.package-lock.json'), 'not json\n');
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--install reinstalls a version-drifted tree instead of calling it up to date', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-drift-install');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  // --await's prescription is `--install`; if --install said "nothing to do"
  // here the pair would be a loop with no way out.
  markInstalled(target, { installedVersions: { 'playwright-core': '1.56.0' } });
  const binDir = path.join(f.root, 'npm-shim-drift');
  mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(f.root, 'npm-args-drift');
  writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 });
  try {
    const { stdout } = await execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], {
      cwd: f.primary,
      encoding: 'utf8',
      env: withBinFirst(ENV, binDir),
    });
    assert.match(stdout, /Reinstalling:? .*playwright-core 1[.]56[.]0 installed, 1[.]62[.]1 wanted/);
    assert.match(readFileSync(argsFile, 'utf8'), /ci .*--ignore-scripts/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--install reinstalls an INCOMPLETE tree, with --ignore-scripts', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-incomplete');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  // In sync with the lockfile, so deps_stale() says "fine", but unusable.
  // Before this, --await said "run --install" and --install said "nothing to
  // do", which is a loop with no way out.
  markInstalled(target, { binding: 'none' });
  const binDir = path.join(f.root, 'npm-shim');
  mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(f.root, 'npm-args');
  writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 });
  try {
    const { stdout } = await execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], {
      cwd: f.primary,
      encoding: 'utf8',
      env: withBinFirst(ENV, binDir),
    });
    assert.match(stdout, /Reinstalling: native-widget has no native binding/);
    assert.match(readFileSync(argsFile, 'utf8'), /ci --prefer-offline --ignore-scripts/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// --- Playwright's browsers live OUTSIDE the worktree --------------
//
// Every check above reads node_modules. Playwright's browsers are not in there:
// they are a separate, versioned download into a registry keyed by revision
// ($PLAYWRIGHT_BROWSERS_PATH, else the platform cache dir), so a tree that is
// complete AND in sync with package-lock.json can still have no runnable browser
// at all. Observed 2026-09-06: --await said "Dependencies ready", then the first
// e2e run died in its auth setup with `Executable doesn't exist at
// .../chromium-1234/...` on a worktree holding only chromium-1194 and -1228.
//
// The assertion deliberately does NOT install: ~306 MB per fan-out wave for tasks
// that mostly never touch e2e was rejected on cost, so the contract is that
// --await NAMES the missing browser and the exact command that fixes it.
//
// The exit-code split added the second half of that contract: it exits EXIT_BROWSERS_MISSING (3),
// not 1. `--await` is mandatory before every gate, with no carve-out, so a task that changes 11 PNGs or one data
// module used to get a non-zero exit from a required step for a reason unrelated to
// whether its gates could run, and had to decide unsupervised whether the repo's own
// ritual had just failed. Both workers in the 2026-09-20 wave hit it and both reported
// it unprompted. One exit code was carrying two unrelated verdicts; now 1 means "no gate
// may run" and 3 means "every gate but e2e may run".

/**
 * Stand in for `node_modules/playwright-core/cli.js`, whose
 * `install --dry-run chromium` prints an indented "Install location:" line per
 * browser. Stubbed rather than real: what is under test is "does that location
 * exist and is it complete", and a real playwright-core plus a real ~306 MB
 * browser download would be the slowest test in this suite by two orders of
 * magnitude. Its PRESENCE is also the "does this tree do e2e at all" signal, so
 * every other test in this file exercises the no-Playwright path for free.
 */
function markPlaywright(dest, { locations = [], exitCode = 0, extraOutput = '', declared = true } = {}) {
  // The check runs only for a project that DECLARES Playwright; a stray playwright-core under
  // some other tool must not make an unrelated project fail on browsers it never launches.
  if (declared) {
    writeFileSync(
      path.join(dest, 'package.json'),
      `${JSON.stringify({ name: 'fixture', devDependencies: { '@playwright/test': '^1.63.0' } })}\n`,
    );
  }
  if (declared) mkdirSync(path.join(dest, 'node_modules', '@playwright', 'test'), { recursive: true });
  const cliDir = path.join(dest, 'node_modules', 'playwright-core');
  mkdirSync(cliDir, { recursive: true });
  const lines = [
    `const locations = ${JSON.stringify(locations)};`,
    'for (const loc of locations) {',
    "  console.log('Chrome for Testing 151.0.7922.34 (playwright chromium v1234)');",
    "  console.log('  Install location:    ' + loc);",
    "  console.log('  Download url:        https://example.invalid/chrome.zip');",
    "  console.log('');",
    '}',
    `process.stdout.write(${JSON.stringify(extraOutput)});`,
    `process.exit(${exitCode});`,
    '',
  ];
  writeFileSync(path.join(cliDir, 'cli.js'), lines.join('\n'));
}

/** A browser directory as `playwright install` leaves it: marker written last. */
function browserDir(registry, name, { complete = true } = {}) {
  const dir = path.join(registry, name);
  mkdirSync(dir, { recursive: true });
  if (complete) writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
  return dir;
}

test('--await stays green when Playwright is present and its pinned browser is installed', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browsers-ok');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  const registry = path.join(f.root, 'ms-playwright-ok');
  markPlaywright(target, {
    locations: [browserDir(registry, 'chromium-1234'), browserDir(registry, 'chromium_headless_shell-1234')],
  });
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when the PINNED Playwright browser is not installed', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browsers-missing');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  const registry = path.join(f.root, 'ms-playwright-old');
  // The exact 2026-09-06 shape: older revisions present, the pinned one absent.
  browserDir(registry, 'chromium-1194');
  browserDir(registry, 'chromium-1228');
  markPlaywright(target, {
    locations: [path.join(registry, 'chromium-1234'), browserDir(registry, 'chromium_headless_shell-1234')],
  });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      // Names the browser AND its pinned revision, "install browsers" alone
      // would not tell the next agent which revision it is short of.
      assert.match(err.stderr, /chromium-1234/);
      assert.match(err.stderr, /node node_modules\/playwright-core\/cli\.js install chromium/);
      // The prescription must NOT be --install: no amount of reinstalling
      // node_modules puts a browser in the registry.
      assert.doesNotMatch(err.stderr, /worktree-new\.sh --install/);
      // The headless shell IS installed, so it must not be listed as missing.
      assert.doesNotMatch(err.stderr, /chromium_headless_shell/);
      // its OWN exit code, so a caller can tell "no gate may run" from
      // "only e2e is unavailable" without parsing prose.
      assert.equal(err.code, 3, 'a browser-only failure must not share exit 1 with a dep failure');
      // And the message must say so, because the exit code is not the thing an agent
      // reads first, the tree is still the verdict.
      assert.match(err.stderr, /dependencies in .* ARE ready/);
      assert.match(err.stderr, /every gate except e2e can run now/);
      assert.match(err.stderr, /not a reason to stop/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails on a half-extracted browser directory (no INSTALLATION_COMPLETE)', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browsers-partial');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  const registry = path.join(f.root, 'ms-playwright-partial');
  // A directory alone is not a browser: an interrupted download leaves one
  // behind, and Playwright itself gates on the marker file, not the directory.
  markPlaywright(target, { locations: [browserDir(registry, 'chromium-1234', { complete: false })] });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /chromium-1234/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails on missing browsers AFTER a finished install, too', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browsers-finished');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  // Nothing in the install path downloads a browser, on purpose, so a
  // perfectly successful install is exactly when this has to still be checked.
  recordFinishedInstall(target, 'added 1500 packages in 2m\n');
  markPlaywright(target, { locations: [path.join(f.root, 'ms-playwright-none', 'chromium-1234')] });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.match(err.stderr, /chromium-1234/);
      assert.doesNotMatch(err.stdout ?? '', /Dependencies ready/);
      // Same verdict on the post-install path as on the no-install-running one.
      assert.equal(err.code, 3);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await keeps exit 1 for a REAL dependency failure, so 3 stays unambiguous', async () => {
  // The whole point of the split is the PAIR, not either code alone: a caller can only
  // act on 3 ("gates other than e2e are fine") if 1 still means what it always meant.
  // Both trees below are missing something; only one of them is a reason to stop.
  const f = fixture();
  try {
    const broken = path.join(f.root, 'target-code-broken-deps');
    mkdirSync(broken, { recursive: true });
    markInstalled(broken, { omit: ['jest'] });
    // Playwright IS fine here, so if the two verdicts were ever merged again, this
    // case and the one below would become indistinguishable from each other.
    const okRegistry = path.join(f.root, 'ms-playwright-both-ok');
    markPlaywright(broken, { locations: [browserDir(okRegistry, 'chromium-1234')] });

    await assert.rejects(run(f.primary, ['--await', toBashPath(broken)]), (err) => {
      assert.equal(err.code, 1, 'a missing core package is still the fatal verdict');
      assert.match(err.stderr, /INCOMPLETE/);
      assert.doesNotMatch(
        err.stderr,
        /every gate except e2e can run now/,
        'it must NOT tell a worker to carry on when node_modules is broken',
      );
      return true;
    });

    const browsersOnly = path.join(f.root, 'target-code-browsers-only');
    mkdirSync(browsersOnly, { recursive: true });
    markInstalled(browsersOnly);
    markPlaywright(browsersOnly, {
      locations: [path.join(f.root, 'ms-playwright-absent', 'chromium-1234')],
    });

    await assert.rejects(run(f.primary, ['--await', toBashPath(browsersOnly)]), (err) => {
      assert.equal(err.code, 3, 'the same code as a dep failure is what made this ambiguous');
      assert.doesNotMatch(err.stderr, /INCOMPLETE/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--help prints the --await exit-code table', async () => {
  // The header block is printed by LINE RANGE, so it can silently slide off the end of
  // the range as the header grows. That table is the first thing a worker needs after a
  // non-zero exit from the step the ritual made mandatory, so pin that it is reachable.
  const f = fixture();
  try {
    const { stdout } = await run(f.primary, ['--help']);
    assert.match(stdout, /--await exit codes/);
    assert.match(stdout, /EVERY OTHER GATE IS FINE/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await is unaffected by the browser check when the tree has no Playwright', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-no-playwright');
  mkdirSync(target, { recursive: true });
  // markInstalled() lays down no playwright-core, which is the --omit=dev /
  // --no-install shape: a worktree that will never run e2e must not be slowed
  // by the check, and must certainly never fail it.
  markInstalled(target);
  assert.equal(existsSync(path.join(target, 'node_modules', 'playwright-core')), false);
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('browsers_missing_reason gives NO verdict when the Playwright CLI fails or says nothing', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browsers-unparseable');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  // Same discipline as deps_missing_reason() with a missing `node` and
  // deps_version_drift() with an unreadable lockfile: never invent a failure
  // out of a tool that did not answer. A CLI whose output shape changed must
  // not strand every worktree in the repo.
  markPlaywright(target, { locations: [], exitCode: 1, extraOutput: 'unrecognized option\n' });
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a failure after the worktree is added cleans up its own branch ref', async () => {
  const f = fixture();
  try {
    // Base the worktree on a commit that carries NO files. That trips the
    // script's own empty-index provisioning guard, a real error
    // path, no stubbing, which exits 1 after `git worktree add` has already
    // created the branch. Pre-fix, that ref survived as an orphan.
    const emptyTree = git(f.primary, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    const empty = git(f.primary, 'commit-tree', '-m', 'empty', emptyTree);
    git(f.primary, 'branch', 'empty-base', empty);

    await assert.rejects(
      run(f.primary, ['boom', 'feat/boom', '--base', 'empty-base', '--no-install']),
      (err) => {
        assert.match(err.stderr, /EMPTY index/);
        return true;
      },
    );

    assert.ok(
      !git(f.primary, 'branch', '--list', 'feat/boom'),
      'the failed run left an orphan branch ref behind',
    );
    assert.ok(!existsSync(path.join(f.root, 'primary-boom')), 'the failed run left its worktree directory behind');
    assert.deepEqual(orphanBranches(f.primary).sort(), ['empty-base']);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// ── `--await` must wait out an in-progress CREATION, not just an ──
// in-progress INSTALL ─────────────────────────────────────────────────────
//
// An orchestrator's `bash scripts/worktree-new.sh <slug> <branch>` call
// ran past the Bash tool's own timeout and got moved to the background while
// `git worktree add` was still checking out. `git worktree list` already showed
// the entry, git adds the admin entry and starts checking out before the command
// returns, so the orchestrator launched a worker against it. That worker's
// `--await` found no `.npm-install.pid` (creation had not reached that far) and no
// package-lock.json either, read the no-PIDF branch's own reasoning ("--no-install
// was used") as applying, and exited 0, ready, over a worktree whose checkout was
// still running and, at the moment the worker looked, had an EMPTY index
//
// These tests exercise the fix directly against the creation marker this script
// writes, without racing a real `git worktree add`, the concurrency tests above
// already race real processes for the OTHER hazards this script guards against,
// and the same technique here would be flaky by construction (this fix exists
// precisely because a real race is not deterministic to observe from outside).
function creationMarkerPath(dest) {
  return path.join(path.dirname(dest), `.worktree-creating-${path.basename(dest)}`);
}

// the original version cleared the marker on a fixed 2500ms JS
// timer, started at spawn, and then asserted `elapsedMs >= 2000` as its proof
// that a real wait happened. Both halves of that race against CPU load: a
// timer callback can itself fire late under a starved event loop (masking
// the intended shape), but worse, the CHILD process can be slow enough to
// even reach its own `if [ -f marker ]` check that the timer wins first and
// deletes the marker before the child ever looks for it, at which point the
// child skips the wait branch entirely, "Waiting for worktree creation to
// finish" never appears, and the test fails having exercised nothing. The fix
// is the same idea as the heartbeat test above: only remove the marker once
// the child has PROVEN, via its own stdout, not a guess about its timing,
// that it is actually waiting on it, and replace the elapsed-time assertion
// with an assertion on the ORDER the three output lines happen to appear in.
test('--await waits out an in-progress creation marker, then proceeds once it clears', { timeout: 120_000 }, async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-creating');
  mkdirSync(target, { recursive: true });
  const marker = creationMarkerPath(target);
  writeFileSync(marker, `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
  const observed = runObserving(f.primary, ['--await', toBashPath(target)]);
  try {
    // Cleared from OUTSIDE the run, the same shape a live worktree-new.sh
    // process clearing its own marker after the empty-index assertion passes
    // would produce, but only once the child has actually printed the wait
    // message, not on a wall-clock guess about when it would have.
    await waitForOutput(observed, /Waiting for worktree creation to finish/);
    rmSync(marker, { force: true });
    const { stdout } = await observed.promise;
    assert.match(stdout, /Waiting for worktree creation to finish/);
    assert.match(stdout, /Worktree creation finished/);
    // No package-lock.json in this fixture, so once the wait clears the run falls
    // through to the --no-install branch, proving the wait actually GATED the
    // readiness questions rather than the marker being ignored.
    assert.match(stdout, /--no-install/);
    // Ordering, not elapsed time: the wait message must precede the
    // clear-confirmation, which must precede the readiness answer below it,
    // true regardless of how long any of it took on this run of the box.
    const waitIdx = stdout.indexOf('Waiting for worktree creation to finish');
    const finishedIdx = stdout.indexOf('Worktree creation finished');
    const readyIdx = stdout.indexOf('--no-install');
    assert.ok(
      waitIdx >= 0 && finishedIdx > waitIdx && readyIdx > finishedIdx,
      `expected wait < finished < readiness ordering in:\n${stdout}`,
    );
  } finally {
    rmSync(marker, { force: true });
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly when a creation marker outlives its deadline', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-stuck-creating');
  mkdirSync(target, { recursive: true });
  const marker = creationMarkerPath(target);
  // Never cleared, simulates a creating process that died without cleaning up
  // after itself (killed outright, rather than exiting normally through its trap).
  writeFileSync(marker, `${process.pid} ${Math.floor(Date.now() / 1000)}\n`);
  try {
    await assert.rejects(
      run(f.primary, ['--await', toBashPath(target)], {
        ...ENV,
        AGENT_TOOLING_AWAIT_CREATION_DEADLINE_SECONDS: '1',
      }),
      (err) => {
        assert.equal(err.code, 1);
        assert.match(err.stderr, /has not finished after 1s/);
        assert.match(err.stderr, /reset --hard HEAD/);
        assert.match(err.stderr, /worktree-creating-target-stuck-creating/, 'names the marker to remove');
        return true;
      },
    );
  } finally {
    rmSync(marker, { force: true });
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await fails loudly on a real worktree whose index is EMPTY, even with no creation marker', async () => {
  const f = fixture();
  try {
    // A real worktree, fully created, the empty-index guard already proved this
    // one's checkout complete when it was made. Then reach the in-progress-creation shape
    // directly: the checkout finished as far as git is concerned, but nothing is
    // staged. `git rm -r --cached` is the git-native inverse of the documented
    // recovery (`git reset --hard HEAD`), so this reaches the exact state a killed
    // mid-checkout `git worktree add` leaves, without racing one.
    await run(f.primary, ['empty-await', 'feat/empty-await', '--no-install']);
    const target = path.join(f.root, 'primary-empty-await');
    git(target, 'rm', '-r', '--cached', '-q', '.');
    assert.equal(git(target, 'ls-files'), '', 'sanity: the index must actually be empty for this test to mean anything');

    await assert.rejects(run(f.primary, ['--await', toBashPath(target)]), (err) => {
      assert.equal(err.code, 1);
      assert.match(err.stderr, /EMPTY index/);
      assert.match(err.stderr, /reset --hard HEAD/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('--await on a real, fully-checked-out worktree is unaffected by the new creation/index checks', async () => {
  const f = fixture();
  try {
    await run(f.primary, ['ok-await', 'feat/ok-await', '--no-install']);
    const target = path.join(f.root, 'primary-ok-await');
    assert.notEqual(git(target, 'ls-files'), '', 'sanity: the fixture worktree really is populated');
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)]);
    assert.match(stdout, /--no-install/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a successful creation removes its own creation marker', async () => {
  const f = fixture();
  try {
    await run(f.primary, ['clean-marker', 'feat/clean-marker', '--no-install']);
    const target = path.join(f.root, 'primary-clean-marker');
    assert.equal(existsSync(creationMarkerPath(target)), false, 'a finished creation left its marker behind');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a creation that fails its own empty-index guard still removes its own creation marker', async () => {
  const f = fixture();
  try {
    const emptyTree = git(f.primary, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    const empty = git(f.primary, 'commit-tree', '-m', 'empty', emptyTree);
    git(f.primary, 'branch', 'empty-base-marker', empty);
    await assert.rejects(
      run(f.primary, ['boom-marker', 'feat/boom-marker', '--base', 'empty-base-marker', '--no-install']),
    );
    const target = path.join(f.root, 'primary-boom-marker');
    assert.equal(existsSync(creationMarkerPath(target)), false, 'the failed run leaked its creation marker');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// ── the creation mutex ───────────────────────────────────────────
//
// The concurrency tests above race real processes, so before this lock existed
// they were only as deterministic as a retry budget. They went red on a change
// (run 33695809088), a UI-only PR touching nothing under scripts/, with
//
//   fatal: bad object worktrees/wt-s2/HEAD
//   error: …/origin.git did not send all necessary objects
//   ERROR: could not fetch origin/main
//
// and green on a rerun of the same commit. Root cause, reproduced deterministically
// on 2026-09-02 by pointing one worktree's .git/worktrees/<name>/HEAD at an
// unresolvable OID: `git fetch` then fails for the WHOLE repo, because its
// connectivity check runs `rev-list --not --all` and `--all` enumerates every other
// worktree's HEAD. `--negotiation-tip` and `fetch.negotiationAlgorithm=noop` were
// both measured making no difference, so no git flag opts out, the fix has to be
// that no sibling is mid-add while we fetch.
//
// These tests pin the mutex itself rather than trying to out-race the scheduler.
// Every timing assertion here points the load-insensitive way: a busy box can only
// make "has not created the worktree yet" MORE true, never less.
const lockDir = (primary) => path.join(primary, '.git', 'worktree-create.lock');

function holdCreationLock(primary, ageSeconds = 0) {
  const dir = lockDir(primary);
  mkdirSync(dir, { recursive: false });
  writeFileSync(path.join(dir, 'owner'), `999999 ${Math.floor(Date.now() / 1000) - ageSeconds}\n`);
  return dir;
}

test('a held creation lock makes a run WAIT rather than fetch beside a sibling mid-add', async () => {
  const f = fixture();
  const lock = holdCreationLock(f.primary);
  try {
    const running = run(f.primary, ['lk', 'feat/lk', '--no-install'], CONTENTION_ENV);
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    // 1.5s is far past the ~200ms an uncontended run needs to create its worktree
    // (the failing CI run reached its fetch inside 100ms). A slower box only makes
    // this assertion safer, which is the whole point of asserting in this direction.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(settled, false, 'the run finished while another writer held the creation lock');
    assert.equal(
      existsSync(path.join(f.root, 'primary-lk')),
      false,
      'the run created its worktree while another writer held the creation lock',
    );

    rmSync(lock, { recursive: true, force: true });
    await running;
    assert.ok(existsSync(path.join(f.root, 'primary-lk')), 'the run never completed after the lock was released');
    assert.equal(git(f.primary, 'config', '--get', 'branch.feat/lk.merge'), 'refs/heads/feat/lk');
    assert.equal(existsSync(lockDir(f.primary)), false, 'the lock was not released on a successful exit');
  } finally {
    removeTempDir(lock, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The control for the test above. Without it, a lock that is never CONSULTED and a
// run that is merely slow look identical, and the wait test would keep passing over
// a mutex that had quietly stopped working.
test('AGENT_TOOLING_WORKTREE_NO_LOCK proceeds straight through a held lock, so the wait above is the LOCK', async () => {
  const f = fixture();
  const lock = holdCreationLock(f.primary);
  try {
    // A large retry budget on purpose: if the escape hatch ever stopped working this
    // must hang until the test's own timeout and fail LOUDLY, rather than waiting
    // out a small budget, proceeding unlocked and passing vacuously.
    await run(f.primary, ['nolock', 'feat/nolock', '--no-install'], {
      ...CONTENTION_ENV,
      AGENT_TOOLING_WORKTREE_NO_LOCK: '1',
    });
    assert.ok(existsSync(path.join(f.root, 'primary-nolock')));
    assert.ok(existsSync(lock), 'the escape-hatch run removed a lock it never took');
  } finally {
    removeTempDir(lock, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a lock left behind by a dead process is broken through, not waited on forever', async () => {
  const f = fixture();
  const lock = holdCreationLock(f.primary, 9999);
  try {
    const { stderr } = await run(f.primary, ['stale', 'feat/stale', '--no-install'], CONTENTION_ENV);
    assert.match(stderr, /breaking a worktree-creation lock/);
    assert.ok(existsSync(path.join(f.root, 'primary-stale')));
    assert.equal(existsSync(lockDir(f.primary)), false, 'the broken lock was not cleaned up');
  } finally {
    removeTempDir(lock, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// ── the mkdir->stamp window ──────────────────────────────────────
//
// `mkdir` is the atomic acquire and the owner stamp lands as a SECOND step, so a
// lock that is genuinely HELD is momentarily stampless. The old waiter broke a
// stampless lock on sight, its comment reasoned that "only a crash between the
// mkdir and the write produces one", which omits the live holder that also does.
// Under load that let B delete A's lock while A held it; both then ran
// `git worktree add` concurrently and on Windows the loser died with
// `Permission denied` reading .git/config, the very failure the lock prevents.
// Seen 2026-09-05 as a red on the concurrency test at the top of this file, green
// on every isolated rerun, which is why the flake IS the bug report.
//
// A stampless lock is simulated directly rather than by racing the scheduler for a
// microsecond-wide window: the holder's observable state in that window is exactly
// "lock dir exists, no owner file", and that is what these construct.
function holdStamplessCreationLock(primary) {
  const dir = lockDir(primary);
  mkdirSync(dir, { recursive: false });
  return dir;
}

test('a lock with no owner stamp yet is WAITED for, not broken, a live holder is mid-acquire', async () => {
  const f = fixture();
  const lock = holdStamplessCreationLock(f.primary);
  try {
    const running = run(f.primary, ['nostamp', 'feat/nostamp', '--no-install'], CONTENTION_ENV);
    let settled = false;
    running.then(() => { settled = true; }, () => { settled = true; });
    // Well inside the default 5s grace, and far past the ~200ms an uncontended run
    // needs to create its worktree. A slower box only makes both assertions safer.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(settled, false, 'the run broke a stampless lock a live holder was still taking');
    assert.equal(
      existsSync(path.join(f.root, 'primary-nostamp')),
      false,
      'the run created its worktree while another writer held a stampless lock',
    );

    // Releasing it must let the run through: this is a WAIT, never a wedge.
    rmSync(lock, { recursive: true, force: true });
    await running;
    assert.ok(existsSync(path.join(f.root, 'primary-nostamp')), 'the run never completed after the lock was released');
    assert.equal(existsSync(lockDir(f.primary)), false, 'the lock was not released on a successful exit');
  } finally {
    removeTempDir(lock, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// The other half of the grace, and the reason it is a grace rather than a refusal:
// a holder that really did die between its mkdir and its stamp leaves a lock nobody
// will ever stamp, and that must still be reaped.
test('a stampless lock IS broken once the grace elapses, a crashed holder still gets reaped', async () => {
  const f = fixture();
  const lock = holdStamplessCreationLock(f.primary);
  try {
    const { stderr } = await run(f.primary, ['crashed', 'feat/crashed', '--no-install'], {
      ...CONTENTION_ENV,
      WORKTREE_NEW_LOCK_STAMP_GRACE_SECONDS: '1',
    });
    assert.match(stderr, /never wrote an owner stamp/);
    assert.ok(existsSync(path.join(f.root, 'primary-crashed')), 'the crashed holder was never reaped');
    assert.equal(existsSync(lockDir(f.primary)), false, 'the broken lock was not cleaned up');
  } finally {
    removeTempDir(lock, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// An unparseable stamp must read as "no stamp", never as an age. `cut -d' ' -f2`
// prints the WHOLE line when the delimiter is absent, so a half-written stamp came
// back as the pid, a small integer that computes to an age of ~56 years. That is
// how the bug report contained "left behind 1788632685s ago" as a statement of
// fact, which sent the reader looking for a lock from 1970 instead of a live one.
test('a garbled owner stamp is not reported as an epoch-sized age', async () => {
  const f = fixture();
  const dir = lockDir(f.primary);
  mkdirSync(dir, { recursive: false });
  writeFileSync(path.join(dir, 'owner'), '999999\n'); // pid written, stamp not yet
  try {
    const { stderr } = await run(f.primary, ['garbled', 'feat/garbled', '--no-install'], {
      ...CONTENTION_ENV,
      WORKTREE_NEW_LOCK_STAMP_GRACE_SECONDS: '1',
    });
    assert.doesNotMatch(
      stderr,
      /left behind \d{7,}s ago/,
      `an unreadable stamp was printed as an age:\n${stderr}`,
    );
    assert.match(stderr, /never wrote an owner stamp/);
    assert.ok(existsSync(path.join(f.root, 'primary-garbled')));
  } finally {
    removeTempDir(dir, 'worktree-new.node-test');
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a run that FAILS still releases the creation lock', async () => {
  const f = fixture();
  try {
    // The empty-index provisioning guard: a real error path, no
    // stubbing, that exits after the lock has been taken. A lock leaked here would
    // stall every later creation in the repo for the whole stale window.
    const emptyTree = git(f.primary, 'hash-object', '-t', 'tree', '-w', '/dev/null');
    const empty = git(f.primary, 'commit-tree', '-m', 'empty', emptyTree);
    git(f.primary, 'branch', 'empty-base', empty);
    await assert.rejects(run(f.primary, ['leak', 'feat/leak', '--base', 'empty-base', '--no-install']));
    assert.equal(existsSync(lockDir(f.primary)), false, 'a failed run leaked the creation lock');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// ── AGENT_TOOLING_WORKTREE_ROOT ────────────────────────────────────────────
// A bare slug used to resolve ONLY as a sibling of the primary checkout, so a
// orchestrator fan-out, hundreds of MB per worktree, always landed on the primary's drive
// whatever the harness's worktree-location setting said. On 2026-09-02 that drive
// hit 2.2 GB free and killed a worker's build with ENOSPC, corrupting a jest
// transform cache into four bogus suite failures.
test('AGENT_TOOLING_WORKTREE_ROOT relocates a bare slug, and the isolation checks pass against it', async () => {
  const f = fixture();
  const elsewhere = path.join(f.root, 'other-root', 'nested');
  try {
    const { stdout } = await run(f.primary, ['moved', 'feat/moved', '--no-install'], {
      ...ENV,
      AGENT_TOOLING_WORKTREE_ROOT: elsewhere,
    });
    const dest = path.join(elsewhere, 'primary-moved');
    // Created on demand: a root that does not exist yet is the normal first use.
    assert.ok(existsSync(dest), `worktree was not created under AGENT_TOOLING_WORKTREE_ROOT:\n${stdout}`);
    assert.ok(!existsSync(path.join(f.root, 'primary-moved')), 'it also landed in the default location');
    assert.match(stdout, /\(published\)/);
    // The script's own isolation assertion ran against the relocated path; this
    // re-checks it from outside, since a wrong root would still have "succeeded".
    // realpath: git prints the LONG form, and a Windows %TEMP% can be an 8.3 short
    // name (windows-latest's is C:/Users/RUNNER~1/..., git says runneradmin).
    assert.equal(git(dest, 'rev-parse', '--show-toplevel'), realpathSync.native(dest).split(path.sep).join('/'));
    assert.equal(git(f.primary, 'config', '--get', 'branch.feat/moved.merge'), 'refs/heads/feat/moved');
    // The --await hint must name the PATH: a shell without the variable resolves a
    // bare slug somewhere else entirely, and --await would then report on nothing.
    assert.ok(
      toBashPath(stdout).includes(`--await ${toBashPath(dest)}`),
      `--await hint did not name the relocated path:\n${stdout}`,
    );
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('with AGENT_TOOLING_WORKTREE_ROOT unset a bare slug still lands beside the primary checkout', async () => {
  const f = fixture();
  try {
    await run(f.primary, ['default', 'feat/default', '--no-install']);
    assert.ok(existsSync(path.join(f.root, 'primary-default')), 'the default location changed');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a full path as the slug still overrides AGENT_TOOLING_WORKTREE_ROOT, per call', async () => {
  const f = fixture();
  const root = path.join(f.root, 'ignored-root');
  const explicit = path.join(f.root, 'explicit-dest');
  try {
    // A bash-form path: `resolve_dest` recognises a full path by the forward slash
    // in it, which is also how every real caller passes one.
    await run(f.primary, [toBashPath(explicit), 'feat/explicit', '--no-install'], {
      ...ENV,
      AGENT_TOOLING_WORKTREE_ROOT: root,
    });
    assert.ok(existsSync(explicit));
    assert.ok(!existsSync(root), 'the env root was used despite an explicit path');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

// with core.fsmonitor on in the shared .git/config, `git worktree add` hung
// forever (its child `git reset --hard` waited on an fsmonitor daemon for the half-made
// worktree). Three sessions lost a worktree to it on 2026-09-28, 09-29 and 10-01; the
// fix is that this script runs its git with core.fsmonitor=false.
//
// The real defect needs the builtin daemon, which no hermetic test can wedge. What IS
// observable is the CONFIG the script's git ran under: a hook-based fsmonitor
// (core.fsmonitor=<script>) is consulted by the same code path whenever the setting is
// on, so a hook that logs each call tells us whether git was told to use fsmonitor.
// No PATH shim, so this runs on Windows too.
//
// The override rides on GIT_CONFIG_COUNT/KEY_n/VALUE_n, which git only reads from 2.31 on.
// An older git ignores it silently: measured on a Windows box with git 2.30.0.windows.2
// the hook test saw fsmonitor consulted, the lib probes read no override at
// all, and the "caller entry turns it ON" test passed only because the caller's entry was
// ignored too. So the tests that need the channel ask git whether it honours it, and skip
// with the version when it does not, rather than fail on, or vacuously pass, an old git.
const GIT_CONFIG_ENV_SKIP = (() => {
  const probe = { ...ENV, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'agenttest.configenvprobe', GIT_CONFIG_VALUE_0: 'yes' };
  try {
    const got = execFileSync('git', ['config', '--get', 'agenttest.configenvprobe'], { encoding: 'utf8', env: probe, stdio: ['ignore', 'pipe', 'ignore'] });
    if (got.trim() === 'yes') return false;
  } catch {
    // exit 1: the key is unset, i.e. this git ignored the env entry
  }
  const version = execFileSync('git', ['--version'], { encoding: 'utf8', env: ENV }).trim();
  return `${version} ignores GIT_CONFIG_COUNT (git >= 2.31 reads it), so the override under test cannot take effect`;
})();

function fsmonitorHook(root) {
  const log = path.join(root, 'fsmonitor-hook.log');
  const hook = path.join(root, 'fsmonitor-hook.sh');
  // Protocol v2 reply: an (empty) token and no paths. Valid enough for git to accept.
  writeFileSync(hook, `#!/bin/sh\necho called >> "${toBashPath(log)}"\nprintf '\\0'\n`, { mode: 0o755 });
  return {
    cmd: toBashPath(hook),
    log,
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0),
  };
}

test('worktree-new runs its git with core.fsmonitor off, even when the shared config turns it on', { skip: GIT_CONFIG_ENV_SKIP }, async () => {
  const f = fixture();
  try {
    const hook = fsmonitorHook(f.root);
    git(f.primary, 'config', 'core.fsmonitor', hook.cmd);

    // Control: a plain `git worktree add` under this config DOES consult fsmonitor. Without
    // this the assertion below would pass on a git that never calls the hook at all.
    git(f.primary, 'worktree', 'add', '-q', '--no-track', path.join(f.root, 'control'), '-b', 'feat/control', 'origin/main');
    assert.ok(hook.calls() > 0, 'fixture is vacuous: a plain worktree add never consulted fsmonitor');
    rmSync(hook.log);

    const callerEnv = {
      ...ENV,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    };
    await run(f.primary, ['fsm', 'feat/fsm', '--no-install'], callerEnv);
    assert.ok(existsSync(path.join(f.root, 'primary-fsm')));
    assert.equal(hook.calls(), 0, 'worktree-new.sh ran git with fsmonitor enabled; its worktree add can hang');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('the override beats a caller GIT_CONFIG_* entry that turns fsmonitor ON', { skip: GIT_CONFIG_ENV_SKIP }, async () => {
  const f = fixture();
  try {
    // An orchestrator prompt prefix, or a CI step, may already use this channel; the script's
    // own later entry must still win. (Preserving the caller's OTHER entries is pinned on
    // the lib directly, below.)
    const hook = fsmonitorHook(f.root);
    await run(f.primary, ['fsm2', 'feat/fsm2', '--no-install'], {
      ...ENV,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: hook.cmd,
      GIT_CONFIG_KEY_1: 'advice.detachedHead',
      GIT_CONFIG_VALUE_1: 'false',
    });
    assert.ok(existsSync(path.join(f.root, 'primary-fsm2')));
    assert.equal(hook.calls(), 0, 'a caller-supplied fsmonitor=true beat the script override');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('worktree-new pins core.fsmonitor=false in the new worktree own config when worktreeConfig is already on', async () => {
  const f = fixture();
  try {
    git(f.primary, 'config', 'extensions.worktreeConfig', 'true');
    git(f.primary, 'config', 'core.fsmonitor', 'true');
    await run(f.primary, ['pin', 'feat/pin', '--no-install']);
    const dest = path.join(f.root, 'primary-pin');
    assert.equal(git(dest, 'config', '--worktree', '--get', 'core.fsmonitor'), 'false');
    // Per-worktree only: the primary checkout and every sibling keep what they had.
    assert.equal(git(f.primary, 'config', '--local', '--get', 'core.fsmonitor'), 'true');
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('worktree-new does NOT enable extensions.worktreeConfig to pin fsmonitor', async () => {
  const f = fixture();
  try {
    // Turning that extension on rewrites how every OTHER worktree reads its config. Not this
    // script's call, so with it off the run must still succeed and leave the shared config be.
    const { stdout, stderr } = await run(f.primary, ['nopin', 'feat/nopin', '--no-install']);
    assert.ok(existsSync(path.join(f.root, 'primary-nopin')));
    // Git itself refuses `--worktree` here (multiple worktrees, extension off), so the guard's
    // observable job is to not even try: no failed write, no spurious warning on every run.
    assert.doesNotMatch(stdout + stderr, /could not pin/);
    assert.throws(() => git(f.primary, 'config', '--local', '--get', 'extensions.worktreeConfig'));
    // And nothing was written to the SHARED .git/config, i.e. the primary checkout's config.
    assert.throws(
      () => git(f.primary, 'config', '--local', '--get', 'core.fsmonitor'),
      'the pin leaked into the shared config of the primary checkout',
    );
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('git_disable_fsmonitor appends to an existing GIT_CONFIG_COUNT and leaves the caller entries alone', { skip: GIT_CONFIG_ENV_SKIP }, () => {
  const lib = toBashPath(path.resolve('scripts/lib/git-no-fsmonitor.sh'));
  const probe = [
    `source "${lib}"`,
    'git_disable_fsmonitor',
    'echo "count=$GIT_CONFIG_COUNT"',
    'echo "caller=$(git config --get user.name)"',
    'echo "fsmonitor=$(git config --get core.fsmonitor)"',
  ].join('\n');
  const out = execFileSync('bash', ['-c', probe], {
    encoding: 'utf8',
    env: {
      ...ENV,
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'user.name',
      GIT_CONFIG_VALUE_0: 'Caller',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'true',
    },
  });
  assert.match(out, /count=3/, 'the caller count was replaced rather than extended');
  assert.match(out, /caller=Caller/, 'a caller-supplied config entry was clobbered');
  assert.match(out, /fsmonitor=false/, 'the override did not win over an earlier fsmonitor=true');
});

test('git_disable_fsmonitor works when the caller set no GIT_CONFIG_COUNT', { skip: GIT_CONFIG_ENV_SKIP }, () => {
  const lib = toBashPath(path.resolve('scripts/lib/git-no-fsmonitor.sh'));
  const env = { ...ENV };
  delete env.GIT_CONFIG_COUNT;
  const out = execFileSync(
    'bash',
    ['-c', `source "${lib}"\ngit_disable_fsmonitor\necho "count=$GIT_CONFIG_COUNT"\ngit config --get core.fsmonitor`],
    { encoding: 'utf8', env },
  );
  assert.match(out, /count=1/);
  assert.match(out, /false/);
});

// --- the consumer hint and the config: nothing consumer-specific is built in -------------

/** ENV with the hint pointed at a file that does not exist, so only the neutral defaults apply. */
const NEUTRAL_ENV = { ...ENV, WORKTREE_NEW_HINT_FILE: NO_HINT_FILE };

test('with no hint, every dependency and devDependency in package.json must be on disk', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-default-required');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { omit: [] });
  writeFileSync(
    path.join(target, 'package.json'),
    `${JSON.stringify({ name: 'fixture', dependencies: { jest: '^30' }, devDependencies: { 'left-pad': '^1' } })}\n`,
  );
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)], NEUTRAL_ENV), (err) => {
      assert.match(err.stderr, /node_modules\/left-pad is missing/);
      assert.match(err.stderr, /INCOMPLETE/);
      return true;
    });
    mkdirSync(path.join(target, 'node_modules', 'left-pad'), { recursive: true });
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)], NEUTRAL_ENV);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('with no hint there is no native-binding check: a tree without one is not called incomplete', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-no-native-check');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'none' });
  try {
    const { stdout } = await run(f.primary, ['--await', toBashPath(target)], NEUTRAL_ENV);
    assert.match(stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('the hint can also name the native packages through the environment-selected file', async () => {
  // The same tree that passed above fails once a hint names its package as native: the mechanism
  // is the hint, not a built-in package name.
  const f = fixture();
  const target = path.join(f.root, 'target-hint-native');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'none' });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)], ENV), (err) => {
      assert.match(err.stderr, /native-widget has no native binding/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('the browser check runs only when package.json declares Playwright (or the hint forces it)', async () => {
  const f = fixture();
  const missing = [path.join(f.root, 'ms-playwright-undeclared', 'chromium-1234')];
  try {
    // playwright-core is on disk (a transitive dependency of something else) but not declared.
    const undeclared = path.join(f.root, 'target-undeclared-playwright');
    mkdirSync(undeclared, { recursive: true });
    markInstalled(undeclared);
    markPlaywright(undeclared, { locations: missing, declared: false });
    const { stdout } = await run(f.primary, ['--await', toBashPath(undeclared)]);
    assert.match(stdout, /already finished and up to date/, 'an undeclared playwright-core must not fail the tree');

    // The hint can force the check on ...
    const forcedHint = path.join(f.root, 'force.hint.sh').split(path.sep).join('/');
    writeFileSync(forcedHint, 'WORKTREE_NEW_BROWSER_CHECK=1\n');
    await assert.rejects(
      run(f.primary, ['--await', toBashPath(undeclared)], { ...NEUTRAL_ENV, WORKTREE_NEW_HINT_FILE: forcedHint }),
      (err) => {
        assert.equal(err.code, 3);
        assert.match(err.stderr, /chromium-1234/);
        return true;
      },
    );

    // ... and off, for a project that does declare Playwright.
    const declared = path.join(f.root, 'target-declared-playwright');
    mkdirSync(declared, { recursive: true });
    markInstalled(declared);
    markPlaywright(declared, { locations: missing });
    await assert.rejects(run(f.primary, ['--await', toBashPath(declared)]), (err) => {
      assert.equal(err.code, 3);
      return true;
    });
    const offHint = path.join(f.root, 'off.hint.sh').split(path.sep).join('/');
    writeFileSync(offHint, 'WORKTREE_NEW_BROWSER_CHECK=0\n');
    const off = await run(f.primary, ['--await', toBashPath(declared)], { ...NEUTRAL_ENV, WORKTREE_NEW_HINT_FILE: offHint });
    assert.match(off.stdout, /already finished and up to date/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('WORKTREE_NEW_BROWSERS names the browsers the dry run asks about and the fix command prints', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-browser-list');
  mkdirSync(target, { recursive: true });
  markInstalled(target);
  markPlaywright(target, { locations: [path.join(f.root, 'ms-playwright-list', 'firefox-1234')] });
  const hint = path.join(f.root, 'browsers.hint.sh').split(path.sep).join('/');
  writeFileSync(hint, 'WORKTREE_NEW_BROWSERS="firefox webkit"\n');
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)], { ...NEUTRAL_ENV, WORKTREE_NEW_HINT_FILE: hint }), (err) => {
      assert.equal(err.code, 3);
      assert.match(err.stderr, /node node_modules\/playwright-core\/cli\.js install firefox webkit/);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('packageManager from agent-tooling.json selects the install command and the lockfile', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-pnpm');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(f.primary, 'agent-tooling.json'), JSON.stringify({ packageManager: 'pnpm' }));
  const binDir = path.join(f.root, 'pnpm-shim');
  mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(f.root, 'pnpm-args');
  writeFileSync(path.join(binDir, 'pnpm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 });
  try {
    // No pnpm-lock.yaml: nothing to install, and the message names the right lockfile.
    await assert.rejects(
      execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], { cwd: f.primary, encoding: 'utf8', env: withBinFirst(ENV, binDir) }),
      (err) => {
        assert.match(err.stderr, /no package\.json \+ pnpm-lock\.yaml/);
        return true;
      },
    );
    writeFileSync(path.join(target, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
    const { stdout } = await execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], {
      cwd: f.primary,
      encoding: 'utf8',
      env: withBinFirst(ENV, binDir),
    });
    assert.match(stdout, /Installing dependencies \(pnpm install\)/);
    assert.match(readFileSync(argsFile, 'utf8'), /install --frozen-lockfile --prefer-offline --ignore-scripts/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('the root package.json postinstall is run after an --ignore-scripts install, through the package manager', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-postinstall');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x","scripts":{"postinstall":"echo hi"}}\n');
  writeFileSync(path.join(target, 'package-lock.json'), '{"name":"x","lockfileVersion":3,"packages":{"":{"name":"x"}}}\n');
  const binDir = path.join(f.root, 'npm-shim-post');
  mkdirSync(binDir, { recursive: true });
  const argsFile = path.join(f.root, 'npm-args-post');
  writeFileSync(path.join(binDir, 'npm'), `#!/bin/sh\necho "$@" >> "${argsFile}"\n`, { mode: 0o755 });
  try {
    await execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], {
      cwd: f.primary,
      encoding: 'utf8',
      env: withBinFirst(ENV, binDir),
    });
    const calls = readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.equal(calls[0], 'ci --prefer-offline --ignore-scripts');
    assert.ok(calls.includes('run postinstall'), `postinstall must run through the manager:\n${calls.join('\n')}`);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('worktreeRoot and worktreeNamePattern from agent-tooling.json place and name a bare slug', async () => {
  const f = fixture();
  writeFileSync(
    path.join(f.primary, 'agent-tooling.json'),
    JSON.stringify({ worktreeRoot: '../trees/nested', worktreeNamePattern: 'wt-<slug>-<repo>' }),
  );
  try {
    const { stdout } = await run(f.primary, ['cfg', 'feat/cfg', '--no-install']);
    const dest = path.join(f.root, 'trees', 'nested', 'wt-cfg-primary');
    assert.ok(existsSync(dest), `expected the configured location and name:\n${stdout}`);
    // The printed commands come from worktreeScripts, with the PATH filled in.
    assert.ok(toBashPath(stdout).includes(`bash scripts/worktree-new.sh --await ${toBashPath(dest)}`));

    // The environment variable still wins over the configured root.
    const elsewhere = path.join(f.root, 'env-wins');
    await run(f.primary, ['cfg2', 'feat/cfg2', '--no-install'], { ...ENV, AGENT_TOOLING_WORKTREE_ROOT: elsewhere });
    assert.ok(existsSync(path.join(elsewhere, 'wt-cfg2-primary')));
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('worktreeScripts overrides change the commands printed in hints, per key', async () => {
  const f = fixture();
  writeFileSync(
    path.join(f.primary, 'agent-tooling.json'),
    JSON.stringify({ worktreeScripts: { await: 'tools/wait <path>', rm: 'tools/drop <path>' } }),
  );
  try {
    const { stdout } = await run(f.primary, ['hints', 'feat/hints', '--no-install']);
    const dest = toBashPath(path.join(f.root, 'primary-hints'));
    assert.ok(stdout.includes(`tools/wait ${dest}`), stdout);
    assert.ok(stdout.includes(`cd ${toBashPath(f.primary)} && tools/drop ${dest}`) || stdout.includes(`tools/drop ${dest}`), stdout);
    // An existing destination is refused with the configured teardown command.
    await assert.rejects(run(f.primary, ['hints', 'feat/hints2', '--no-install']), (err) => {
      assert.match(toBashPath(err.stderr), new RegExp(`remove it with: tools/drop ${dest.replace(/[.*+?^${}()|[\]]/g, '\\$&')}`));
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('a broken agent-tooling.json warns and the defaults apply, rather than failing the creation', async () => {
  const f = fixture();
  writeFileSync(path.join(f.primary, 'agent-tooling.json'), JSON.stringify({ packageManger: 'pnpm' }));
  try {
    const { stderr } = await run(f.primary, ['typo', 'feat/typo', '--no-install']);
    assert.match(stderr, /WARNING: agent-tooling\.json is unusable, using the defaults/);
    assert.match(stderr, /unknown key "packageManger"/);
    assert.ok(existsSync(path.join(f.root, 'primary-typo')));
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});
