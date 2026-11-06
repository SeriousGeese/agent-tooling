#!/usr/bin/env node
// Single source of truth for an agent session's BEADS ACTOR IDENTITY.
//
// Why this exists:
// `bd update <id> --claim` writes the resolved actor into `issues.assignee`, resolving it
// as $BEADS_ACTOR -> git user.name -> $USER. With BEADS_ACTOR unset, EVERY session belonging
// to one person claims under the SAME name. Two consequences, both bad:
//
//   1. You cannot tell which of your own sessions holds a bead.
//   2. The claim-age check (scripts/claim-age.mjs) cannot catch a same-person collision. It
//      compares the claim's assignee to your identity and treats a match as "already yours,
//      --claim is idempotent", so two parallel sessions of the SAME person sail straight
//      through the check. That is the likelier collision, since a bulk run is precisely what
//      runs several of one person's sessions at once.
//
// So each session claims under `<base>-bot-<session8>`, e.g. `ada-lovelace-bot-0fc812d7`.
// The human-readable base is kept up front so `bd list` still shows at a glance whose fleet
// owns a bead, and the suffix makes sessions distinguishable from each other. In Claude Code
// the window's name goes in between: `ada-bot-win-3c-c54b71a9`, so a lead can tell WHICH
// window holds a claim; see `claudeSessionName`.
//
// Claiming with BEADS_ACTOR="probe-bot-deadbeef" sets `assignee` to exactly that string (checked
// against a live DB on a scratch bead), so this really does drive the assignee and not
// merely the audit trail.
//
// Consumed by scripts/claim.sh (exports it before claiming) and by scripts/claim-age.mjs
// (must resolve identity IDENTICALLY, or the check would mistake your own fresh claim for
// someone else's and refuse it). Keep those two on this module: do not re-implement the
// derivation.
//
// CLI: `node scripts/agent-actor-id.mjs` prints the id.
//      `--check` exits 0 (printing the id) when it is session-distinct, 1 (with the remedy
//      on stderr) when it is shared. scripts/claim.sh gates on `--check` before any
//      mutation: a Claude PreToolUse hook is no enforcement boundary for Codex or a human
//      shell, so the helper must refuse on its own.
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** How many hex chars of the session UUID to keep. 8 is ~4 billion, ample, and stays readable. */
export const SESSION_SUFFIX_LEN = 8;

/**
 * The shape of a per-session id, in both formats this module has produced: `<base>-bot-<session8>`
 * and, with a window name, `<base>-bot-<session name>-<session8>`. The ONE copy: claim.sh's claim-age
 * check (scripts/claim-age.mjs) and any other script that classifies an id import it, so an id is never
 * distinct to one of them and shared to another. Existing assignees in the old format still match.
 */
export const DISTINCT_ACTOR_RE = new RegExp(`-bot-(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[a-z0-9]{${SESSION_SUFFIX_LEN}}$`);

/**
 * Slug a human name into an identifier-safe base: "Ada Lovelace" -> "ada-lovelace",
 * "Build Bot" -> "build-bot". Collapses runs of non-alphanumerics and trims dashes.
 */
