#!/usr/bin/env node
// Concurrency tests for `scripts/worktree-new.sh`: the .git/config.lock races.
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
//
// Split note: worktree-new.node-test.mjs was one ~2400-line file of tests that each spawn real git and
// bash, and it crept toward the 10 minute per-file deadline in scripts/test-support/file-deadline.mjs on a
// loaded box. Each concern is now its own worktree-new-*.node-test.mjs file that finishes well inside the
// deadline; the shared harness is scripts/test-support/worktree-new-fixture.mjs.

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import {
  writeFileSync,
  existsSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  execFileAsync,
  script,
  ENV,
  git,
  fixture,
  run,
  orphanBranches,
  holdLockUntilContended,
  CONTENTION_ENV,
  CONTENTION_TIMEOUT_MS,
  cleanupFixtures,
} from './test-support/worktree-new-fixture.mjs';

after(() => cleanupFixtures('worktree-new-concurrency.node-test'));

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
