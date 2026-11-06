#!/usr/bin/env node
// Tests for scripts/repair-hookspath.mjs.
//
// These build REAL throwaway git repos rather than stubbing git, because every bug this
// script exists to prevent lives in git's own scope precedence:
//
//   - `git config --local` does not touch a per-worktree `config.worktree` override.
//   - a per-worktree override WINS over `.git/config`.
//   - `git config --worktree` is only legal when `extensions.worktreeConfig` is true.
//   - `--unset-all` exits 5 (not 0, not 1) when the key was already absent in that scope.
//
// A mock would have had to encode all four correctly to be worth anything, at which point it
// is asserting my understanding of git instead of git's behaviour. The `.git/config`-only
// repair, the specific incomplete fix, passes a mocked test and fails
// the second test below.
//
// Runs under scripts/run-node-tests.mjs (node --test).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  DESIRED_HOOKS_PATH,
  inspectHooksPath,
  repairHooksPath,
  sameHooksPath,
  parseShowOrigin,
  parseWorktreeList,
  resolveHooksPathAbs,
  hooksDirsEquivalent,
  hooksPathResolvesToDesired,
} from './repair-hookspath.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, 'repair-hookspath.mjs');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  // Never let an ambient user/system core.hooksPath leak into a fixture and make a
  // "healthy repo" assertion pass or fail for reasons outside the test. Pointing
  // GIT_CONFIG_GLOBAL at a path that does not exist is git's documented way to do this;
  // unsetting HOME is not (git falls back to USERPROFILE on Windows).
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: path.join(tmpdir(), 'acme-hookspath-no-such-global-config'),
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function tryGit(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: ENV });
  return { status: r.status, stdout: (r.stdout || '').trim() };
}

/** A repo with one commit, a `.beads/hooks` directory, and no core.hooksPath set. */
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'acme-hookspath-'));
  const main = path.join(root, 'main');
  mkdirSync(path.join(main, '.beads', 'hooks'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main', main);
  writeFileSync(path.join(main, '.beads', 'hooks', 'pre-push'), '#!/bin/sh\nexit 0\n');
  writeFileSync(path.join(main, 'a.txt'), 'base\n');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'base');
  return { root, main };
}

function addWorktree(f, name) {
  const wt = path.join(f.root, name);
  git(f.main, 'worktree', 'add', '-q', wt, '-b', name);
  return wt;
}

/** The absolute-.git/hooks shape measured on the product owner's machine. */
function absHooksDir(mainRepo) {
  return path.join(mainRepo, '.git', 'hooks');
}

function runCli(cwd, ...args) {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env: ENV });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// ---------------------------------------------------------------------------
// The three core scenarios.
// ---------------------------------------------------------------------------

