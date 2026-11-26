#!/usr/bin/env node
// SessionStart hook: tell this person which beads are waiting on THEM.
//
// Contract: plain text on STDOUT (that is what lands in the session's starting context),
// and ALWAYS exit 0. A SessionStart hook cannot block anything, and this one must never be
// the reason a session fails to start, so nearly every failure path here is silent. No bd,
// unknown person, corrupt DB, timeout, zero asks: print nothing. The one exception is an
// agent-tooling.json that exists but failed to load: with no routing table every ask would
// look absent, so that prints a single [asks] line naming the reason (still exit 0). A
// missing agent-tooling.json is not an error and stays silent.
//
// It runs exactly ONE bd call (about 0.7s). It deliberately does NOT `bd dolt pull`: that
// would add network latency to every session start and put a write-path operation behind a
// read-only banner. The banner can therefore be one sync stale, which is acceptable because
// a session start already runs a pull.
//
// People come from `people` in agent-tooling.json (see scripts/ask-lib.mjs). The interactive
// counterpart is /asks (.agents/skills/ask-review/SKILL.md).
//
// OTHER CHECKOUTS. When the per-machine file lists other checkouts (scripts/ask-repos.mjs), their
// asks for the same person follow, each tagged with its repo and checkout path. They come from a
// cache in the git common dir, never from a scan here: a cache that is missing or older than
// REFRESH_AFTER_MS starts a detached refresh and this session shows what the cache had (nothing,
// the first time). So session start still makes exactly ONE bd call. With no machine file, the
// output is exactly what it was before.
import { execFileSync, spawn } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveActorId } from '../agent-actor-id.mjs';
import { askLabel, defaultPeopleLoadError, formatBanner, parseAsks, resolvePerson } from '../ask-lib.mjs';
import { formatOtherRepos, gitCommonDir, needsRefresh, readCache, readMachineCheckouts, refreshCache, LOCK_NAME } from '../ask-repos.mjs';
import path from 'node:path';
import { statSync } from 'node:fs';

// Short: a slow bd must not stall session start. bd invocations serialize on the embedded
// Dolt lock, so a concurrent bd command elsewhere can make this wait.
const BD_TIMEOUT_MS = 15_000;

function readGitEmail() {
  try {
    return execFileSync('git', ['config', 'user.email'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function runBdList(label) {
  return execFileSync('bd', ['list', '--label', label, '--all', '--json', '-n', '0'], {
    encoding: 'utf8',
    timeout: BD_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

/**
 * The banner for this session, or '' when there is nothing to say. Throws on any failure;
 * the entry point below swallows it. The edges are injectable for tests.
 * @param {{ actor?: () => { base: string }, gitEmail?: () => string, bdList?: (label: string) => string, env?: object, people?: object[], now?: Date }} [deps]
 */
export function buildInboxBanner(deps = {}) {
  return inboxParts(deps).banner;
}

/** The person this session belongs to (or null) and this repository's banner. */
function inboxParts(deps) {
  const { actor = () => resolveActorId(), gitEmail = readGitEmail, bdList = runBdList, env = process.env, people, now } = deps;
  const person = resolvePerson({ env, actorBase: actor().base, gitEmail: gitEmail(), people });
  if (!person) return { person: null, banner: '' }; // Unrecognised contributor: say nothing.

  const raw = String(bdList(askLabel(person.key)) ?? '').trim();
  if (!raw) return { person, banner: '' };

  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.issues ?? []);
  return { person, banner: formatBanner(parseAsks(rows, person.key, now ? { now } : undefined), person) };
}

const HOOK_FILE = fileURLToPath(import.meta.url);

function startDetachedRefresh(commonDir, personKey) {
  const child = spawn(process.execPath, [HOOK_FILE, '--refresh-other-repos', commonDir, personKey], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.on('error', () => {});
  child.unref();
}

const mtimeOf = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

/**
 * The whole SessionStart banner: this repository's asks, then the other checkouts' asks from the
 * cache. Makes no bd call beyond inboxParts' one; a stale cache only starts a detached refresh.
 * The edges are injectable for tests.
 */
export function buildSessionBanner(deps = {}) {
  const {
    machine = readMachineCheckouts,
    commonDir = () => gitCommonDir(process.cwd()),
    cache = readCache,
    lockMtime = (dir) => mtimeOf(path.join(dir, LOCK_NAME)),
    start = startDetachedRefresh,
    nowMs = Date.now(),
  } = deps;
  const { person, banner } = inboxParts(deps);
  if (!person) return banner;
  const { checkouts, error } = machine();
  if (!error && !checkouts.length) return banner;
  const extra = [];
  if (error) {
    extra.push(`[asks] ${String(error).replace(/\s+/g, ' ').trim()}; asks in other checkouts are not shown.`);
  } else {
    const dir = commonDir();
    if (dir) {
      const cached = cache(dir);
      if (needsRefresh({ cacheMtime: cached?.mtime ?? null, lockMtime: lockMtime(dir), cachedPerson: cached?.person, personKey: person.key, now: nowMs })) {
        start(dir, person.key);
      }
      if (cached && cached.person === person.key) extra.push(...formatOtherRepos(cached.repos, person, { ageMs: nowMs - cached.mtime }));
    }
  }
  return [banner, ...extra].filter(Boolean).join('\n');
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** The single diagnostic line for an agent-tooling.json that failed to load. */
export function configErrorLine(reason) {
  return `[asks] cannot read agent-tooling.json, so pending asks cannot be routed: ${String(reason).replace(/\s+/g, ' ').trim()}`;
}

if (isMain() && process.argv[2] === '--refresh-other-repos') {
  // The detached half (see startDetachedRefresh): never prints, always exits 0.
  try {
    refreshCache({ commonDir: process.argv[3], personKey: process.argv[4] });
  } catch {
    // A failed refresh leaves its lock, which backs the next attempt off.
  }
  process.exit(0);
}

if (isMain()) {
  try {
    const loadError = defaultPeopleLoadError();
    if (loadError) {
      process.stdout.write(`${configErrorLine(loadError)}\n`);
    } else {
      const banner = buildSessionBanner();
      if (banner) process.stdout.write(`${banner}\n`);
    }
  } catch {
    // Fail open, always and silently. See the header.
  }
  process.exit(0);
}
