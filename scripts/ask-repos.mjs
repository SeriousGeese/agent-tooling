// Cross-repo asks: the other checkouts on this machine whose asks a repository's inbox also shows.
//
// Asks are labels in ONE repository's tracker, so the [asks] banner in one repo never showed an ask
// raised in another, and a person working across several repos only saw the asks of the repo they
// happened to open. This reads every checkout listed in the per-machine file
//
//   ~/.seriousgeese/agent-tooling.json   (AGENT_TOOLING_MACHINE_CONFIG overrides the path)
//   { "checkouts": { "<repo name>": "<absolute checkout path>", ... } }
//
// (an array of paths, or of { "repo", "path" } objects, is accepted too; the repo name then
// defaults to the path's basename). It is per MACHINE, not per repository, so it never lives in a
// repository's agent-tooling.json, and unknown keys are ignored. A missing file means "no other
// checkouts": the banner and ask.mjs behave exactly as before.
//
// The current repository is skipped by its git COMMON dir, not by path, so a session inside a
// linked worktree does not list its own repo's asks twice. A checkout that is missing, or whose
// tracker cannot be read, is one line in the answer, never a failure.
//
// SessionStart never scans: the banner reads a cache in the git common dir and, when it is old,
// starts a detached refresh (a lock keeps a burst of session starts to one scan, and the cache is
// written to a temp file and renamed so a reader never sees half of it).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { askLabel, parseAsks } from './ask-lib.mjs';
import { bd, parseBdJsonRows } from './lib/bd-cli.mjs';

export const MACHINE_CONFIG_REL = path.join('.seriousgeese', 'agent-tooling.json');
export const CACHE_NAME = 'agent-tooling-asks-other-repos.json';
export const LOCK_NAME = 'agent-tooling-asks-other-repos.lock';
/** Asks change within a working day, so a cache older than this starts a refresh. */
export const REFRESH_AFTER_MS = 15 * 60 * 1000;
/** Longer than a scan can run, so a lock this old belonged to a process that died. */
export const LOCK_EXPIRES_MS = 10 * 60 * 1000;
/**
 * One bd call per checkout; bd serializes on its database lock, so a slow one is contention. Shorter
 * than lib/bd-cli.mjs's default because a scan reads several trackers in a row.
 */
export const BD_TIMEOUT_MS = 30_000;

/** The per-machine file: AGENT_TOOLING_MACHINE_CONFIG, else ~/.seriousgeese/agent-tooling.json. */
export function machineConfigPath(env = process.env, home = os.homedir()) {
  return env.AGENT_TOOLING_MACHINE_CONFIG || path.join(home, MACHINE_CONFIG_REL);
}

/**
 * The configured checkouts, `{ checkouts: [{ repo, path }], error }`. Pure over `text`.
 * `error` is set only for a file that exists and cannot be used; then `checkouts` is empty.
 */
export function parseMachineConfig(text, source = MACHINE_CONFIG_REL) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return { checkouts: [], error: `${source} is not valid JSON (${err.message})` };
  }
  const listed = raw && typeof raw === 'object' ? raw.checkouts : undefined;
  if (listed === undefined) return { checkouts: [], error: null };
  const entries = Array.isArray(listed)
    ? listed.map((e) => (typeof e === 'string' ? { path: e } : e))
    : listed && typeof listed === 'object'
      ? Object.entries(listed).map(([repo, p]) => ({ repo, path: p }))
      : null;
  if (!entries) return { checkouts: [], error: `${source}: "checkouts" must be an object of repo name to path, or an array` };
  const checkouts = [];
  for (const e of entries) {
    const p = typeof e?.path === 'string' ? e.path.trim() : '';
    if (!p) continue;
    const repo = String(e.repo ?? '').trim() || path.basename(p.replace(/[\\/]+$/, ''));
    if (!checkouts.some((c) => c.path === p)) checkouts.push({ repo, path: p });
  }
  return { checkouts, error: null };
}

/** Reads the machine file. A missing file is no checkouts and no error. */
export function readMachineCheckouts({ env = process.env, home = os.homedir(), readFile = fs.readFileSync } = {}) {
  const file = machineConfigPath(env, home);
  let text;
  try {
    text = readFile(file, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return { checkouts: [], error: null, file };
    return { checkouts: [], error: `cannot read ${file}: ${err?.message ?? err}`, file };
  }
  return { ...parseMachineConfig(text, file), file };
}

/** `git rev-parse --git-common-dir` of `cwd`, absolute and normalised, or null. */
export function gitCommonDir(cwd) {
  try {
    const out = execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    }).trim();
    return out ? normalise(out) : null;
  } catch {
    return null;
  }
}

/** One spelling for comparing paths: forward slashes, no trailing slash, case-folded on Windows. */
export function normalise(p, platform = process.platform) {
  const s = path.resolve(String(p)).replace(/\\/g, '/').replace(/\/+$/, '');
  return platform === 'win32' ? s.toLowerCase() : s;
}

/**
 * `bd -C <checkout> list --label ask-<person> --all --json -n 0`, as text, through the one shared
 * bd caller (lib/bd-cli.mjs: maxBuffer, windowsHide) with this file's timeout. `exec` is for tests.
 */
export function bdListIn(checkout, label, { exec } = {}) {
  return bd(['-C', checkout, 'list', '--label', label, '--all', '--json', '-n', '0'], { timeout: BD_TIMEOUT_MS, exec });
}

