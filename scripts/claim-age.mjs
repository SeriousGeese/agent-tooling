#!/usr/bin/env node
// The 4h claim-age check, run by scripts/claim.sh before it claims.
//
// Why: two orchestrations collided on one bead on 2026-08-22. Session B saw no PR and no
// branch, concluded the bead was free and re-claimed it 17 minutes into session A's work. A
// claim legitimately precedes its branch and PR by many minutes, and `bd show` prints
// `Started:` as a date only, so an agent cannot tell a claim made minutes ago from one made
// days ago. This reads the full `started_at` and refuses a steal while the claim is fresh.
//
// This used to live in a 1,456-line PreToolUse hook that tried to find every claim hidden
// in a loop, a script or a substitution, and produced a steady stream of false refusals.
// It now lives where the claim is made, so it covers every vendor and a human shell, not
// only Claude Code. A hook that blocks a bare claim can route agents here.
//
// Usage (claim.sh pipes `bd show <id> --json` in):
//   bd show <id> --json | node scripts/claim-age.mjs <id> --actor <me>
// Exit 0: the claim may proceed. Exit 3: refused, with the reason on stderr.
// Window: AGENT_TOOLING_CLAIM_COLLISION_HOURS (default 4). Hatch: AGENT_TOOLING_ALLOW_CLAIM_STEAL=1,
// for a deliberate takeover of abandoned work, with a bd note saying why.
// Anything unexpected (no input, malformed JSON, no usable timestamp) fails OPEN: an
// unreadable lookup is not evidence of a live claim.
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { isOldFormatOfSameSession, resolveActorId, slugifyActorBase } from './agent-actor-id.mjs';
import { tryLoadConfig } from './agent-tooling-config.mjs';

export const DEFAULT_WINDOW_HOURS = 4;
export const BLOCKED_EXIT = 3;

/**
 * The whole decision, pure. `blocked` is true only for an ACTIVE claim held by someone else
 * that is still inside the window. Every uncertain case returns blocked:false.
 * @returns {{ blocked: boolean, holder?: string, ageHours?: number }}
 */
export function decide({ issue, me, meBase = '', windowHours = DEFAULT_WINDOW_HOURS, now = Date.now() }) {
  const open = { blocked: false };
  if (!issue || typeof issue !== 'object') return open;

  const holder = String(issue.assignee ?? '').trim();
  if (!holder) return open; // unclaimed
  if (sameActor(holder, String(me ?? '').trim())) return open; // yours: --claim is idempotent
  // The same session's claim in the older id format (`<base>-bot-<session8>`).
  if (isOldFormatOfSameSession(holder, String(me ?? ''))) return open;
  // A claim written before per-session ids existed carries the bare team name, which can
  // never match a suffixed id even when it is ours. Let a bare base-name match through.
  if (meBase && slugifyActorBase(holder) === slugifyActorBase(meBase)) return open;
  if (String(issue.status ?? '') !== 'in_progress') return open; // not an active claim

  const startedAt = Date.parse(issue.started_at ?? issue.startedAt ?? '');
  if (!Number.isFinite(startedAt)) return open;

  const ageHours = (now - startedAt) / 3_600_000;
  if (ageHours < 0) return open; // clock skew: never block on it
  if (ageHours >= windowHours) return open; // stale enough to be reclaimable
  return { blocked: true, holder, ageHours };
}

export function formatAge(hours) {
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return 'less than a minute';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} hour${h === 1 ? '' : 's'}` : `${h}h ${m}m`;
}

export function positiveNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The first issue object in `bd show --json` output, or null. */
export function parseIssue(text) {
  try {
    const j = JSON.parse(text);
    const o = Array.isArray(j) ? j[0] : j?.issues ? j.issues[0] : j;
    return o && typeof o === 'object' ? o : null;
  } catch {
    return null;
  }
}

export function blockMessage(id, { holder, ageHours }, windowHours, claimHelper = 'scripts/claim.sh') {
  return (
    `ERROR: refusing to claim ${id}: it is held by "${holder}", claimed ${formatAge(ageHours)} ago ` +
    '(in_progress). Another session is very likely working it right now. A claim precedes its ' +
    'branch and PR by many minutes, so an empty `gh pr list` does not mean the bead is free ' +
    '(the 2026-08-22 collision). Pick a different bead. With positive evidence ' +
    `the claim is abandoned, take it over with AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 bash ${claimHelper} ` +
    `${id} ... and say why in a bd note. Claims older than ${windowHours}h are not refused ` +
    '(AGENT_TOOLING_CLAIM_COLLISION_HOURS). Nothing was claimed.\n'
  );
}

function sameActor(a, b) {
  if (!a || !b) return false;
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
}

function derivedBase(env) {
  try {
    return resolveActorId({ env: { ...env, BEADS_ACTOR: '' } }).base;
  } catch {
    return '';
  }
}

function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i === -1 ? '' : (argv[i + 1] ?? '');
}

/** The claim helper's path for the hint: the consumer's `claimHelper`, else the neutral default. */
function configuredClaimHelper() {
  return tryLoadConfig().config.claimHelper;
}

export function main(
  argv = process.argv.slice(2),
  env = process.env,
  stdin = () => readFileSync(0, 'utf8'),
  claimHelper = configuredClaimHelper(),
) {
  if (env.AGENT_TOOLING_ALLOW_CLAIM_STEAL === '1') return { code: 0 };
  const id = argv[0] && !argv[0].startsWith('-') ? argv[0] : '';
  let text = '';
  try {
    text = stdin();
  } catch {
    return { code: 0 };
  }
  const windowHours = positiveNumber(env.AGENT_TOOLING_CLAIM_COLLISION_HOURS) ?? DEFAULT_WINDOW_HOURS;
  const verdict = decide({
    issue: parseIssue(text),
    me: argValue(argv, '--actor'),
    // The session's bare base name (git user.name slug), for the pre-per-session tolerance.
    // claim.sh has already exported BEADS_ACTOR, which would make the base the full id.
    meBase: argValue(argv, '--base') || derivedBase(env),
    windowHours,
  });
  if (!verdict.blocked) return { code: 0 };
  return { code: BLOCKED_EXIT, message: blockMessage(id || '(this bead)', verdict, windowHours, claimHelper) };
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const { code, message } = main();
  if (message) process.stderr.write(message);
  process.exitCode = code;
}
