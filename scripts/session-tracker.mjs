#!/usr/bin/env node
// Session tracker: a "pizza tracker" over every agent session in this checkout.
// Reads the lines scripts/session-phase.mjs appends from its hooks and prints one block per
// session: each step it reached, the wall time spent in it, the step it is in now, any command
// still running, the time it sat waiting on you, and its slowest step.
//
//   node scripts/session-tracker.mjs                 live sessions (an event in the last 12h, no SessionEnd)
//   node scripts/session-tracker.mjs --all           ended sessions too
//   node scripts/session-tracker.mjs --since 2h      only sessions active in that window (m, h or d)
//   node scripts/session-tracker.mjs --watch [sec]   redraw in place every sec seconds (default 10); appends off a TTY
//   node scripts/session-tracker.mjs --json          the timelines, for a script or a dashboard
//   node scripts/session-tracker.mjs --prom-dir <d>  also write <d>/agent_sessions_<writer>.prom for node_exporter
//
// Grafana: `--prom-dir` writes the node_exporter textfile behind the CI - Agent
// sessions dashboard. The jobs dashboard's 5-minute refresh writes it too, into its own --prom-dir,
// so a host that already reports scheduled jobs reports its sessions with no new task.
//
// A step's time runs from the first event that entered it to the first event of the next step,
// minus the time the session was stopped waiting on you, which is reported separately. A session
// that goes back to an earlier step (gates fail, back to coding) adds to that step's total.
// Logs older than RETENTION_MS are deleted when the tracker reads them.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLoadConfig } from './agent-tooling-config.mjs';
import { escapePromLabel, promWriter } from './lib/prom-text.mjs';
import { findCheckout } from './session-lock.mjs';
import { PHASES, phaseDir } from './session-phase.mjs';

export const RETENTION_MS = 7 * 86_400_000;
export const DEFAULT_SINCE_MS = 12 * 3_600_000;
/** A step shorter than this is never called the slowest: it is noise, not a bottleneck. */
export const SLOWEST_MIN_MS = 60_000;
/**
 * The Bash and PowerShell tools' hard cap on a foreground command (600000 ms). A command that
 * reaches it is cut off by the harness (moved to the background, or killed on older builds) and
 * PostToolUse still fires as if it had finished, so its span lands within a few seconds of 10m00s.
 * The 2026-11-04 logs had 16 of them between 600.4s and 604.3s.
 */
export const SHELL_CAP_MS = 600_000;
/**
 * How far under the cap a span may end and still count as a cap hit: hook and clock jitter only.
 * Kept tight because a command that genuinely finishes at 595-599s returned a real verdict; every
 * observed cap hit ended AFTER 600s, since PostToolUse fires once the harness has moved it aside.
 */
export const CAP_SLACK_MS = 1_000;
/**
 * How far past the cap a span may end and still count as one. The cap moves the command aside and
 * PostToolUse follows within seconds; a span far beyond it was not ended by the cap (a hung hook,
 * a missing Post matched to a later one) and stays a plain "longest command".
 */
export const CAP_OVERRUN_MS = 60_000;
/** What to do instead, printed under a session that hit the cap. */
export const CAP_REMEDY = 'run long gates with run_in_background through bash scripts/gate.sh --name <slug> and read the verdict from .tmp-gates/<slug>.log';

/**
 * True when a finished foreground command ran long enough that the shell cap, not the command,
 * ended it. Only the DEFAULT cap is recognised: a call with a smaller Bash `timeout` parameter
 * (say 300000) is cut off at that value, which the phase log does not record, so such a span reads
 * as an ordinary (uncapped) command here.
 */
export function hitShellCap(ms) {
  return ms >= SHELL_CAP_MS - CAP_SLACK_MS && ms <= SHELL_CAP_MS + CAP_OVERRUN_MS;
}

/**
 * A prompt the harness wrote, not a person: it opens with a tag (`<system-reminder>`,
 * `<scheduled-task name=...>`, `<cross-session-message>`, `<task-notification>`, ...). Every
 * harness-started session's first UserPromptSubmit is one, so as a title it made the rows
 * indistinguishable.
 */
export function isHarnessPrompt(prompt) {
  return /^\s*<[a-zA-Z][\w-]*[\s>]/.test(String(prompt ?? ''));
}

/** Branches that say nothing about the work: the primary checkout's. */
const GENERIC_BRANCHES = new Set(['main', 'master', 'HEAD']);

