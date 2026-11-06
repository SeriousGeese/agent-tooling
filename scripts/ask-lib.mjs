#!/usr/bin/env node
// Pure logic for "asks": routing a bead to a specific person for a decision.
//
// Why this exists:
// Collaborators work async. There was no reliable way to say "look at this bead and decide"
// and have it actually reach the other person. `assignee` could not be reused for it: that
// field is owned by the claim machinery (`bd update --claim` writes it, scripts/claim-age.mjs
// reads it), so overloading it for routing would corrupt claim semantics. An ask is
// therefore a LABEL plus METADATA on the bead, and leaves `assignee` alone.
//
// The gap is worst for DEFERRED beads: `bd ready` hides them, so a bead parked awaiting a
// product call is invisible until somebody remembers it exists, which is exactly the class
// of bead that most needs a human decision. An ask surfaces a bead in ANY non-closed state.
//
// The contract
//   label      ask-<person>                      e.g. ask-alice
//   metadata   ask_<person>_by                   requesting person key
//              ask_<person>_at                   ISO-8601 UTC
//              ask_<person>_reason               free text, ONLY if one was given
//   notes      appended human-readable audit line (never read back, see below)
//
// The keys are person-prefixed so two people can each have an open ask on the same bead
// without clobbering each other.
//
// THE REASON IS OPTIONAL BY DESIGN. Sometimes you just want the other person to pick the
// bead up and it needs no context. A bead hand-tagged with a bare `bd tag <id> ask-alice`
// and no metadata at all is valid and must render cleanly: parseAsks() is written to
// survive it.
//
// Measured bd facts this depends on (bd 1.3.2)
//   * `bd list --label X --all --json -n 0` returns id/title/description/status/priority/
//     labels/defer_until AND metadata in about 0.7s. So the whole inbox is ONE bd call. We
//     filter closed rows here rather than enumerating statuses in --status, so every open
//     state (open/in_progress/blocked/deferred/pinned/hooked) is covered with no list to
//     keep in sync as bd adds more.
//   * Notes are the human audit trail only, even though `bd show --json` returns them; all
//     machine-read state lives in metadata.
//   * bd COERCES numeric-looking metadata values: `--set-metadata a=1` reads back as the JSON
//     number 1, not "1". Everything here stringifies defensively.
//
// Who the people are comes from `people` in the consumer's agent-tooling.json (lower-case
// handles or person objects with actorBases and emails, read through agent-tooling-config.mjs). Every function that needs the
// list takes it as a parameter, so the logic is pure and testable without a file; when the
// parameter is omitted the configured list is read once and cached. Nothing here calls bd,
// touches the filesystem itself or exits the process. The bd-touching CLI is scripts/ask.mjs;
// the SessionStart banner is scripts/hooks/ask-inbox.mjs.
import { peopleOf, tryLoadConfig } from './agent-tooling-config.mjs';

const clip = (text, limit) => {
  const s = String(text ?? '').trim();
  return s.length <= limit ? s : `${s.slice(0, limit - 1).trimEnd()}…`;
};

/**
 * Build the people registry from config handles.
 *
 * `actorBases` are slugified identity bases as produced by scripts/agent-actor-id.mjs
 * (slugifyActorBase), NOT display names, and they match EXACTLY: a prefix rule would hand
 * `alice-jones` (someone else) to alice. A person given as a bare handle, with no actorBases,
 * matches `<handle>` and `<handle>-bot`; a person who lists actorBases matches only those.
 * `aliases` supplies them, per handle:
 * `{ alice: { actorBases: ['a-smith'], emails: ['alice@example.com'] } }`. Two handles
 * claiming one base would route an ask to whoever is listed first, so a base is kept by the
 * first handle that names it.
 *
 * @param {readonly string[]} handles
 * @param {Record<string, { display?: string, actorBases?: string[], emails?: string[] }>} [aliases]
 */
export function buildPeople(handles, aliases = {}) {
  const seen = new Set();
  const people = [];
  for (const raw of Array.isArray(handles) ? handles : []) {
    const key = String(raw ?? '').trim().toLowerCase();
    if (!key || people.some((p) => p.key === key)) continue;
    const extra = aliases[key] ?? {};
    const listed = extra.actorBases ?? [];
    const actorBases = (listed.length ? listed : [key, `${key}-bot`])
      .map((b) => String(b).trim().toLowerCase())
      .filter((b) => b && !seen.has(b));
    for (const b of actorBases) seen.add(b);
    people.push({
      key,
      display: extra.display ?? key.charAt(0).toUpperCase() + key.slice(1),
      actorBases,
      emails: (extra.emails ?? []).map((e) => String(e).trim().toLowerCase()),
    });
  }
  return people;
}

