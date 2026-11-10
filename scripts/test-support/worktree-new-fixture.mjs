// Shared fixture and helpers for the scripts/worktree-new*.node-test.mjs files.
//
// worktree-new.node-test.mjs used to be one ~2400-line file of 75+ tests that each spawn real git
// and bash, which put it close to the per-file deadline in file-deadline.mjs on a loaded Windows
// box. The tests are now split by concern and the harness lives here, once: a bare origin plus a
// primary checkout copied from a per-file template, the env that keeps ambient git config out of
// the fixtures, run()/runObserving() for the script under test, and the helpers that lay down a
// fake installed tree (markInstalled, markPlaywright). Importing this module has side effects
// (it creates the hint directory), so every importing file calls cleanupFixtures() from after().

import { mkdirSync, mkdtempSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { removeTempDir } from './cleanup.mjs';
import { scaledMs } from './timeout-scale.mjs';
import { copyTemplate, disposeTemplates } from './git-fixture-template.mjs';

export const execFileAsync = promisify(execFile);
export const script = path.resolve('scripts/worktree-new.sh');

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
export const NO_HINT_FILE = path.join(HINT_DIR, 'absent.hint.sh').split(path.sep).join('/');

export function fixtureEnv(source = process.env) {
  const env = { ...source };
  // Ambient GIT_CONFIG_COUNT/KEY_n/VALUE_n entries can override repo-local settings and make fixture
  // controls (especially the fsmonitor-on baseline) silently vacuous. Individual
  // tests that exercise caller-provided entries pass them explicitly to `run`.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  }
  return env;
}

export const ENV = {
  ...fixtureEnv(),
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  // The script reads these from config, and a CI runner may have none set.
  GIT_CONFIG_GLOBAL: '/dev/null',
  WORKTREE_NEW_HINT_FILE: HINT_FILE,
};

// Bare fixture slugs must stay beside their temporary primary checkout. A host's
// configured root would leak fixtures into real worktrees and defeat cleanup.
// The relocation cases below supply their own root explicitly.
for (const key of Object.keys(ENV)) {
  if (key.toUpperCase() === 'AGENT_TOOLING_WORKTREE_ROOT') delete ENV[key];
}

export function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/**
 * `env` with `binDir` first on PATH. Windows spells the key `Path` under PowerShell and `PATH`
 * under Git Bash; writing a second spelling beside the first leaves the child two PATHs and no
 * defined winner, so prepend to whichever key is already there.
 */
export function withBinFirst(env, binDir) {
  const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return { ...env, [key]: binDir + path.delimiter + (env[key] ?? '') };
}

/**
 * A bare origin plus a `primary` checkout on main with one pushed commit. Built once per file and
 * copied per test: seven git processes per test became a file copy, and
 * git-fixture-template.mjs rewrites the absolute paths git records, so each copy is the same repo
 * a fresh build would be.
 */
export function fixture() {
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

export function run(primary, args, env = ENV) {
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
export function runObserving(primary, args, env = ENV) {
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
export async function waitForOutput(observed, pattern, { ceilingMs = scaledMs(60_000) } = {}) {
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
export function orphanBranches(primary) {
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
export function publishedToOrigin(f, branch) {
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
export async function holdLockUntilContended(f, branch, running, { extraHoldMs = 0, ceilingMs = scaledMs(120_000) } = {}) {
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
// deterministic test (in worktree-new-concurrency.node-test.mjs), which forces the budget to 0.
export const TEST_RETRY_SECONDS = '600';
export const CONTENTION_ENV = { ...ENV, WORKTREE_NEW_CONFIG_RETRY_SECONDS: TEST_RETRY_SECONDS };
// A loud upper bound on a hung run, never a thing under assertion.
export const CONTENTION_TIMEOUT_MS = scaledMs(300_000);

// The same branch was later extended: "in sync with package-lock.json" is not
// the same claim as "usable". One provisioning wave produced a tree that exited
// NONZERO and was perfectly fine (a native package's implicit node-gyp rebuild
// failed after everything was unpacked), and another that exited ZERO with MORE
// directories than a healthy install and no jest, next or typescript at all. So
// markInstalled() lays down the artefacts a gate actually reaches for, and the
// tests that use it drive each way they can be missing.
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

export function markInstalled(
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
export const toBashPath = (p) => p.replace(/\\/g, '/');

/**
 * Stand in for `node_modules/playwright-core/cli.js`, whose
 * `install --dry-run chromium` prints an indented "Install location:" line per
 * browser. Stubbed rather than real: what is under test is "does that location
 * exist and is it complete", and a real playwright-core plus a real ~306 MB
 * browser download would be the slowest test in this suite by two orders of
 * magnitude. Its PRESENCE is also the "does this tree do e2e at all" signal, so
 * every other test in this file exercises the no-Playwright path for free.
 */
export function markPlaywright(dest, { locations = [], exitCode = 0, extraOutput = '', declared = true } = {}) {
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
export function browserDir(registry, name, { complete = true } = {}) {
  const dir = path.join(registry, name);
  mkdirSync(dir, { recursive: true });
  if (complete) writeFileSync(path.join(dir, 'INSTALLATION_COMPLETE'), '');
  return dir;
}

/** Remove the per-file fixture templates and the hint directory. Each test file calls this from its own after(). */
export function cleanupFixtures(label) {
  disposeTemplates((dir) => removeTempDir(dir, label));
  removeTempDir(HINT_DIR, label);
}
