#!/usr/bin/env node
// Behavioural tests for scripts/lib/dolt-resilient-pull.sh.
//
// The helper's 2nd-failure recovery runs `dolt reset --hard origin/<branch>` on DOLT_DIR. That is
// the intended recovery for a DISPOSABLE CI mirror and destroys work anywhere else:
// a caller script (record-feature-idea.sh) pointed DOLT_DIR at a real checkout's shared embedded database
// and ran the pull AFTER `bd create`, so a DoltHub blip discarded the new bead (and any other
// session's unpushed bead commits) while the script printed "Feature idea recorded!".
//
// Pinned here: the reset NAMES every commit it discards (never silent), it runs only when DOLT_DIR
// is set, and the one caller that runs from a working checkout does not set it.
//
// Driven through bash with FUNCTION stubs for bd/dolt/sleep - no PATH shims, so nothing here needs
// Node to exec an extensionless script (the Windows limitation conformance smokes skip for).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { removeTempDir } from './test-support/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'lib', 'dolt-resilient-pull.sh').split(path.sep).join('/');
const RECORD_FEATURE_IDEA = path.join(HERE, 'record-feature-idea.sh');

const HAVE_BASH = (() => {
  try {
    return spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
})();
const SKIP_BASH = HAVE_BASH ? false : 'requires bash on PATH';

/**
 * Run the helper with a bd whose pull always fails. `unpushed` is what the stub `dolt log` reports
 * for origin/main..main; `withDoltDir` decides whether the caller opted into the reset, and
 * `inheritDoltDir` exports one from the calling ENVIRONMENT instead of assigning it in the script.
 */
function runHelper({ unpushed, withDoltDir, inheritDoltDir = false, servedByPid = null, servedByShell = false }) {
  const root = mkdtempSync(path.join(tmpdir(), 'dolt-resilient-'));
  // DOLT_DIR is <store root>/<database>, as in a real checkout, so the root can hold a sql-server.info.
  const dir = path.join(root, 'beadsdb');
  mkdirSync(dir);
  if (servedByPid !== null || servedByShell) mkdirSync(path.join(root, '.dolt'));
  if (servedByPid !== null) {
    writeFileSync(path.join(root, '.dolt', 'sql-server.info'), `${servedByPid}:3317:test-uuid`);
  }
  const log = path.join(root, 'calls.log').split(path.sep).join('/');
  const serverInfo = path.join(root, '.dolt', 'sql-server.info').split(path.sep).join('/');
  const script = [
    'set -uo pipefail',
    // `$$` is the shell the helper's `kill -0` runs in. No trailing newline, as dolt writes it.
    servedByShell ? `printf '%s:3317:test-uuid' "$$" > '${serverInfo}'` : '',
    'sleep() { :; }',
    `fakebd() { echo "bd $*" >> '${log}'; return 1; }`,
    'dolt() {',
    `  echo "dolt $*" >> '${log}'`,
    '  case "$1" in',
    '    branch) echo main ;;',
    `    log) printf '%s' "$UNPUSHED" ;;`,
    '  esac',
    '}',
    'BD=fakebd',
    'BEAD_PULL_ATTEMPTS=3',
    withDoltDir ? `DOLT_DIR='${dir.split(path.sep).join('/')}'` : '',
    `source '${HELPER}'`,
    'dolt_pull_resilient; echo "rc=$?"',
  ].join('\n');
  const res = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      UNPUSHED: unpushed,
      ...(inheritDoltDir ? { DOLT_DIR: dir.split(path.sep).join('/') } : {}),
    },
  });
  let calls = '';
  try {
    calls = readFileSync(log, 'utf8');
  } catch (e) {
    // Only a MISSING call log means "no calls were made". Any other read failure (EACCES,
    // EISDIR) must surface: swallowing it would read as zero calls and let a negative
    // assertion on `calls` pass without ever having looked.
    if (e?.code !== 'ENOENT') throw e;
  }
  removeTempDir(root);
  return { stdout: res.stdout, stderr: res.stderr, calls };
}