/**
 * The people configured for a repository. Fail-open: a broken or missing agent-tooling.json
 * reads as nobody configured, never as a throw.
 * @param {{ root?: string, from?: string }} [opts] forwarded to the config loader
 */
export function peopleFromConfig(opts = {}) {
  // A `people` entry is a handle or a person object with display, actorBases and emails;
  // peopleOf (the shared loader) gives one shape for both.
  const people = peopleOf(tryLoadConfig(opts).config);
  const aliases = Object.fromEntries(people.map((p) => [p.handle, { display: p.display, actorBases: p.actorBases, emails: p.emails }]));
  return buildPeople(
    people.map((p) => p.handle),
    aliases,
  );
}

let cachedPeople = null;

/** The configured people, read once per process. */
export function defaultPeople() {
  cachedPeople ??= peopleFromConfig();
  return cachedPeople;
}

/** Every valid person key, for error messages and CLI validation. */
export function personKeys(people = defaultPeople()) {
  return people.map((p) => p.key);
}

/** Look up a person by key, case-insensitively. Returns undefined when unknown. */
export function personByKey(key, people = defaultPeople()) {
  const want = String(key ?? '').trim().toLowerCase();
  if (!want) return undefined;
  return people.find((p) => p.key === want);
}

/** The routing label for a person: `ask-alice`. */
export function askLabel(personKey) {
  return `ask-${String(personKey ?? '').trim().toLowerCase()}`;
}

/**
 * The three metadata keys for a person's ask.
 * Person-prefixed so two people can have concurrent asks on one bead.
 */
export function askMetaKeys(personKey) {
  const k = String(personKey ?? '').trim().toLowerCase();
  return { by: `ask_${k}_by`, at: `ask_${k}_at`, reason: `ask_${k}_reason` };
}

/**
 * Resolve WHICH PERSON this session belongs to.
 *
 * Order:
 *   1. ASK_PERSON env: explicit override, also how you inspect the other person's inbox from
 *      your own machine without impersonating them in bd.
 *   2. The session's actor base (scripts/agent-actor-id.mjs) matched against actorBases, or
 *      starting with `<handle>-`. This is the normal path: BEADS_ACTOR_BASE can be set per
 *      machine.
 *   3. git user.email matched against emails (only people given `emails` aliases), which
 *      covers a plain shell with no agent env at all.
 *
 * Returns the person object, or null when unknown. Callers must treat null as "say nothing"
 * rather than an error: an unrecognised contributor should never have their session start
 * fail.
 */
export function resolvePerson({ env = process.env, actorBase = '', gitEmail = '', people = defaultPeople() } = {}) {
  const override = String(env.ASK_PERSON ?? '').trim().toLowerCase();
  if (override) return personByKey(override, people) ?? null;

  const base = String(actorBase ?? '').trim().toLowerCase();
  if (base) {
    const byBase = people.find((p) => p.actorBases.includes(base));
    if (byBase) return byBase;
  }

  const email = String(gitEmail ?? '').trim().toLowerCase().replace(/^<|>$/g, '');
  if (email) {
    const byEmail = people.find((p) => p.emails.includes(email));
    if (byEmail) return byEmail;
  }

  return null;
}

