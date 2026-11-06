#!/usr/bin/env node
// SessionStart hook: tell this person which beads are waiting on THEM.
//
// Contract: plain text on STDOUT (that is what lands in the session's starting context),
// and ALWAYS exit 0. A SessionStart hook cannot block anything, and this one must never be
// the reason a session fails to start, so every failure path here is silent. No bd, unknown
// person, corrupt DB, timeout, zero asks: print nothing.
//
// It runs exactly ONE bd call (about 0.7s). It deliberately does NOT `bd dolt pull`: that
// would add network latency to every session start and put a write-path operation behind a
// read-only banner. The banner can therefore be one sync stale, which is acceptable because
// a session start already runs a pull.
//
// People come from `people` in agent-tooling.json (see scripts/ask-lib.mjs). The interactive
// counterpart is /asks (.agents/skills/ask-review/SKILL.md).
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { resolveActorId } from '../agent-actor-id.mjs';
import { askLabel, formatBanner, parseAsks, resolvePerson } from '../ask-lib.mjs';

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
  const { actor = () => resolveActorId(), gitEmail = readGitEmail, bdList = runBdList, env = process.env, people, now } = deps;
  const person = resolvePerson({ env, actorBase: actor().base, gitEmail: gitEmail(), people });
  if (!person) return ''; // Unrecognised contributor: say nothing.

  const raw = String(bdList(askLabel(person.key)) ?? '').trim();
  if (!raw) return '';

  const parsed = JSON.parse(raw);
  const rows = Array.isArray(parsed) ? parsed : (parsed?.issues ?? []);
  return formatBanner(parseAsks(rows, person.key, now ? { now } : undefined), person);
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  try {
    const banner = buildInboxBanner();
    if (banner) process.stdout.write(`${banner}\n`);
  } catch {
    // Fail open, always and silently. See the header.
  }
  process.exit(0);
}
