#!/usr/bin/env node
// Session locks: a worktree a live agent session is in is never removed out from under it.
//
// Once, a live orchestrating lead's harness worktree was emptied and unregistered
// mid-session, so its next command ran with git resolving the PRIMARY checkout. A hook can make
// that state loud (refuse the command from an orphaned worktree directory); this stops the removal.
//
//   touch           Hook entry (SessionStart, PreToolUse on shell tools, PostToolUse on
//                   EnterWorktree, SubagentStop, SessionEnd). Reads the hook's stdin JSON and
//                   records "session <id> is in worktree <toplevel>" as
//                   <git common dir>/<prefix>-session-locks/<session id>[--<agent id>].json, or deletes
//                   it when the agent or session ends. Silent, and always exits 0: a lock that
//                   fails to write must never block a tool call.
//   check <path>    Exit 3, naming each one on stderr, when a live session OTHER than the
//                   caller's is in <path>; 0 when none is; 4 when <path> resolves to no checkout
//                   (a failed lookup, never "nobody is here"). worktree-rm.sh calls it.
//   filter-live     Reads worktree paths on stdin, prints back (verbatim) the ones a live
//                   session other than the caller's is in; exits 4 if a present path could not be
//                   read. worktree-rm.sh --stale calls it.
//
// One record per AGENT (a session's main thread, or one of its subagents), rewritten wherever
// that agent's shell commands run, so an agent that moves (EnterWorktree) leaves no lock behind
// on the worktree it left.
// The record lives in the COMMON git dir, the one every linked worktree shares, so a remover
// running anywhere in the checkout sees every session's record.
//
// A record is live while its process is alive (CLAUDE_PID, the Claude Code process every hook
// and tool command inherits) and it was refreshed within MAX_AGE_MS. Without a pid the
// shorter NO_PID_MAX_AGE_MS applies. A dead pid, or a record older than the cap, never blocks:
// a crashed session cannot pin a worktree forever, and an orphaned record is deleted when a
// check reads it.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Derived from the neutral-prefix token so a consumer's sync yields `<prefix>-session-locks` (the name
// existing consumer hooks already write). Never spell the literal: old and new hooks must agree.
export const LOCK_DIR_NAME = 'AGENT_TOOLING_SESSION_LOCKS'.toLowerCase().replaceAll('_', '-');
/** A record already this fresh, for the same worktree and pid, is not rewritten. */
export const REFRESH_MS = 5 * 60_000;
/** A live pid keeps a record live for this long after its session's last shell command. */
export const MAX_AGE_MS = 12 * 3_600_000;
/** With no pid to test, the record is live only this long. */
export const NO_PID_MAX_AGE_MS = 2 * 3_600_000;

/** The session-id variables a caller may carry, as agent-actor-id.mjs reads them. */
const SESSION_ENV = ['CLAUDE_CODE_SESSION_ID', 'CODEX_THREAD_ID'];

export function callerSessionId(env = process.env) {
  for (const name of SESSION_ENV) {
    const v = String(env[name] ?? '').trim();
    if (v) return v;
  }
  return '';
}

/**
 * A path in the host's own spelling. Git Bash hands node an MSYS `/c/x` path verbatim whenever
 * MSYS_NO_PATHCONV=1 is set (worktree-rm.sh's `pwd -P` is one), and win32 path.resolve reads
 * that as `C:\c\x`: every lookup then misses and the check passes, silently.
 */
export function nativePath(p, platform = process.platform) {
  const s = String(p);
  if (platform !== 'win32') return s;
  const msys = /^\/([a-zA-Z])(\/|$)/.exec(s);
  return msys ? `${msys[1]}:/${s.slice(3)}` : s;
}

/**
 * The checkout `start` is in: its toplevel and the common git dir, read from the filesystem
 * (no git spawn, since the hook runs on every shell command). Null outside any checkout.
 */
