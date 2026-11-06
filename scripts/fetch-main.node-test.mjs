/**
 * scripts/fetch-main.mjs: a fetch of main that cannot read as success when it did nothing.
 * Unit cases drive a fake git; the end-to-end cases run real git against a temp bare
 * origin, including a ref lock another "session" holds for a moment.
 */

import { strict as assert } from 'node:assert';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FETCH_ATTEMPTS, fetchMain, isRefLockError, isSafeBranch } from './fetch-main.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fetch-main.mjs');
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const LOCK_ERR = "error: cannot lock ref 'refs/remotes/origin/main': Unable to create '/x/.git/refs/remotes/origin/main.lock': File exists.";

/** A scripted git: `fetch` answers come from `fetches` in order; ls-remote and rev-parse from functions. */
function fakeGit({ fetches, remote = () => SHA_A, local = () => SHA_A }) {
  const calls = [];
  const git = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'fetch') return fetches.shift() ?? { status: 0, stdout: '', stderr: '' };
    if (args[0] === 'ls-remote') return { status: 0, stdout: `${remote()}\trefs/heads/main\n`, stderr: '' };
    if (args[0] === 'rev-parse') return { status: 0, stdout: `${local()}\n`, stderr: '' };
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { git, calls };
}
const quiet = { sleep: () => {}, log: () => {}, env: {} };

test('a branch name is accepted only when it cannot be read as an option or break git\'s ref rules', () => {
  for (const ok of ['main', 'feat/x-bd-1.2', 'release/v0.0.1', 'fix/a_b']) assert.equal(isSafeBranch(ok), true, ok);
  for (const bad of ['--upload-pack=touch pwned', '-x', '', 'a..b', 'a//b', 'a/', 'a.', 'a.lock', 'a/.b', 'a b', 'a;rm -rf', '$(id)', 'a@{1}', 'a~1', 'a^', 'a:b', null, 42]) {
    assert.equal(isSafeBranch(bad), false, String(bad));
  }
});

