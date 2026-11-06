// The small bd, actor and dolt-sync plumbing the hygiene scripts share (epic-hygiene, idea-inbox,
// oddity). A vendored set may import only base files and its own files, so the hygiene set carries
// its own copy of the few helpers it needs instead of importing the beads or asks sets:
//
//   - the no-shell-first spawn with its win32 shell fallback
//   - (re-exported from lib/bd-cli.mjs in base: the synchronous `bd` caller, the assignee-mismatch close retry)
//   - the per-session actor id: the CLI of the asks set when it is installed, BEADS_ACTOR otherwise
//   - dolt pull and push: the CLI of the beads set when it is installed (it verifies the sync),
//     a bare `bd dolt pull|push` otherwise
//
// Dependency-free (node: builtins only).
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { bd, bdCloseAsAssignee, bdJson, closeRefusalAssignee, CLOSE_ASSIGNEE_REFUSAL_RE, parseBdJsonRows, BD_MAX_BUFFER, BD_TIMEOUT_MS } from './lib/bd-cli.mjs';

// The synchronous bd caller, its JSON row parser and the assignee-mismatch close retry live in
// lib/bd-cli.mjs (base); they are re-exported so the hygiene scripts keep one import.
export { bd, bdCloseAsAssignee, bdJson, closeRefusalAssignee, CLOSE_ASSIGNEE_REFUSAL_RE, parseBdJsonRows, BD_MAX_BUFFER, BD_TIMEOUT_MS };

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** A sibling script of this file, by file name (`bd-dolt-sync.mjs`). */
export const siblingScript = (name) => path.join(HERE, name);

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
  // Reported as `timedOut` so the caller can say what happened rather than printing a bare
  // non-zero exit code.
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

/** How many hex chars of the session id the per-session actor id ends in. */
export const SESSION_SUFFIX_LEN = 8;

/**
 * The shape of a per-session actor id: `<base>-bot-<session8>` or `<base>-bot-<name>-<session8>`.
 * The same pattern the asks set's actor-id script uses, so an id is never distinct to one script
 * and shared to another.
 */
export const DISTINCT_ACTOR_RE = new RegExp(`-bot-(?:[a-z0-9]+(?:-[a-z0-9]+)*-)?[a-z0-9]{${SESSION_SUFFIX_LEN}}$`);

/** Slug a human name into an identifier-safe base ("Ann Lee" -> "ann-lee"); the rule agent-actor-id.mjs uses. */
export function slugifyActorBase(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readGitUserName() {
  try {
    return execFileSync('git', ['config', 'user.name'], { encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/**
 * This session's bd actor id. Asks the asks set's `agent-actor-id.mjs` when it is installed
 * beside this file (one derivation of the per-session id). Without it: BEADS_ACTOR, else the
 * slug of BEADS_ACTOR_BASE, `git config user.name` or $USER (a shared name, not session-distinct),
 * else '' (the caller then leaves the actor to bd's own default).
 * @param {{ env?: NodeJS.ProcessEnv, run?: typeof spawnSync, script?: string, gitUserName?: () => string }} [opts]
 */
export function resolveActor({ env = process.env, run = spawnSync, script = siblingScript('agent-actor-id.mjs'), gitUserName = readGitUserName } = {}) {
  if (existsSync(script)) {
    const r = run(process.execPath, [script], { encoding: 'utf8', env, timeout: 10_000, stdio: ['ignore', 'pipe', 'ignore'] });
    const id = r && r.status === 0 ? String(r.stdout ?? '').trim() : '';
    if (id) return id;
  }
  const explicit = String(env.BEADS_ACTOR ?? '').trim();
  if (explicit) return explicit;
  return slugifyActorBase(String(env.BEADS_ACTOR_BASE ?? '').trim() || gitUserName() || String(env.USER ?? env.USERNAME ?? '').trim());
}

/**
 * `bd dolt pull|push`, through the beads set's `bd-dolt-sync.mjs` when it is installed beside
 * this file (it VERIFIES the sync and exits non-zero when it cannot), a bare bd call otherwise.
 * @param {'pull'|'push'} verb
 * @returns {{ ok: boolean }}
 */
export function doltSync(verb, { run = spawnWithShellFallback, script = siblingScript('bd-dolt-sync.mjs'), warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  if (existsSync(script)) return { ok: run(process.execPath, [script, verb], { stdio: 'inherit' }).status === 0 };
  warn(`[hygiene] WARNING: dolt ${verb} sync NOT verified (beads set not installed): running a bare \`bd dolt ${verb}\`.`);
  return { ok: run(bdCli(), ['dolt', verb], { stdio: 'inherit' }).status === 0 };
}

export const syncPull = (opts) => doltSync('pull', opts);
export const syncPush = (opts) => doltSync('push', opts);

/** The routing label a person's ask carries: `ask-<person>`. */
export function askLabel(personKey) {
  return `ask-${String(personKey ?? '').trim().toLowerCase()}`;
}