export function findCheckout(start) {
  let dir = path.resolve(nativePath(start));
  for (;;) {
    const dotGit = path.join(dir, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch {
      // not here; keep walking
    }
    if (st?.isDirectory()) return { toplevel: dir, commonDir: dotGit, linked: false };
    if (st?.isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return null;
      const gitDir = path.resolve(dir, m[1].trim());
      let commonDir = gitDir;
      try {
        commonDir = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
      } catch {
        // a gitdir with no commondir file is its own common dir
      }
      return { toplevel: dir, commonDir, linked: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * One spelling per directory, for comparison only: MSYS `/c/x` becomes `c:/x`, separators are
 * forward slashes, and case is folded on Windows, whose filesystem ignores it.
 */
export function pathKey(p, platform = process.platform) {
  let s = nativePath(p, platform);
  s = platform === 'win32' ? path.win32.resolve(s) : path.posix.resolve(s);
  if (platform === process.platform) {
    try {
      s = fs.realpathSync.native(s); // one spelling for a symlink or an 8.3 short name
    } catch {
      // a directory that is gone keeps its resolved spelling
    }
  }
  if (platform === 'win32') s = s.replace(/\\/g, '/').toLowerCase();
  return s.replace(/\/+$/, '') || '/';
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // alive, owned by someone else
  }
}

/** Whether a parsed record still pins its worktree. Pure apart from the injected isAlive. */
export function isLive(rec, { now = Date.now(), isAlive = isPidAlive } = {}) {
  if (!rec || typeof rec.touchedAt !== 'number' || !rec.worktree) return false;
  const age = now - rec.touchedAt;
  if (rec.pid) return age <= MAX_AGE_MS && isAlive(rec.pid);
  return age <= NO_PID_MAX_AGE_MS;
}

function lockDir(commonDir) {
  return path.join(commonDir, LOCK_DIR_NAME);
}

/**
 * One record per AGENT: the session's main thread, or one subagent of it. Subagents share their
 * parent's session id, so an orchestrating lead and its N workers would otherwise overwrite one
 * record, and only the worktree touched last would stay pinned. The hook payload names a
 * subagent with `agent_id`; the main thread has none.
 */
function lockFile(commonDir, sessionId, agentId) {
  const key = agentId ? `${sessionId}--${agentId}` : sessionId;
  return path.join(lockDir(commonDir), `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`);
}

/** Every record in the checkout, live or not. A record that cannot be parsed is skipped. */
export function readRecords(commonDir) {
  let names = [];
  try {
    names = fs.readdirSync(lockDir(commonDir)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(lockDir(commonDir), name);
    try {
      out.push({ file, rec: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      // half-written or foreign; not a lock
    }
  }
  return out;
}

/**
 * Record (or, at the end, drop) this agent's lock. Returns what it did, for tests:
 * 'wrote', 'fresh', 'removed', or 'skipped'. `fallbackCwd` (the project dir) finds the checkout
 * at SessionEnd when the session's own cwd no longer resolves to one.
 */
export function touch({ sessionId, agentId = '', cwd, fallbackCwd = '', pid, event, now = Date.now() }) {
  if (!sessionId || !cwd) return 'skipped';
  const co = findCheckout(cwd) ?? (fallbackCwd ? findCheckout(fallbackCwd) : null);
  if (!co) return 'skipped';
  const file = lockFile(co.commonDir, sessionId, agentId);
  if (event === 'SessionEnd') {
    // Every record the session holds, its subagents' included.
    for (const r of readRecords(co.commonDir)) {
      if (r.rec?.sessionId === sessionId) fs.rmSync(r.file, { force: true });
    }
    return 'removed';
  }
  if (event === 'SubagentStop') {
    // Without an agent id this would name the MAIN thread's record, which is still working.
    if (!agentId) return 'skipped';
    fs.rmSync(file, { force: true });
    return 'removed';
  }
  // The primary checkout is never a removal target, so an agent there needs no lock; and
  // writing one would leave its PREVIOUS worktree record in place, so drop that.
  if (!co.linked) {
    fs.rmSync(file, { force: true });
    return 'skipped';
  }
  const rec = { sessionId, ...(agentId ? { agentId } : {}), pid: pid || null, worktree: co.toplevel, touchedAt: now };
  try {
    const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pathKey(prev.worktree) === pathKey(rec.worktree) && prev.pid === rec.pid && now - prev.touchedAt < REFRESH_MS) {
      return 'fresh';
    }
  } catch {
    // no record yet
  }
  fs.mkdirSync(lockDir(co.commonDir), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(rec)}\n`);
  fs.renameSync(tmp, file);
  return 'wrote';
}

/**
 * The live records of OTHER sessions in `target`. A dead record read on the way is deleted.
 */
export function liveSessionsIn(target, { selfId = callerSessionId(), now = Date.now(), isAlive = isPidAlive } = {}) {
  const co = findCheckout(target);
  // A worktree path that resolves to no checkout is a lookup that failed, never "nobody is
  // here": say so, and let the caller decide (worktree-rm.sh warns).
  if (!co) throw new Error(`no git checkout found at ${target}`);
  const key = pathKey(target);
  const live = [];
  for (const { file, rec } of readRecords(co.commonDir)) {
    if (!isLive(rec, { now, isAlive })) {
      fs.rmSync(file, { force: true });
      continue;
    }
    if (rec.sessionId === selfId) continue;
    if (pathKey(rec.worktree) === key) live.push(rec);
  }
  return live;
}

function minutesAgo(ms, now) {
  const m = Math.round((now - ms) / 60_000);
  return m < 1 ? 'just now' : `${m} min ago`;
}

export function describe(rec, now = Date.now()) {
  const pid = rec.pid ? `pid ${rec.pid}` : 'no pid recorded';
  const who = rec.agentId ? `session ${rec.sessionId}, subagent ${rec.agentId}` : `session ${rec.sessionId}`;
  return `${who} (${pid}, last shell command ${minutesAgo(rec.touchedAt, now)})`;
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === 'touch') {
    try {
      let input = {};
      try {
        input = JSON.parse(readStdin() || '{}');
      } catch {
        // no hook payload; fall back to the environment
      }
      touch({
        sessionId: input.session_id || callerSessionId(),
        agentId: typeof input.agent_id === 'string' ? input.agent_id : '',
        cwd: input.cwd || process.cwd(),
        fallbackCwd: process.env.CLAUDE_PROJECT_DIR || '',
        pid: Number.parseInt(process.env.CLAUDE_PID ?? '', 10) || null,
        event: input.hook_event_name || '',
      });
    } catch {
      // never block a tool call over a lock
    }
    return 0;
  }
  if (cmd === 'check') {
    const target = rest[0];
    if (!target) {
      process.stderr.write('usage: session-lock.mjs check <worktree path>\n');
      return 2;
    }
    const now = Date.now();
    let live;
    try {
      live = liveSessionsIn(target, { now });
    } catch (e) {
      process.stderr.write(`session-lock: ${e.message}\n`);
      return 4;
    }
    for (const rec of live) process.stderr.write(`  ${describe(rec, now)}\n`);
    return live.length ? 3 : 0;
  }
  if (cmd === 'filter-live') {
    let failed = false;
    for (const p of readStdin().split(/\r?\n/).filter(Boolean)) {
      try {
        if (liveSessionsIn(p).length) process.stdout.write(`${p}\n`);
      } catch (e) {
        // A registered worktree whose directory is gone has nobody in it; anything else is a
        // failed read, reported without dropping the paths that did resolve.
        if (fs.existsSync(nativePath(p))) {
          process.stderr.write(`session-lock: ${e.message}\n`);
          failed = true;
        }
      }
    }
    return failed ? 4 : 0;
  }
  process.stderr.write('usage: session-lock.mjs touch | check <path> | filter-live\n');
  return 2;
}

/** True when this file is the script node was started on. Both sides go through realpath, so a symlinked or 8.3-short-named path still matches. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
