import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  DOLT_BRANCH,
  PUSH_ATTEMPTS,
  PUSH_BACKOFF_MS,
  DEFAULT_PUSH_TIMEOUT_MS,
  pushTimeoutMs,
  buildSyncQuery,
  parseSyncJson,
  resolveDoltDir,
  syncPull,
  syncPush,
  adoptRemote,
  parseIssueCount,
  main,
  DEFAULT_DEPS,
  CLOSE_METADATA_COLUMNS,
  CONFLICT_SUMMARY_QUERY,
  CONFLICT_ISSUES_QUERY,
  classifyConflicts,
  parseJsonRows,
  spawnWithShellFallback,
} from './bd-dolt-sync.mjs';
import { removeTempDir } from './test-support/cleanup.mjs';

/**
 * Real `dolt sql -r json` output for buildSyncQuery(), verbatim in shape from dolt 2.3.1.
 * These strings are the whole contract with the CLI - if dolt ever changes the envelope the
 * parser must be updated, not these fixtures (the repo's agent docs).
 */
const row = (over = {}) =>
  JSON.stringify({
    rows: [{ ahead: 0, behind: 0, branch: 'main', conflicts: 0, dirty_tables: '', ...over }],
  });

const SYNC = {
  clean: row(),
  diverged: row({ ahead: 2, behind: 1 }),
  ahead: row({ ahead: 2 }),
  behind: row({ behind: 3 }),
  conflict: row({ conflicts: 1, ahead: 1, behind: 1 }),
  dirty: row({ dirty_tables: 'issues|memories' }),
};

/**
 * The FALSE GREEN this guards against: `.dolt/repo_state.json` has
 * `branches.main.remote: ""`, so `dolt status` compares main against ITSELF and prints this
 * on a genuinely diverged DB. Nothing may ever base a verdict on it.
 */
const STATUS_FALSE_GREEN = `On branch main
Your branch is up to date with 'main'.
nothing to commit, working tree clean`;

const READ_ONLY_FETCH_ERROR = 'fetch failed: cannot update manifest: database is read only';

test('the sync CLI executes through a directory symlink instead of exiting with a false success', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-sync-entry-'));
  try {
    const alias = path.join(tmp, 'scripts');
    fs.symlinkSync(path.dirname(fileURLToPath(import.meta.url)), alias, process.platform === 'win32' ? 'junction' : 'dir');
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const r = spawnSync(process.execPath, [path.join(alias, 'bd-dolt-sync.mjs'), 'unknown-command'], {
      cwd: tmp, encoding: 'utf8', env,
    });
    assert.equal(r.status, 2, 'the CLI must run its argument validation through the alias');
    assert.match(r.stderr, /Usage: node scripts\/bd-dolt-sync.mjs/);
    assert.equal(r.stdout, '');
  } finally { removeTempDir(tmp); }
});

test('buildSyncQuery counts against origin/<branch>, never dolt status', () => {
  const q = buildSyncQuery(DOLT_BRANCH);
  assert.match(q, /dolt_log\('origin\/main\.\.main'\)/, 'ahead is a real rev-list count');
  assert.match(q, /dolt_log\('main\.\.origin\/main'\)/, 'behind is a real rev-list count');
  assert.match(q, /dolt_conflicts/);
  assert.match(q, /dolt_status/, 'uncommitted writes are part of the answer');
  assert.match(q, /active_branch\(\)/, 'a surprise branch must be catchable');
});

test('parseSyncJson reads the diverged case with both commit counts', () => {
  const s = parseSyncJson(SYNC.diverged);
  assert.equal(s.diverged, true);
  assert.equal(s.unmerged, false);
  assert.equal(s.ahead, 2);
  assert.equal(s.behind, 1);
  assert.equal(s.synced, false);
});

test('parseSyncJson reads ahead / behind / clean', () => {
  const ahead = parseSyncJson(SYNC.ahead);
  assert.deepEqual([ahead.diverged, ahead.ahead, ahead.synced], [false, 2, false]);

  const behind = parseSyncJson(SYNC.behind);
  assert.deepEqual([behind.diverged, behind.behind, behind.synced], [false, 3, false]);

  const clean = parseSyncJson(SYNC.clean);
  assert.equal(clean.synced, true);
  assert.equal(clean.diverged, false);
});

test('parseSyncJson flags an unmerged conflict', () => {
  const s = parseSyncJson(SYNC.conflict);
  assert.equal(s.unmerged, true);
  assert.equal(s.synced, false);
});

test('parseSyncJson splits dirty tables on the pipe separator, and dirt is not synced', () => {
  const s = parseSyncJson(SYNC.dirty);
  assert.deepEqual(s.dirtyTables, ['issues', 'memories']);
  assert.equal(s.dirty, true);
  assert.equal(s.synced, false, 'an uncommitted write is unpublished work like any other');
});

test('parseSyncJson returns null rather than a clean-looking answer on junk', () => {
  for (const input of ['', null, undefined, 'not json', '{"rows":[]}', '{"rows":[{"ahead":"x"}]}']) {
    assert.equal(parseSyncJson(input), null, `must not read ${JSON.stringify(input)} as clean`);
  }
});

test('resolveDoltDir walks up from cwd', () => {
  const root = path.join('C:', 'repo');
  const want = path.join(root, '.beads', 'embeddeddolt', 'beadsdb');
  const found = resolveDoltDir({
    cwd: path.join(root, 'src', 'lib'),
    dbName: 'beadsdb',
    exists: (p) => p === want,
    gitCommonDir: null,
  });
  assert.equal(found, want);
});

test('resolveDoltDir falls back to the primary checkout from inside a linked worktree', () => {
  // A linked worktree has no .beads of its own - walking up from it finds nothing. The git
  // common dir points back at the primary checkout, which is where the beads workspace lives.
  const primary = path.join('C:', 'git', 'primary');
  const want = path.join(primary, '.beads', 'embeddeddolt', 'beadsdb');
  const found = resolveDoltDir({
    cwd: path.join('C:', 'git', 'primary-feature'),
    dbName: 'beadsdb',
    exists: (p) => p === want,
    gitCommonDir: path.join(primary, '.git'),
  });
  assert.equal(found, want);
});

test('resolveDoltDir without a database name uses the single database directory found', () => {
  const root = path.join('C:', 'repo');
  const base = path.join(root, '.beads', 'embeddeddolt');
  const want = path.join(base, 'only-db');
  const found = resolveDoltDir({
    cwd: path.join(root, 'src'),
    dbName: null,
    exists: (p) => p === base || p === want || p === path.join(want, '.dolt'),
    readdir: (p) => (p === base ? ['only-db'] : []),
    gitCommonDir: null,
  });
  assert.equal(found, want);
});

test('resolveDoltDir without a name ignores the .dolt and .doltcfg dirs a sql-server leaves beside the database', () => {
  const root = path.join('C:', 'repo');
  const base = path.join(root, '.beads', 'embeddeddolt');
  const want = path.join(base, 'beadsdb');
  const found = resolveDoltDir({
    cwd: root,
    dbName: null,
    exists: (p) => p === base || p === want || p === path.join(want, '.dolt'),
    readdir: (p) => (p === base ? ['.dolt', '.doltcfg', 'beadsdb'] : []),
    gitCommonDir: null,
  });
  assert.equal(found, want);
});

