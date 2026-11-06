#!/usr/bin/env node
// "Asks" CLI: route a bead to a person for an async decision.
//
//   node scripts/ask.mjs <bead-id> <person> ["why you need them"]
//   node scripts/ask.mjs <bead-id> <person>            # no reason, just pick it up
//   node scripts/ask.mjs list [--for <person>] [--json]
//   node scripts/ask.mjs clear <bead-id> <person> ["how it was resolved"]
//
// People are the `people` handles in agent-tooling.json. The contract (label + metadata +
// note) and the measured bd facts behind it are documented in scripts/ask-lib.mjs. This
// file owns only the bd-touching side: argument parsing, the reads, the writes, and the
// clobber-safe Dolt sequence.
//
// Every write goes pull -> mutate -> PUSH -> (verify): push while your commit is the only
// edit in flight, so a genuine collision surfaces as a conflict instead of being silently
// superseded by a concurrent whole-column write.
//
// Sync goes through scripts/bd-dolt-sync.mjs when the consumer has it (the beads set), never
// a bare `bd dolt` when it can be avoided. Bare `bd dolt pull` can EXIT 0 having merged
// nothing on a diverged branch ("Pull complete", still diverged), after which every push is
// rejected indefinitely. The helper asks the dolt CLI for ground truth, retries a rejected
// push with backoff, and commits pending working-set writes first. It is run as a child
// process, not imported, so this file stays inside the asks set. Without the helper the
// fallback is `bd dolt pull` / `bd dolt push` with the exit status still checked.
//
// THE LOCAL WRITE IS STILL BEST-EFFORT-SAFE: a remote hiccup never loses the ask, because bd
// has already committed it locally by the time we sync. What is NOT best-effort is STAYING
// QUIET ABOUT IT. A swallowed push failure is how an answered ask never reaches the other
// person while both sides believe the other is the blocker. So a failed push prints loudly
// and sets a non-zero exit: the write survives, and you know to retry.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveActorId } from './agent-actor-id.mjs';
import {
  NO_REASON,
  askLabel,
  askMetaKeys,
  formatDetail,
  parseAsks,
  personByKey,
  personKeys,
  resolvePerson,
} from './ask-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SYNC_HELPER = path.join(HERE, 'bd-dolt-sync.mjs');

/** bd invocations serialize on the embedded Dolt lock, so a slow call is normal contention. */
const BD_TIMEOUT_MS = 120_000;
/** Node's 1 MB default overflows as a bare `spawnSync bd ENOBUFS` on a big tracker. */
const BD_MAX_BUFFER = 64 * 1024 * 1024;
/**
 * Caps only the bare `bd dolt` fallback. The beads set's sync helper bounds its own attempts,
 * and killing it mid-push would leave its `bd dolt push` holding the Dolt lock while this
 * reports a failure for a push that may still land.
 */
const BARE_SYNC_TIMEOUT_MS = 300_000;

function usage(people) {
  const known = personKeys(people).join(', ') || '(none configured: add handles to "people" in agent-tooling.json)';
  return `
Asks: route a bead to a person for an async decision.

  node scripts/ask.mjs <bead-id> <person> ["why you need them"]
  node scripts/ask.mjs <bead-id> <person>          just pick it up, no reason needed
  node scripts/ask.mjs list [--for <person>] [--json]
  node scripts/ask.mjs clear <bead-id> <person> ["how it was resolved"]

People: ${known}

Flags
  --replace    overwrite an ask that person already has on this bead
  --for <p>    list someone else's inbox (read-only; does not impersonate them)
  --json       machine-readable list output
  -h, --help   this text

The reason is OPTIONAL. Sometimes you just want the bead picked up.

Examples
  node scripts/ask.mjs <bead-id> <person> "Two ways to fix this; they trade off on touch."
  node scripts/ask.mjs <bead-id> <person>
  node scripts/ask.mjs list
  ASK_PERSON=<person> node scripts/ask.mjs list
  node scripts/ask.mjs clear <bead-id> <person> "Going with the debounce; see notes."
`.trim();
}

