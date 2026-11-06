#!/usr/bin/env node
// Configuration tests for `scripts/worktree-new.sh`: AGENT_TOOLING_WORKTREE_ROOT, the core.fsmonitor
// override, the neutral defaults with no consumer hint, and agent-tooling.json.
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
  realpathSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  execFileAsync,
  script,
  NO_HINT_FILE,
  fixtureEnv,
  ENV,
  git,
  withBinFirst,
  fixture,
  run,
  markInstalled,
  toBashPath,
  markPlaywright,
  cleanupFixtures,
} from './test-support/worktree-new-fixture.mjs';

after(() => cleanupFixtures('worktree-new-config.node-test'));

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

// Every spelling of an EXISTING path the script may legitimately print. On a Windows runner the
// temp dir is spelled with an 8.3 short name (RUNNER~1) by the test and with the long name by git,
// which is where the script takes its paths from, so both forms are accepted, never a prefix.
function pathForms(p) {
  return [...new Set([toBashPath(p), toBashPath(realpathSync.native(p))])];
}
// An absolute script path in any form bash prints: POSIX (/d/a/...), or a drive letter with either slash.
const ABS_SCRIPT = '"(?:/|[A-Za-z]:[\\\\/])[^"]*worktree-new\\.sh"';

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
    // Unconfigured, the await command names the script by absolute path so it pastes from anywhere.
    assert.ok(
      new RegExp(`bash ${ABS_SCRIPT} --await `).test(stdout) && pathForms(dest).some((d) => stdout.includes(` --await ${d}`)),
      `expected an absolute-path await command:\n${stdout}`,
    );

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
    const destForms = pathForms(path.join(f.root, 'primary-hints'));
    assert.ok(destForms.some((d) => stdout.includes(`tools/wait ${d}`)), stdout);
    assert.ok(destForms.some((d) => stdout.includes(`tools/drop ${d}`)), stdout);
    // An existing destination is refused with the configured teardown command.
    await assert.rejects(run(f.primary, ['hints', 'feat/hints2', '--no-install']), (err) => {
      assert.ok(destForms.some((d) => toBashPath(err.stderr).includes(`remove it with: tools/drop ${d}`)), err.stderr);
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

test('a non-npm package manager prints a one-line degraded-support warning on install', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-degraded');
  mkdirSync(target, { recursive: true });
  writeFileSync(path.join(target, 'package.json'), '{"name":"x"}\n');
  writeFileSync(path.join(target, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n');
  writeFileSync(path.join(f.primary, 'agent-tooling.json'), JSON.stringify({ packageManager: 'pnpm' }));
  const binDir = path.join(f.root, 'pnpm-shim-warn');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(binDir, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const { stderr } = await execFileAsync('bash', [script, '--install', toBashPath(target), '--wait'], {
      cwd: f.primary,
      encoding: 'utf8',
      env: withBinFirst(ENV, binDir),
    });
    assert.match(stderr, /WARNING: packageManager 'pnpm' is only partly supported.*NOT rebuilt.*no version-drift check/);
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});

test('the --await Fix command names the script by absolute path', async () => {
  const f = fixture();
  const target = path.join(f.root, 'target-abs-fix');
  mkdirSync(target, { recursive: true });
  markInstalled(target, { binding: 'none' });
  try {
    await assert.rejects(run(f.primary, ['--await', toBashPath(target)], ENV), (err) => {
      assert.match(err.stderr, new RegExp(`bash ${ABS_SCRIPT} --install `), err.stderr);
      return true;
    });
  } finally {
    removeTempDir(f.root, 'worktree-new.node-test');
  }
});
