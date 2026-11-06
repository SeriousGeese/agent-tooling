#!/usr/bin/env node
// Idea inbox, the ONE bead that collects speculative ideas for the repo's people
// (the `people` of agent-tooling.json) to triage.
//
//   node scripts/idea-inbox.mjs add "<idea>" [--source "<where it came from>"]
//   node scripts/idea-inbox.mjs show [--json]
//
// A "could also…" or "nice to have" an agent notices mid-work is NOT a bead of its own: it is a
// line appended to the open `idea-inbox` bead, which carries an ask for each person. When they
// walk their asks they decide; every idea they keep becomes a real bead, and the inbox is closed
// by a human. The next `add` after that opens a fresh one.
//
// The inbox is a childless `task` labelled `idea-inbox` + `human-required`: human-required keeps
// it out of `bd ready --exclude-label human-required`, so no agent "works" it, and a childless
// task is outside every nightly hygiene close (a nightly epic close touches epics only).
// Nothing but a person closes it, losing an unread idea is the failure this exists to prevent.
//
// Every write goes pull -> mutate -> push through the verified dolt sync. Hygiene relies on the
// beads set for that: scripts/bd-dolt-sync.mjs verifies the sync when it is installed. Without it a
// bare `bd dolt pull|push` runs and a warning says the sync is NOT verified. Unlike ask.mjs, an
// unverified pull REFUSES the write (a stale read can open a second inbox), and a failed push is
// reported loudly and exits non-zero, because the note is then local-only. A missing ask.mjs (asks
// set) only skips raising the ask: the note is already written, so that is a warning and exit 0.
import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { loadConfig, peopleOf } from './agent-tooling-config.mjs';
import { askLabel, bd, bdJson, resolveActor, siblingScript, syncPull, syncPush } from './hygiene-bd-lib.mjs';

export const INBOX_LABEL = 'idea-inbox';
export const INBOX_TITLE = 'Idea inbox — speculative ideas to triage';
export const INBOX_DESCRIPTION = [
  'One bead that collects speculative ideas agents noticed mid-work, one bd note per idea, instead',
  'of a bead per idea.',
  '',
  'Triage (a human): read the notes, file a real bead for every idea you want, then close this',
  'bead. The next `node scripts/idea-inbox.mjs add` opens a fresh inbox. No agent and no hygiene',
  'pass closes it.',
].join('\n');
export const ASK_REASON = 'Speculative ideas waiting for triage: keep the ones worth a bead, then close the inbox.';

const OPEN_STATES = new Set(['open', 'in_progress', 'blocked', 'deferred', 'pinned', 'hooked']);

/** The open inbox among `bd list --label idea-inbox --all` rows: the OLDEST, so two never split ideas. */
export function pickInbox(rows) {
  const open = (rows ?? []).filter((row) => OPEN_STATES.has(row?.status));
  open.sort((a, b) => String(a.created_at ?? '').localeCompare(String(b.created_at ?? '')));
  return open[0] ?? null;
}

/** The handles of the configured people (entries may be plain handles or objects). */
export function configuredHandles(cfg = loadConfig()) {
  return peopleOf(cfg).map((p) => p.handle);
}

/** `['--actor', actor]`, or nothing when the actor is empty (bd then uses its own default). */
export const actorArgs = (actor) => (actor ? ['--actor', actor] : []);

/** People whose ask label is missing from the inbox row. */
export function missingAsks(row, people = configuredHandles()) {
  const labels = new Set(row?.labels ?? []);
  return people.filter((key) => !labels.has(askLabel(key)));
}

/** One note line per idea: `[idea YYYY-MM-DD by <actor>] <idea> (source: …)`. */
export function formatIdeaNote(idea, { actor, source = '', now = new Date() } = {}) {
  const text = String(idea ?? '').replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('an idea needs some text');
  const date = now.toISOString().slice(0, 10);
  const from = String(source ?? '').trim();
  return `[idea ${date} by ${actor || 'unknown'}] ${text}${from ? ` (source: ${from})` : ''}`;
}

export function parseArgs(argv) {
  const out = { command: argv[0] ?? '', positional: [], source: '', json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source') {
      out.source = argv[i + 1] ?? '';
      i += 1;
    } else if (arg === '--json') {
      out.json = true;
    } else {
      out.positional.push(arg);
    }
  }
  return out;
}

const USAGE = `
Idea inbox — one bead for speculative ideas, triaged by the repo's people.

  node scripts/idea-inbox.mjs add "<idea>" [--source "<where it came from>"]
  node scripts/idea-inbox.mjs show [--json]
`.trim();

let syncFailed = false;

function doltPull() {
  if (!syncPull().ok) {
    syncFailed = true;
    console.warn('[idea-inbox] WARNING: could not verify a pull from DoltHub; the inbox read may be stale.');
  }
}

const PUSH_FAILED =
  '[idea-inbox] *** PUSH FAILED — the idea is written LOCALLY ONLY. ***\n' +
  `[idea-inbox] Retry with:  ${existsSync(siblingScript('bd-dolt-sync.mjs')) ? 'node scripts/bd-dolt-sync.mjs push' : 'bd dolt push'}`;