test('a store served by a LIVE bd sql-server is never reset', { skip: SKIP_BASH }, () => {
  // The helper's own shell is alive, so its pid stands in for the server's. Not this test process:
  // Git Bash's `kill -0` cannot see a Windows pid, so that read as a dead server on Windows.
  const { stdout, stderr, calls } = runHelper({ unpushed: 'abc123 a session\'s bead\n', withDoltDir: true, servedByShell: true });
  assert.match(stdout, /rc=1/);
  assert.match(stderr, /served by a live bd sql-server - the stuck-merge reset is REFUSED/);
  assert.doesNotMatch(calls, /dolt reset/, calls);
  assert.doesNotMatch(calls, /dolt merge --abort/, calls);
  assert.match(calls, /bd dolt pull[\s\S]*bd dolt pull[\s\S]*bd dolt pull/, 'still retries the pull');
});

test('a STALE sql-server.info (dead pid) does not block the disposable-mirror reset', { skip: SKIP_BASH }, () => {
  // A pid far above any kernel pid_max is never alive.
  const { calls } = runHelper({ unpushed: '', withDoltDir: true, servedByPid: 2147483646 });
  assert.match(calls, /dolt reset --hard origin\/main/);
});

test('a reset NAMES every unpushed commit it is about to discard', { skip: SKIP_BASH }, () => {
  const { stdout, stderr, calls } = runHelper({ unpushed: 'abc123 bead one\ndef456 bead two\n', withDoltDir: true });
  assert.match(stdout, /rc=1/);
  assert.match(stderr, /::warning::dolt reset --hard discards unpushed local commit: abc123 bead one/);
  assert.match(stderr, /::warning::dolt reset --hard discards unpushed local commit: def456 bead two/);
  // Named BEFORE the reset runs, against the fetched upstream of the current branch.
  const logAt = calls.indexOf('dolt log --oneline origin/main..main');
  const resetAt = calls.indexOf('dolt reset --hard origin/main');
  assert.ok(logAt !== -1 && resetAt > logAt, calls);
});

test('a reset that discards nothing says nothing', { skip: SKIP_BASH }, () => {
  const { stderr, calls } = runHelper({ unpushed: '', withDoltDir: true });
  assert.doesNotMatch(stderr, /discards unpushed local commit/);
  assert.match(calls, /dolt reset --hard origin\/main/);
});

test('without DOLT_DIR the helper never touches the Dolt clone at all', { skip: SKIP_BASH }, () => {
  const { stdout, calls } = runHelper({ unpushed: 'abc123 bead one\n', withDoltDir: false });
  assert.match(stdout, /rc=1/);
  assert.doesNotMatch(calls, /^dolt /m);
  assert.equal((calls.match(/^bd dolt pull$/gm) ?? []).length, 3);
});

test('a DOLT_DIR inherited from the ENVIRONMENT opts into the reset too', { skip: SKIP_BASH }, () => {
  // Why the caller below must UNSET it rather than merely not assign it: the helper cannot tell a
  // caller's deliberate opt-in from a stray export in the shell that launched it.
  const { calls } = runHelper({ unpushed: '', withDoltDir: false, inheritDoltDir: true });
  assert.match(calls, /dolt reset --hard origin\/main/);
});

// That caller script is not part of this set: a consumer that has it gets the check, one that
// does not skips it (an absent file is not a pass of the property, so it says so).
const NO_CALLER = existsSync(RECORD_FEATURE_IDEA) ? false : 'record-feature-idea.sh is not present in this checkout';

test('record-feature-idea.sh does not opt into the reset - it runs from a real checkout', { skip: NO_CALLER }, () => {
  const code = readFileSync(RECORD_FEATURE_IDEA, 'utf8')
    .split(/\r?\n/)
    .filter(line => !line.trimStart().startsWith('#'));
  assert.equal(code.some(line => /^\s*(export\s+)?DOLT_DIR=/.test(line)), false);
  // An inherited DOLT_DIR is cleared BEFORE the helper is sourced.
  const unsetAt = code.findIndex(line => /^\s*unset\s+DOLT_DIR\s*$/.test(line));
  const sourceAt = code.findIndex(line => /^\s*(source|\.)\s.*dolt-resilient-pull\.sh/.test(line));
  assert.ok(unsetAt !== -1, 'record-feature-idea.sh must unset DOLT_DIR');
  assert.ok(sourceAt > unsetAt, 'DOLT_DIR must be unset before the helper is sourced');
  // And it still uses the helper (plain retry-with-backoff), so this is not a vacuous pass.
  assert.ok(code.some(line => line.includes('dolt_pull_resilient')));
});
