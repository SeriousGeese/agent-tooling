// The small bd, actor and dolt-sync plumbing the hygiene scripts share (epic-hygiene, idea-inbox,
// oddity). A vendored set may import only base files and its own files, so the hygiene set carries
// its own copy of the few helpers it needs instead of importing the beads or asks sets:
//
//   - the synchronous `bd` caller and the no-shell-first spawn with its win32 shell fallback
//   - the assignee-mismatch close retry
//   - the per-session actor id: the CLI of the asks set when it is installed, BEADS_ACTOR otherwise
//   - dolt pull and push: the CLI of the beads set when it is installed (it verifies the sync),
//     a bare `bd dolt pull|push` otherwise
//
// Dependency-free (node: builtins only).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A sibling script of this file, by file name (`bd-dolt-sync.mjs`). */
export const siblingScript = (name) => path.join(HERE, name);

/** bd invocations serialize on the embedded Dolt lock, so a slow call is normal contention. */
export const BD_TIMEOUT_MS = 120_000;

/**
 * Node's 1 MB default is not enough for a real tracker, and the overflow arrives as a bare
 * `spawnSync bd ENOBUFS` with no mention of size, which reads like bd is broken. Callers should
 * still narrow their reads with a filter; this is the backstop for growth.
 */
export const BD_MAX_BUFFER = 64 * 1024 * 1024;

/**
 * The bd binary to spawn. Honours $BD_CLI so a caller that stubs bd reaches the stub, and so a
 * Windows box, where `bd` can be an extensionless shim CreateProcess cannot start, can point at
 * the real binary. Read at CALL time so a test can set it per case.
 */
export const bdCli = () => process.env.BD_CLI || 'bd';

const NEEDS_SHELL = process.platform === 'win32';

/**
 * Spawn with no shell first; on win32, retry through the shell when the command never STARTED
 * (an extensionless shim). A `timeout` expiry also arrives as `r.error` (ETIMEDOUT) and must NOT
 * take the shell fallback: re-running a command that just wedged behind a wall-clock cap would
 * re-take whatever lock it held for another full cap. It is reported as `timedOut` instead.
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {{ status: number, stdout: string, stderr: string, timedOut?: true }}
 */
export function spawnWithShellFallback(cmd, args, opts = {}) {
  let r;
  try {
    r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  } catch (err) {
    if (!NEEDS_SHELL) throw err;
    r = { error: err };
  }
  const timedOut = r.error?.code === 'ETIMEDOUT' || (opts.timeout && r.signal != null && !r.status);
  if (r.error && NEEDS_SHELL && !timedOut) {
    r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, ...opts });
  }
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  };
}

/**
 * Run `bd <args>` and return its stdout. A failure throws an Error naming the command and bd's
 * stderr, unless `allowFailure` is set, in which case it returns ''. `exec` is injectable.
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

/** `bd <args>` parsed as rows; see parseBdJsonRows. */
export function bdJson(args, opts = {}) {
  return parseBdJsonRows(bd(args, opts));
}

/**
 * bd 1.3 refuses to close a bead claimed by a different actor:
 *   cannot close <id>: assignee is "<assignee>", actor is "<actor>"; reclaim or use --force to override
 * Claims are per-session `<base>-bot-<session8>` actors while CI and nightly jobs run under one
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
 * bd's stderr on `error.stderr`). An assignee-mismatch refusal is retried once as that assignee.
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

/** How many hex chars of the session id the per-session actor id ends in. */
export const SESSION_SUFFIX_LEN = 8;

/**
 * The shape of a per-session actor id: `<base>-bot-<session8>` or `<base>-bot-<name>-<session8>`.
 * The same pattern the asks set's actor-id script uses, so an id is never distinct to one script
 * and shared to another.
 */
export const DISTINCT_ACTOR_RE = new RegExp(`-bot-(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[a-z0-9]{${SESSION_SUFFIX_LEN}}$`);

/**
 * This session's bd actor id. Asks the asks set's `agent-actor-id.mjs` when it is installed
 * beside this file (one derivation of the per-session id), else falls back to BEADS_ACTOR, else
 * '' (the caller then leaves the actor to bd's own default).
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof spawnSync, script?: string }} [opts]
 */
export function resolveActor({ env = process.env, run = spawnSync, script = siblingScript('agent-actor-id.mjs') } = {}) {
  if (existsSync(script)) {
    const r = run(process.execPath, [script], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const id = r && r.status === 0 ? String(r.stdout ?? '').trim() : '';
    if (id) return id;
  }
  return String(env.BEADS_ACTOR ?? '').trim();
}

/**
 * `bd dolt pull|push`, through the beads set's `bd-dolt-sync.mjs` when it is installed beside
 * this file (it VERIFIES the sync and exits non-zero when it cannot), a bare bd call otherwise.
 * @param {'pull'|'push'} verb
 * @returns {{ ok: boolean }}
 */
export function doltSync(verb, { run = spawnWithShellFallback, script = siblingScript('bd-dolt-sync.mjs') } = {}) {
  const r = existsSync(script) ? run(process.execPath, [script, verb], { stdio: 'inherit' }) : run(bdCli(), ['dolt', verb], { stdio: 'inherit' });
  return { ok: r.status === 0 };
}

export const syncPull = (opts) => doltSync('pull', opts);
export const syncPush = (opts) => doltSync('push', opts);

/** The routing label a person's ask carries: `ask-<person>`. */
export function askLabel(personKey) {
  return `ask-${String(personKey ?? '').trim().toLowerCase()}`;
}