/** bd may hand back numbers for numeric-looking metadata: always land on a string. */
function str(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

/**
 * Turn raw `bd list --label ask-<person> --all --json` rows into asks.
 *
 * Drops closed rows (that is what makes "--all minus closed" mean *any* open state),
 * tolerates rows with no metadata at all (the hand-tagged path), and sorts oldest ask first
 * so the thing that has been waiting longest is read first.
 */
export function parseAsks(rows, personKey, { now = new Date() } = {}) {
  const key = String(personKey ?? '').trim().toLowerCase();
  const label = askLabel(key);
  const meta = askMetaKeys(key);
  const list = Array.isArray(rows) ? rows : [];

  return list
    .filter((row) => row && typeof row === 'object')
    .filter((row) => str(row.status).toLowerCase() !== 'closed')
    // Belt-and-braces for a caller passing rows bd did NOT label-filter. Deliberately lenient
    // when `labels` is absent: bd OMITS the key entirely for a bead with no labels (it does
    // not send []), and it likewise omits `metadata` when there is none. A label-filtered
    // query can never return a bead with no labels, so being strict here would buy nothing,
    // and would silently empty the whole inbox if bd ever stopped hydrating the field.
    .filter((row) => !Array.isArray(row.labels) || row.labels.map(str).includes(label))
    .map((row) => {
      const m = row.metadata && typeof row.metadata === 'object' ? row.metadata : {};
      const askedAt = str(m[meta.at]) || str(row.created_at);
      return {
        id: str(row.id),
        title: str(row.title),
        status: str(row.status) || 'open',
        priority: row.priority ?? null,
        deferUntil: str(row.defer_until) || null,
        by: str(m[meta.by]),
        at: askedAt,
        // '' means no reason was recorded: a deliberate, supported state.
        reason: str(m[meta.reason]),
        summary: summarize(row.description),
        age: formatAge(askedAt, now),
      };
    })
    .sort((a, b) => {
      const at = Date.parse(a.at) || Number.POSITIVE_INFINITY;
      const bt = Date.parse(b.at) || Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      return a.id.localeCompare(b.id);
    });
}

/**
 * A one-or-two-line gist of a bead's description for the inbox.
 *
 * Bead descriptions almost always open with a markdown heading ("## Problem"), so headings,
 * fences, list bullets and blockquote markers are stripped and the first real prose
 * paragraph is used.
 */
export function summarize(description, { maxChars = 200 } = {}) {
  const text = str(description);
  if (!text) return '';

  const lines = text.split(/\r?\n/);
  const kept = [];
  let inFence = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!line) {
      if (kept.length) break; // end of the first real paragraph
      continue;
    }
    if (/^#{1,6}\s/.test(line)) continue; // heading
    if (/^([-*_]\s*){3,}$/.test(line)) continue; // horizontal rule
    kept.push(line.replace(/^[>\-*+]\s+/, '').replace(/^\d+\.\s+/, ''));
  }

  const gist = kept.join(' ').replace(/\s+/g, ' ').trim();
  if (gist.length <= maxChars) return gist;
  // Cut on a word boundary so the ellipsis does not land mid-word.
  const cut = gist.slice(0, maxChars);
  const space = cut.lastIndexOf(' ');
  return `${(space > maxChars * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** Compact relative age: "today", "3d ago", "2mo ago". '' when the date is unusable. */
export function formatAge(iso, now = new Date()) {
  const then = Date.parse(str(iso));
  if (!Number.isFinite(then)) return '';
  const days = Math.floor((now.getTime() - then) / 86_400_000);
  if (days < 0) return 'just now';
  if (days === 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

/** What we show when somebody tagged a bead without saying why. Not an error state. */
export const NO_REASON = '(no reason given, just pick it up)';

/**
 * The SessionStart banner. Returns '' when there is nothing to say, which is the signal for
 * the hook to stay completely silent.
 */
export function formatBanner(asks, person, { max = 5 } = {}) {
  const list = Array.isArray(asks) ? asks : [];
  if (!list.length || !person) return '';

  const noun = list.length === 1 ? 'bead is' : 'beads are';
  const out = [`[asks] ${list.length} ${noun} waiting on YOU (${person.key}):`];

  const width = Math.max(...list.slice(0, max).map((a) => a.id.length));
  for (const ask of list.slice(0, max)) {
    const who = ask.by ? `asked by ${ask.by}` : 'asked';
    const when = ask.age ? `, ${ask.age}` : '';
    const flag = ask.status === 'deferred' ? ' [deferred]' : '';
    out.push(`[asks]   ${ask.id.padEnd(width)}  ${clip(ask.title, 52)}${flag}  (${who}${when})`);
  }
  if (list.length > max) out.push(`[asks]   …and ${list.length - max} more.`);

  out.push('[asks] Run /asks to review them.');
  return out.join('\n');
}

/** The per-bead block /asks prints before prompting for a decision. */
export function formatDetail(ask) {
  if (!ask) return '';
  const bits = [`${ask.id}  ${ask.title}`];

  const facts = [`status: ${ask.status}`];
  if (ask.priority !== null && ask.priority !== undefined) facts.push(`P${ask.priority}`);
  if (ask.deferUntil) facts.push(`deferred until ${ask.deferUntil.slice(0, 10)}`);
  bits.push(`  ${facts.join('  |  ')}`);

  const who = ask.by || 'someone';
  const when = ask.age ? ` ${ask.age}` : '';
  bits.push(`  asked by ${who}${when}`);
  bits.push(`  reason:  ${ask.reason || NO_REASON}`);
  if (ask.summary) bits.push(`  summary: ${ask.summary}`);

  return bits.join('\n');
}
