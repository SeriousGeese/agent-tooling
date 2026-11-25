// scripts/lib/bd-retry.sh: claim.sh's bd calls wait out another session's hold on the beads database.
//
// Eleven sessions on one checkout family shared one embedded Dolt database, which is single-writer.
// bd failed AT ONCE on its lock ("another process has locked a portion of the file") with a message
// that read like a broken database; every call succeeded within ten attempts a few seconds apart.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-support/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(HERE, 'lib', 'bd-retry.sh').replace(/\\/g, '/');
const SKIP = spawnSync('bash', ['--version'], { encoding: 'utf8' }).status === 0 ? false : 'requires bash on PATH';
const LOCKED = 'Error: The process cannot access the file because another process has locked a portion of the file.';

/**
 * A bash `bd` that fails with `failure` on its first `failTimes` calls, then prints `{"ok":true}`.
 * Every call is counted, so "retried" and "not retried" are both observable.
 */
function stubBd(failure, failTimes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-retry-'));
  const count = path.join(dir, 'count').replace(/\\/g, '/');
  fs.writeFileSync(path.join(dir, 'bd'), [
    '#!/usr/bin/env bash',
    `n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "${count}"`,
    `if [ "$n" -le ${failTimes} ]; then echo "${failure}" >&2; exit 1; fi`,
    'echo "bd says: done" >&2',
    'echo \'{"ok":true}\'',
    '',
  ].join('\n'), { mode: 0o755 });
  return { dir, calls: () => Number(fs.readFileSync(count, 'utf8').trim()) };
}

function bdRetry(stub, args, env = {}) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  return spawnSync('bash', ['-c', `set -euo pipefail; source "${LIB}"; bd_retry "$@"`, 'bd-retry', ...args], {
    encoding: 'utf8',
    env: { ...process.env, [key]: `${stub.dir}${path.delimiter}${process.env[key] ?? ''}`, AGENT_TOOLING_BD_LOCK_DELAY_SECONDS: '0', ...env },
  });
}

test('a lock failure is retried until bd gets through, one line per wait naming the cause', { skip: SKIP }, () => {
  const stub = stubBd(LOCKED, 2);
  try {
    const r = bdRetry(stub, ['show', 'x-1', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{"ok":true}\n', 'only the successful call\'s output');
    assert.equal(stub.calls(), 3);
    const waits = r.stderr.split('\n').filter((l) => l.includes('locked by another bd process'));
    assert.equal(waits.length, 2, r.stderr);
    assert.match(waits[0], /^bd show: the beads database is locked by another bd process \(attempt 1\/8\); retrying in 0s$/);
    assert.doesNotMatch(r.stderr, /another process has locked a portion/, 'the raw lock error of a retried call is not replayed');
    assert.match(r.stderr, /bd says: done/, "the final call's own stderr is kept");
  } finally {
    removeTempDir(stub.dir, 'bd-retry.node-test');
  }
});

// A bad delay knob once would have reached `sleep` and, under set -e, aborted the caller mid-claim.
test('a non-numeric AGENT_TOOLING_BD_LOCK_DELAY_SECONDS falls back to the ladder, never aborts', { skip: SKIP }, () => {
  for (const bad of ['soon', '-1', '1.2.3', '.', '3s']) {
    const stub = stubBd(LOCKED, 1);
    try {
      // The first ladder step is 2 s; set -e is on, as in claim.sh.
      const r = bdRetry(stub, ['show', 'x-1', '--json'], { AGENT_TOOLING_BD_LOCK_DELAY_SECONDS: bad });
      assert.equal(r.status, 0, `${bad}: ${r.stderr}`);
      assert.equal(r.stdout, '{"ok":true}\n', bad);
      assert.equal(stub.calls(), 2, bad);
      assert.match(r.stderr, /retrying in 2s$/m, `${bad} uses the ladder`);
    } finally {
      removeTempDir(stub.dir, 'bd-retry.node-test');
    }
  }
  const stub = stubBd(LOCKED, 1);
  try {
    const r = bdRetry(stub, ['show', 'x-1', '--json'], { AGENT_TOOLING_BD_LOCK_DELAY_SECONDS: '0.1' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /retrying in 0\.1s$/m, 'a decimal is a valid wait');
  } finally {
    removeTempDir(stub.dir, 'bd-retry.node-test');
  }
});

test('the retry is bounded: the last lock failure returns its exit code and says why', { skip: SKIP }, () => {
  const stub = stubBd('share access flags are incompatible', 99);
  try {
    const r = bdRetry(stub, ['update', 'x-1', '--claim'], { AGENT_TOOLING_BD_LOCK_ATTEMPTS: '3' });
    assert.equal(r.status, 1);
    assert.equal(stub.calls(), 3);
    assert.match(r.stderr, /share access flags are incompatible/, "bd's own error is shown once it stops retrying");
    assert.match(r.stderr, /still locked by another bd process after 3 attempt\(s\)/);
  } finally {
    removeTempDir(stub.dir, 'bd-retry.node-test');
  }
});

test('any other failure returns at once, with its exit code and stderr', { skip: SKIP }, () => {
  const stub = stubBd('Error: no issue found matching "x-9"', 99);
  try {
    const r = bdRetry(stub, ['show', 'x-9', '--json']);
    assert.equal(r.status, 1);
    assert.equal(stub.calls(), 1, 'not a lock: never retried');
    assert.match(r.stderr, /no issue found/);
    assert.doesNotMatch(r.stderr, /locked by another bd process/);
  } finally {
    removeTempDir(stub.dir, 'bd-retry.node-test');
  }
});

test("--no-bd-stderr drops bd's own stderr but keeps the wait lines", { skip: SKIP }, () => {
  const stub = stubBd(LOCKED, 1);
  try {
    const r = bdRetry(stub, ['--no-bd-stderr', 'show', 'x-1', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{"ok":true}\n');
    assert.doesNotMatch(r.stderr, /bd says: done/);
    assert.match(r.stderr, /^bd show: the beads database is locked/m);
  } finally {
    removeTempDir(stub.dir, 'bd-retry.node-test');
  }
});

// Source-level: every bd call claim.sh makes goes through bd_retry, and its main pull never takes the
// user's pull.rebase (with pull.rebase=true the bare pull failed "Cannot rebase onto multiple branches";
// --ff-only fails the same check, --no-rebase is what worked).
test('claim.sh routes every bd call through bd_retry and pulls main --no-rebase', () => {
  const code = fs.readFileSync(path.join(HERE, 'claim.sh'), 'utf8')
    .split('\n')
    .filter((l) => !/^\s*#/.test(l) && !/^\s*echo /.test(l));
  assert.ok(code.some((l) => /source "\$SCRIPT_DIR\/lib\/bd-retry\.sh"/.test(l)), 'claim.sh sources lib/bd-retry.sh');
  const bare = code.filter((l) => /(^|[|;&(]|\$\()\s*bd\s/.test(l));
  assert.deepEqual(bare, [], 'a bd call outside bd_retry');
  assert.ok(code.filter((l) => /\bbd_retry\b/.test(l)).length >= 4, 'the show, clear and claim calls');
  const pulls = code.filter((l) => /\bgit pull\b/.test(l));
  assert.ok(pulls.length > 0, 'claim.sh still pulls main');
  for (const l of pulls) assert.match(l, /git pull --no-rebase origin main/, l);
});