export function slugifyActorBase(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * The agent session identifiers this module knows how to key on, in precedence order.
 *
 * - CLAUDE_CODE_SESSION_ID: Claude Code's session UUID (v4, random throughout), so
 *   its PREFIX is taken, which is unchanged from the first version, so existing assignees match it.
 * - CODEX_THREAD_ID: OpenAI Codex injects this into every command it spawns
 *   (codex-rs core/src/exec_env.rs `create_env` → CODEX_THREAD_ID_ENV_VAR, "injected
 *   when a thread id is provided, even when include_only is set"). Its thread ids
 *   are UUIDv7: the leading 48 bits are a millisecond timestamp, so two threads
 *   started within ~65s share their first 8 hex chars (`01a073bb-…`, `01a0a510-…`).
 *   The SUFFIX, which is random, is taken instead.
 *
 * Originally only the Claude variable was read, so a Codex session resolved a
 * bare shared base ("ada-lovelace") and claim.sh published it without complaint.
 */
export const SESSION_ID_SOURCES = [
  { name: 'CLAUDE_CODE_SESSION_ID', take: 'prefix' },
  { name: 'CODEX_THREAD_ID', take: 'suffix' },
];

/** Which session variable (if any) supplies the suffix: { name, suffix } or null. */
export function sessionIdSource(env = process.env) {
  for (const { name, take } of SESSION_ID_SOURCES) {
    const alnum = String(env[name] ?? '').trim().replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    if (!alnum) continue;
    const suffix = take === 'prefix' ? alnum.slice(0, SESSION_SUFFIX_LEN) : alnum.slice(-SESSION_SUFFIX_LEN);
    return { name, suffix };
  }
  return null;
}

/** The session-distinct portion, or '' when this process has no session id to key on. */
export function sessionSuffix(env = process.env) {
  return sessionIdSource(env)?.suffix ?? '';
}

/**
 * Why an identity is not session-distinct, and how to fix it: the one message both
 * `--check` and scripts/claim.sh print, so the remedy cannot drift between them.
 */
export function sharedIdentityMessage(resolved) {
  const names = SESSION_ID_SOURCES.map((s) => s.name).join(' or ');
  const why =
    resolved.source === 'BEADS_ACTOR'
      ? `BEADS_ACTOR is set to a name with no -bot-<${SESSION_SUFFIX_LEN} chars> session suffix`
      : `no agent session id was found (${names})`;
  return (
    `agent-actor-id: identity "${resolved.id || '(none)'}" is NOT session-distinct (source: ${resolved.source}): ${why}. ` +
    'Every session of this user would claim under the same name, and the claim-age check in claim.sh cannot tell them apart. ' +
    `Fix: set BEADS_ACTOR to a per-session id, e.g. BEADS_ACTOR="${resolved.base || '<you>'}-bot-<${SESSION_SUFFIX_LEN} unique lowercase alphanumerics>". ` +
    'A deliberately shared claim: AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1.'
  );
}

/**
 * Resolve this session's actor identity.
 *
 * Returns { id, base, suffix, distinct, source }.
 * `distinct` is false when no session id was available, so the caller then knows
 * the id is shared across that person's sessions and cannot be relied on to
 * disambiguate them.
 *
 * An explicit BEADS_ACTOR always wins untouched: if a human or another tool has
 * deliberately set an identity, honour it rather than rewriting it.
 */
export function resolveActorId({ env = process.env, gitUserName = readGitUserName, readSessionFile = readTextFile } = {}) {
  const explicit = String(env.BEADS_ACTOR ?? '').trim();
  if (explicit) {
    return {
      id: explicit,
      base: explicit,
      suffix: '',
      // Treat an explicit actor as distinct only if it already carries a suffix
      // this module would have produced; otherwise it is a shared team name.
      distinct: DISTINCT_ACTOR_RE.test(explicit),
      source: 'BEADS_ACTOR',
    };
  }

  const rawBase =
    String(env.BEADS_ACTOR_BASE ?? '').trim() ||
    gitUserName() ||
    String(env.USER ?? env.USERNAME ?? '').trim();

  const base = slugifyActorBase(rawBase);
  if (!base) return { id: '', base: '', suffix: '', distinct: false, source: 'none' };

  const session = sessionIdSource(env);
  if (!session) return { id: base, base, suffix: '', distinct: false, source: 'base-only' };

  const { suffix, name: sessionVar } = session;
  // The window's name, between the base and the suffix, so a lead can tell which window
  // holds a claim. Claude Code only; any miss keeps the plain `<base>-bot-<session8>`.
  const name = sessionVar === 'CLAUDE_CODE_SESSION_ID' ? claudeSessionName(env, readSessionFile) : '';
  const id = name ? `${base}-bot-${name}-${suffix}` : `${base}-bot-${suffix}`;
  return { id, base, suffix, distinct: true, source: 'derived', sessionVar, ...(name ? { sessionName: name } : {}) };
}

/**
 * Whether `holder`, an id in the OLD `<base>-bot-<session8>` format, was written by the same session
 * as `me`, an id in the new `<base>-bot-<name>-<session8>` format: same base, same
 * session suffix, a name in between. A claim made before the format changed, or by a hook that read
 * no sessions file, must not read as someone else's to the session that made it.
 */
export function isOldFormatOfSameSession(holder, me) {
  const old = new RegExp(`^(.+)-bot-([a-z0-9]{${SESSION_SUFFIX_LEN}})$`).exec(String(holder ?? ''));
  if (!old) return false;
  const [, base, suffix] = old;
  const mine = String(me ?? '');
  const prefix = `${base}-bot-`;
  return mine.length > holder.length + 1 && mine.startsWith(prefix) && mine.endsWith(`-${suffix}`)
    && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mine.slice(prefix.length, -(suffix.length + 1)));
}

/**
 * This Claude Code session's name, the one ListAgents and cross-session messages address it by
 * (`win-3c`), slugified; '' when it cannot be read with confidence.
 *
 * Read from `~/.claude/sessions/<CLAUDE_PID>.json`, which Claude Code writes per running session.
 * The file is UNDOCUMENTED harness state, so it is read defensively: a missing or unparsable file,
 * no name, or a `sessionId` that is not this session's (a stale file, a reused pid) all read as no
 * name. `CLAUDE_CONFIG_DIR` relocates the directory, as it does for Claude Code itself.
 *
 * The name is stable across `/clear` while the session id is not, and it is two hex characters,
 * so it recurs over time: that is why the session suffix stays on the id after it.
 */
export function claudeSessionName(env = process.env, readSessionFile = readTextFile) {
  const pid = String(env.CLAUDE_PID ?? '').trim();
  const sessionId = String(env.CLAUDE_CODE_SESSION_ID ?? '').trim();
  if (!/^\d+$/.test(pid) || !sessionId) return '';
  const configDir = String(env.CLAUDE_CONFIG_DIR ?? '').trim() || path.join(String(env.HOME ?? '').trim() || os.homedir(), '.claude');
  let parsed;
  try {
    parsed = JSON.parse(readSessionFile(path.join(configDir, 'sessions', `${pid}.json`)));
  } catch {
    return '';
  }
  if (!parsed || typeof parsed !== 'object' || parsed.sessionId !== sessionId) return '';
  return typeof parsed.name === 'string' ? slugifyActorBase(parsed.name) : '';
}

function readTextFile(file) {
  return readFileSync(file, 'utf8');
}

function readGitUserName() {
  try {
    return execFileSync('git', ['config', 'user.name'], {
      encoding: 'utf8',
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

if (isMain()) {
  const resolved = resolveActorId();
  if (process.argv.includes('--check')) {
    if (!resolved.distinct) {
      process.stderr.write(`${sharedIdentityMessage(resolved)}\n`);
      process.exit(1);
    }
    process.stdout.write(resolved.id);
    process.exit(0);
  }
  process.stdout.write(resolved.id);
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