/**
 * Every OTHER configured checkout's asks for `personKey`: `[{ repo, path, asks, error }]`, in the
 * file's order. `error` is one line (a missing checkout, an unreadable tracker) and never throws.
 * The edges are injectable for tests.
 */
export function readOtherRepos({
  personKey,
  checkouts,
  selfCommonDir,
  exists = fs.existsSync,
  commonDirOf = gitCommonDir,
  bdList = bdListIn,
  now = new Date(),
}) {
  const out = [];
  const seen = new Set(selfCommonDir ? [selfCommonDir] : []);
  for (const { repo, path: checkout } of checkouts ?? []) {
    if (!exists(checkout)) {
      out.push({ repo, path: checkout, asks: [], error: `checkout ${checkout} not found` });
      continue;
    }
    const common = commonDirOf(checkout);
    if (!common) {
      out.push({ repo, path: checkout, asks: [], error: `${checkout} is not a git checkout` });
      continue;
    }
    if (seen.has(common)) continue; // this repository (or a second path to one already read)
    seen.add(common);
    try {
      const rows = parseBdJsonRows(bdList(checkout, askLabel(personKey)));
      const asks = parseAsks(rows, personKey, { now }).map((a) => ({ ...a, repo, path: checkout }));
      out.push({ repo, path: checkout, asks, error: null });
    } catch (err) {
      // bd's own words first; else the spawn's error (a timeout, no bd on PATH), which lib/bd-cli.mjs
      // keeps as `cause` behind a message that starts with the command line.
      const why = String(err?.stderr || err?.cause?.message || err?.message || err).trim().split(/\r?\n/)[0].slice(0, 160);
      out.push({ repo, path: checkout, asks: [], error: `its tracker could not be read (${why})` });
    }
  }
  return out;
}

const plural = (n, one, many) => (n === 1 ? one : many);

/** Compact age of the cache for the banner. */
export function cacheAge(ms) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

/**
 * The banner lines for the other checkouts, or [] when there is nothing to say. Each ask names its
 * repo and checkout, because acting on it (`ask.mjs clear`, `bd`) works only from there.
 */
export function formatOtherRepos(repos, person, { max = 5, ageMs = null } = {}) {
  const list = Array.isArray(repos) ? repos : [];
  const asks = list.flatMap((r) => r.asks ?? []);
  const errors = list.filter((r) => r.error);
  if (!asks.length && !errors.length) return [];
  const out = [];
  if (asks.length) {
    out.push(`[asks] ${asks.length} ${plural(asks.length, 'bead is', 'beads are')} waiting on YOU (${person.key}) in other checkouts:`);
    const width = Math.max(...asks.slice(0, max).map((a) => a.id.length));
    for (const a of asks.slice(0, max)) {
      const who = a.by ? `asked by ${a.by}` : 'asked';
      const when = a.age ? `, ${a.age}` : '';
      out.push(`[asks]   ${a.id.padEnd(width)}  ${String(a.title).slice(0, 52)}  [${a.repo}: ${a.path}]  (${who}${when})`);
    }
    if (asks.length > max) out.push(`[asks]   …and ${asks.length - max} more.`);
  }
  for (const r of errors) out.push(`[asks] ${r.repo}: ${r.error}; skipped.`);
  if (ageMs !== null) out.push(`[asks] (other checkouts read ${cacheAge(ageMs)}; run /asks from that checkout to act on one)`);
  return out;
}

// ── the cache (SessionStart reads it; a detached refresh writes it) ──────────────────────────

const mtimeOf = (file) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/** Whether to start a refresh: no cache yet (or one for someone else), an old one, and no live lock. */
export function needsRefresh({ cacheMtime, lockMtime, cachedPerson, personKey, now = Date.now() }) {
  if (lockMtime !== null && now - lockMtime < LOCK_EXPIRES_MS) return false;
  return cacheMtime === null || cachedPerson !== personKey || now - cacheMtime >= REFRESH_AFTER_MS;
}

/** The cached answer, `{ person, repos, mtime }`, or null. */
export function readCache(commonDir) {
  const file = path.join(commonDir, CACHE_NAME);
  const mtime = mtimeOf(file);
  if (mtime === null) return null;
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { person: String(j.person ?? ''), repos: Array.isArray(j.repos) ? j.repos : [], mtime };
  } catch {
    return null;
  }
}

function takeLock(lockFile, now = Date.now()) {
  const mtime = mtimeOf(lockFile);
  if (mtime !== null) {
    if (now - mtime < LOCK_EXPIRES_MS) return false;
    fs.rmSync(lockFile, { force: true });
  }
  try {
    fs.closeSync(fs.openSync(lockFile, 'wx'));
    return true;
  } catch {
    return false;
  }
}

/**
 * The detached half: read every other checkout and publish the answer. Returns false when another
 * refresh holds the lock. A crash leaves the lock, which is the back-off for a scan that keeps failing.
 */
export function refreshCache({ commonDir, personKey, read = readOtherRepos, machine = readMachineCheckouts }) {
  const lockFile = path.join(commonDir, LOCK_NAME);
  if (!takeLock(lockFile)) return false;
  const { checkouts } = machine();
  const repos = read({ personKey, checkouts, selfCommonDir: normalise(commonDir) });
  const file = path.join(commonDir, CACHE_NAME);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ person: personKey, at: new Date().toISOString(), repos }));
  fs.renameSync(temp, file);
  fs.rmSync(lockFile, { force: true });
  return true;
}