/**
 * Raise one person's ask on the inbox via ask.mjs. A missing ask.mjs (asks set not installed) is a
 * warning, not a failure: the note is already written and pushed, so the run must not exit 1.
 * A present ask.mjs that fails still throws, and addIdea reports it.
 */
export function raiseAsk(id, person, { script = siblingScript('ask.mjs'), run = execFileSync, warn = (l) => console.warn(l) } = {}) {
  if (!existsSync(script)) {
    warn(`[idea-inbox] WARNING: ask.mjs is not installed (asks set), so no ask was raised for ${person}. The idea is recorded.`);
    return false;
  }
  run(process.execPath, [script, id, person, ASK_REASON], { stdio: 'inherit' });
  return true;
}

function defaultDeps() {
  const askScript = siblingScript('ask.mjs');
  return {
    actor: () => resolveActor(),
    people: () => configuredHandles(),
    pull: () => syncPull().ok,
    push: () => syncPush().ok,
    list: () => bdJson(['list', '--label', INBOX_LABEL, '--all', '--json', '-n', '0']),
    create: (actor) =>
      bd([
        'create', ...actorArgs(actor), '--type', 'task', '--priority', 'P3', '--silent',
        '--title', INBOX_TITLE, '--description', INBOX_DESCRIPTION,
        '--labels', `${INBOX_LABEL},human-required`,
      ]).trim(),
    note: (id, text, actor) => bd(['note', id, text, ...actorArgs(actor)]),
    close: (id, reason, actor) => bd(['close', id, '--reason', reason, ...actorArgs(actor)]),
    ask: (id, person) => raiseAsk(id, person, { script: askScript }),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  };
}

/**
 * Append one idea to THE inbox. Returns an exit code; nothing is written unless the pull was
 * verified, and a non-zero code means the idea did not reach DoltHub (or never got written).
 *
 * Two adds can race: both pull, both see no inbox, both create one. So the creator pulls again
 * after its push and, when an OLDER open inbox now exists (pickInbox picks the oldest, exactly
 * as every reader does), moves its idea there and closes its own bead as a duplicate.
 */
export function addIdea(idea, source, deps = defaultDeps()) {
  const actor = deps.actor();
  const note = formatIdeaNote(idea, { actor, source });
  if (!deps.pull()) {
    deps.error('[idea-inbox] could not verify a pull from DoltHub; refusing to write against a stale inbox. Nothing was written.');
    return 1;
  }
  let inbox = pickInbox(deps.list());
  let created = null;
  if (!inbox) {
    created = deps.create(actor);
    if (!created) throw new Error('bd create returned no id');
    deps.log(`[idea-inbox] opened a new inbox: ${created}`);
    inbox = { id: created, labels: [INBOX_LABEL, 'human-required'] };
  }
  deps.note(inbox.id, note, actor);
  if (!deps.push()) {
    deps.error(PUSH_FAILED);
    return 1;
  }

  if (created) {
    if (!deps.pull()) {
      deps.error(`[idea-inbox] could not re-check for a concurrent inbox; if two now exist, move ${created}'s note to the older one.`);
      return 1;
    }
    const winner = pickInbox(deps.list());
    if (winner && winner.id !== created) {
      deps.note(winner.id, note, actor);
      deps.close(created, `duplicate of ${winner.id}: a concurrent add opened it first; the idea was moved there`, actor);
      if (!deps.push()) {
        deps.error(PUSH_FAILED);
        return 1;
      }
      deps.log(`[idea-inbox] ${winner.id} was opened concurrently; moved the idea there and closed ${created}.`);
      inbox = winner;
    }
  }
  deps.log(`[idea-inbox] ${inbox.id} <- ${note}`);

  // ask.mjs owns the ask contract and its own sync; re-raise any ask a person has cleared, so a
  // new idea after a triage still reaches both of them.
  let rc = 0;
  for (const person of missingAsks(inbox, deps.people())) {
    try {
      deps.ask(inbox.id, person);
    } catch {
      rc = 1;
      deps.error(`[idea-inbox] could not raise the ask for ${person}; run: node scripts/ask.mjs ${inbox.id} ${person}`);
    }
  }
  return rc;
}

function findInbox() {
  return pickInbox(defaultDeps().list());
}

function show(json) {
  doltPull();
  const inbox = findInbox();
  if (!inbox) {
    console.log(json ? 'null' : '[idea-inbox] no open inbox — the next `add` opens one.');
    return 0;
  }
  if (json) {
    console.log(JSON.stringify(bdJson(['show', inbox.id, '--json'])));
    return 0;
  }
  process.stdout.write(bd(['show', inbox.id]));
  return 0;
}

export function main(argv) {
  const args = parseArgs(argv);
  switch (args.command) {
    case 'add':
      if (args.positional.length !== 1) {
        console.error('usage: node scripts/idea-inbox.mjs add "<idea>" [--source "<text>"]');
        return 1;
      }
      return addIdea(args.positional[0], args.source);
    case 'show':
      return show(args.json);
    default:
      console.log(USAGE);
      return args.command === '' || args.command === '--help' ? 0 : 1;
  }
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2)) || (syncFailed ? 1 : 0);
  } catch (error) {
    process.stderr.write(`idea-inbox: ${error?.message ?? error}\n`);
    process.exit(1);
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