test('an absolute .git/hooks value in .git/config is repaired to the relative .beads/hooks', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'core.hookspath', absHooksDir(f.main));
    assert.equal(inspectHooksPath(f.main).healthy, false);

    const { actions } = repairHooksPath({ cwd: f.main });
    assert.ok(actions.some((a) => a.kind === 'set-local'), 'should have rewritten the local scope');

    assert.equal(git(f.main, 'config', '--local', '--get', 'core.hookspath'), DESIRED_HOOKS_PATH);
    assert.equal(inspectHooksPath(f.main).healthy, true);
    // The value git will actually resolve, from the repo root.
    assert.equal(git(f.main, 'rev-parse', '--git-path', 'hooks'), DESIRED_HOOKS_PATH);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('with extensions.worktreeConfig on, BOTH .git/config and every linked worktree override are repaired', () => {
  const f = fixture();
  try {
    const bad = absHooksDir(f.main);
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    const wt2 = addWorktree(f, 'wt2');

    // Exactly the measured state: the bad value in the local scope AND in each worktree's own
    // config.worktree, including the primary checkout's.
    git(f.main, 'config', '--local', 'core.hookspath', bad);
    git(f.main, 'config', '--worktree', 'core.hookspath', bad);
    git(wt1, 'config', '--worktree', 'core.hookspath', bad);
    git(wt2, 'config', '--worktree', 'core.hookspath', bad);

    const before = inspectHooksPath(f.main);
    assert.equal(before.worktreeConfigEnabled, true);
    assert.equal(before.badOverrides.length, 3, 'primary + two linked worktrees each carry an override');
    assert.equal(before.healthy, false);

    repairHooksPath({ cwd: f.main });

    // Every worktree now RESOLVES to .beads/hooks, this is the assertion a `.git/config`-only
    // repair fails, because the surviving --worktree override would still win.
    for (const wt of [f.main, wt1, wt2]) {
      assert.equal(
        git(wt, 'config', '--get', 'core.hookspath'),
        DESIRED_HOOKS_PATH,
        `effective core.hooksPath in ${wt}`,
      );
      assert.equal(tryGit(wt, 'config', '--worktree', '--get-all', 'core.hookspath').status, 1, `no leftover override in ${wt}`);
    }
    assert.equal(inspectHooksPath(f.main).healthy, true);
    assert.equal(inspectHooksPath(wt1).healthy, true);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

// ---------------------------------------------------------------------------
// an absolute `config.worktree` override pointing at the PRIMARY
// checkout's .beads/hooks (not this worktree's OWN copy) is correct, not drift.
// ---------------------------------------------------------------------------

test('an absolute worktree override pointing at the PRIMARY\'s .beads/hooks is NOT reported as drift', () => {
  // The measured shape (2026-09-06 sweep): 14 worktrees each carried a `config.worktree`
  // override that was an ABSOLUTE path to the PRIMARY checkout's .beads/hooks, a DIFFERENT
  // directory than the worktree's own tracked copy, but (same commit) byte-identical files, so
  // the chained pre-push hook genuinely ran `git lfs pre-push`. `--check` reported all 14 as
  // drift and claimed the chained hooks were NOT running, which was false.
  const f = fixture();
  try {
    // Local scope healthy already, so this isolates the override-specific claim: whether the
    // per-worktree override ALONE is (wrongly) enough to make the whole repo read as unhealthy.
    git(f.main, 'config', '--local', 'core.hookspath', DESIRED_HOOKS_PATH);
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    const primaryHooksDir = path.join(f.main, '.beads', 'hooks');
    git(wt1, 'config', '--worktree', 'core.hookspath', primaryHooksDir);

    const state = inspectHooksPath(wt1);
    assert.deepEqual(state.badOverrides, [], 'a correctly-resolving absolute override must not be flagged as drift');
    assert.equal(state.healthy, true);

    const { actions } = repairHooksPath({ cwd: wt1 });
    assert.deepEqual(actions, [], 'a healthy-but-absolute override is left alone, not rewritten');
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('an absolute worktree override pointing at DIFFERENT hook content is still real drift', () => {
  // If the worktree's own tracked .beads/hooks has since diverged from the primary's (a plausible
  // history, the worktree is pinned to an older commit), an override pointing at the primary's
  // copy would run the WRONG script. Path resolution alone must not paper over that.
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    writeFileSync(path.join(wt1, '.beads', 'hooks', 'pre-push'), '#!/bin/sh\necho different\nexit 0\n');

    const primaryHooksDir = path.join(f.main, '.beads', 'hooks');
    git(wt1, 'config', '--worktree', 'core.hookspath', primaryHooksDir);

    const state = inspectHooksPath(wt1);
    assert.equal(state.badOverrides.length, 1, 'divergent hook content must still be reported as drift');
    assert.equal(state.healthy, false);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('a healthy repo is left completely unchanged (idempotent, no output churn)', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'core.hookspath', DESIRED_HOOKS_PATH);
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    addWorktree(f, 'wt1');

    const first = runCli(f.main);
    assert.equal(first.status, 0);
    assert.equal(first.stdout.trim(), '', 'a healthy machine gets no output at all');

    const r = repairHooksPath({ cwd: f.main });
    assert.equal(r.healthy, true);
    assert.deepEqual(r.actions, [], 'nothing to do, so nothing written');

    // Run the whole CLI twice more; still silent, still healthy.
    assert.equal(runCli(f.main).stdout.trim(), '');
    assert.equal(runCli(f.main).status, 0);
    assert.equal(inspectHooksPath(f.main).healthy, true);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

// ---------------------------------------------------------------------------
// Supporting behaviour.
// ---------------------------------------------------------------------------

test('repair is idempotent: a second run after a repair is a no-op', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    git(f.main, 'config', '--local', 'core.hookspath', absHooksDir(f.main));
    git(wt1, 'config', '--worktree', 'core.hookspath', absHooksDir(f.main));

    assert.ok(repairHooksPath({ cwd: f.main }).actions.length > 0);
    assert.deepEqual(repairHooksPath({ cwd: f.main }).actions, [], 'second pass does nothing');
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('--check reports drift and exits 1 WITHOUT writing anything', () => {
  const f = fixture();
  try {
    const bad = absHooksDir(f.main);
    git(f.main, 'config', '--local', 'core.hookspath', bad);

    const r = runCli(f.main, '--check');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /drift detected/);
    assert.match(r.stdout, /\.beads\/hooks are NOT running/);
    // Unchanged on disk.
    assert.equal(git(f.main, 'config', '--local', '--get', 'core.hookspath'), bad);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('--check on a healthy repo exits 0 and says so', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'core.hookspath', DESIRED_HOOKS_PATH);
    const r = runCli(f.main, '--check');
    assert.equal(r.status, 0);
    assert.match(r.stdout, /✓/);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('an entirely unset core.hooksPath (fresh clone) is set, not just left alone', () => {
  const f = fixture();
  try {
    assert.equal(inspectHooksPath(f.main).effective, null);
    repairHooksPath({ cwd: f.main });
    assert.equal(git(f.main, 'config', '--local', '--get', 'core.hookspath'), DESIRED_HOOKS_PATH);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('duplicate local entries collapse to exactly one', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', '--add', 'core.hookspath', absHooksDir(f.main));
    git(f.main, 'config', '--local', '--add', 'core.hookspath', '.beads/hooks');
    assert.equal(inspectHooksPath(f.main).local.length, 2);

    repairHooksPath({ cwd: f.main });
    const after = inspectHooksPath(f.main);
    assert.deepEqual(after.local, [DESIRED_HOOKS_PATH]);
    assert.equal(after.healthy, true);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('an absolute LOCAL value that resolves to this repo\'s own .beads/hooks is healthy, not rewritten', () => {
  // Superseded by this used to assert the OPPOSITE (still flagged unhealthy and
  // normalised to relative on every repair pass) purely because the value was not spelled
  // `.beads/hooks` literally, even though it named exactly the right directory. That is the
  // same class of false positive the bead fixes for per-worktree overrides, applied here to the
  // local scope: `sameHooksPath` never resolves a path, so ANY absolute spelling failed the
  // literal comparison regardless of where it pointed. It is still true that an absolute value is
  // less portable than the relative form (a moved checkout takes a stale absolute value with it),
  // but "less portable" and "not currently running the right hooks" are different claims, and only
  // the second is what `--check` promises to report.
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'core.hookspath', path.join(f.main, '.beads', 'hooks'));
    assert.equal(inspectHooksPath(f.main).healthy, true);
    const { actions } = repairHooksPath({ cwd: f.main });
    assert.deepEqual(actions, [], 'a correctly-resolving absolute value is left alone, not rewritten');
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('a worktree whose directory is gone is skipped, not fatal', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    git(f.main, 'config', '--local', 'core.hookspath', absHooksDir(f.main));
    removeTempDir(wt1, 'repair-hookspath.node-test');
    assert.equal(existsSync(wt1), false);

    const state = inspectHooksPath(f.main);
    assert.equal(state.missingWorktrees.length, 1);
    repairHooksPath({ cwd: f.main });
    assert.equal(inspectHooksPath(f.main).healthy, true);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('running the repair from inside a LINKED worktree fixes the whole repo, not just that worktree', () => {
  const f = fixture();
  try {
    const bad = absHooksDir(f.main);
    git(f.main, 'config', '--local', 'extensions.worktreeConfig', 'true');
    const wt1 = addWorktree(f, 'wt1');
    const wt2 = addWorktree(f, 'wt2');
    git(f.main, 'config', '--local', 'core.hookspath', bad);
    git(wt2, 'config', '--worktree', 'core.hookspath', bad);

    repairHooksPath({ cwd: wt1 });

    assert.equal(git(wt2, 'config', '--get', 'core.hookspath'), DESIRED_HOOKS_PATH);
    assert.equal(git(f.main, 'config', '--get', 'core.hookspath'), DESIRED_HOOKS_PATH);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('extensions.worktreeConfig OFF: the local scope is repaired and no --worktree call is attempted', () => {
  const f = fixture();
  try {
    addWorktree(f, 'wt1');
    git(f.main, 'config', '--local', 'core.hookspath', absHooksDir(f.main));
    const state = inspectHooksPath(f.main);
    assert.equal(state.worktreeConfigEnabled, false);
    assert.deepEqual(state.overrides, [], 'no override lookup when the extension is off');
    repairHooksPath({ cwd: f.main });
    assert.equal(inspectHooksPath(f.main).healthy, true);
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

// ---------------------------------------------------------------------------
// Pure helpers.
// ---------------------------------------------------------------------------

test('sameHooksPath normalises separators, and case only on win32', () => {
  assert.equal(sameHooksPath('.beads/hooks', '.beads\\hooks'), true);
  assert.equal(sameHooksPath('.beads/hooks/', '.beads/hooks'), true);
  assert.equal(sameHooksPath('  .beads/hooks  ', '.beads/hooks'), true);
  assert.equal(sameHooksPath('.git/hooks', '.beads/hooks'), false);
  assert.equal(sameHooksPath(null, '.beads/hooks'), false);
  assert.equal(sameHooksPath('.BEADS/Hooks', '.beads/hooks'), process.platform === 'win32');
});

test('resolveHooksPathAbs resolves a relative value against baseDir and passes an absolute one through', () => {
  // Build the fixtures per-platform. A drive-letter literal like `C:/other/hooks` is absolute only
  // on win32; on Linux it has no leading slash, so it is a RELATIVE path named "C:" and
  // path.resolve joins it onto baseDir, which made the pass-through assertion below fail on CI
  // while passing locally on Windows. resolveHooksPathAbs itself is correct on both.
  const base = process.platform === 'win32' ? 'C:\\repo' : '/repo';
  const otherAbs = process.platform === 'win32' ? 'C:\\other\\hooks' : '/other/hooks';

  assert.equal(resolveHooksPathAbs('.beads/hooks', base), path.resolve(base, '.beads/hooks'));
  assert.equal(resolveHooksPathAbs(otherAbs, base), path.resolve(otherAbs));
});

test('hooksDirsEquivalent compares file names AND content, and never matches an empty directory', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'acme-hookseq-'));
  try {
    const a = path.join(root, 'a');
    const b = path.join(root, 'b');
    const c = path.join(root, 'c');
    const empty = path.join(root, 'empty');
    mkdirSync(a);
    mkdirSync(b);
    mkdirSync(c);
    mkdirSync(empty);
    writeFileSync(path.join(a, 'pre-push'), 'same\n');
    writeFileSync(path.join(b, 'pre-push'), 'same\n');
    writeFileSync(path.join(c, 'pre-push'), 'different\n');

    assert.equal(hooksDirsEquivalent(a, b), true);
    assert.equal(hooksDirsEquivalent(a, c), false, 'same filename, different content');
    assert.equal(hooksDirsEquivalent(a, empty), false, 'an empty directory is never a match');
    assert.equal(hooksDirsEquivalent(empty, empty), false, 'two empty directories are still not a match');
    assert.equal(hooksDirsEquivalent(a, path.join(root, 'does-not-exist')), false);
  } finally {
    removeTempDir(root, 'repair-hookspath.node-test');
  }
});

test('hooksDirsEquivalent ignores CRLF-vs-LF but still fails on real content or a missing hook', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'acme-hookseol-'));
  try {
    const mk = (name, files) => {
      const d = path.join(root, name);
      mkdirSync(d);
      for (const [f, body] of Object.entries(files)) writeFileSync(path.join(d, f), body);
      return d;
    };
    const lf = mk('lf', { 'pre-push': 'a\nb\n', 'pre-commit': 'x\ny\n' });
    const crlf = mk('crlf', { 'pre-push': 'a\r\nb\r\n', 'pre-commit': 'x\r\ny' });
    const changed = mk('changed', { 'pre-push': 'a\r\nCHANGED\r\n', 'pre-commit': 'x\r\ny\r\n' });
    const missing = mk('missing', { 'pre-push': 'a\r\nb\r\n' });

    assert.equal(hooksDirsEquivalent(lf, crlf), true, 'CRLF vs LF (and trailing newline) is equal');
    assert.equal(hooksDirsEquivalent(lf, changed), false, 'a real content difference is still drift');
    assert.equal(hooksDirsEquivalent(lf, missing), false, 'a missing hook is still drift');
  } finally {
    removeTempDir(root, 'repair-hookspath.node-test');
  }
});

test('hooksPathResolvesToDesired: literal match, resolved-path match, and content-equivalent fallback', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'acme-hookresolve-'));
  try {
    const wt = path.join(root, 'wt');
    mkdirSync(path.join(wt, '.beads', 'hooks'), { recursive: true });
    writeFileSync(path.join(wt, '.beads', 'hooks', 'pre-push'), 'hook\n');

    // Literal .beads/hooks, the plain sameHooksPath case.
    assert.equal(hooksPathResolvesToDesired('.beads/hooks', wt), true);
    // Absolute path that IS this worktree's own .beads/hooks.
    assert.equal(hooksPathResolvesToDesired(path.join(wt, '.beads', 'hooks'), wt), true);
    // A DIFFERENT directory with no files at all is not a match.
    assert.equal(hooksPathResolvesToDesired(path.join(root, 'nowhere'), wt), false);

    // A different directory with byte-identical file content, the fallback.
    const elsewhere = path.join(root, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(path.join(elsewhere, 'pre-push'), 'hook\n');
    assert.equal(hooksPathResolvesToDesired(elsewhere, wt), true);

    // A different directory with DIVERGENT content is still drift.
    writeFileSync(path.join(elsewhere, 'pre-push'), 'different hook\n');
    assert.equal(hooksPathResolvesToDesired(elsewhere, wt), false);
  } finally {
    removeTempDir(root, 'repair-hookspath.node-test');
  }
});

test('parseShowOrigin splits on the FIRST tab so a value containing spaces survives', () => {
  const parsed = parseShowOrigin(
    'file:.git/config\tC:/git/Serious Geese/Acme/.git/hooks\nfile:.git/worktrees/w/config.worktree\t.beads/hooks\n',
  );
  assert.deepEqual(parsed, [
    { origin: 'file:.git/config', value: 'C:/git/Serious Geese/Acme/.git/hooks' },
    { origin: 'file:.git/worktrees/w/config.worktree', value: '.beads/hooks' },
  ]);
});

test('parseWorktreeList reads only the worktree lines', () => {
  assert.deepEqual(
    parseWorktreeList('worktree /a/b\nHEAD deadbeef\nbranch refs/heads/main\n\nworktree /c/d\nHEAD cafe\n'),
    ['/a/b', '/c/d'],
  );
});

// ---------------------------------------------------------------------------
// The hooks path is a knob: a consumer whose tracked hooks live elsewhere sets it.
// ---------------------------------------------------------------------------

test('AGENT_TOOLING_HOOKS_PATH names the directory the check wants, and the default stays .beads/hooks', () => {
  const f = fixture();
  try {
    const run = (extra) => spawnSync(process.execPath, [CLI, '--check'], { cwd: f.main, encoding: 'utf8', env: { ...ENV, ...extra } });
    const dflt = run({ AGENT_TOOLING_HOOKS_PATH: '' });
    assert.equal(dflt.status, 1);
    assert.match(dflt.stdout, /chained hooks in \.beads\/hooks are NOT running/);
    const custom = run({ AGENT_TOOLING_HOOKS_PATH: 'tools/githooks' });
    assert.equal(custom.status, 1);
    assert.match(custom.stdout, /chained hooks in tools\/githooks are NOT running/);
    git(f.main, 'config', '--local', 'core.hookspath', 'tools/githooks');
    assert.equal(run({ AGENT_TOOLING_HOOKS_PATH: 'tools/githooks' }).status, 0, 'the configured value is healthy when it is the wanted one');
    assert.equal(run({ AGENT_TOOLING_HOOKS_PATH: '' }).status, 1, 'and drift under the default');
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

// ---------------------------------------------------------------------------
// Fail-open: a repair that CANNOT complete must not abort a setup script.
// ---------------------------------------------------------------------------

test('repairHooksPath still THROWS on a failed write, library callers keep the hard contract', () => {
  const f = fixture();
  try {
    git(f.main, 'config', '--local', 'core.hookspath', absHooksDir(f.main));
    // A worktree path that git will refuse: inspect saw it, the write cannot land there.
    assert.throws(
      () => repairHooksPath({ cwd: path.join(f.main, 'definitely-not-a-repo') }),
      /not a git repository/,
      'the exported helper must surface failure to its callers',
    );
  } finally {
    removeTempDir(f.root, 'repair-hookspath.node-test');
  }
});

test('the CLI fails OPEN: it never exits non-zero in repair mode, so a setup script completes', () => {
  // a setup script runs `set -euo pipefail` and calls this script. A non-zero exit there aborts
  // first-time setup BEFORE beads.role, the DoltHub remote and the issue sync, leaving a
  // half-configured machine that is harder to diagnose than the drift being repaired. A failing
  // `git config` write is not hypothetical on this repo's Windows box, where concurrent sessions
  // contend on the shared config (that same failure shows up inside a test).
  //
  // Deliberately asserted against a NON-REPO cwd, which is the one unrepairable state that can be
  // constructed deterministically on every platform. `--check` must still exit 1 there, because a
  // scripted or CI caller needs the signal.
  const dir = mkdtempSync(path.join(tmpdir(), 'hookspath-nonrepo-'));
  try {
    assert.equal(runCli(dir).status, 0, 'repair mode must fail open');
    assert.equal(runCli(dir, '--check').status, 1, '--check must still report drift/failure');
  } finally {
    removeTempDir(dir);
  }
});

test('main() wraps the repair call, not just the inspect call', () => {
  // Source-level guardrail. The runtime test above can only construct an inspect-stage failure;
  // this one pins that the REPAIR stage is inside a try/catch too, which is the regression that
  // actually reintroduces the setup-abort. Known limitation: it reads source text, so it catches
  // the wrapper being deleted, not every way the fail-open could be defeated.
  const src = readFileSync(path.join(HERE, 'repair-hookspath.mjs'), 'utf8');
  const main = src.slice(src.indexOf('function main('));
  const call = main.indexOf('repairHooksPath({');
  assert.ok(call !== -1, 'main() should still call repairHooksPath');
  const before = main.slice(0, call);
  assert.match(
    before.slice(before.lastIndexOf('\n\n')),
    /try\s*\{/,
    'the repairHooksPath call in main() must sit inside a try/catch, an uncaught throw aborts a setup script under `set -e`',
  );
});