test('resolveDoltDir without a name does not count a directory that holds no .dolt', () => {
  const root = path.join('C:', 'repo');
  const base = path.join(root, '.beads', 'embeddeddolt');
  const found = resolveDoltDir({
    cwd: root,
    dbName: null,
    exists: (p) => p === base || p === path.join(base, 'stray'),
    readdir: (p) => (p === base ? ['stray'] : []),
    gitCommonDir: null,
  });
  assert.equal(found, null);
});

test('resolveDoltDir without a name never guesses between several real databases', () => {
  const root = path.join('C:', 'repo');
  const base = path.join(root, '.beads', 'embeddeddolt');
  const found = resolveDoltDir({
    cwd: root,
    dbName: null,
    exists: () => true,
    readdir: (p) => (p === base ? ['.dolt', 'a', 'b'] : []),
    gitCommonDir: null,
  });
  assert.equal(found, null);
});

test('resolveDoltDir without a database name never guesses between several', () => {
  const root = path.join('C:', 'repo');
  const base = path.join(root, '.beads', 'embeddeddolt');
  const found = resolveDoltDir({
    cwd: root,
    dbName: null,
    exists: () => true,
    readdir: (p) => (p === base ? ['a', 'b'] : []),
    gitCommonDir: null,
  });
  assert.equal(found, null);
});

test('resolveDoltDir returns null when nothing exists', () => {
  assert.equal(
    resolveDoltDir({ cwd: path.join('C:', 'nowhere'), dbName: 'beadsdb', exists: () => false, gitCommonDir: null }),
    null,
  );
});

/**
 * Scriptable fake for the command runner: queue up a reply per matched command.
 *
 * Keys are COLLAPSED (`dolt sql`, `dolt commit`) so a fixture never has to embed the whole
 * SQL text or commit message.
 */
function commandKey(cmd, args) {
  const joined = [cmd, ...args].join(' ');
  // The conflict-inspection queries get keys of their own, so the existing
  // ground-truth `dolt sql` queues are untouched. Unscripted, they answer '' - unreadable,
  // which must refuse (fail closed).
  if (cmd === 'dolt' && args[0] === 'sql' && args.at(-1) === CONFLICT_SUMMARY_QUERY) return 'dolt sql conflicts';
  if (cmd === 'dolt' && args[0] === 'sql' && args.at(-1) === CONFLICT_ISSUES_QUERY) return 'dolt sql conflicts_issues';
  if (cmd === 'dolt' && args[0] === 'sql') return 'dolt sql';
  if (cmd === 'dolt' && args[0] === 'commit') return 'dolt commit';
  if (cmd === 'dolt' && args[0] === 'add') return 'dolt add';
  return joined;
}

function makeDeps(script, { doltDir = path.join('C:', 'repo', '.beads', 'embeddeddolt', 'beadsdb') } = {}) {
  const calls = [];
  const queues = new Map(Object.entries(script));
  const deps = {
    calls,
    // Per-call spawn options, so a test can assert that a time cap was actually applied
    // and not merely declared.
    runOpts: [],
    logs: [],
    slept: [],
    run(cmd, args = [], opts = {}) {
      const key = commandKey(cmd, args);
      calls.push(key);
      deps.runOpts.push({ key, opts });
      if (key === 'git rev-parse --git-common-dir') {
        return { status: 0, stdout: path.join('C:', 'repo', '.git'), stderr: '' };
      }
      // Anything unscripted succeeds silently - except the ground-truth query, which must be
      // scripted explicitly so no test can accidentally assert against an empty answer.
      const queue = queues.get(key);
      if (!queue) return { status: 0, stdout: '', stderr: '' };
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return { status: 0, stdout: '', stderr: '', ...next };
    },
    log: (m) => deps.logs.push(String(m)),
    warn: (m) => deps.logs.push(String(m)),
    exists: (p) => p === doltDir,
    dbName: 'beadsdb',
    cwd: () => path.join('C:', 'repo'),
    sleep: (ms) => deps.slept.push(ms),
  };
  return deps;
}

const hasLog = (deps, re) => deps.logs.some((l) => re.test(l));

test('syncPull accepts a pull that really merged', () => {
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.ok(!deps.calls.includes('dolt pull'), 'no CLI fallback when bd actually merged');
  // a healthy pull must SAY so - silent success once hid the no-op for a day.
  assert.ok(hasLog(deps, /pull verified: up to date/), 'states the verified outcome');
});

test('syncPull names the unpublished local commits on a verified, in-sync pull', () => {
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.ahead }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true);
  assert.ok(hasLog(deps, /pull verified: in sync with origin, 2 local commit\(s\) still to publish/));
});

test('syncPull falls back to the dolt CLI when bd reports success but merged nothing', () => {
  // The exact observed sequence: bd exits 0, the branch is still diverged, no conflicts.
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    // Read three times: once before the pull (to check for pending writes), once after bd's
    // no-op, once after the CLI pull that actually merges.
    'dolt sql': [{ stdout: SYNC.diverged }, { stdout: SYNC.diverged }, { stdout: SYNC.ahead }],
    'dolt pull': [{ status: 0 }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true);
  assert.ok(deps.calls.includes('dolt pull'), 'the CLI pull is what actually merges');
  assert.equal(r.state.diverged, false);
});

test('syncPull refuses to guess at a real merge conflict', () => {
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.conflict }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.includes('dolt pull'), 'never re-pull over an unresolved conflict');
  assert.ok(hasLog(deps, /resolve by UNION/i), 'points at the union rule');
});

test('syncPull reports unverified rather than false-green when the dolt CLI is missing', () => {
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ status: 127, stdout: '' }],
  });
  const r = syncPull(deps);
  assert.equal(r.verified, false);
  assert.ok(hasLog(deps, /NOT verified/i));
});

// ---------------------------------------------------------------------------
// The two false greens, and the write-loss they hid.
// ---------------------------------------------------------------------------

