#!/usr/bin/env node
// Session phase log: the "pizza tracker" feed. A hook appends one line per milestone an agent
// session reaches (claim, coding, gates, push, PR, armed, landing, cleanup) so
// scripts/session-tracker.mjs can show where every live session is and how long each step took.
//
//   record   Hook entry (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse and
//            PostToolUseFailure on shell tools, PostToolUse on edit tools, Stop, SubagentStop,
//            SessionEnd). Reads the hook's stdin JSON and
//            appends one JSON line to <git common dir>/<prefix>-session-phases/<session>[--<agent>].jsonl.
//            Silent, and always exits 0: a log that fails to write must never block a tool call.
//
// Shell commands that match no phase are not logged, so a file stays a few hundred lines. The
// time between a command's PreToolUse and PostToolUse line is its wall time: `git push` covers the
// whole pre-push hook, which is the usual answer to "why is this session slow".
// The log lives in the COMMON git dir, like session-lock.mjs's records, so the viewer run from any
// checkout sees every worktree's sessions.
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callerSessionId, findCheckout } from './session-lock.mjs';

// Derived from the neutral-prefix token (as session-lock.mjs does) so a consumer's sync yields `<prefix>-session-phases`.
export const PHASE_DIR_NAME = 'AGENT_TOOLING_SESSION_PHASES'.toLowerCase().replaceAll('_', '-');
/** The longest command text kept on a line: enough to recognise it, never a whole heredoc. */
export const CMD_MAX = 160;
/** The longest first-prompt text kept as the session's label. */
export const LABEL_MAX = 80;

/** `git <sub>` with only global options between (`-c k=v`, `-C dir`, `--no-pager`), never `git log … push`. */
function GIT_SUBCOMMAND(sub) {
  return new RegExp(`\\bgit\\s+(?:-[cC]\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)*${sub}\\b`);
}

/**
 * The pizza-tracker steps, in the order a bead normally walks them. `diagnose` has no matcher:
 * it is the time from the session's start to its first other step.
 */
// The `gates` matcher includes verify-local.sh and verify.mjs as common gate wrapper names; they are
// harmless where those scripts do not exist.
export const PHASES = [
  { id: 'diagnose', label: 'diagnose' },
  { id: 'claim', label: 'claim', match: /\b(claim\.sh|worktree-new\.sh)\b/ },
  { id: 'coding', label: 'code a fix' },
  { id: 'gates', label: 'local gates', match: /\bnpm\s+(run\s+)?(test|lint|type-check|build)\b|\bverify-local\.sh\b|\bgate\.sh\b|\bverify\.mjs\b|\brun-node-tests\.mjs\b/ },
  { id: 'commit', label: 'commit', match: GIT_SUBCOMMAND('commit') },
  { id: 'push', label: 'push + pre-push hooks', match: GIT_SUBCOMMAND('push') },
  { id: 'pr', label: 'open PR', match: /\bgh\s+pr\s+create\b/ },
  { id: 'armed', label: 'arm auto-merge', match: /\bgh\s+pr\s+merge\b/ },
  { id: 'landing', label: 'CI + merge queue', match: /\bland\.sh\b|\bpr-queue-state\.mjs\b|\bgh\s+pr\s+(view|checks)\b/ },
  { id: 'cleanup', label: 'worktree deleted', match: /\bworktree-rm\.sh\b/ },
];

const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/**
 * The phase a shell command belongs to, or ''. A compound command counts as its LAST matching
 * step, so `git commit && git push` is a push.
 */
export function classifyCommand(command) {
  const text = String(command ?? '');
  let best = '';
  let bestAt = -1;
  for (const p of PHASES) {
    if (!p.match) continue;
    const re = new RegExp(p.match.source, 'g');
    let m;
    while ((m = re.exec(text))) {
      if (m.index > bestAt) {
        best = p.id;
        bestAt = m.index;
      }
    }
  }
  return best;
}

