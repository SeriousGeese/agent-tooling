// The one synchronous `bd` caller for the scripts that read the tracker through the CLI. Scripts
// used to carry their own copies; one had the maxBuffer backstop below and the others were one
// tracker-growth away from a bare `spawnSync bd ENOBUFS`.

import { execFileSync } from 'node:child_process';

/** bd invocations serialize on the embedded Dolt lock, so a slow call is normal contention. */
export const BD_TIMEOUT_MS = 120_000;

/**
 * Node's 1 MB default is not enough for a real tracker, and the overflow arrives as a bare
 * `spawnSync bd ENOBUFS`, no mention of size, and it reads like bd is broken. Callers should
 * still narrow their reads with a filter; this is the backstop for growth.
 */
export const BD_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * Run `bd <args>` and return its stdout. A failure throws an Error naming the command and
 * bd's stderr, unless `allowFailure` is set, in which case it returns ''.
 * `exec` is injectable for tests; it defaults to execFileSync.
 */
export function bd(args, { allowFailure = false, exec = execFileSync } = {}) {
  try {
    return exec('bd', args, {
      encoding: 'utf8',
      timeout: BD_TIMEOUT_MS,
      maxBuffer: BD_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    if (allowFailure) return '';
    const detail = String(error?.stderr || error?.message || error).trim();
    // `stderr` travels separately so a caller can read bd's OWN words without the command line,
    // whose arguments (a close reason, say) are caller data.
    throw Object.assign(new Error(`bd ${args.join(' ')}\n  ${detail}`), { stderr: String(error?.stderr ?? '') });
  }
}

/** bd --json shapes vary by subcommand: bare array, {issues:[…]}, or a single object. */
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

/** `bd <args>` parsed as rows; see parseBdJsonRows. */
export function bdJson(args, opts = {}) {
  return parseBdJsonRows(bd(args, opts));
}

/**
 * bd 1.3 refuses to close a bead claimed by a different actor:
 *   cannot close <id>: assignee is "ann-bot-1234abcd", actor is "ann (ci)"; reclaim or use --force to override
 * Claims are per-session `<base>-bot-<session8>` actors, while CI and nightly jobs run under one
 * shared actor, so without a retry every claimed bead refuses to close.
 */
export const CLOSE_ASSIGNEE_REFUSAL_RE = /cannot close (\S+): assignee is "([^"]+)", actor is "[^"]*"/;

const ANCHORED_REFUSAL_RE = new RegExp(`^${CLOSE_ASSIGNEE_REFUSAL_RE.source}`, 'm');

/**
 * The assignee named by a bd 1.3 assignee-mismatch close refusal of bead `id`, or null for any
 * other text. Read from bd's STDERR only, and only a refusal that starts a line and names this
 * very bead: refusal-shaped text inside a close reason or another bead's message never counts.
 */
export function closeRefusalAssignee(stderr, id) {
  const m = ANCHORED_REFUSAL_RE.exec(String(stderr ?? ''));
  if (!m) return null;
  return id === undefined || m[1] === id ? m[2] : null;
}

/**
 * `bd close <id> --reason <reason>` via `run` (a bd runner that THROWS on a non-zero exit with
 * bd's stderr on `error.stderr`: `bd` above, or a script's own, as epic-hygiene.mjs's does). An assignee-mismatch refusal is
 * retried once as that assignee.
 *
 * DELIBERATE: the retry records the close under the CLAIMANT's actor id, not the job's. Every
 * caller closes work that has already shipped, and the close reason names what shipped it, so
 * closing on the claimant's behalf is the honest record. It is NOT `--force`, which also
 * overrides a blocking dependency and a gate, which every caller must still respect.
 */
export function bdCloseAsAssignee(run, id, reason) {
  try {
    return run(['close', id, '--reason', reason]);
  } catch (error) {
    // bd's own stderr, never the message, which also carries the command line and the reason.
    const assignee = typeof error?.stderr === 'string' ? closeRefusalAssignee(error.stderr, id) : null;
    if (!assignee) throw error;
    return run(['close', id, '--reason', reason, '--actor', assignee]);
  }
}