test('a FAILED dolt fetch is NOT verified, however clean the counts look', () => {
  // Five clones share one embedded DB, so "database is read only" from a concurrent bd
  // process is routine. It is also not ignorable: origin/main is then stale, so "behind: 0"
  // is a lie. This printed "pull verified: up to date with origin/main" on a provably
  // diverged DB.
  const deps = makeDeps({
    'dolt fetch': [{ status: 1, stderr: READ_ONLY_FETCH_ERROR }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPull(deps);
  assert.equal(r.verified, false, 'a stale origin/main can never be "verified"');
  assert.ok(!hasLog(deps, /pull verified/), 'must not print the verified line at all');
  assert.ok(hasLog(deps, /dolt fetch FAILED/), 'names the fetch as the reason');
  assert.ok(hasLog(deps, /read only/), 'surfaces dolt\'s own message');
});

test('a transient fetch failure is retried before being called a failure', () => {
  const deps = makeDeps({
    'dolt fetch': [{ status: 1, stderr: READ_ONLY_FETCH_ERROR }, { status: 0 }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPull(deps);
  assert.equal(r.verified, true, 'the lock is transient - one retry clears it');
  assert.ok(deps.slept.length > 0, 'backs off between attempts rather than hammering');
  assert.ok(hasLog(deps, /pull verified/));
});

test("dolt status's self-comparing 'up to date' line can never produce a green", () => {
  // branches.main.remote is "" in this DB, so `dolt status` compares main against ITSELF and
  // prints "up to date with 'main'" while the branch is genuinely diverged. The helper must
  // not consult that line at all.
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt status': [{ stdout: STATUS_FALSE_GREEN }],
    'dolt sql': [{ stdout: SYNC.diverged }, { stdout: SYNC.diverged }, { stdout: SYNC.clean }],
    'dolt pull': [{ status: 0 }],
  });
  const r = syncPull(deps);
  assert.ok(!deps.calls.includes('dolt status'), 'never asks dolt status for a verdict');
  assert.ok(deps.calls.includes('dolt pull'), 'the diverged truth won, not the status line');
  assert.equal(r.state.diverged, false);
});

test('pending bead writes are COMMITTED before any pull can abort', () => {
  // bd's conflict abort "restores the working set" - a bd update that printed
  // "✓ Updated issue" and reads back fine is not yet a commit, and the rollback eats it.
  const deps = makeDeps({
    'dolt sql': [{ stdout: SYNC.dirty }, { stdout: SYNC.clean }, { stdout: SYNC.clean }],
    'bd dolt pull': [{ status: 0 }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true);
  const commitAt = deps.calls.indexOf('dolt commit');
  const pullAt = deps.calls.indexOf('bd dolt pull');
  assert.ok(commitAt >= 0, 'the working set is committed');
  assert.ok(commitAt < pullAt, 'and committed BEFORE the pull that could abort');
  assert.ok(hasLog(deps, /UNCOMMITTED bead writes in: issues, memories/));
});

test('when the pending writes cannot be committed, the pull is REFUSED and they are named', () => {
  const deps = makeDeps({
    'dolt sql': [{ stdout: SYNC.dirty }],
    'dolt commit': [{ status: 1, stderr: 'Aborting commit due to empty committer name' }],
    'bd dolt pull': [{ status: 0 }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.includes('bd dolt pull'), 'never pulls with unprotected writes at risk');
  assert.ok(hasLog(deps, /REFUSING to pull/));
  assert.ok(hasLog(deps, /issues/), 'names exactly what is at risk');
});

for (const verb of ['pull', 'push']) {
  for (const [name, branch] of [['empty', ''], ['missing', undefined], ['different', 'other-branch']]) {
    for (const afterCommit of [false, true]) {
      test(`sync${verb} refuses an ${name} active branch${afterCommit ? ' after committing pending writes' : ''}`, () => {
        const deps = makeDeps({
          'dolt sql': [...(afterCommit ? [{ stdout: SYNC.dirty }] : []), { stdout: row({ branch }) }],
        });
        const result = verb === 'pull' ? syncPull(deps) : syncPush(deps);
        assert.equal(result.ok, false);
        if (verb === 'pull') assert.equal(result.verified, false, 'an unproven branch is not verified');
        assert.ok(!deps.calls.includes(`bd dolt ${verb}`), 'an unproven main branch never reaches synchronization');
        if (!afterCommit) assert.ok(!deps.calls.includes('dolt commit'), 'does not commit on another or unknown branch');
      });
    }
  }
  test(`sync${verb} continues after a concurrent writer committed the pending tables`, () => {
    const deps = makeDeps({
      'dolt sql': [{ stdout: SYNC.dirty }, { stdout: SYNC.ahead }, { stdout: SYNC.clean }],
      'dolt commit': [{ status: 1, stderr: 'no changes added to commit (use "dolt add")' }],
    });
    const result = verb === 'pull' ? syncPull(deps) : syncPush(deps);
    assert.equal(result.ok, true, 'a fresh clean working set is safe to sync');
    const syncAt = deps.calls.indexOf(`bd dolt ${verb}`);
    const commitAt = deps.calls.indexOf('dolt commit');
    assert.ok(syncAt > commitAt, 'the sync follows the attempted commit');
    assert.equal(deps.calls.slice(commitAt + 1, syncAt).filter(c => c === 'dolt sql').length, 1,
      'fresh database evidence must precede the sync');
    assert.equal(deps.calls.filter(c => c === 'dolt commit').length, 1, 'does not retry an empty commit');
    assert.ok(hasLog(deps, /Fresh state has no pending writes or conflicts/));
    assert.ok(!hasLog(deps, /REFUSING to pull/));
  });
}

for (const [name, answer, fetchFails] of [
  ['pending writes remain', { stdout: SYNC.dirty }],
  ['a merge conflict remains', { stdout: SYNC.conflict }],
  ['the state query fails', { status: 1, stderr: 'database is locked' }],
  ['the state is unreadable', { stdout: 'not-json' }],
  ['the database changed branch', { stdout: row({ branch: 'other-branch' }) }],
  ['the database branch is unknown', { stdout: row({ branch: '' }) }],
  ['the remote could not be refreshed', { stdout: SYNC.clean }, true],
]) {
  test(`an empty pending commit still refuses a pull when ${name}`, () => {
    const deps = makeDeps({
      'dolt sql': [{ stdout: SYNC.dirty }, answer],
      'dolt commit': [{ status: 1, stderr: 'no changes added to commit' }],
      ...(fetchFails ? { 'dolt fetch': [{ status: 0 }, { status: 1, stderr: READ_ONLY_FETCH_ERROR }] } : {}),
    });
    assert.equal(syncPull(deps).ok, false);
    assert.ok(!deps.calls.includes('bd dolt pull'), 'uncertain or unprotected writes never reach a pull');
    assert.ok(hasLog(deps, /REFUSING to pull/));
  });
}

test('syncPush commits pending writes first - an uncommitted push publishes nothing', () => {
  const deps = makeDeps({
    'dolt sql': [{ stdout: SYNC.dirty }, { stdout: SYNC.ahead }],
    'bd dolt push': [{ status: 0 }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, true);
  const commitAt = deps.calls.indexOf('dolt commit');
  const pushAt = deps.calls.indexOf('bd dolt push');
  assert.ok(commitAt >= 0 && commitAt < pushAt, 'commit precedes the push it makes meaningful');
});

test('main status refuses to report synced when the fetch behind it failed', () => {
  const deps = makeDeps({
    'dolt fetch': [{ status: 1, stderr: READ_ONLY_FETCH_ERROR }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  assert.equal(main(['status'], deps), 1, 'clean counts on a stale origin are not proof');
  assert.ok(hasLog(deps, /NOT verified/));
});

// ---------------------------------------------------------------------------

test('syncPush retries once behind a verified pull after a rejection', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }, { status: 0 }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, true);
  assert.equal(r.retried, true);
  assert.equal(deps.calls.filter((c) => c === 'bd dolt push').length, 2);
  // A successful retry must not END on the pull's "still to publish" line.
  assert.ok(hasLog(deps, /push verified: published after retry/));
});

// ── a wedged push must not take every session with it ──────────
// bd runs dolt embedded, so ONE push holds the machine-wide storage lock for as long as
// it lives. One wedged on the network half of the DoltHub push and held it
// for 67 minutes on 1 second of CPU: a claim script printed nothing for 11 minutes and died to
// its own timeout, a second session's claim queued behind it, and a bare `bd show`
// from a third shell hung too. A cap does not make the push succeed - it makes ONE
// session fail loudly instead of every session hanging with nothing on screen.

test('every bd dolt push attempt carries a wall-clock cap', () => {
  const deps = makeDeps({ 'bd dolt push': [{ status: 0 }], 'dolt sql': [{ stdout: SYNC.clean }] });
  syncPush(deps);
  const pushes = deps.runOpts.filter((c) => c.key === 'bd dolt push');
  assert.equal(pushes.length, 1);
  // Asserted on the OPTIONS actually handed to spawn: a cap that is documented but never
  // passed is exactly the uncapped push this exists to prevent.
  assert.equal(pushes[0].opts.timeout, DEFAULT_PUSH_TIMEOUT_MS);
});

test('BD_DOLT_PUSH_TIMEOUT_MS overrides the cap, and garbage falls back to the default', () => {
  const prev = process.env.BD_DOLT_PUSH_TIMEOUT_MS;
  try {
    process.env.BD_DOLT_PUSH_TIMEOUT_MS = '5000';
    assert.equal(pushTimeoutMs(), 5000);
    for (const bad of ['', 'soon', '0', '-1']) {
      process.env.BD_DOLT_PUSH_TIMEOUT_MS = bad;
      assert.equal(pushTimeoutMs(), DEFAULT_PUSH_TIMEOUT_MS, `"${bad}" should not disable the cap`);
    }
    delete process.env.BD_DOLT_PUSH_TIMEOUT_MS;
    assert.equal(pushTimeoutMs(), DEFAULT_PUSH_TIMEOUT_MS);
  } finally {
    if (prev === undefined) delete process.env.BD_DOLT_PUSH_TIMEOUT_MS;
    else process.env.BD_DOLT_PUSH_TIMEOUT_MS = prev;
  }
});

test('a push killed by the cap stops the ladder and says it WEDGED, not that it was rejected', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1, timedOut: true }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPush(deps);

  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  // Never retried: the retry ladder exists for a non-fast-forward RACE, and re-running a
  // push that wedged just re-takes the lock for another full cap.
  assert.equal(deps.calls.filter((c) => c === 'bd dolt push').length, 1);
  assert.deepEqual(deps.slept, [], 'a wedged push must not sit in the backoff ladder');

  assert.ok(hasLog(deps, /WEDGED/), 'the message must distinguish wedged from rejected');
  assert.ok(hasLog(deps, /BD_DOLT_PUSH_TIMEOUT_MS/), 'it must name the knob');
  assert.ok(hasLog(deps, /wchan|Get-Process/), 'it must name how to check the holder');
  assert.ok(hasLog(deps, /Do NOT kill another session/), 'and what not to do');
});

test('an ordinary REJECTION is still retried - the cap must not swallow the race path', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }, { status: 0 }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, true);
  assert.equal(r.timedOut, undefined);
  assert.equal(deps.calls.filter((c) => c === 'bd dolt push').length, 2);
});

test('the sync query is a single line - a newline in the argv dies at cmd.exe', () => {
  // shell:true on win32 routed the query through cmd.exe, which terminates the
  // command line at the first embedded newline; dolt received the lone word
  // `select` and pull AND push were broken on every Windows box.
  assert.ok(!buildSyncQuery().includes('\n'));
  assert.match(buildSyncQuery(), /^select \(select count/);
});

test('DEFAULT_DEPS.run delivers hostile argv byte-identical to a real child', () => {
  // Spawns REAL node: the arg carries a newline, single AND double quotes, a pipe
  // and a caret - everything cmd.exe mangles. The no-shell-first path must hand it
  // over verbatim on every platform.
  const hostile = 'select\n  "a" | \'b\' ^ &c';
  const r = DEFAULT_DEPS.run(process.execPath, [
    '-e',
    'process.stdout.write(JSON.stringify(process.argv[1]))',
    hostile,
  ]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout), hostile);
});

test('spawns $BD_CLI instead of bare bd when set, read at call time', () => {
  // A close script threads $BD to every bd call; a conformance smoke's fixture relies
  // on it. When this script spawned bare 'bd', the smoke's temp dir found a REAL bd
  // with no workspace - a fake "push rejected" then a fake pull failure.
  const prev = process.env.BD_CLI;
  process.env.BD_CLI = 'stub-bd';
  try {
    const deps = makeDeps({
      'stub-bd dolt push': [{ status: 0 }],
      'dolt sql': [{ stdout: SYNC.clean }],
    });
    const r = syncPush(deps);
    assert.equal(r.ok, true);
    assert.ok(deps.calls.includes('stub-bd dolt push'), 'spawned the stub, not bare bd');
    assert.ok(!deps.calls.some((c) => c.startsWith('bd ')), 'no bare bd call');
  } finally {
    if (prev === undefined) delete process.env.BD_CLI;
    else process.env.BD_CLI = prev;
  }
});

test('the retry push also honours $BD_CLI (it used to fall back to bare bd)', () => {
  const prev = process.env.BD_CLI;
  process.env.BD_CLI = 'stub-bd';
  try {
    const deps = makeDeps({
      'stub-bd dolt push': [{ status: 1 }, { status: 0 }],
      'stub-bd dolt pull': [{ status: 0 }],
      'dolt sql': [{ stdout: SYNC.clean }],
    });
    const r = syncPush(deps);
    assert.equal(r.ok, true);
    assert.equal(r.retried, true);
    assert.ok(!deps.calls.some((c) => c.startsWith('bd ')), 'no bare bd call on the retry either');
  } finally {
    if (prev === undefined) delete process.env.BD_CLI;
    else process.env.BD_CLI = prev;
  }
});

test('syncPush states the verified outcome on a clean first-try push', () => {
  const deps = makeDeps({ 'bd dolt push': [{ status: 0 }], 'dolt sql': [{ stdout: SYNC.clean }] });
  const r = syncPush(deps);
  assert.equal(r.ok, true);
  assert.equal(r.retried, false);
  // deps.run captures bd's own output, so without this line the command is silent.
  assert.ok(hasLog(deps, /push verified: published\./));
});

test('syncPush does not pull when the first push already succeeded', () => {
  const deps = makeDeps({ 'bd dolt push': [{ status: 0 }], 'dolt sql': [{ stdout: SYNC.clean }] });
  const r = syncPush(deps);
  assert.equal(r.ok, true);
  assert.equal(r.retried, false);
  assert.ok(!deps.calls.includes('bd dolt pull'));
});

test('syncPush gives up loudly rather than suggesting --force', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, false);
  assert.ok(hasLog(deps, /Do NOT --force/));
});

// ---------------------------------------------------------------------------
// One retry was not enough, and the closes died with the runner.
//
// A CI close job closed four beads on the runner's own clone, the
// push was rejected, and then BOTH the bd pull and the dolt CLI pull inside the
// single retry failed against a DB a concurrent session was mid-push on. Red
// run, discarded runner, four beads still in_progress on DoltHub.
// ---------------------------------------------------------------------------

test('syncPush retries the whole ladder and gives up non-zero at the cap', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }], // rejected forever
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, false, 'a push that never lands must never report success');
  assert.equal(r.attempts, PUSH_ATTEMPTS);
  assert.equal(
    deps.calls.filter((c) => c === 'bd dolt push').length,
    PUSH_ATTEMPTS,
    'exactly the capped number of attempts - no unbounded hammering of the shared remote',
  );
  assert.equal(
    deps.calls.filter((c) => c === 'bd dolt pull').length,
    PUSH_ATTEMPTS - 1,
    'each retry sits behind its own verified pull',
  );
  assert.deepEqual(deps.slept, PUSH_BACKOFF_MS, 'backs off on the documented ladder');
  assert.ok(hasLog(deps, /Do NOT --force/), 'still refuses the one action the agent rules forbid');
});