/** The row title: the branch when it names the work, else the first human prompt, else the session id. */
export function sessionTitle(tl) {
  if (tl.scheduledTask) return `scheduled: ${tl.scheduledTask}`;
  if (tl.branch && !GENERIC_BRANCHES.has(tl.branch)) return tl.branch;
  return tl.label || tl.branch || String(tl.session ?? '').slice(0, 8);
}

export function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${String(m % 60).padStart(2, '0')}m`;
  return `${Math.floor(h / 24)}d${String(h % 24).padStart(2, '0')}h`;
}

export function parseSince(text) {
  const m = /^(\d+)\s*([mhd])$/.exec(String(text ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

/** A step's position in the tracker; an unknown id sorts last. */
export function phaseIndex(id) {
  const i = PHASES.findIndex((p) => p.id === id);
  return i < 0 ? PHASES.length : i;
}

/**
 * Steps that cannot happen without the ones listed: a push means a commit, and a PR was pushed
 * first. Only the safe implications; `landing` (`gh pr view`) and `armed` also fire on someone
 * else's PR, so they imply nothing.
 */
export const IMPLIED_STEPS = Object.freeze({ push: ['commit'], pr: ['commit', 'push'] });

/**
 * The steps only the bead workflow reaches. A session that reached none of them (a research or
 * chat session that only read, edited or ran tests) is not walking a bead, so the tracker shows
 * it without the step list instead of a row of empty boxes.
 */
export const BEAD_STEPS = Object.freeze(['claim', 'commit', 'push', 'pr', 'armed', 'landing', 'cleanup']);

/** The task name of a scheduled-task prompt (`<scheduled-task name="release-notes-check" ...>`), or null. */
export function scheduledTaskName(prompt) {
  const m = /^\s*<scheduled-task\b([^>]*)/.exec(String(prompt ?? ''));
  if (!m) return null;
  return /\bname="([^"]*)/.exec(m[1])?.[1] || 'task';
}

/**
 * A regex for a branch that names a bead (`<prefix>-<id>`, case-insensitive), or null when the
 * consumer set no `beadPrefix`: without a prefix any hyphenated branch would look like one.
 */
export function beadBranchPattern(prefix) {
  const p = String(prefix ?? '').replace(/[^A-Za-z0-9]/g, '');
  return p ? new RegExp(`\\b${p}-[a-z0-9]{4,}`, 'i') : null;
}

let configuredBeadPrefix;
/** The consumer's `beadPrefix` from agent-tooling.json, read once; '' when unset or the config is unreadable. */
function defaultBeadPrefix() {
  configuredBeadPrefix ??= tryLoadConfig().config.beadPrefix ?? '';
  return configuredBeadPrefix;
}

/**
 * What kind of session a timeline is: `scheduled` (started by a scheduled task: it waits on no
 * one, so it is never "waiting on you"), `bead` (it reached a bead-workflow step, or its branch
 * names a bead) or `plain` (neither). Only `bead` sessions are drawn with the step list.
 */
export function sessionKind(tl, { beadPrefix = defaultBeadPrefix() } = {}) {
  if (tl.scheduledTask) return 'scheduled';
  if (tl.reached.some((id) => BEAD_STEPS.includes(id)) || beadBranchPattern(beadPrefix)?.test(tl.branch)) return 'bead';
  return 'plain';
}

/**
 * One session's timeline from its log lines. Pure: the caller supplies the clock.
 * `stages` holds the wall time spent in each step id; `running` the commands with a PreToolUse
 * line and no PostToolUse yet.
 */
export function buildTimeline(entries, now = Date.now(), { beadPrefix } = {}) {
  const evs = [...entries].filter((e) => typeof e?.t === 'number').sort((a, b) => a.t - b.t);
  const tl = {
    session: evs[0]?.session ?? '',
    agent: evs.find((e) => e.agent)?.agent ?? '',
    label: '',
    scheduledTask: '',
    kind: 'plain',
    branch: '',
    worktree: '',
    startedAt: evs[0]?.t ?? now,
    lastAt: evs[0]?.t ?? now,
    stage: 'diagnose',
    reached: ['diagnose'],
    stages: {},
    waitingMs: 0,
    waiting: false,
    // Set for a scheduled task only, but present on every kind so --json has one shape.
    idle: false,
    idleMs: 0,
    ended: false,
    running: [],
    longestCommand: null,
    capHits: [],
  };
  if (!evs.length) return tl;
  let stageStart = tl.startedAt;
  let waitingSince = null;
  let sawPrompt = false;
  const open = new Map();
  const addStage = (until) => {
    tl.stages[tl.stage] = (tl.stages[tl.stage] ?? 0) + Math.max(0, until - stageStart);
  };
  for (const e of evs) {
    tl.lastAt = e.t;
    if (e.branch) tl.branch = e.branch;
    if (e.worktree) tl.worktree = e.worktree;
    if (waitingSince !== null && e.ev !== 'Stop' && e.ev !== 'SessionEnd') {
      tl.waitingMs += e.t - waitingSince;
      waitingSince = null;
      stageStart = e.t;
    }
    // Only the FIRST prompt says how the session started; a later one quoting a task is chat.
    if (e.ev === 'UserPromptSubmit' && !sawPrompt) {
      sawPrompt = true;
      tl.scheduledTask = scheduledTaskName(e.prompt) ?? '';
    }
    if (e.ev === 'UserPromptSubmit' && !tl.label && e.prompt && !isHarnessPrompt(e.prompt)) tl.label = e.prompt;
    // A turn that ended runs no foreground command: one still open was blocked by a PreToolUse
    // guard, which leaves a PreToolUse line with no PostToolUse.
    if (e.ev === 'Stop' || e.ev === 'SessionEnd' || e.ev === 'SubagentStop') open.clear();
    if (e.ev === 'Stop' && waitingSince === null) {
      addStage(e.t);
      waitingSince = e.t;
      continue;
    }
    // A subagent has no SessionEnd: its SubagentStop is its end.
    if (e.ev === 'SessionEnd' || (e.ev === 'SubagentStop' && e.agent)) {
      if (waitingSince === null) addStage(e.t);
      else tl.waitingMs += e.t - waitingSince;
      waitingSince = null;
      tl.ended = true;
      break;
    }
    if (e.phase && e.phase !== tl.stage) {
      addStage(e.t);
      tl.stage = e.phase;
      stageStart = e.t;
      if (!tl.reached.includes(e.phase)) tl.reached.push(e.phase);
    }
    const key = e.id || e.cmd;
    // Later evidence settles an earlier step: once the session acts in a LATER step, a command of
    // an earlier step left open (its PostToolUse never came, or came under a different id) is not
    // in the foreground any more, so it stops showing as running (a push "running 1h03m" beside
    // an open PR and the merge queue).
    if (e.phase) {
      const at = phaseIndex(e.phase);
      for (const [k, o] of open) if (k !== key && phaseIndex(o.phase) < at) open.delete(k);
    }
    if (e.ev === 'PreToolUse' && key) open.set(key, e);
    if ((e.ev === 'PostToolUse' || e.ev === 'PostToolUseFailure') && key && open.has(key)) {
      const pre = open.get(key);
      open.delete(key);
      const ms = e.t - pre.t;
      const span = { cmd: pre.cmd, phase: pre.phase, ms, ...(e.ev === 'PostToolUseFailure' ? { failed: true } : {}) };
      // A capped command goes to capHits only, so `longestCommand` stays the longest command that
      // actually finished: an 8m gate still shows beside a 10m cap hit.
      if (hitShellCap(ms)) tl.capHits.push(span);
      else if (!tl.longestCommand || ms > tl.longestCommand.ms) tl.longestCommand = span;
    }
  }
  if (!tl.ended) {
    if (waitingSince === null) addStage(now);
    else {
      tl.waitingMs += now - waitingSince;
      tl.waiting = true;
    }
  }
  // A step that implies earlier ones marks them reached even when no command of theirs matched
  // (`git commit && git push && gh pr create` classifies as the PR alone), so they never read as
  // skipped beside the step that needed them.
  for (const id of [...tl.reached]) {
    for (const before of IMPLIED_STEPS[id] ?? []) if (!tl.reached.includes(before)) tl.reached.push(before);
  }
  tl.reached.sort((a, b) => phaseIndex(a) - phaseIndex(b));
  tl.kind = sessionKind(tl, beadPrefix === undefined ? undefined : { beadPrefix });
  // A scheduled task that stopped has finished its run: it is idle, not waiting on anyone.
  if (tl.kind === 'scheduled') {
    tl.idle = tl.waiting;
    tl.idleMs = tl.waitingMs;
    tl.waiting = false;
    tl.waitingMs = 0;
  }
  const until = tl.ended ? tl.lastAt : now;
  tl.running = [...open.values()].map((e) => ({ cmd: e.cmd, phase: e.phase, ms: until - e.t }));
  return tl;
}

/** The id of the step that took longest, or '' when none passed SLOWEST_MIN_MS. */
export function slowestStage(tl) {
  let best = '';
  let bestMs = SLOWEST_MIN_MS - 1;
  for (const [id, ms] of Object.entries(tl.stages)) {
    if (ms > bestMs) {
      best = id;
      bestMs = ms;
    }
  }
  return best;
}

const ANSI = { cyan: '\x1b[36m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m' };

/** One session as text lines, wrapped at `width`. */
export function renderTimeline(tl, { now = Date.now(), width = 120, color = false } = {}) {
  const c = (name, s) => (color ? `${ANSI[name]}${s}${ANSI.reset}` : s);
  const slow = slowestStage(tl);
  const lastReached = Math.max(...tl.reached.map((id) => PHASES.findIndex((p) => p.id === id)));
  const steps = PHASES.map((p, i) => {
    const ms = tl.stages[p.id];
    const isNow = p.id === tl.stage && !tl.ended;
    const mark = isNow ? '▶' : tl.reached.includes(p.id) ? 'x' : i < lastReached ? '-' : ' ';
    let s = `[${mark}] ${p.label}${ms !== undefined ? ` ${formatDuration(ms)}` : ''}`;
    if (p.id === slow) s = `${s} ◀ slowest`;
    if (p.id === slow) return c('yellow', s);
    return isNow ? c('cyan', s) : mark === ' ' || mark === '-' ? c('dim', s) : s;
  });
  const title = sessionTitle(tl);
  const meta = [tl.branch && tl.branch !== title ? tl.branch : '', tl.label && tl.label !== title ? tl.label : '', tl.agent ? `subagent ${tl.agent.slice(0, 8)}` : '', `up ${formatDuration((tl.ended ? tl.lastAt : now) - tl.startedAt)}`]
    .filter(Boolean)
    .join(' · ');
  const state = tl.ended
    ? 'ended'
    : tl.idle
      ? `idle ${formatDuration(now - tl.lastAt)}`
      : tl.waiting
        ? `waiting on you ${formatDuration(now - tl.lastAt)}`
        : `in ${PHASES.find((p) => p.id === tl.stage)?.label ?? tl.stage}`;
  const out = [`${c('bold', `● ${title}`)}  ${c('dim', `(${meta})`)}  ${state}`];
  // Only a bead session walks the steps; any other draws its state, commands and waits alone.
  if ((tl.kind ?? 'bead') !== 'bead') steps.length = 0;
  // Wrap the steps on their own lines, two spaces apart, without splitting a step.
  const visible = (s) => s.replace(/\x1b\[[0-9;]*m/g, '').length;
  let line = '   ';
  for (const s of steps) {
    if (visible(line) > 3 && visible(line) + 2 + visible(s) > width) {
      out.push(line);
      line = '   ';
    }
    line = visible(line) > 3 ? `${line}  ${s}` : `${line}${s}`;
  }
  if (steps.length) out.push(line);
  for (const r of tl.running) out.push(`   ${c('cyan', `running ${formatDuration(r.ms)}:`)} ${r.cmd}`);
  const extras = [];
  if (tl.waitingMs >= 1000) extras.push(`waited on you ${formatDuration(tl.waitingMs)} in all`);
  const lc = tl.longestCommand;
  if (lc && lc.ms >= SLOWEST_MIN_MS) extras.push(`longest command ${formatDuration(lc.ms)}${lc.failed ? ' (failed)' : ''}: ${lc.cmd}`);
  if (extras.length) out.push(`   ${c('dim', extras.join(' · '))}`);
  const hits = tl.capHits ?? [];
  if (hits.length) {
    const n = hits.length === 1 ? '1 command' : `${hits.length} commands`;
    const last = hits[hits.length - 1];
    out.push(`   ${c('yellow', `${n} hit the ${formatDuration(SHELL_CAP_MS)} shell cap (cut off, no verdict):`)}${last.failed ? ' (failed)' : ''} ${last.cmd}`);
    out.push(`   ${c('dim', `fix: ${CAP_REMEDY}`)}`);
  }
  return out;
}

/**
 * Every session log under `commonDir`, parsed into timelines, newest activity first. Logs past
 * RETENTION_MS are deleted on the way. A line that does not parse is skipped.
 */
export function loadTimelines(commonDir, { now = Date.now(), prune = true } = {}) {
  const dir = phaseDir(commonDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      if (prune && now - fs.statSync(file).mtimeMs > RETENTION_MS) {
        fs.rmSync(file, { force: true });
        continue;
      }
      const entries = [];
      for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // a torn line; the rest of the log still counts
        }
      }
      if (entries.length) out.push(buildTimeline(entries, now));
    } catch {
      // unreadable log; skip it
    }
  }
  return out.sort((a, b) => b.lastAt - a.lastAt);
}

export function selectTimelines(timelines, { now = Date.now(), all = false, sinceMs = DEFAULT_SINCE_MS } = {}) {
  return timelines.filter((tl) => now - tl.lastAt <= sinceMs && (all || !tl.ended));
}

// ---------- Prometheus textfile ----------

/**
 * The one file name this process writes into a textfile directory: one per writer (promWriter), so a
 * Windows host and its WSL distro sharing one textfile dir never replace each other's file.
 */
export const SESSION_PROM_FILE = `agent_sessions_${promWriter()}.prom`;
/** The name every writer shared before the per-writer file names; removed (when it is the tracker's) after each write. */
export const LEGACY_SESSION_PROM_FILE = 'agent_sessions.prom';
/** The first line renderSessionProm writes: how an existing file is recognised as the tracker's own. */
export const SESSION_PROM_HEADER = '# HELP agent_session_info ';
export const QUANTILES = [0.5, 0.9];

/**
 * The step totals a session has FINISHED: every step it reached except the one it is still in.
 * Only these feed the duration summary, so a step half-way through never drags a quantile down.
 */
export function finishedStages(tl) {
  return Object.entries(tl.stages).filter(([id]) => tl.ended || id !== tl.stage);
}

/** Nearest-rank quantile of a sorted array; null when it is empty. */
export function quantile(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/**
 * The node_exporter textfile for the CI - Agent sessions dashboard. Live series carry a short
 * session id (8 characters, plus the subagent's), the branch and the title (capped), so a
 * series' size stays bounded; the summary has only `step` and `quantile`, so its cardinality is
 * fixed. No host label: Prometheus adds the scrape target's `instance`. Every series carries
 * `writer`, so two writers sharing one textfile dir never emit the same series.
 * `live` is the sessions to show as running now; `all` is every timeline in the log (7 days),
 * which the duration summary is computed over.
 */
export function renderSessionProm({ live, all, now = Date.now(), writer = promWriter() }) {
  const cap = (s, n) => String(s ?? '').slice(0, n);
  const lines = [];
  const family = (name, help, type = 'gauge') => lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
  const labels = (o) => `{${Object.entries({ ...o, writer }).map(([k, v]) => `${k}="${escapePromLabel(v)}"`).join(',')}}`;
  const secs = (ms) => (ms / 1000).toFixed(3);
  const ids = (tl) => ({ session: cap(tl.session, 8), agent: cap(tl.agent, 8) });
  const stepIndex = (id) => PHASES.findIndex((p) => p.id === id);

  family('agent_session_info', 'One series per live agent session; value 1. title is the branch (or the first human prompt); kind is bead, scheduled or plain.');
  for (const tl of live) lines.push(`agent_session_info${labels({ ...ids(tl), branch: cap(tl.branch, 120), title: cap(sessionTitle(tl), 80), kind: tl.kind ?? 'bead' })} 1`);

  family('agent_session_step', 'The step a live session is in now: value is its position in the tracker (0 = diagnose).');
  for (const tl of live) lines.push(`agent_session_step${labels({ ...ids(tl), step: tl.stage })} ${stepIndex(tl.stage)}`);

  family('agent_session_step_seconds', 'Wall time a live session has spent in each step so far, waiting on the user excluded.');
  for (const tl of live) {
    for (const p of PHASES) {
      if (tl.stages[p.id] !== undefined) lines.push(`agent_session_step_seconds${labels({ ...ids(tl), step: p.id })} ${secs(tl.stages[p.id])}`);
    }
  }

  family('agent_session_waiting', '1 while a live session is stopped waiting on the user.');
  for (const tl of live) lines.push(`agent_session_waiting${labels(ids(tl))} ${tl.waiting ? 1 : 0}`);

  family('agent_session_waiting_seconds', 'Total time a live session has spent stopped waiting on the user.');
  for (const tl of live) lines.push(`agent_session_waiting_seconds${labels(ids(tl))} ${secs(tl.waitingMs)}`);

  family('agent_session_running_seconds', 'Age of the oldest command a live session is still running, by its step (absent when none).');
  for (const tl of live) {
    const oldest = [...tl.running].sort((a, b) => b.ms - a.ms)[0];
    if (oldest) lines.push(`agent_session_running_seconds${labels({ ...ids(tl), step: oldest.phase })} ${secs(oldest.ms)}`);
  }

  // A live-session gauge like the families above: one series per live session, its count of
  // foreground commands cut off at the shell cap so far (0 when none). Ended sessions drop out.
  family('agent_session_cap_hits', 'Live sessions only: foreground shell commands this session ran into the 10m tool cap (cut off, no verdict).');
  for (const tl of live) lines.push(`agent_session_cap_hits${labels(ids(tl))} ${(tl.capHits ?? []).length}`);

  family('agent_session_step_duration_seconds', 'Per-session time spent in each step, over every finished step of a bead session in the 7-day log.', 'summary');
  // Bead sessions only: a scheduled task's or a chat session's "diagnose" is not a bead's.
  const beads = all.filter((tl) => (tl.kind ?? 'bead') === 'bead');
  for (const p of PHASES) {
    const values = beads.flatMap((tl) => finishedStages(tl).filter(([id]) => id === p.id).map(([, ms]) => ms / 1000)).sort((a, b) => a - b);
    for (const q of QUANTILES) {
      const v = quantile(values, q);
      if (v !== null) lines.push(`agent_session_step_duration_seconds${labels({ step: p.id, quantile: String(q) })} ${v.toFixed(3)}`);
    }
    lines.push(`agent_session_step_duration_seconds_sum${labels({ step: p.id })} ${values.reduce((a, b) => a + b, 0).toFixed(3)}`);
    lines.push(`agent_session_step_duration_seconds_count${labels({ step: p.id })} ${values.length}`);
  }

  family('agent_sessions_generated_timestamp_seconds', 'When this file was written.');
  lines.push(`agent_sessions_generated_timestamp_seconds${labels({})} ${secs(now)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Why `file` must not be the textfile destination, or null when it may be. The write renames over
 * it, so it only ever replaces the tracker's own file: the name is exactly SESSION_PROM_FILE (or
 * LEGACY_SESSION_PROM_FILE, which is only ever removed), and an existing file starts with
 * SESSION_PROM_HEADER. `existing` is its first bytes, or null when absent.
 */
