#!/usr/bin/env node
// `--await` and `--install` tests for `scripts/worktree-new.sh`: the dependency verdict (tree in sync,
// native binding, version drift, finished and in-progress installs) and the Playwright browser check.
//
// Split note: worktree-new.node-test.mjs was one ~2400-line file of tests that each spawn real git and
// bash, and it crept toward the 10 minute per-file deadline in scripts/test-support/file-deadline.mjs on a
// loaded box. Each concern is now its own worktree-new-*.node-test.mjs file that finishes well inside the
// deadline; the shared harness is scripts/test-support/worktree-new-fixture.mjs.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  statSync,
  chmodSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  execFileAsync,
  script,
  ENV,
  withBinFirst,
  fixture,
  run,
  runObserving,
  waitForOutput,
  markInstalled,
  toBashPath,
  markPlaywright,
  browserDir,
  cleanupFixtures,
} from './test-support/worktree-new-fixture.mjs';

after(() => cleanupFixtures('worktree-new-await.node-test'));

// `--await` used to read "no install recorded" as unconditional
// success, even when node_modules was missing or out of sync with
// package-lock.json (a worktree rebased across a commit that added a
// dependency). A gate run in that state silently resolves modules against
// whatever OTHER checkout npm's lockfile-root heuristic finds, producing a
// false red (or green) in files the branch never touched. These tests target
// `--await`/`--install` directly against a plain directory, no real worktree
// or npm install needed, since the no-PID branch never shells out to npm.

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