// ── the bd and git edges (injectable, so the flows are testable with no bd binary) ─────────

/** Run `bd <args>` and return stdout; a failure throws an Error naming the command and bd's stderr. */
function runBd(args) {
  try {
    return execFileSync('bd', args, {
      encoding: 'utf8',
      timeout: BD_TIMEOUT_MS,
      maxBuffer: BD_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    throw new Error(`bd ${args.join(' ')}\n  ${detail}`);
  }
}

/** bd --json shapes vary by subcommand: bare array, {issues:[...]}, or a single object. */
export function parseBdJsonRows(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (Array.isArray(parsed)) return parsed;
  if (Array.isArray(parsed?.issues)) return parsed.issues;
  return parsed && typeof parsed === 'object' ? [parsed] : [];
}

function runSync(kind) {
  const haveHelper = existsSync(SYNC_HELPER);
  const [cmd, args] = haveHelper ? [process.execPath, [SYNC_HELPER, kind]] : ['bd', ['dolt', kind]];
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...(haveHelper ? {} : { timeout: BARE_SYNC_TIMEOUT_MS }) });
  return { ok: r.status === 0 };
}

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

/**
 * The default edges. Tests pass their own `deps` to main() instead.
 * `people` is undefined here on purpose: ask-lib then reads the configured list.
 */
export function defaultDeps() {
  return {
    bd: runBd,
    sync: runSync,
    gitEmail: readGitEmail,
    actor: () => resolveActorId(),
    env: process.env,
    people: undefined,
    now: () => new Date(),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
    error: (line) => console.error(line),
  };
}

const bdRows = (deps, args) => parseBdJsonRows(deps.bd(args));

function fetchBead(deps, id) {
  const rows = bdRows(deps, ['list', '--id', id, '--all', '--json', '-n', '0']);
  return rows.find((r) => String(r?.id) === id) ?? null;
}

/** The one call that IS the inbox. --all then drop closed = every open state. */
function fetchAsks(deps, personKey) {
  const rows = bdRows(deps, ['list', '--label', askLabel(personKey), '--all', '--json', '-n', '0']);
  return parseAsks(rows, personKey, { now: deps.now() });
}

/**
 * Set when a sync fails, so the process can exit non-zero AFTER the local write and the
 * user-facing output are both complete. Exiting early would be worse than the bug being
 * fixed: it would hide the result of a mutation that did land locally.
 */
let syncFailed = false;

/** Non-zero exit if any sync failed, so callers and CI cannot mistake this for success. */
export function syncExitCode() {
  return syncFailed ? 1 : 0;
}

/** Forget a recorded sync failure (tests; a long-lived caller that retries). */
export function resetSyncState() {
  syncFailed = false;
}

function doltPull(deps) {
  if (!deps.sync('pull').ok) {
    syncFailed = true;
    deps.warn(
      '[ask] WARNING: could not verify a pull from the beads remote. You may be reading STALE asks: ' +
        "someone else's answer or a newly raised ask may be missing from this list.",
    );
  }
}

function doltPush(deps) {
  if (deps.sync('push').ok) return;
  syncFailed = true;
  const retry = existsSync(SYNC_HELPER) ? 'node scripts/bd-dolt-sync.mjs push' : 'bd dolt push';
  deps.error(
    '\n[ask] *** PUSH FAILED. THIS CHANGE IS LOCAL ONLY AND THE OTHER PERSON CANNOT SEE IT. ***\n' +
      '[ask] The bead was written locally and is NOT lost. It has simply not reached the remote,\n' +
      '[ask] so an answer you just recorded is invisible to whoever is waiting on it.\n' +
      `[ask] Retry with:  ${retry}\n` +
      '[ask] If that keeps failing, run it again after a pull. A non-fast-forward rejection\n' +
      '[ask] just means another session pushed first, which is routine with concurrent sessions.',
  );
}