export function sessionPromProblem(file, existing) {
  const name = path.basename(String(file));
  if (name !== SESSION_PROM_FILE && name !== LEGACY_SESSION_PROM_FILE) return `${file}: the session tracker only writes ${SESSION_PROM_FILE}`;
  if (existing !== null && existing !== undefined && !String(existing).startsWith(SESSION_PROM_HEADER)) {
    return `${file} exists and was not written by the session tracker; refusing to replace it`;
  }
  return null;
}

function headOf(file) {
  try {
    return fs.readFileSync(file, 'utf8').slice(0, 200);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write `<promDir>/agent_sessions_<writer>.prom` from the logs under `commonDir`, atomically: a fresh
 * O_EXCL temp file (ending .tmp, which the textfile collector ignores) renamed into place, as
 * jobs-dashboard.mjs's writeAtomic does. Returns the file written.
 */
export function writeSessionProm(promDir, { commonDir, now = Date.now() }) {
  if (!fs.existsSync(promDir)) throw new Error(`--prom-dir ${promDir} does not exist (node_exporter's --collector.textfile.directory)`);
  const file = path.join(path.resolve(promDir), SESSION_PROM_FILE);
  const problem = sessionPromProblem(file, headOf(file));
  if (problem) throw new Error(problem);
  const all = loadTimelines(commonDir, { now });
  const content = renderSessionProm({ live: selectTimelines(all, { now }), all, now });
  // The ownership check above guards against a mistyped --prom-dir; it is not a security boundary,
  // and no check-then-rename can be one (POSIX rename has no compare-and-swap). What must hold is
  // that nothing is written THROUGH a link: the temp file is O_EXCL ('wx'), which refuses a planted
  // link, and rename replaces a symlink at `file` rather than its target. A test pins the latter.
  const tmp = `${file}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { flag: 'wx', mode: 0o644 });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  // The shared earlier shared name would keep serving frozen sessions beside the new file.
  const legacy = path.join(path.dirname(file), LEGACY_SESSION_PROM_FILE);
  const legacyHead = headOf(legacy);
  if (legacyHead !== null && !sessionPromProblem(legacy, legacyHead)) fs.rmSync(legacy, { force: true });
  return file;
}

/**
 * One `--watch` frame. On a TTY it redraws IN PLACE: the first frame clears the screen, every
 * frame homes the cursor, ends each line with erase-to-end-of-line and the frame with
 * erase-below, so nothing scrolls; a frame taller than the terminal is cut to fit with a count of
 * what was left out, since a frame that scrolls cannot be redrawn from the top. Off a TTY (a pipe,
 * a log, an agent's tool output) escape codes are noise, so each frame is appended plainly.
 */
export function watchFrame(header, body, { tty, first = false, rows = 0 } = {}) {
  let lines = `${header}\n\n${body}`.replace(/\n$/, '').split('\n');
  if (!tty) return `${lines.join('\n')}\n\n`;
  if (rows > 1 && lines.length > rows - 1) {
    const keep = rows - 2;
    lines = [...lines.slice(0, keep), `… ${lines.length - keep} more lines (widen or heighten the terminal)`];
  }
  return `${first ? '\x1b[2J' : ''}\x1b[H${lines.map((l) => `${l}\x1b[K`).join('\n')}\n\x1b[J`;
}

function parseArgs(argv) {
  const opts = { all: false, json: false, watch: 0, sinceMs: DEFAULT_SINCE_MS, promDir: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--watch') {
      const n = Number(argv[i + 1]);
      opts.watch = Number.isFinite(n) && n > 0 ? (i++, n) : 10;
    } else if (a === '--since') {
      const ms = parseSince(argv[++i]);
      if (ms === null) throw new Error(`--since takes a number and m, h or d (e.g. 2h), not ${argv[i]}`);
      opts.sinceMs = ms;
    } else if (a === '--prom-dir') {
      opts.promDir = argv[++i] ?? '';
      if (!opts.promDir) throw new Error('--prom-dir takes the node_exporter textfile directory');
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

function draw(commonDir, opts) {
  const now = Date.now();
  const shown = selectTimelines(loadTimelines(commonDir, { now }), { now, ...opts });
  if (opts.json) return `${JSON.stringify(shown, null, 2)}\n`;
  const width = process.stdout.columns || 120;
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
  if (!shown.length) {
    return `No ${opts.all ? '' : 'live '}sessions logged in the last ${formatDuration(opts.sinceMs)}. Sessions log once their checkout's .claude/settings.json registers scripts/session-phase.mjs.\n`;
  }
  return `${shown.map((tl) => renderTimeline(tl, { now, width, color }).join('\n')).join('\n\n')}\n`;
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`session-tracker: ${e.message}\n`);
    return 2;
  }
  const co = findCheckout(process.cwd());
  if (!co) {
    process.stderr.write('session-tracker: run it from inside a checkout of this repo\n');
    return 2;
  }
  // The textfile, when asked for; a failed write is reported and, in a one-shot run, fails it.
  const exportProm = () => {
    if (!opts.promDir) return true;
    try {
      writeSessionProm(opts.promDir, { commonDir: co.commonDir });
      return true;
    } catch (e) {
      process.stderr.write(`session-tracker: ${e.message}\n`);
      return false;
    }
  };
  if (!opts.watch) {
    const wrote = exportProm();
    process.stdout.write(draw(co.commonDir, opts));
    return wrote ? 0 : 1;
  }
  let first = true;
  const tick = () => {
    exportProm();
    const header = `${new Date().toLocaleTimeString()}  (every ${opts.watch}s, Ctrl+C to stop)`;
    process.stdout.write(watchFrame(header, draw(co.commonDir, opts), { tty: Boolean(process.stdout.isTTY), first, rows: process.stdout.rows || 0 }));
    first = false;
  };
  tick();
  setInterval(tick, opts.watch * 1000);
  return undefined;
}

/** True when this file is the script node was started on. Both sides go through realpath, so a symlinked or 8.3-short-named path still matches. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const code = main(process.argv.slice(2));
  if (code !== undefined) process.exitCode = code;
}
