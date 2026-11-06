/**
 * scripts/session-lock.mjs: a worktree a live session is in is never removed out from under it.
 * Real git worktrees in a temp dir; a live pid is this test process's own.
 */
import { strict as assert } from 'node:assert';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-support/cleanup.mjs';
import {
  LOCK_DIR_NAME,
  MAX_AGE_MS,
  NO_PID_MAX_AGE_MS,
  REFRESH_MS,
  describe,
  findCheckout,
  isLive,
  liveSessionsIn,
  nativePath,
  pathKey,
  touch,
} from './session-lock.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'session-lock.mjs');

const ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};
for (const key of Object.keys(ENV)) {
  if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete ENV[key];
}

const roots = new Set();
after(() => {
  for (const r of roots) removeTempDir(r, 'session-lock.node-test');
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

/** A primary checkout with two linked worktrees, the second with a subdirectory. */
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slock-')));
  roots.add(root);
  const primary = path.join(root, 'primary');
  fs.mkdirSync(primary);
  git(primary, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(primary, 'a.txt'), 'a\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-q', '-m', 'base');
  const wtA = path.join(root, 'wt-a');
  const wtB = path.join(root, 'wt-b');
  git(primary, 'worktree', 'add', '-q', wtA, '-b', 'feat/a');
  git(primary, 'worktree', 'add', '-q', wtB, '-b', 'feat/b');
  fs.mkdirSync(path.join(wtB, 'deep'));
  return { root, primary, wtA, wtB, commonDir: path.join(primary, '.git') };
}

const alive = () => true;
const dead = () => false;

test('findCheckout reads the toplevel and the shared common dir from the filesystem', () => {
  const f = fixture();
  assert.deepEqual(findCheckout(f.primary), { toplevel: f.primary, commonDir: f.commonDir, linked: false });
  const a = findCheckout(f.wtA);
  assert.equal(pathKey(a.toplevel), pathKey(f.wtA));
  assert.equal(pathKey(a.commonDir), pathKey(f.commonDir), 'a linked worktree shares the primary .git');
  assert.equal(a.linked, true);
  assert.equal(pathKey(findCheckout(path.join(f.wtB, 'deep')).toplevel), pathKey(f.wtB), 'a subdirectory resolves to its worktree');
});

test('pathKey spells one directory one way: MSYS, native and trailing-slash forms agree on Windows', () => {
  assert.equal(pathKey('/c/git/Repo/', 'win32'), pathKey('C:\\git\\Repo', 'win32'));
  assert.equal(pathKey('C:/Git/repo', 'win32'), pathKey('c:\\git\\Repo', 'win32'));
  assert.notEqual(pathKey('/tmp/A', 'linux'), pathKey('/tmp/a', 'linux'), 'case matters off Windows');
});

test('a record is live only with a live pid inside the cap, or without a pid inside the shorter cap', () => {
  const now = 10 * MAX_AGE_MS;
  const rec = (over) => ({ sessionId: 's', worktree: '/w', touchedAt: now, pid: 1234, ...over });
  assert.equal(isLive(rec(), { now, isAlive: alive }), true);
  assert.equal(isLive(rec(), { now, isAlive: dead }), false, 'a dead pid never blocks');
  assert.equal(isLive(rec({ touchedAt: now - MAX_AGE_MS - 1 }), { now, isAlive: alive }), false, 'nor does a record past the cap');
  assert.equal(isLive(rec({ pid: null, touchedAt: now - NO_PID_MAX_AGE_MS + 1 }), { now, isAlive: dead }), true);
  assert.equal(isLive(rec({ pid: null, touchedAt: now - NO_PID_MAX_AGE_MS - 1 }), { now, isAlive: dead }), false);
  assert.equal(isLive({ sessionId: 's' }, { now, isAlive: alive }), false, 'a malformed record is not a lock');
});

test('touch records the session where it is, follows it when it moves, and SessionEnd drops it', () => {
  const f = fixture();
  const lock = path.join(f.commonDir, LOCK_DIR_NAME, 'sess-1.json');
  const t0 = 1_000_000;
  assert.equal(touch({ sessionId: 'sess-1', cwd: path.join(f.wtB, 'deep'), pid: process.pid, now: t0 }), 'wrote');
  assert.equal(pathKey(JSON.parse(fs.readFileSync(lock, 'utf8')).worktree), pathKey(f.wtB));
  assert.equal(touch({ sessionId: 'sess-1', cwd: f.wtB, pid: process.pid, now: t0 + REFRESH_MS - 1 }), 'fresh', 'no rewrite inside the refresh window');
  assert.equal(touch({ sessionId: 'sess-1', cwd: f.wtA, pid: process.pid, now: t0 + 1 }), 'wrote', 'a move rewrites at once');
  assert.equal(pathKey(JSON.parse(fs.readFileSync(lock, 'utf8')).worktree), pathKey(f.wtA), 'one record per session: B is no longer pinned');
  assert.equal(touch({ sessionId: 'sess-1', cwd: f.primary, pid: process.pid, now: t0 + 2 }), 'skipped', 'the primary needs no lock');
  assert.equal(fs.existsSync(lock), false, 'and moving there drops the previous record');
  touch({ sessionId: 'sess-1', cwd: f.wtA, pid: process.pid, now: t0 + 3 });
  assert.equal(touch({ sessionId: 'sess-1', cwd: f.wtA, event: 'SessionEnd' }), 'removed');
  assert.equal(fs.existsSync(lock), false);
});

test('liveSessionsIn names another live session, ignores the caller, and deletes a dead record', () => {
  const f = fixture();
  const now = Date.now();
  touch({ sessionId: 'other', cwd: f.wtA, pid: process.pid, now });
  touch({ sessionId: 'me', cwd: f.wtA, pid: process.pid, now });
  touch({ sessionId: 'gone', cwd: f.wtA, pid: process.pid, now });
  const isAlive = () => true;
  assert.deepEqual(liveSessionsIn(f.wtA, { selfId: 'me', now, isAlive }).map((r) => r.sessionId).sort(), ['gone', 'other']);
  assert.deepEqual(liveSessionsIn(f.wtB, { selfId: 'me', now, isAlive }), [], 'a sibling with nobody in it is free');
  const deadFile = path.join(f.commonDir, LOCK_DIR_NAME, 'gone.json');
  const rec = JSON.parse(fs.readFileSync(deadFile, 'utf8'));
  fs.writeFileSync(deadFile, JSON.stringify({ ...rec, touchedAt: now - MAX_AGE_MS - 1 }));
  assert.deepEqual(liveSessionsIn(f.wtA, { selfId: 'me', now, isAlive }).map((r) => r.sessionId), ['other']);
  assert.equal(fs.existsSync(deadFile), false, 'an expired record is cleaned up when read');
});

test('the CLI: touch reads the hook payload, check exits 3 for another session and 0 for the caller', () => {
  const f = fixture();
  const payload = JSON.stringify({ session_id: 'cli-sess', cwd: f.wtA, hook_event_name: 'PreToolUse' });
  const env = { ...ENV, CLAUDE_PID: String(process.pid), CLAUDE_CODE_SESSION_ID: 'someone-else' };
  const t = spawnSync(process.execPath, [SCRIPT, 'touch'], { input: payload, env, encoding: 'utf8' });
  assert.equal(t.status, 0, t.stderr);
  assert.equal(t.stdout + t.stderr, '', 'the hook is silent');

  const c = spawnSync(process.execPath, [SCRIPT, 'check', f.wtA], { env, encoding: 'utf8' });
  assert.equal(c.status, 3);
  assert.match(c.stderr, /session cli-sess \(pid \d+, last shell command just now\)/);

  const own = spawnSync(process.execPath, [SCRIPT, 'check', f.wtA], { env: { ...env, CLAUDE_CODE_SESSION_ID: 'cli-sess' }, encoding: 'utf8' });
  assert.equal(own.status, 0, 'a session may remove its own worktree (land.sh from the primary)');

  const filtered = spawnSync(process.execPath, [SCRIPT, 'filter-live'], { input: `${f.wtA}\n${f.wtB}\n`, env, encoding: 'utf8' });
  assert.equal(filtered.stdout, `${f.wtA}\n`);
});

test('an MSYS /c/... path (MSYS_NO_PATHCONV=1 passes one through) finds the same checkout', { skip: process.platform !== 'win32' && 'MSYS paths are a Windows spelling' }, () => {
  const f = fixture();
  const msys = `/${f.wtA[0].toLowerCase()}${f.wtA.slice(2).replace(/\\/g, '/')}`;
  assert.equal(nativePath(msys), `${msys[1]}:/${msys.slice(3)}`);
  const co = findCheckout(msys);
  assert.ok(co, 'the review on this PR: path.resolve read /c/x as C:\\c\\x and every lookup missed');
  assert.equal(pathKey(co.toplevel), pathKey(f.wtA));
  touch({ sessionId: 'peer', cwd: f.wtA, pid: process.pid });
  assert.deepEqual(liveSessionsIn(msys, { selfId: 'me' }).map((r) => r.sessionId), ['peer']);
});

test('a path that resolves to no checkout is a failed lookup, never "nobody is here": check exits 4', () => {
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slock-none-')));
  roots.add(outside);
  assert.throws(() => liveSessionsIn(outside, { selfId: 'me' }), /no git checkout/);
  const c = spawnSync(process.execPath, [SCRIPT, 'check', outside], { env: ENV, encoding: 'utf8' });
  assert.equal(c.status, 4);
  const filtered = spawnSync(process.execPath, [SCRIPT, 'filter-live'], { input: `${outside}\n${path.join(outside, 'gone')}\n`, env: ENV, encoding: 'utf8' });
  assert.equal(filtered.status, 4, 'a present path that could not be read is reported');
  assert.match(filtered.stderr, /no git checkout/);
  assert.doesNotMatch(filtered.stderr, /gone/, 'a registered worktree whose directory is gone has nobody in it');
});

test('subagents keep their own records: a lead and its workers in different worktrees are all pinned', () => {
  const f = fixture();
  const now = Date.now();
  touch({ sessionId: 'lead', cwd: f.wtA, pid: process.pid, now });
  touch({ sessionId: 'lead', agentId: 'worker-1', cwd: f.wtB, pid: process.pid, now });
  const isAlive = () => true;
  assert.deepEqual(liveSessionsIn(f.wtA, { selfId: 'peer', now, isAlive }).map((r) => r.sessionId), ['lead']);
  assert.deepEqual(liveSessionsIn(f.wtB, { selfId: 'peer', now, isAlive }).map((r) => r.agentId), ['worker-1'], 'the lead touching A did not unpin the worker in B');

  assert.equal(touch({ sessionId: 'lead', cwd: f.primary, pid: process.pid, now }), 'skipped');
  assert.deepEqual(liveSessionsIn(f.wtA, { selfId: 'peer', now, isAlive }), [], 'the lead moving to the primary drops only its own record');
  assert.equal(liveSessionsIn(f.wtB, { selfId: 'peer', now, isAlive }).length, 1, "and not the worker's");

  assert.equal(touch({ sessionId: 'lead', cwd: f.wtB, event: 'SubagentStop' }), 'skipped', 'a SubagentStop with no agent id never drops the main record');
  assert.equal(touch({ sessionId: 'lead', agentId: 'worker-1', cwd: f.wtB, event: 'SubagentStop' }), 'removed');
  assert.deepEqual(liveSessionsIn(f.wtB, { selfId: 'peer', now, isAlive }), [], 'a finished worker unpins its worktree');
  assert.match(describe({ sessionId: 'lead', agentId: 'worker-1', pid: 7, touchedAt: now }, now), /session lead, subagent worker-1 \(pid 7/);
});

test("SessionEnd drops every record the session holds, found through the project dir when its own cwd is gone", () => {
  const f = fixture();
  const now = Date.now();
  touch({ sessionId: 'lead', cwd: f.wtA, pid: process.pid, now });
  touch({ sessionId: 'lead', agentId: 'w', cwd: f.wtB, pid: process.pid, now });
  touch({ sessionId: 'other', cwd: f.wtB, pid: process.pid, now });
  const gone = path.join(f.root, 'deleted-cwd');
  assert.equal(touch({ sessionId: 'lead', cwd: gone, event: 'SessionEnd' }), 'skipped', 'control: an unresolvable cwd alone finds nothing');
  assert.equal(touch({ sessionId: 'lead', cwd: gone, fallbackCwd: f.primary, event: 'SessionEnd' }), 'removed');
  const left = fs.readdirSync(path.join(f.commonDir, LOCK_DIR_NAME)).filter((n) => n.endsWith('.json'));
  assert.deepEqual(left, ['other.json']);
});

test('a broken payload or a cwd outside any checkout never fails the hook', () => {
  for (const input of ['not json', JSON.stringify({ session_id: 'x', cwd: os.tmpdir() })]) {
    const r = spawnSync(process.execPath, [SCRIPT, 'touch'], { input, env: ENV, encoding: 'utf8' });
    assert.equal(r.status, 0);
  }
});
