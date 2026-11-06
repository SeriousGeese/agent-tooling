#!/usr/bin/env node
// Fetch a branch from origin and PROVE the remote-tracking ref is current.
//
//   node scripts/fetch-main.mjs [branch]      # default: main
//
// Two failures made a plain `git fetch origin main` untrustworthy on this host:
//
//   * It reads like success when it did nothing. The Bash tool rewrites `git fetch` through rtk,
//     whose filtered output drops git's ref-update lines AND its error text, so a fetch that
//     updated nothing, or failed, returned quietly. A migration-number check then read a stale
//     journal, and a merge-main step missed new commits (one wave of parallel sessions, 2026-10-22/23).
//   * Every worktree shares ONE .git, so concurrent fetches from sibling sessions contend for the
//     same ref lock: `cannot lock ref 'refs/remotes/origin/main'` (three workers in one wave,
//     2026-10-24). A retry a moment later succeeds.
//
// So this runs git directly (no rtk in a child process), prints git's own output, retries a
// ref-lock failure with backoff, and then checks `origin/<branch>` against `git ls-remote`, the
// remote's own answer. A mismatch (the branch moved between the fetch and the check) refetches
// once. Exit 0 prints the verified sha; anything else exits 1 and says why.
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const FETCH_ATTEMPTS = 4;
const DEFAULT_BACKOFF_MS = [1000, 3000, 6000];

/**
 * A branch name this script will hand to git: never option-like (a leading `-` would reach
 * `git fetch`'s option parsing, `--upload-pack=...` included), and within git's own ref rules
 * (`git check-ref-format --branch`), on a conservative character set. Pure.
 */
export function isSafeBranch(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)) return false;
  if (name.length > 200 || name.includes('..') || name.includes('//') || name.includes('/.') || name.includes('.lock/')) return false;
  return !/[./]$/.test(name) && !name.endsWith('.lock');
}

/** True for git's "another process holds this ref" family of failures. */
export function isRefLockError(text) {
  return /cannot lock ref|Unable to create '[^']*\.lock'|unable to update local ref/i.test(text);
}

function defaultGit(args) {
  const r = spawnSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error) : '') };
}

function defaultSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function backoffFrom(env) {
  const one = Number(env.AGENT_TOOLING_FETCH_MAIN_RETRY_MS);
  return Number.isFinite(one) && one >= 0 ? [one, one, one] : DEFAULT_BACKOFF_MS;
}

/**
 * Fetch `branch` and verify it. Returns `{ ok: true, sha }` or `{ ok: false, reason }`.
 * `git`, `sleep` and `log` are injectable for the tests.
 */
export function fetchMain(branch = 'main', { git = defaultGit, sleep = defaultSleep, log = (l) => process.stderr.write(`${l}\n`), env = process.env } = {}) {
  // Before ANY git call: every one below interpolates the branch.
  if (!isSafeBranch(branch)) return { ok: false, reason: `${JSON.stringify(branch)} is not a branch name this script will pass to git` };
  const backoff = backoffFrom(env);
  const fetchOnce = () => {
    for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
      // `--` ends option parsing as a second guard: nothing after it is read as a fetch option.
      const r = git(['fetch', '--', 'origin', branch]);
      const out = `${r.stdout}${r.stderr}`.trim();
      if (out) log(out);
      if (r.status === 0) return null;
      if (!isRefLockError(out) || attempt === FETCH_ATTEMPTS) {
        return `git fetch origin ${branch} failed (exit ${r.status}${isRefLockError(out) ? `, still locked after ${attempt} attempts` : ''})`;
      }
      const wait = backoff[Math.min(attempt - 1, backoff.length - 1)];
      log(`[fetch-main] a concurrent fetch holds the ref lock; retrying in ${wait}ms (attempt ${attempt + 1}/${FETCH_ATTEMPTS})`);
      sleep(wait);
    }
    return 'unreachable';
  };
  const remoteSha = () => {
    const r = git(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
    const sha = r.status === 0 ? r.stdout.trim().split(/\s+/)[0] : '';
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };
  const localSha = () => {
    const r = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]);
    const sha = r.stdout.trim();
    return r.status === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  };

  for (let round = 1; round <= 2; round++) {
    const failure = fetchOnce();
    if (failure) return { ok: false, reason: failure };
    const remote = remoteSha();
    if (!remote) return { ok: false, reason: `git ls-remote origin refs/heads/${branch} returned no sha: cannot verify the fetch` };
    const local = localSha();
    if (local === remote) return { ok: true, sha: local };
    if (round === 1) log(`[fetch-main] origin/${branch} is ${local ?? '(missing)'} but the remote is at ${remote}; fetching again (it may have just moved)`);
    else return { ok: false, reason: `origin/${branch} is ${local ?? '(missing)'} after two fetches, but the remote is at ${remote}` };
  }
  return { ok: false, reason: 'unreachable' };
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  const branch = process.argv[2] ?? 'main';
  const result = fetchMain(branch);
  if (result.ok) {
    process.stdout.write(`[fetch-main] origin/${branch} = ${result.sha} (verified against git ls-remote)\n`);
  } else {
    process.stderr.write(`[fetch-main] ${result.reason}\n`);
    process.exitCode = 1;
  }
}
