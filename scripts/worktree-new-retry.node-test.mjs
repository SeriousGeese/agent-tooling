#!/usr/bin/env node
// Retry classification tests for `scripts/worktree-new.sh`: which failures of fetch, push, worktree add
// and the post-creation reads are a concurrency race to retry, and which are real errors to report once.
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
} from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  execFileAsync,
  script,
  ENV,
  git,
  withBinFirst,
  fixture,
  orphanBranches,
  TEST_RETRY_SECONDS,
  toBashPath,
  cleanupFixtures,
} from './test-support/worktree-new-fixture.mjs';

after(() => cleanupFixtures('worktree-new-retry.node-test'));

// The OTHER race in this script, and not the config lock. Found by the test
// in worktree-new-concurrency.node-test.mjs on CI, runs 33581801987 and 33582652613, on two different runners:
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