test('an option-like branch never reaches git at all', () => {
  const { git, calls } = fakeGit({ fetches: [] });
  const r = fetchMain('--upload-pack=touch pwned', { git, ...quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /is not a branch name this script will pass to git/);
  assert.deepEqual(calls, []);
});

test('the fetch ends option parsing before the remote and the branch', () => {
  const { git, calls } = fakeGit({ fetches: [{ status: 0, stdout: '', stderr: '' }] });
  fetchMain('main', { git, ...quiet });
  assert.equal(calls[0], 'fetch -- origin main');
});

test('recognises the ref-lock family and nothing else', () => {
  assert.equal(isRefLockError(LOCK_ERR), true);
  assert.equal(isRefLockError('error: unable to update local ref refs/remotes/origin/main'), true);
  assert.equal(isRefLockError('fatal: could not read from remote repository'), false);
});

test('a clean fetch whose ref matches the remote is verified', () => {
  const { git } = fakeGit({ fetches: [{ status: 0, stdout: '', stderr: '' }] });
  assert.deepEqual(fetchMain('main', { git, ...quiet }), { ok: true, sha: SHA_A });
});

test('a ref-lock failure is retried, and the retry that wins is verified', () => {
  const { git, calls } = fakeGit({ fetches: [{ status: 1, stdout: '', stderr: LOCK_ERR }, { status: 0, stdout: '', stderr: '' }] });
  const lines = [];
  assert.deepEqual(fetchMain('main', { git, ...quiet, log: (l) => lines.push(l) }), { ok: true, sha: SHA_A });
  assert.equal(calls.filter((c) => c.startsWith('fetch')).length, 2);
  assert.match(lines.join('\n'), /concurrent fetch holds the ref lock; retrying/);
});

test('a lock that never clears fails after the bounded attempts, loudly', () => {
  const fetches = Array.from({ length: FETCH_ATTEMPTS + 2 }, () => ({ status: 1, stdout: '', stderr: LOCK_ERR }));
  const { git, calls } = fakeGit({ fetches });
  const r = fetchMain('main', { git, ...quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`still locked after ${FETCH_ATTEMPTS} attempts`));
  assert.equal(calls.filter((c) => c.startsWith('fetch')).length, FETCH_ATTEMPTS);
});

test('a failure that is not a lock is not retried', () => {
  const { git, calls } = fakeGit({ fetches: [{ status: 128, stdout: '', stderr: 'fatal: could not read from remote repository' }] });
  const r = fetchMain('main', { git, ...quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /failed \(exit 128\)/);
  assert.equal(calls.filter((c) => c.startsWith('fetch')).length, 1);
});

test('a "successful" fetch that left the ref stale is NOT reported as success (the rtk symptom)', () => {
  // Every fetch exits 0, the remote is at B, and origin/main stays at A: a no-op fetch.
  const { git, calls } = fakeGit({ fetches: [], remote: () => SHA_B, local: () => SHA_A });
  const r = fetchMain('main', { git, ...quiet });
  assert.equal(r.ok, false);
  assert.match(r.reason, /after two fetches, but the remote is at b{40}/);
  assert.equal(calls.filter((c) => c.startsWith('fetch')).length, 2);
});

test('a branch that moved between the fetch and the check is fetched once more and verified', () => {
  // The first fetch lands A while the remote has already moved to B; the second lands B.
  let fetched = 0;
  const { git, calls } = fakeGit({ fetches: [], remote: () => SHA_B, local: () => (fetched >= 2 ? SHA_B : SHA_A) });
  const counting = (args) => {
    if (args[0] === 'fetch') fetched += 1;
    return git(args);
  };
  assert.deepEqual(fetchMain('main', { git: counting, ...quiet }), { ok: true, sha: SHA_B });
  assert.equal(calls.filter((c) => c.startsWith('fetch')).length, 2);
});

// ── Real git ───────────────────────────────────────────────────────────────

function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function repos() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-main-'));
  const origin = path.join(root, 'origin.git');
  const author = path.join(root, 'author');
  const clone = path.join(root, 'clone');
  sh(root, 'init', '-q', '--bare', '-b', 'main', origin);
  sh(root, 'clone', '-q', origin, author);
  for (const [k, v] of [['user.email', 't@example.com'], ['user.name', 'T']]) sh(author, 'config', k, v);
  fs.writeFileSync(path.join(author, 'f.txt'), '1\n');
  sh(author, 'add', '-A');
  sh(author, 'commit', '-qm', 'one');
  sh(author, 'push', '-q', 'origin', 'main');
  sh(root, 'clone', '-q', origin, clone);
  const advance = () => {
    fs.appendFileSync(path.join(author, 'f.txt'), 'more\n');
    sh(author, 'commit', '-qam', 'next');
    sh(author, 'push', '-q', 'origin', 'main');
    return sh(author, 'rev-parse', 'HEAD');
  };
  return { clone, advance, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('end to end: origin/main ends at the remote tip and the sha is printed', () => {
  const r = repos();
  try {
    const tip = r.advance();
    const out = spawnSync(process.execPath, [SCRIPT], { cwd: r.clone, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`origin/main = ${tip} \\(verified against git ls-remote\\)`));
    assert.equal(sh(r.clone, 'rev-parse', 'origin/main'), tip);
  } finally { r.done(); }
});

test('end to end: an option-like argument exits 1 and runs nothing it names', () => {
  const r = repos();
  try {
    const before = sh(r.clone, 'rev-parse', 'origin/main');
    r.advance();
    const marker = path.join(r.clone, 'pwned');
    const out = spawnSync(process.execPath, [SCRIPT, `--upload-pack=node -e "require('node:fs').writeFileSync('${marker.split(path.sep).join('/')}','x')"`], { cwd: r.clone, encoding: 'utf8' });
    assert.equal(out.status, 1, out.stdout);
    assert.match(out.stderr, /is not a branch name/);
    assert.equal(fs.existsSync(marker), false, 'the upload-pack command ran');
    assert.equal(sh(r.clone, 'rev-parse', 'origin/main'), before, 'nothing was fetched');
  } finally { r.done(); }
});

test('end to end: a ref lock held by a concurrent fetch is waited out, not reported as a stale success', async () => {
  const r = repos();
  try {
    const tip = r.advance();
    const lock = path.join(r.clone, '.git', 'refs', 'remotes', 'origin', 'main.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    const child = spawn(process.execPath, [SCRIPT], { cwd: r.clone, env: { ...process.env, AGENT_TOOLING_FETCH_MAIN_RETRY_MS: '400' } });
    let stderr = '';
    // Release the lock only once the child has HIT it and said it will retry, never on a timer: a
    // loaded host can take longer than any fixed delay to start the child (the first version of
    // this test released at 600 ms and lost that race under a full test:scripts run). The
    // fallback timer only keeps a broken script from hanging the suite.
    const release = () => fs.rmSync(lock, { force: true });
    const fallback = setTimeout(release, 30_000);
    child.stderr.on('data', (d) => {
      stderr += d;
      if (/retrying/.test(stderr)) release();
    });
    const code = await new Promise((resolve) => child.on('exit', resolve));
    clearTimeout(fallback);
    assert.equal(code, 0, stderr);
    assert.match(stderr, /retrying/);
    assert.equal(sh(r.clone, 'rev-parse', 'origin/main'), tip);
  } finally { r.done(); }
});
