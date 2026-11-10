#!/usr/bin/env node
// Creation tests for `scripts/worktree-new.sh`: the cleanup of a failed creation, the creation marker
// that `--await` waits out, and the creation mutex that keeps sibling runs from fetching mid-add.
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
  existsSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import path from 'node:path';
import { removeTempDir } from './test-support/cleanup.mjs';
import { scaledMs } from './test-support/timeout-scale.mjs';
import {
  git,
  fixture,
  run,
  runObserving,
  waitForOutput,
  orphanBranches,
  CONTENTION_ENV,
  toBashPath,
  ENV,
  cleanupFixtures,
} from './test-support/worktree-new-fixture.mjs';

after(() => cleanupFixtures('worktree-new-creation.node-test'));

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
// writes, without racing a real `git worktree add`, the concurrency tests (worktree-new-concurrency.node-test.mjs)
// already race real processes for the OTHER hazards this script guards against,
// and the same technique here would be flaky by construction (this fix exists
// precisely because a real race is not deterministic to observe from outside).
// Both names derive from the prefix tokens the sync rewrites, so they follow a consumer's prefix
// (a consumer's old copy names are reproduced byte for byte); a literal here would not.
const LOCK_NAME = `${'AGENT_TOOLING_WORKTREE_CREATE'.toLowerCase().replaceAll('_', '-')}.lock`;
const CREATING_NAME = 'AGENT_TOOLING_WORKTREE_CREATING'.toLowerCase().replaceAll('_', '-');
function creationMarkerPath(dest) {
  return path.join(path.dirname(dest), `.${CREATING_NAME}-${path.basename(dest)}`);
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
// is the same idea as the heartbeat test in worktree-new-await.node-test.mjs: only remove the marker once
// the child has PROVEN, via its own stdout, not a guess about its timing,
// that it is actually waiting on it, and replace the elapsed-time assertion
// with an assertion on the ORDER the three output lines happen to appear in.
test('--await waits out an in-progress creation marker, then proceeds once it clears', { timeout: scaledMs(120_000) }, async () => {
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
// The concurrency tests (worktree-new-concurrency.node-test.mjs) race real processes, so before this lock existed
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
const lockDir = (primary) => path.join(primary, '.git', LOCK_NAME);

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

test('worktree-new.sh derives its creation lock and marker names from the prefix tokens, never a literal', () => {
  const src = readFileSync(new URL('./worktree-new.sh', import.meta.url), 'utf8');
  assert.match(src, /AGENT_TOOLING_WORKTREE_CREATE\b/);
  assert.match(src, /AGENT_TOOLING_WORKTREE_CREATING\b/);
  // A consumer's older copy used its own prefixed lock and marker names; a hardcoded neutral name
  // would stop an old and a new script on one machine excluding each other.
  assert.doesNotMatch(src, /worktree-create\.lock/);
  assert.doesNotMatch(src, /\.worktree-creating-/);
});