test('the backoff ladder stays in the tens of seconds, never minutes', () => {
  // This runs on a single-job-at-a-time self-hosted runner shared with PR
  // auto-review, so a long ladder here blocks every other job on that host.
  const total = PUSH_BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.equal(PUSH_BACKOFF_MS.length, PUSH_ATTEMPTS - 1, 'one wait between each pair of attempts');
  assert.ok(total <= 30_000, `backoff budget ${total}ms must stay within ~30s`);
  assert.deepEqual(
    [...PUSH_BACKOFF_MS].sort((a, b) => a - b),
    PUSH_BACKOFF_MS,
    'delays only grow - a flat ladder just re-races the same contention',
  );
});

test('a FAILED pull mid-ladder does not abandon the push (the run-33194890814 shape)', () => {
  // The exact observed sequence: push rejected, bd dolt pull FAILED, the branch
  // still diverged, the dolt CLI pull FAILED too. Under the old one-shot retry
  // that ended the run red with the closes already lost. It is almost always the
  // same concurrent push that rejected us, so back off and try the lot again.
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }, { status: 1 }, { status: 0 }],
    'bd dolt pull': [{ status: 1 }],
    'dolt pull': [{ status: 1 }],
    'dolt sql': [{ stdout: SYNC.diverged }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, true, 'the third attempt lands - the failure was transient contention');
  assert.equal(r.attempts, 3);
  assert.equal(r.retried, true);
  assert.equal(deps.calls.filter((c) => c === 'bd dolt push').length, 3);
  assert.deepEqual(deps.slept, PUSH_BACKOFF_MS.slice(0, 2));
  assert.ok(hasLog(deps, /pull before retry 2\/4 FAILED/i), 'says which retry the pull failed for');
  assert.ok(hasLog(deps, /published after retry \(attempt 3\/4\)/), 'names the winning attempt');
});