/** The branch a checkout is on, read from its HEAD file (no git spawn), or ''. */
export function readBranch(toplevel) {
  try {
    const dotGit = path.join(toplevel, '.git');
    let gitDir = dotGit;
    if (fs.statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
      if (!m) return '';
      gitDir = path.resolve(toplevel, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : '';
  } catch {
    return '';
  }
}

function oneLine(s, max) {
  const flat = String(s ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/**
 * The line to append for one hook payload, or null when the event is not a milestone.
 * Pure apart from nothing: the caller supplies the branch and the clock.
 */
export function entryFor(input, { now = Date.now(), branch = '', worktree = '' } = {}) {
  const ev = input?.hook_event_name || '';
  const base = { t: now, ev, ...(input?.agent_id ? { agent: input.agent_id } : {}), ...(branch ? { branch } : {}), ...(worktree ? { worktree } : {}) };
  if (ev === 'SessionStart' || ev === 'Stop' || ev === 'SessionEnd' || ev === 'SubagentStop') return base;
  if (ev === 'UserPromptSubmit') return { ...base, prompt: oneLine(input.prompt, LABEL_MAX) };
  if (ev !== 'PreToolUse' && ev !== 'PostToolUse' && ev !== 'PostToolUseFailure') return null;
  const tool = input.tool_name || '';
  if (EDIT_TOOLS.has(tool)) return ev === 'PostToolUse' ? { ...base, phase: 'coding', tool } : null;
  if (!SHELL_TOOLS.has(tool)) return null;
  const command = input.tool_input?.command;
  const phase = classifyCommand(command);
  // A failed command (a red pre-push hook fails `git push`) fires PostToolUseFailure, whose
  // payload is not documented to carry tool_input: keep its id so the viewer can close the span.
  if (!phase && ev === 'PostToolUseFailure' && input.tool_use_id) return { ...base, tool, id: input.tool_use_id };
  if (!phase) return null;
  return { ...base, phase, tool, cmd: oneLine(command, CMD_MAX), ...(input.tool_use_id ? { id: input.tool_use_id } : {}) };
}

export function phaseDir(commonDir) {
  return path.join(commonDir, PHASE_DIR_NAME);
}

function logFile(commonDir, sessionId, agentId) {
  const key = agentId ? `${sessionId}--${agentId}` : sessionId;
  return path.join(phaseDir(commonDir), `${key.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
}

/** Append this payload's line, if it is a milestone. Returns 'wrote' or 'skipped', for tests. */
export function record(input, { cwd, fallbackCwd = '', sessionId = '', now = Date.now() } = {}) {
  const session = input?.session_id || sessionId;
  if (!session || !cwd) return 'skipped';
  const co = findCheckout(cwd) ?? (fallbackCwd ? findCheckout(fallbackCwd) : null);
  if (!co) return 'skipped';
  const entry = entryFor(input, { now, branch: readBranch(co.toplevel), worktree: co.toplevel });
  if (!entry) return 'skipped';
  fs.mkdirSync(phaseDir(co.commonDir), { recursive: true });
  // One short appendFileSync is a single write; concurrent hooks cannot interleave inside it.
  fs.appendFileSync(logFile(co.commonDir, session, input?.agent_id), `${JSON.stringify({ session, ...entry })}\n`);
  return 'wrote';
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function main(argv) {
  if (argv[0] !== 'record') {
    process.stderr.write('usage: session-phase.mjs record   (a hook; the viewer is session-tracker.mjs)\n');
    return 2;
  }
  try {
    let input = {};
    try {
      input = JSON.parse(readStdin() || '{}');
    } catch {
      // no hook payload; nothing to record
    }
    record(input, {
      cwd: input.cwd || process.cwd(),
      fallbackCwd: process.env.CLAUDE_PROJECT_DIR || '',
      sessionId: callerSessionId(),
    });
  } catch {
    // never block a tool call over the tracker
  }
  return 0;
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