/** Who is running this command, for the `_by` field. Falls back to the raw actor base. */
function requesterLabel(deps) {
  const actor = deps.actor();
  const person = resolvePerson({
    env: { ...deps.env, ASK_PERSON: '' },
    actorBase: actor.base,
    gitEmail: deps.gitEmail(),
    people: deps.people,
  });
  return person?.key || actor.base || 'unknown';
}

function requirePerson(deps, key) {
  const person = personByKey(key, deps.people);
  if (!person) {
    const known = personKeys(deps.people).join(', ') || '(none configured)';
    throw new Error(`Unknown person "${key}". Known people: ${known}.\n` +
      'Add a handle to "people" in agent-tooling.json.');
  }
  return person;
}

const today = (deps) => deps.now().toISOString().slice(0, 10);

// ── commands ──────────────────────────────────────────────────────────────────

function cmdAdd(deps, beadId, personKey, reason, { replace = false } = {}) {
  const person = requirePerson(deps, personKey);
  const label = askLabel(person.key);
  const keys = askMetaKeys(person.key);
  const by = requesterLabel(deps);

  doltPull(deps);

  const bead = fetchBead(deps, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found.`);
  if (String(bead.status).toLowerCase() === 'closed') {
    throw new Error(`Bead ${beadId} is closed. Reopen it before asking someone to look at it.`);
  }

  const already = Array.isArray(bead.labels) && bead.labels.includes(label);
  if (already && !replace) {
    const existing = String(bead.metadata?.[keys.reason] ?? '').trim();
    throw new Error(
      `${person.display} already has an open ask on ${beadId}` +
        (existing ? `:\n  "${existing}"` : ' (no reason recorded).') +
        '\nPass --replace to overwrite it, or clear it first:\n' +
        `  node scripts/ask.mjs clear ${beadId} ${person.key}`,
    );
  }

  const args = ['update', beadId, '--add-label', label,
    '--set-metadata', `${keys.by}=${by}`,
    '--set-metadata', `${keys.at}=${deps.now().toISOString()}`];
  if (reason) {
    args.push('--set-metadata', `${keys.reason}=${reason}`);
  } else {
    // A --replace over an ask that HAD a reason must not silently inherit it.
    args.push('--unset-metadata', keys.reason);
  }
  args.push('--append-notes', `[ask→${person.key} by ${by} ${today(deps)}] ${reason || NO_REASON}`);

  deps.bd(args);
  doltPush(deps);

  deps.log(`Asked ${person.display} to look at ${beadId}: ${bead.title}`);
  deps.log(`  reason: ${reason || NO_REASON}`);
  deps.log(`  ${person.display} will see it in the [asks] banner at their next session start.`);
}

function cmdClear(deps, beadId, personKey, resolution) {
  const person = requirePerson(deps, personKey);
  const label = askLabel(person.key);
  const keys = askMetaKeys(person.key);
  const by = requesterLabel(deps);

  doltPull(deps);

  const bead = fetchBead(deps, beadId);
  if (!bead) throw new Error(`Bead ${beadId} not found.`);
  if (!Array.isArray(bead.labels) || !bead.labels.includes(label)) {
    deps.log(`No open ask for ${person.display} on ${beadId}: nothing to clear.`);
    return;
  }

  deps.bd(['update', beadId,
    '--remove-label', label,
    '--unset-metadata', keys.by,
    '--unset-metadata', keys.at,
    '--unset-metadata', keys.reason,
    '--append-notes', `[ask→${person.key} CLEARED by ${by} ${today(deps)}] ${resolution || '(no resolution recorded)'}`]);
  doltPush(deps);

  deps.log(`Cleared the ask for ${person.display} on ${beadId}.`);
  if (resolution) deps.log(`  resolution: ${resolution}`);
}

function cmdList(deps, { forKey = '', json = false } = {}) {
  const actor = deps.actor();
  const env = forKey ? { ...deps.env, ASK_PERSON: forKey } : deps.env;
  const person = resolvePerson({ env, actorBase: actor.base, gitEmail: deps.gitEmail(), people: deps.people });

  if (!person) {
    const who = forKey || actor.base || '(unresolved)';
    const known = personKeys(deps.people).join(', ') || '(none configured)';
    throw new Error(
      `Could not tell which person "${who}" is. Known people: ${known}.\n` +
        'Pass --for <person>, set ASK_PERSON, or add handles to "people" in agent-tooling.json.',
    );
  }

  const asks = fetchAsks(deps, person.key);

  if (json) {
    deps.log(JSON.stringify({ person: person.key, count: asks.length, asks }, null, 2));
    return;
  }

  if (!asks.length) {
    deps.log(`No beads are waiting on ${person.display}. All clear.`);
    return;
  }

  const noun = asks.length === 1 ? 'bead is' : 'beads are';
  deps.log(`${asks.length} ${noun} waiting on ${person.display}:\n`);
  for (const ask of asks) deps.log(`${formatDetail(ask)}\n`);
  deps.log('Run /asks to walk through these and decide on each one.');
}

// ── argv ──────────────────────────────────────────────────────────────────────

export function parseArgs(argv) {
  const flags = { replace: false, json: false, forKey: '', help: false };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') flags.help = true;
    else if (arg === '--replace') flags.replace = true;
    else if (arg === '--json') flags.json = true;
    else if (arg === '--for') { flags.forKey = String(argv[i + 1] ?? ''); i += 1; }
    else if (arg.startsWith('--for=')) flags.forKey = arg.slice('--for='.length);
    else if (arg.startsWith('-')) throw new Error(`Unknown flag "${arg}". Use --help for usage.`);
    else positional.push(arg);
  }

  if (flags.help) return { command: 'help', flags, positional };

  const [first, ...rest] = positional;
  const verb = String(first ?? '').toLowerCase();
  if (!first) return { command: 'list', flags, positional: [] };
  if (verb === 'list' || verb === 'clear' || verb === 'add') {
    return { command: verb, flags, positional: rest };
  }
  // Bare form: `ask.mjs <bead-id> <person> [reason]`.
  return { command: 'add', flags, positional };
}

/**
 * Run one command. Returns the exit code main() itself wants; a failed sync is reported
 * separately through syncExitCode(). Throws on a usage or logic error.
 * @param {string[]} argv
 * @param {ReturnType<typeof defaultDeps>} [deps]
 */
export function main(argv, deps = defaultDeps()) {
  const { command, flags, positional } = parseArgs(argv);

  switch (command) {
    case 'help':
      deps.log(usage(deps.people));
      return 0;
    case 'list':
      cmdList(deps, { forKey: flags.forKey, json: flags.json });
      return 0;
    case 'add': {
      const [beadId, personKey, ...reasonParts] = positional;
      if (!beadId || !personKey) {
        throw new Error('Usage: node scripts/ask.mjs <bead-id> <person> ["why"]\nUse --help for details.');
      }
      cmdAdd(deps, beadId, personKey, reasonParts.join(' ').trim(), { replace: flags.replace });
      return 0;
    }
    case 'clear': {
      const [beadId, personKey, ...resolutionParts] = positional;
      if (!beadId || !personKey) {
        throw new Error('Usage: node scripts/ask.mjs clear <bead-id> <person> ["resolution"]');
      }
      cmdClear(deps, beadId, personKey, resolutionParts.join(' ').trim());
      return 0;
    }
    default:
      deps.log(usage(deps.people));
      return 1;
  }
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
    // A sync failure must not be reported as success. main()'s own code wins when it is
    // already non-zero (a real usage/logic error); otherwise a failed push escalates a 0 to a 1.
    process.exitCode = main(process.argv.slice(2)) || syncExitCode();
  } catch (error) {
    process.stderr.write(`ask: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}