test('syncPush does NOT retry a non-race failure - an unresolved merge conflict', () => {
  // A conflict is data-level: no number of retries clears it, and it needs
  // resolution by UNION. Hammering the remote three more times just
  // buries the one message that says what to do.
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }],
    'bd dolt pull': [{ status: 0 }],
    // Clean before the push; the conflict arrives with the pull after the rejection. (A
    // conflict already standing before the push is refused before any push.)
    'dolt sql': [{ stdout: SYNC.clean }, { stdout: SYNC.conflict }],
  });
  const r = syncPush(deps);
  assert.equal(r.ok, false);
  assert.equal(r.unmerged, true);
  assert.equal(r.attempts, 1, 'stops on the first attempt, not at the cap');
  assert.equal(deps.calls.filter((c) => c === 'bd dolt push').length, 1);
  assert.deepEqual(deps.slept, [], 'no point backing off from a state that will not change');
  assert.ok(hasLog(deps, /UNRESOLVED merge conflict/), 'names it as not-a-race');
  assert.ok(hasLog(deps, /resolve by UNION/i), 'and still points at the union rule');
});

test('a rejection log names the attempt so a red run is readable without arithmetic', () => {
  const deps = makeDeps({
    'bd dolt push': [{ status: 1 }, { status: 0 }],
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.clean }],
  });
  syncPush(deps);
  assert.ok(hasLog(deps, /push rejected \(attempt 1\/4\)/));
  assert.ok(hasLog(deps, /waiting 2000ms before push attempt 2\/4/));
});

test('main status exits 1 when the DB is not synced, 0 when it is', () => {
  const dirty = makeDeps({ 'dolt sql': [{ stdout: SYNC.ahead }] });
  assert.equal(main(['status'], dirty), 1);

  const clean = makeDeps({ 'dolt sql': [{ stdout: SYNC.clean }] });
  assert.equal(main(['status'], clean), 0);
});

test('main rejects an unknown subcommand', () => {
  assert.equal(main(['frobnicate'], makeDeps({})), 2);
});

// ---------------------------------------------------------------------------
// Query-integrity guardrails. Everything above runs against
// FIXTURES, which is exactly why the cmd.exe breakage (cmd.exe truncating
// the newline-joined query argv to the single word `select`) stayed green in
// CI while pull AND push were dead on every Windows dev box. These two tests
// close that hole from both ends: a static invariant on the string itself,
// and a live parse+execute round-trip against whatever real dolt is on PATH.

test('buildSyncQuery is one line - a newline anywhere revives the cmd.exe truncation', () => {
  const q = buildSyncQuery(DOLT_BRANCH);
  // The query travels as ONE argv element, and the win32 fallback spawn path
  // routes through cmd.exe, which terminates the command line at the first
  // embedded newline. Never "prettify" this string.
  assert.doesNotMatch(q, /[\r\n]/, 'query must contain no newline in any form');
  assert.match(q, /^select /, 'query must start as a single select statement');
});

test('buildSyncQuery parses and executes on the real dolt on PATH', (t) => {
  // Runs on EVERY platform including Windows. It used to skip on win32,
  // because `dolt push` below spawns a detached background events/telemetry process that
  // holds `.dolt/eventsData/dolt.lock` open for an unpredictable window (observed from
  // under a second to ~15-20s) after the command returns, so the t.after cleanup EPERMed
  // and failed the test. `metrics.disabled=true` (set --global, before init) does NOT
  // prevent it, and no retry budget a test should spend covers a 20s window - both were
  // reproduced and ruled out.
  //
  // The skip is no longer the right answer because the *cleanup* is no longer fatal:
  // removeTempDir reports a stuck scratch dir loudly and returns instead of
  // throwing, which is exactly this case.
  // The assertions below - that the shipped query string parses and executes against a
  // real dolt - are platform-independent and were never what failed. Skipping cost
  // Windows that coverage to avoid a cleanup log line; that trade was backwards.
  const probe = spawnSync('dolt', ['version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    t.skip('dolt not on PATH - live query check needs a real dolt binary');
    return;
  }

  // Hermetic scratch clone: its own DOLT_ROOT_PATH (never the user global
  // config or creds) and a file:// remote so `origin/main` genuinely exists -
  // dolt_log('origin/main..main') is the part of the query a fixture can
  // never exercise.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-sync-query-'));
  // MUST stay removeTempDir, not a bare fs.rmSync. On Windows
  // dolt's detached events process can still hold this tree when the test ends; a
  // throwing cleanup would turn that lock contention into a red test, which is what the
  // deleted win32 skip was papering over. Leaking a scratch dir is reported, not fatal.
  t.after(() => removeTempDir(root, 'bd-dolt-sync.node-test'));
  const dbDir = path.join(root, 'db');
  const remoteDir = path.join(root, 'remote');
  fs.mkdirSync(dbDir);
  fs.mkdirSync(remoteDir);
  const env = { ...process.env, DOLT_ROOT_PATH: root, HOME: root };
  const dolt = (args, cwd) => {
    const r = spawnSync('dolt', args, { encoding: 'utf8', cwd, env });
    assert.equal(
      r.status,
      0,
      `dolt ${args.join(' ')} failed: ${r.stderr || r.stdout || r.error}`,
    );
    return r;
  };

  dolt(['config', '--global', '--add', 'user.name', 'guardrail'], dbDir);
  dolt(['config', '--global', '--add', 'user.email', 'guardrail@test.invalid'], dbDir);
  dolt(['init', '-b', DOLT_BRANCH], dbDir);
  dolt(['remote', 'add', 'origin', `file://${remoteDir.replace(/\\/g, '/')}`], dbDir);
  dolt(['push', 'origin', DOLT_BRANCH], dbDir);

  // The actual assertion: the EXACT string the helper ships parses, executes,
  // and round-trips through parseSyncJson on this machine's dolt version. If
  // a dolt upgrade drops dolt_log ranges, dolt_conflicts, dolt_status, or the
  // group_concat separator syntax, this goes red here instead of silently
  // degrading every claim.sh sync in the field.
  const r = dolt(['sql', '-r', 'json', '-q', buildSyncQuery(DOLT_BRANCH)], dbDir);
  const sync = parseSyncJson(r.stdout);
  assert.ok(sync, `parseSyncJson could not read real dolt output: ${r.stdout}`);
  assert.equal(sync.ahead, 0);
  assert.equal(sync.behind, 0);
  assert.equal(sync.conflicts, 0);
  assert.deepEqual(sync.dirtyTables, []);
  assert.equal(sync.branch, DOLT_BRANCH);
});

// ---------------------------------------------------------------------------
// adoptRemote. Fresh-clone recovery: `bd init` seeds an empty local
// dolt history that shares no root with DoltHub, so `bd dolt pull` can never
// fast-forward and the CLI-merge fallback cannot merge unrelated histories
// either - the clone sits at 0 issues with no tracker. adopt resets onto
// origin/main, and the ONLY thing that makes that safe is the emptiness check,
// so most of what is asserted here is the refusal.

const countRow = (c) => JSON.stringify({ rows: [{ c }] });

test('adoptRemote resets onto origin/main when the local history is empty', () => {
  const deps = makeDeps({
    // First `dolt sql` is the issue count; the second is readSyncState's ground-truth query.
    'dolt sql': [{ stdout: countRow(0) }, { stdout: SYNC.clean }],
  });
  const r = adoptRemote(deps);
  assert.equal(r.ok, true);
  assert.equal(r.adopted, true);
  assert.ok(
    deps.calls.includes(`dolt reset --hard origin/${DOLT_BRANCH}`),
    'it must actually reset',
  );
  assert.ok(hasLog(deps, /adopted origin\/main \(local history was empty\)/));
});

test('adoptRemote REFUSES when the local DB holds issues - it must never discard real work', () => {
  const deps = makeDeps({ 'dolt sql': [{ stdout: countRow(4358) }] });
  const r = adoptRemote(deps);
  assert.equal(r.ok, false);
  assert.equal(r.adopted, false);
  assert.ok(
    !deps.calls.some((c) => c.startsWith('dolt reset')),
    'a non-empty DB must not be reset',
  );
  assert.ok(hasLog(deps, /holds 4358 issue\(s\) - refusing to discard/));
});

// An unreadable count is NOT an empty one. This is the direction that matters:
// treating "cannot tell" as "empty" would hard-reset a database whose contents
// nobody verified.
test('adoptRemote REFUSES when the issue count cannot be read', () => {
  const deps = makeDeps({ 'dolt sql': [{ stdout: 'not json at all' }] });
  const r = adoptRemote(deps);
  assert.equal(r.ok, false);
  assert.ok(!deps.calls.some((c) => c.startsWith('dolt reset')));
  assert.ok(hasLog(deps, /Could not read the local issue count - refusing to reset/));
});

test('adoptRemote does not claim success when the DB is still not synced afterwards', () => {
  const deps = makeDeps({
    'dolt sql': [{ stdout: countRow(0) }, { stdout: SYNC.behind }],
  });
  const r = adoptRemote(deps);
  assert.equal(r.ok, false, 'a reset that did not reach sync is not a success');
  assert.ok(hasLog(deps, /Still not synced after adopt/));
});

test('parseIssueCount refuses every shape that is not a readable count', () => {
  assert.equal(parseIssueCount(JSON.stringify({ rows: [{ c: 0 }] })), 0);
  assert.equal(parseIssueCount(JSON.stringify({ rows: [{ c: 12 }] })), 12);
  assert.equal(parseIssueCount(''), null);
  assert.equal(parseIssueCount('garbage'), null);
  assert.equal(parseIssueCount(JSON.stringify({ rows: [] })), null);
  assert.equal(parseIssueCount(JSON.stringify({ rows: [{ c: 'lots' }] })), null);
});

test('main adopt dispatches to adoptRemote', () => {
  const ok = makeDeps({ 'dolt sql': [{ stdout: countRow(0) }, { stdout: SYNC.clean }] });
  assert.equal(main(['adopt'], ok), 0);

  const refused = makeDeps({ 'dolt sql': [{ stdout: countRow(1) }] });
  assert.equal(main(['adopt'], refused), 1);
});

// ── a double close leaves a conflict nobody needs to judge ──────────
// Twice an author session closed a bead by hand seconds after a CI job had closed it.
// The push then stopped on an unresolved conflict on that one `issues` row - closed on both
// sides, differing only in when and why - and printed `dolt add . && dolt commit`, which
// fails while the conflict stands. The working recovery was `dolt conflicts resolve --theirs
// issues` first. These pin: that exact shape resolves itself, and nothing wider does.

/** A `dolt_conflicts_issues` row in dolt's own JSON shape (null columns are OMITTED). */
const conflictRow = ({ ours = {}, theirs = {}, base = {} } = {}) => {
  const out = { dolt_conflict_id: 'c1', from_root_ish: 'abc', our_diff_type: 'modified', their_diff_type: 'modified' };
  const side = (prefix, over) => {
    const cols = {
      id: 'bd-x1', title: 'Fix it', description: 'desc', status: 'closed',
      closed_at: '2026-10-01 12:00:00', close_reason: 'Closed', updated_at: '2026-10-01 12:00:00',
      ...over,
    };
    for (const [k, v] of Object.entries(cols)) if (v !== null) out[`${prefix}_${k}`] = v;
  };
  side('base', { status: 'in_progress', closed_at: null, close_reason: null, updated_at: '2026-09-30 09:00:00', ...base });
  side('our', { close_reason: 'done by hand', closed_by_session: 'sess-a', ...ours });
  side('their', {
    closed_at: '2026-10-01 11:59:30', close_reason: 'Closed via PR #4800',
    updated_at: '2026-10-01 11:59:30', content_hash: 'h2', ...theirs,
  });
  return out;
};
const rowsJson = (rows) => JSON.stringify({ rows });
const issuesSummary = (n = 1) => rowsJson([{ num_conflicts: n, table: 'issues' }]);
const UNMERGED = row({ conflicts: 1, dirty_tables: 'issues' });
const AHEAD_ONE = row({ ahead: 1 });
const RESOLVE_THEIRS = 'dolt conflicts resolve --theirs issues';

test('classifyConflicts accepts a double close that differs only in close metadata', () => {
  const r = classifyConflicts(JSON.parse(issuesSummary()).rows, [conflictRow()]);
  assert.equal(r.resolvable, true, r.reason);
  assert.deepEqual(r.ids, ['bd-x1']);
  for (const col of r.columns) assert.ok(CLOSE_METADATA_COLUMNS.includes(col), col);
  assert.ok(r.columns.includes('close_reason'));
});

for (const [name, rows, summary, why] of [
  ['one side is still open', [conflictRow({ ours: { status: 'open', closed_at: null } })], issuesSummary(), /not closed on both sides/],
  ['the title differs', [conflictRow({ theirs: { title: 'Fix it properly' } })], issuesSummary(), /"title"/],
  ['the description differs', [conflictRow({ ours: { description: 'more detail' } })], issuesSummary(), /"description"/],
  ['a column is null on one side only', [conflictRow({ ours: { description: null } })], issuesSummary(), /"description"/],
  ['a side deleted the row', [{ ...conflictRow(), our_diff_type: 'removed' }], issuesSummary(), /not modified on both sides/],
  ['another table conflicts', [conflictRow()],
    rowsJson([{ num_conflicts: 1, table: 'issues' }, { num_conflicts: 1, table: 'dependencies' }]), /outside issues: dependencies/],
  ['the row count disagrees', [conflictRow()], issuesSummary(2), /counts 2 conflict/],
  ['no rows were read', [], issuesSummary(), /no rows/],
  ['no table was listed', [conflictRow()], rowsJson([]), /no conflicted table/],
]) {
  test(`classifyConflicts refuses when ${name}`, () => {
    const r = classifyConflicts(JSON.parse(summary).rows, rows);
    assert.equal(r.resolvable, false);
    assert.match(r.reason, why);
  });
}

test('parseJsonRows is null on anything but a rows envelope', () => {
  assert.deepEqual(parseJsonRows(issuesSummary()), [{ num_conflicts: 1, table: 'issues' }]);
  for (const bad of ['', 'nope', '{}', '{"rows":[1]}', null]) assert.equal(parseJsonRows(bad), null);
});

const settledDeps = (extra = {}) => makeDeps({
  'bd dolt push': [{ status: 0 }],
  'bd dolt pull': [{ status: 0 }],
  'dolt sql conflicts': [{ stdout: issuesSummary() }],
  'dolt sql conflicts_issues': [{ stdout: rowsJson([conflictRow()]) }],
  ...extra,
});

test('syncPush auto-resolves a standing double-close conflict with --theirs, then pushes', () => {
  // The incident: the conflict is already standing when push starts, and the table is dirty.
  const deps = settledDeps({ 'dolt sql': [{ stdout: UNMERGED }, { stdout: AHEAD_ONE }] });
  const r = syncPush(deps);
  assert.equal(r.ok, true, deps.logs.join('\n'));
  const resolveAt = deps.calls.indexOf(RESOLVE_THEIRS);
  const addAt = deps.calls.indexOf('dolt add');
  const commitAt = deps.calls.indexOf('dolt commit');
  const pushAt = deps.calls.indexOf('bd dolt push');
  assert.ok(resolveAt >= 0, 'resolves with --theirs on the issues table');
  assert.ok(resolveAt < addAt && addAt < commitAt && commitAt < pushAt, deps.calls.join(' -> '));
  assert.ok(hasLog(deps, /auto-resolved bd-x1/), 'names each auto-resolved id');
  assert.ok(hasLog(deps, /double close only/));
});

test('syncPull auto-resolves a double close the pull itself produced, then verifies', () => {
  const deps = settledDeps({ 'dolt sql': [{ stdout: SYNC.clean }, { stdout: UNMERGED }, { stdout: AHEAD_ONE }] });
  const r = syncPull(deps);
  assert.equal(r.ok, true, deps.logs.join('\n'));
  assert.equal(r.verified, true);
  assert.ok(deps.calls.includes(RESOLVE_THEIRS));
  assert.ok(hasLog(deps, /pull verified/));
});

test('syncPull auto-resolves a double close left standing by the dolt CLI fallback merge', () => {
  const deps = settledDeps({
    'dolt sql': [{ stdout: SYNC.diverged }, { stdout: SYNC.diverged }, { stdout: UNMERGED }, { stdout: AHEAD_ONE }],
    'dolt pull': [{ status: 0 }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true, deps.logs.join('\n'));
  const pullAt = deps.calls.indexOf('dolt pull');
  assert.ok(pullAt >= 0 && pullAt < deps.calls.indexOf(RESOLVE_THEIRS));
});

test('syncPull settles a double close the CLI merge left standing even when it EXITED non-zero (server mode)', () => {
  // Through a bd sql-server the CLI merge reports the conflict as a failure but leaves it standing.
  const deps = settledDeps({
    'dolt sql': [{ stdout: SYNC.diverged }, { stdout: SYNC.diverged }, { stdout: UNMERGED }, { stdout: AHEAD_ONE }],
    'dolt pull': [{ status: 1, stderr: 'merge has unresolved conflicts' }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, true, deps.logs.join('\n'));
  assert.ok(deps.calls.includes(RESOLVE_THEIRS), 'the standing conflict is settled, not abandoned');
  assert.ok(hasLog(deps, /pull verified/));
});

test('a failed CLI merge with NO standing conflict still fails', () => {
  const deps = makeDeps({
    'bd dolt pull': [{ status: 0 }],
    'dolt sql': [{ stdout: SYNC.diverged }, { stdout: SYNC.diverged }, { stdout: SYNC.diverged }],
    'dolt pull': [{ status: 1, stderr: 'network down' }],
  });
  const r = syncPull(deps);
  assert.equal(r.ok, false);
  assert.ok(hasLog(deps, /dolt pull FAILED \(exit 1\)/));
});

const refusedCases = [
  ['one side is still open',
    { 'dolt sql conflicts_issues': [{ stdout: rowsJson([conflictRow({ ours: { status: 'in_progress' } })]) }] }, /not closed on both sides/],
  ['the title differs',
    { 'dolt sql conflicts_issues': [{ stdout: rowsJson([conflictRow({ theirs: { title: 'Other' } })]) }] }, /"title"/],
  ['another table conflicts',
    { 'dolt sql conflicts': [{ stdout: rowsJson([{ num_conflicts: 2, table: 'dependencies' }]) }] }, /outside issues: dependencies/],
  ['the conflict summary cannot be read',
    { 'dolt sql conflicts': [{ status: 1, stderr: 'database is locked' }] }, /could not read dolt_conflicts \(database is locked\)/],
  ['the conflict summary is unreadable', { 'dolt sql conflicts': [{ stdout: 'garbage' }] }, /unreadable/],
  ['the conflict rows cannot be read',
    { 'dolt sql conflicts_issues': [{ status: 1, stderr: 'boom' }] }, /could not read dolt_conflicts_issues/],
];

for (const verb of ['push', 'pull']) {
  for (const [name, extra, why] of refusedCases) {
    test(`sync${verb} REFUSES a conflict when ${name}, and prints the recipe that works`, () => {
      const deps = settledDeps({ 'dolt sql': [{ stdout: UNMERGED }], ...extra });
      const r = verb === 'push' ? syncPush(deps) : syncPull(deps);
      assert.equal(r.ok, false);
      assert.ok(!deps.calls.some((c) => c.startsWith('dolt conflicts resolve')), 'never picks a side');
      assert.ok(!deps.calls.includes('dolt commit'), 'never commits over the conflict');
      assert.ok(!deps.calls.includes(`bd dolt ${verb}`), 'never syncs over the conflict');
      assert.ok(hasLog(deps, why), `names why: ${deps.logs.join('\n')}`);
      assert.ok(hasLog(deps, /resolve by UNION/i));
      assert.ok(hasLog(deps, /dolt sql -q "select \* from dolt_conflicts"/), 'says how to inspect first');
      assert.ok(hasLog(deps, /dolt conflicts resolve --theirs /), 'names the resolve step');
      assert.ok(hasLog(deps, /dolt conflicts resolve --ours /));
      assert.ok(hasLog(deps, /Only once dolt_conflicts is empty:\s+dolt add \. && dolt commit/),
        'add+commit is ordered AFTER the resolve, never offered alone');
    });
  }
}

test('a resolve that fails part-way refuses and prints the recipe', () => {
  const deps = settledDeps({
    'dolt sql': [{ stdout: UNMERGED }],
    [RESOLVE_THEIRS]: [{ status: 1, stderr: 'nope' }],
  });
  assert.equal(syncPush(deps).ok, false);
  assert.ok(!deps.calls.includes('dolt commit'));
  assert.ok(!deps.calls.includes('bd dolt push'));
  assert.ok(hasLog(deps, /dolt conflicts resolve FAILED/));
  assert.ok(hasLog(deps, /Only once dolt_conflicts is empty/));
});

test('a conflict still standing after the automatic resolution stops instead of looping', () => {
  const deps = settledDeps({ 'dolt sql': [{ stdout: UNMERGED }] });
  assert.equal(syncPush(deps).ok, false);
  assert.equal(deps.calls.filter((c) => c === RESOLVE_THEIRS).length, 1);
  assert.ok(!deps.calls.includes('bd dolt push'));
  assert.ok(hasLog(deps, /not clean - stopping rather than guessing/));
});

/**
 * The real thing, against a real dolt (skipped without one): two clones close the same bead
 * differently, the local one pulls into a standing conflict, and syncPush - with bd stubbed to
 * the dolt CLI - resolves, commits and publishes it. When the title ALSO differs, the conflict
 * must be left standing.
 */
const BD_STUB = 'bd-stub-double-close';
const HAVE_DOLT = (() => {
  const probe = spawnSync('dolt', ['version'], { encoding: 'utf8' });
  return !probe.error && probe.status === 0;
})();

function buildDoubleClose(t, theirClose) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dolt-sync-wnu6d-'));
  t.after(() => removeTempDir(root, 'bd-dolt-sync.node-test'));
  const dbDir = path.join(root, '.beads', 'embeddeddolt', 'beadsdb');
  const ciDir = path.join(root, 'ci');
  const remoteDir = path.join(root, 'remote');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.mkdirSync(remoteDir);
  const env = { ...process.env, DOLT_ROOT_PATH: root, HOME: root };
  const dolt = (args, cwd, { check = true } = {}) => {
    const r = spawnSync('dolt', args, { encoding: 'utf8', cwd, env });
    if (check) assert.equal(r.status, 0, `dolt ${args.join(' ')} failed: ${r.stderr || r.stdout || r.error}`);
    return r;
  };
  const count = (q) => parseJsonRows(dolt(['sql', '-r', 'json', '-q', q], dbDir).stdout)?.[0]?.c;
  const remoteUrl = `file://${remoteDir.split(path.sep).join('/')}`;
  dolt(['config', '--global', '--add', 'user.name', 'guardrail'], dbDir);
  dolt(['config', '--global', '--add', 'user.email', 'guardrail@test.invalid'], dbDir);
  dolt(['init', '-b', DOLT_BRANCH], dbDir);
  dolt(['sql', '-q', 'create table issues (id varchar(32) primary key, title text, status varchar(32),' +
    ' closed_at datetime, close_reason text, updated_at datetime, content_hash varchar(64))'], dbDir);
  dolt(['sql', '-q', "insert into issues values ('bd-x1', 'Fix it', 'in_progress', null, null, '2026-09-30 09:00:00', 'h0')"], dbDir);
  dolt(['add', '.'], dbDir);
  dolt(['commit', '-m', 'seed'], dbDir);
  dolt(['remote', 'add', 'origin', remoteUrl], dbDir);
  dolt(['push', '--set-upstream', 'origin', DOLT_BRANCH], dbDir);
  dolt(['clone', remoteUrl, ciDir], root);
  // the CI close job closes first and publishes...
  dolt(['sql', '-q', `update issues set status = 'closed', closed_at = '2026-10-01 11:59:30',` +
    ` close_reason = 'Closed via PR #4800', updated_at = '2026-10-01 11:59:30', content_hash = 'h2'${theirClose} where id = 'bd-x1'`], ciDir);
  dolt(['commit', '-am', 'ci-close'], ciDir);
  dolt(['push', 'origin', DOLT_BRANCH], ciDir);
  // ...then the author closes the same bead by hand, and pulls into the conflict.
  dolt(['sql', '-q', "update issues set status = 'closed', closed_at = '2026-10-01 12:00:00', close_reason = 'done by hand'," +
    " updated_at = '2026-10-01 12:00:00', content_hash = 'h1' where id = 'bd-x1'"], dbDir);
  dolt(['commit', '-am', 'hand close'], dbDir);
  dolt(['pull', 'origin', DOLT_BRANCH], dbDir, { check: false });
  assert.equal(count('select count(*) as c from dolt_conflicts_issues'), 1, 'the scenario must leave a conflict standing');

  const logs = [];
  const deps = {
    run(cmd, args = [], opts = {}) {
      if (cmd === 'git') return { status: 1, stdout: '', stderr: 'not a repo' };
      if (cmd === BD_STUB) {
        // `bd dolt push|pull` -> the same operation through the dolt CLI.
        const doltArgs = args[1] === 'push' ? ['push', 'origin', DOLT_BRANCH] : ['pull', 'origin', DOLT_BRANCH];
        return spawnWithShellFallback('dolt', doltArgs, { cwd: dbDir, env });
      }
      return spawnWithShellFallback(cmd, args, { ...opts, env });
    },
    log: (m) => logs.push(String(m)),
    warn: (m) => logs.push(String(m)),
    exists: (p) => fs.existsSync(p),
    dbName: 'beadsdb',
    cwd: () => root,
    sleep: () => {},
  };
  return { deps, logs, dolt, dbDir, count };
}

function withBdStub(fn) {
  const prev = process.env.BD_CLI;
  process.env.BD_CLI = BD_STUB;
  try {
    fn();
  } finally {
    if (prev === undefined) delete process.env.BD_CLI;
    else process.env.BD_CLI = prev;
  }
}

test('real dolt: a double close resolves with --theirs and publishes', (t) => {
  if (!HAVE_DOLT) { t.skip('dolt not on PATH'); return; }
  withBdStub(() => {
    const { deps, logs, dolt, dbDir, count } = buildDoubleClose(t, '');
    const r = syncPush(deps);
    assert.equal(r.ok, true, logs.join('\n'));
    assert.ok(logs.some((l) => /auto-resolved bd-x1/.test(l)), logs.join('\n'));
    const after = dolt(['sql', '-r', 'json', '-q', "select status, close_reason from issues where id = 'bd-x1'"], dbDir);
    assert.deepEqual(parseJsonRows(after.stdout), [{ status: 'closed', close_reason: 'Closed via PR #4800' }], "origin's close wins");
    assert.equal(count('select count(*) as c from dolt_conflicts'), 0);
    assert.equal(count("select count(*) as c from dolt_log('origin/main..main')"), 0, 'the resolution was published');
  });
});

test('real dolt: a double close that ALSO changed the title is left standing', (t) => {
  if (!HAVE_DOLT) { t.skip('dolt not on PATH'); return; }
  withBdStub(() => {
    const { deps, logs, count } = buildDoubleClose(t, ", title = 'Fix it properly'");
    const r = syncPush(deps);
    assert.equal(r.ok, false);
    assert.ok(logs.some((l) => /"title"/.test(l)), logs.join('\n'));
    assert.ok(logs.some((l) => /dolt conflicts resolve --theirs issues/.test(l)), logs.join('\n'));
    assert.equal(count('select count(*) as c from dolt_conflicts_issues'), 1, 'nothing was resolved');
  });
});
