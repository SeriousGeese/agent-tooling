/**
 * scripts/session-tracker.mjs: the pizza-tracker view over session-phase.mjs's logs.
 * Timelines are built from hand-written log lines on a fixed clock.
 */
import { strict as assert } from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { removeTempDir } from './test-support/cleanup.mjs';
import { PHASE_DIR_NAME } from './session-phase.mjs';
import {
  CAP_OVERRUN_MS,
  CAP_REMEDY,
  CAP_SLACK_MS,
  LEGACY_SESSION_PROM_FILE,
  RETENTION_MS,
  SHELL_CAP_MS,
  beadBranchPattern,
  configWarning,
  hitShellCap,
  SESSION_PROM_FILE,
  SESSION_PROM_HEADER,
  buildTimeline,
  finishedStages,
  formatDuration,
  isHarnessPrompt,
  loadTimelines,
  parseSince,
  quantile,
  renderSessionProm,
  renderTimeline,
  selectTimelines,
  scheduledTaskName,
  sessionPromProblem,
  sessionTitle,
  slowestStage,
  watchFrame,
  writeSessionProm,
} from './session-tracker.mjs';

const roots = new Set();
after(() => {
  for (const r of roots) removeTempDir(r, 'session-tracker.node-test');
});

const S = 1000;
const M = 60 * S;

/** The example from the bead: 20s diagnosing, 47m coding, a 20m push, then into the queue. */
function exampleLog() {
  return [
    { session: 's', t: 0, ev: 'SessionStart', branch: 'feat/x' },
    { session: 's', t: 1 * S, ev: 'UserPromptSubmit', prompt: 'BD read P0/P1 bugs' },
    { session: 's', t: 20 * S, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 30 * M, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 20 * S + 47 * M, ev: 'PreToolUse', phase: 'push', id: 'p', cmd: 'git push' },
    { session: 's', t: 20 * S + 67 * M, ev: 'PostToolUse', phase: 'push', id: 'p', cmd: 'git push' },
    { session: 's', t: 20 * S + 68 * M, ev: 'PreToolUse', phase: 'pr', id: 'c', cmd: 'gh pr create' },
    { session: 's', t: 20 * S + 68 * M + 5 * S, ev: 'PostToolUse', phase: 'pr', id: 'c', cmd: 'gh pr create' },
  ];
}

test('formatDuration and parseSince', () => {
  assert.equal(formatDuration(20 * S), '20s');
  assert.equal(formatDuration(47 * M + 10 * S), '47m10s');
  assert.equal(formatDuration(72 * M), '1h12m');
  assert.equal(formatDuration(26 * 60 * M), '1d02h');
  assert.equal(formatDuration(-5), '0s');
  assert.equal(parseSince('2h'), 2 * 60 * M);
  assert.equal(parseSince('30m'), 30 * M);
  assert.equal(parseSince('1d'), 24 * 60 * M);
  assert.equal(parseSince('soon'), null);
});

test('buildTimeline gives each step its wall time and names the slowest', () => {
  const now = 20 * S + 70 * M;
  const tl = buildTimeline(exampleLog(), now);
  assert.equal(tl.label, 'BD read P0/P1 bugs');
  assert.equal(tl.branch, 'feat/x');
  assert.equal(tl.stage, 'pr');
  assert.deepEqual(tl.reached, ['diagnose', 'coding', 'commit', 'push', 'pr'], 'a push implies the commit');
  assert.equal(tl.stages.commit, undefined, 'an implied step has no time of its own');
  assert.equal(tl.stages.diagnose, 20 * S);
  assert.equal(tl.stages.coding, 47 * M);
  assert.equal(tl.stages.push, 21 * M, 'push runs until the next step starts');
  assert.equal(tl.stages.pr, 2 * M, 'the current step runs until now');
  assert.deepEqual(tl.longestCommand, { cmd: 'git push', phase: 'push', ms: 20 * M });
  assert.equal(slowestStage(tl), 'coding');
  assert.deepEqual(tl.running, []);
});

test('time stopped waiting on the user is taken out of the step and reported apart', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 1 * M, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 5 * M, ev: 'Stop' },
    { session: 's', t: 15 * M, ev: 'UserPromptSubmit', prompt: 'go on' },
    { session: 's', t: 20 * M, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 21 * M, ev: 'Stop' },
  ];
  const tl = buildTimeline(log, 30 * M);
  assert.equal(tl.stages.coding, 4 * M + 6 * M);
  assert.equal(tl.waitingMs, 10 * M + 9 * M);
  assert.equal(tl.waiting, true);
  assert.equal(tl.label, 'go on');
});

test('a command with no PostToolUse yet is running, and a return to a step adds to it', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'gates', id: 'g1', cmd: 'npm test' },
    { session: 's', t: 3 * M, ev: 'PostToolUse', phase: 'gates', id: 'g1', cmd: 'npm test' },
    { session: 's', t: 4 * M, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 6 * M, ev: 'PreToolUse', phase: 'gates', id: 'g2', cmd: 'npm run lint' },
  ];
  const tl = buildTimeline(log, 10 * M);
  assert.equal(tl.stages.gates, 3 * M + 4 * M);
  assert.equal(tl.stages.coding, 2 * M);
  assert.deepEqual(tl.running, [{ cmd: 'npm run lint', phase: 'gates', ms: 4 * M }]);
});

test('later evidence settles earlier steps: an open push stops running once the PR and queue start', () => {
  // drag-gate: the push's PostToolUse never came, so it read "running 1h03m" beside a done PR.
  const log = [
    { session: 's', t: 0, ev: 'SessionStart', branch: 'feat/x' },
    { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'push', id: 'p', cmd: 'git push' },
    { session: 's', t: 9 * M, ev: 'PreToolUse', phase: 'pr', id: 'c', cmd: 'gh pr create' },
    { session: 's', t: 9 * M + 5 * S, ev: 'PostToolUse', phase: 'pr', id: 'c', cmd: 'gh pr create' },
    { session: 's', t: 10 * M, ev: 'PreToolUse', phase: 'landing', id: 'l', cmd: 'bash scripts/land.sh .' },
  ];
  assert.deepEqual(buildTimeline(log.slice(0, 2), 5 * M).running, [{ cmd: 'git push', phase: 'push', ms: 4 * M }], 'alone, it is running');
  const tl = buildTimeline(log, 64 * M);
  assert.deepEqual(tl.running, [{ cmd: 'bash scripts/land.sh .', phase: 'landing', ms: 54 * M }], 'only the step it is in now runs');
  const text = renderTimeline(tl, { now: 64 * M, width: 400 }).join('\n');
  assert.doesNotMatch(text, /running [^:]*: git push/);
  assert.match(text, /\[x\] commit/, 'the PR implies the commit before it');

  // A command of the SAME or a later step stays open: a re-run of gates is not settled by gates.
  const same = buildTimeline(
    [
      { session: 's', t: 0, ev: 'SessionStart' },
      { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'gates', id: 'a', cmd: 'npm test' },
      { session: 's', t: 2 * M, ev: 'PreToolUse', phase: 'gates', id: 'b', cmd: 'npm run lint' },
      { session: 's', t: 3 * M, ev: 'PostToolUse', phase: 'coding' },
    ],
    4 * M,
  );
  assert.deepEqual(same.running.map((r) => r.cmd), ['npm test', 'npm run lint']);
});

test('a PR opened by a compound command marks push and commit reached, never skipped', () => {
  // bd-dolt-server-stalled: `git commit && git push && gh pr create` classifies as the PR alone.
  const log = [
    { session: 's', t: 0, ev: 'SessionStart', branch: 'feat/x' },
    { session: 's', t: 1 * M, ev: 'PostToolUse', phase: 'coding' },
    { session: 's', t: 2 * M, ev: 'PreToolUse', phase: 'pr', id: 'c', cmd: 'git commit -q && git push && gh pr create' },
    { session: 's', t: 3 * M, ev: 'PostToolUse', phase: 'pr', id: 'c', cmd: 'git commit -q && git push && gh pr create' },
  ];
  const tl = buildTimeline(log, 4 * M);
  assert.deepEqual(tl.reached, ['diagnose', 'coding', 'commit', 'push', 'pr']);
  const text = renderTimeline(tl, { now: 4 * M, width: 400 }).join('\n');
  assert.match(text, /\[x\] commit/);
  assert.match(text, /\[x\] push \+ pre-push hooks/);
  assert.doesNotMatch(text, /\[-\] (commit|push)/);
  assert.match(text, /\[-\] claim/, 'a step nothing implies still reads as skipped');
  assert.match(text, /\[-\] local gates/);
  // landing (gh pr view) can be someone else's PR, so it implies nothing.
  const watcher = buildTimeline([{ session: 's', t: 0, ev: 'SessionStart' }, { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'landing', id: 'v', cmd: 'gh pr view 1' }], 2 * M);
  assert.deepEqual(watcher.reached, ['diagnose', 'landing']);
});

test('SessionEnd closes the timeline at its own time', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 2 * M, ev: 'PreToolUse', phase: 'cleanup', id: 'r', cmd: 'bash scripts/worktree-rm.sh x' },
    { session: 's', t: 3 * M, ev: 'SessionEnd' },
  ];
  const tl = buildTimeline(log, 99 * M);
  assert.equal(tl.ended, true);
  assert.equal(tl.stages.cleanup, 1 * M);
  assert.deepEqual(tl.running, [], 'an ended session runs nothing');
});

test('a command a guard blocked (PreToolUse, no Post) stops counting as running at the Stop', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'push', id: 'b', cmd: 'git push' },
    { session: 's', t: 2 * M, ev: 'Stop' },
  ];
  assert.deepEqual(buildTimeline(log.slice(0, 2), 1 * M + 30 * S).running, [{ cmd: 'git push', phase: 'push', ms: 30 * S }]);
  assert.deepEqual(buildTimeline(log, 9 * M).running, []);
});

test('a failed command closes its span and is marked failed', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'push', id: 'p', cmd: 'git push' },
    { session: 's', t: 21 * M, ev: 'PostToolUseFailure', phase: 'push', id: 'p', cmd: 'git push' },
  ];
  const tl = buildTimeline(log, 22 * M);
  assert.deepEqual(tl.running, []);
  assert.deepEqual(tl.longestCommand, { cmd: 'git push', phase: 'push', ms: 20 * M, failed: true });
  assert.match(renderTimeline(tl, { now: 22 * M }).join('\n'), /longest command 20m00s \(failed\): git push/);
});

test('hitShellCap: a span ending at the 10m tool cap, within jitter, and nothing else', () => {
  assert.equal(SHELL_CAP_MS, 600_000);
  assert.ok(CAP_SLACK_MS <= 1 * S, 'a command that finishes at 595-599s returned a real verdict');
  for (const ms of [SHELL_CAP_MS - CAP_SLACK_MS, 600 * S, 600.4 * S, 604.3 * S, SHELL_CAP_MS + CAP_OVERRUN_MS]) assert.equal(hitShellCap(ms), true, `${ms}`);
  for (const ms of [5 * M, 595 * S, 598.9 * S, SHELL_CAP_MS + CAP_OVERRUN_MS + 1, 20 * M]) assert.equal(hitShellCap(ms), false, `${ms}`);
});

test('a command cut off at the 10m cap is reported as a cap hit with the remedy, not as slow', () => {
  // The three from the bead: each a compound command whose verify-local.sh ran past the cap.
  const cmds = ['rm -rf .next && bash scripts/verify-local.sh', 'git commit -q -F - && bash scripts/verify-local.sh', 'bash scripts/gate.sh --name verify bash scripts/verify-local.sh'];
  const log = [{ session: 's', t: 0, ev: 'SessionStart' }];
  cmds.forEach((cmd, i) => {
    const t0 = (1 + i * 12) * M;
    log.push({ session: 's', t: t0, ev: 'PreToolUse', phase: 'gates', id: `g${i}`, cmd });
    log.push({ session: 's', t: t0 + 601.4 * S + i * S, ev: 'PostToolUse', phase: 'gates', id: `g${i}`, cmd });
  });
  log.push({ session: 's', t: 40 * M, ev: 'PreToolUse', phase: 'gates', id: 'ok', cmd: 'npm run lint' });
  log.push({ session: 's', t: 42 * M, ev: 'PostToolUse', phase: 'gates', id: 'ok', cmd: 'npm run lint' });
  const tl = buildTimeline(log, 45 * M);
  assert.deepEqual(tl.capHits.map((h) => h.cmd), cmds);
  assert.deepEqual(tl.longestCommand, { cmd: 'npm run lint', phase: 'gates', ms: 2 * M }, 'longestCommand is the longest UNCAPPED command');
  const text = renderTimeline(tl, { now: 45 * M, width: 400 }).join('\n');
  assert.match(text, /3 commands hit the 10m00s shell cap \(cut off, no verdict\): bash scripts\/gate\.sh --name verify/);
  assert.ok(text.includes(`fix: ${CAP_REMEDY}`));
  assert.match(CAP_REMEDY, /run_in_background/);
  assert.match(CAP_REMEDY, /gate\.sh/);
  assert.match(text, /longest command 2m00s: npm run lint/);
  assert.doesNotMatch(text, /longest command 10m/, 'a capped command is never reported as merely the longest');
  assert.match(renderSessionProm({ live: [tl], all: [tl], now: 45 * M, writer: 'linux' }), /^agent_session_cap_hits\{session="s",agent="",writer="linux"\} 3$/m);
});

test('a capped command that also failed keeps "(failed)" on its cap line', () => {
  const log = [
    { session: 's', t: 0, ev: 'SessionStart' },
    { session: 's', t: 1 * M, ev: 'PreToolUse', phase: 'push', id: 'p', cmd: 'git push' },
    { session: 's', t: 1 * M + 601 * S, ev: 'PostToolUseFailure', phase: 'push', id: 'p', cmd: 'git push' },
  ];
  const tl = buildTimeline(log, 15 * M);
  assert.deepEqual(tl.capHits, [{ cmd: 'git push', phase: 'push', ms: 601 * S, failed: true }]);
  assert.equal(tl.longestCommand, null);
  assert.match(renderTimeline(tl, { now: 15 * M }).join('\n'), /1 command hit the 10m00s shell cap \(cut off, no verdict\): \(failed\) git push/);
});

test('an 8m uncapped command still shows beside a cap hit; a span over the overrun stays a plain longest', () => {
  const span = (id, cmd, t0, ms) => [
    { session: 's', t: t0, ev: 'PreToolUse', phase: 'gates', id, cmd },
    { session: 's', t: t0 + ms, ev: 'PostToolUse', phase: 'gates', id, cmd },
  ];
  const both = buildTimeline([{ session: 's', t: 0, ev: 'SessionStart' }, ...span('a', 'npm test', 1 * M, 8 * M), ...span('b', 'bash scripts/verify-local.sh', 10 * M, 600.5 * S)], 30 * M);
  assert.equal(both.capHits.length, 1);
  const text = renderTimeline(both, { now: 30 * M, width: 400 }).join('\n');
  assert.match(text, /longest command 8m00s: npm test/);
  assert.match(text, /1 command hit the 10m00s shell cap/);

  const over = buildTimeline([{ session: 's', t: 0, ev: 'SessionStart' }, ...span('c', 'git push', 1 * M, SHELL_CAP_MS + CAP_OVERRUN_MS + 1 * S)], 30 * M);
  assert.deepEqual(over.capHits, []);
  assert.equal(over.longestCommand.cmd, 'git push');
  const overText = renderTimeline(over, { now: 30 * M }).join('\n');
  assert.match(overText, /longest command 11m01s: git push/);
  assert.doesNotMatch(overText, /shell cap/);
});

test('a session with no cap hit prints no cap line and exports 0', () => {
  const now = 20 * S + 70 * M;
  const tl = buildTimeline(exampleLog(), now);
  assert.deepEqual(tl.capHits, []);
  assert.doesNotMatch(renderTimeline(tl, { now }).join('\n'), /shell cap/);
  assert.match(renderSessionProm({ live: [tl], all: [tl], now, writer: 'linux' }), /^agent_session_cap_hits\{session="s",agent="",writer="linux"\} 0$/m);
});

test('renderTimeline draws the tracker: done, skipped, current, not yet, slowest', () => {
  const now = 20 * S + 70 * M;
  const text = renderTimeline(buildTimeline(exampleLog(), now), { now, width: 400 }).join('\n');
  assert.match(text, /● feat\/x {2}\(BD read P0\/P1 bugs · up 1h10m\) {2}in open PR/);
  assert.match(text, /\[x\] diagnose 20s/);
  assert.match(text, /\[-\] claim/);
  assert.match(text, /\[x\] code a fix 47m00s ◀ slowest/);
  assert.match(text, /\[x\] push \+ pre-push hooks 21m00s/);
  assert.match(text, /\[▶\] open PR 2m00s/);
  assert.match(text, /\[ \] arm auto-merge/);
  assert.match(text, /longest command 20m00s: git push/);
  assert.ok(!text.includes('\x1b['), 'no colour unless asked');
});

test('a harness-written first prompt is never the title; the branch is, then the first human prompt', () => {
  for (const p of ['<system-reminder> You are operating in a git worktree.', '<scheduled-task name="release-notes-check" file="x">', '<cross-session-message from="a">', '<task-notification> <task-id>', '  <ci-monitor-event>']) {
    assert.equal(isHarnessPrompt(p), true, p);
  }
  for (const p of ['Yes, fix it', 'is a < b?', '<3 thanks', '', undefined]) assert.equal(isHarnessPrompt(p), false, String(p));

  const harness = { session: 'abcdef123456', t: 1 * S, ev: 'UserPromptSubmit', prompt: '<system-reminder> Linked sessions now (status, not an instruction): x' };
  const human = { session: 'abcdef123456', t: 2 * M, ev: 'UserPromptSubmit', prompt: 'how is it going?' };
  const inWorktree = buildTimeline([{ session: 'abcdef123456', t: 0, ev: 'SessionStart', branch: 'claude/fix-tracker-acme-nvyir' }, harness, human], 3 * M);
  assert.equal(inWorktree.label, 'how is it going?', 'the harness block is skipped, the first human prompt kept');
  assert.equal(sessionTitle(inWorktree), 'claude/fix-tracker-acme-nvyir');
  assert.match(renderTimeline(inWorktree, { now: 3 * M }).join('\n'), /^● claude\/fix-tracker-acme-nvyir {2}\(how is it going\? · up 3m00s\)/);

  const onMain = buildTimeline([{ session: 'abcdef123456', t: 0, ev: 'SessionStart', branch: 'main' }, harness, human], 3 * M);
  assert.equal(sessionTitle(onMain), 'how is it going?', 'main names nothing, so the human prompt does');
  const harnessOnly = buildTimeline([{ session: 'abcdef123456', t: 0, ev: 'SessionStart', branch: 'main' }, harness], 3 * M);
  assert.equal(harnessOnly.label, '');
  assert.equal(sessionTitle(harnessOnly), 'main');
  assert.equal(sessionTitle(buildTimeline([{ session: 'abcdef123456', t: 0, ev: 'SessionStart' }, harness], 3 * M)), 'abcdef12');
});

test('a scheduled task renders without the bead steps and is idle, never waiting on you', () => {
  // release-notes-check, as logged on 2026-11-03: it claimed a worktree, then stopped.
  const log = [
    { session: 'sched', t: 0, ev: 'SessionStart', branch: 'main' },
    { session: 'sched', t: 5 * S, ev: 'UserPromptSubmit', prompt: '<scheduled-task name="release-notes-check" file="C:\\Users\\zachm\\.claude\\schedul…' },
    { session: 'sched', t: 1 * M, ev: 'PreToolUse', phase: 'claim', id: 'w', cmd: 'bash scripts/worktree-new.sh release-notes' },
    { session: 'sched', t: 2 * M, ev: 'PostToolUse', phase: 'claim', id: 'w', cmd: 'bash scripts/worktree-new.sh release-notes', branch: 'docs/release-notes-v1' },
    { session: 'sched', t: 3 * M, ev: 'Stop' },
  ];
  const tl = buildTimeline(log, 30 * M);
  assert.equal(scheduledTaskName(log[1].prompt), 'release-notes-check');
  assert.equal(tl.kind, 'scheduled');
  assert.equal(tl.waiting, false);
  assert.equal(tl.waitingMs, 0);
  assert.equal(tl.idle, true);
  const text = renderTimeline(tl, { now: 30 * M, width: 400 }).join('\n');
  assert.match(text, /^● scheduled: release-notes-check {2}\(docs\/release-notes-v1 · up 30m00s\) {2}idle 27m00s$/m);
  assert.doesNotMatch(text, /waiting on you|waited on you/);
  assert.doesNotMatch(text, /\[[x▶ -]\]/, 'no step boxes');
  const prom = renderSessionProm({ live: [tl], all: [tl], now: 30 * M });
  assert.match(sample(prom, 'agent_session_waiting', { session: 'sched' }), / 0$/);
  assert.ok(sample(prom, 'agent_session_info', { session: 'sched', kind: 'scheduled', title: 'scheduled: release-notes-check' }), prom);
  assert.match(sample(prom, 'agent_session_step_duration_seconds_count', { step: 'claim' }), / 0$/, 'a scheduled run never feeds the bead step summary');

  // --json has one shape whatever the kind.
  const plain = buildTimeline([{ session: 'p', t: 0, ev: 'SessionStart' }], 1 * M);
  assert.deepEqual(Object.keys(plain).sort(), Object.keys(tl).sort());
  assert.deepEqual(Object.keys(buildTimeline(exampleLog(), 70 * M)).sort(), Object.keys(tl).sort());
  assert.equal(plain.idle, false);
  assert.equal(plain.idleMs, 0);
  assert.equal(buildTimeline([], 0).idle, false, 'even an empty log');

  // Only the FIRST prompt says how it started.
  const quoted = buildTimeline([{ session: 'q', t: 0, ev: 'UserPromptSubmit', prompt: 'hello' }, { session: 'q', t: 1, ev: 'UserPromptSubmit', prompt: '<scheduled-task name="x">' }], 1 * M);
  assert.equal(quoted.kind, 'plain');
  assert.equal(scheduledTaskName('<system-reminder>'), null);
  assert.equal(scheduledTaskName('<scheduled-task file="y">'), 'task');
});

test('a session that reached no bead step renders without the steps; one on a bead branch keeps them', () => {
  const chat = buildTimeline(
    [
      { session: 'c', t: 0, ev: 'SessionStart', branch: 'main' },
      { session: 'c', t: 1 * S, ev: 'UserPromptSubmit', prompt: 'how is the sweep going?' },
      { session: 'c', t: 1 * M, ev: 'PreToolUse', phase: 'gates', id: 'g', cmd: 'npm test -- x' },
      { session: 'c', t: 3 * M, ev: 'PostToolUse', phase: 'gates', id: 'g', cmd: 'npm test -- x' },
      { session: 'c', t: 4 * M, ev: 'Stop' },
    ],
    10 * M,
  );
  assert.equal(chat.kind, 'plain');
  const text = renderTimeline(chat, { now: 10 * M, width: 400 });
  assert.match(text[0], /^● how is the sweep going\? {2}\(main · up 10m00s\) {2}waiting on you 6m00s$/, 'a person can still be waited on');
  assert.ok(!text.some((l) => /\[[x▶ -]\]/.test(l)), text.join('\n'));
  assert.match(text.join('\n'), /longest command 2m00s: npm test -- x/);

  const branchLog = [{ session: 'b', t: 0, ev: 'SessionStart', branch: 'claude/fix-x-acme-nvyir' }, { session: 'b', t: 1 * M, ev: 'PostToolUse', phase: 'coding' }];
  const onBeadBranch = buildTimeline(branchLog, 2 * M, { beadPrefix: 'ACME' });
  assert.equal(onBeadBranch.kind, 'bead');
  assert.equal(buildTimeline(branchLog, 2 * M, { beadPrefix: 'other' }).kind, 'plain', 'another prefix names no bead here');
  assert.equal(buildTimeline(branchLog, 2 * M, { beadPrefix: '' }).kind, 'plain', 'with no prefix a hyphenated branch is not a bead');
  assert.equal(beadBranchPattern(''), null);
  assert.match('claude/fix-x-ACME-nvyir', beadBranchPattern('ACME'));
  assert.doesNotMatch('claude/fix-x-acme-ab', beadBranchPattern('ACME'), 'an id shorter than four characters is not one');
  assert.match(renderTimeline(onBeadBranch, { now: 2 * M, width: 400 }).join('\n'), /\[▶\] code a fix/);
  assert.equal(buildTimeline(exampleLog(), 70 * M).kind, 'bead');
});

test('watchFrame redraws in place on a TTY and appends plainly off one', () => {
  const ESC = String.fromCharCode(27);
  const body = 'row one\nrow two\n';
  const firstFrame = watchFrame('12:00:00', body, { tty: true, first: true, rows: 40 });
  const next = watchFrame('12:00:10', body, { tty: true, rows: 40 });
  assert.ok(firstFrame.startsWith(`${ESC}[2J${ESC}[H`), 'the first frame clears once');
  assert.ok(next.startsWith(`${ESC}[H`), 'later frames home the cursor');
  assert.ok(!next.includes(`${ESC}[2J`), 'and never clear the screen again, which scrolls on Windows terminals');
  assert.ok(next.includes(`row one${ESC}[K\nrow two${ESC}[K`), 'each line erases what a longer old line left');
  assert.ok(next.endsWith(`${ESC}[J`), 'the frame erases the rows a taller old frame left');

  const tall = watchFrame('h', Array.from({ length: 50 }, (_, i) => `r${i}`).join('\n'), { tty: true, rows: 10 });
  const tallLines = tall.split('\n');
  assert.equal(tallLines.length, 10, 'a frame never scrolls the terminal: rows-1 lines plus the trailing erase');
  assert.match(tall, /… 44 more lines/);

  const plain = watchFrame('12:00:10', body, { tty: false, first: true, rows: 40 });
  assert.equal(plain, '12:00:10\n\nrow one\nrow two\n\n');
  assert.ok(!plain.includes(ESC), 'no escape codes in a pipe or a log');
});

test('--watch off a TTY appends one frame per tick', async () => {
  const { spawn } = await import('node:child_process');
  const script = path.join(import.meta.dirname, 'session-tracker.mjs');
  // A throwaway checkout with its own log, so the test never reads (or prunes) this repo's real one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-watch-'));
  roots.add(root);
  const logDir = path.join(root, '.git', PHASE_DIR_NAME);
  fs.mkdirSync(logDir, { recursive: true });
  const t = Date.now();
  fs.writeFileSync(path.join(logDir, 'w.jsonl'), `${JSON.stringify({ session: 'watchtest', t, ev: 'SessionStart', branch: 'feat/watch-test' })}\n`);
  const child = spawn(process.execPath, [script, '--watch', '1'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((resolve) => {
    // Generous: two 1s ticks, but a loaded host can take a while to start node at all.
    const stop = setTimeout(() => child.kill(), 60_000);
    const poll = setInterval(() => {
      if ((out.match(/Ctrl\+C to stop/g) ?? []).length >= 2) {
        clearInterval(poll);
        clearTimeout(stop);
        child.kill();
      }
    }, 50);
    child.on('exit', () => {
      clearInterval(poll);
      resolve();
    });
  });
  assert.ok((out.match(/Ctrl\+C to stop/g) ?? []).length >= 2, out);
  assert.ok((out.match(/● feat\/watch-test/g) ?? []).length >= 2, `it draws the temp log's session each tick:\n${out}`);
  assert.ok(!out.includes(String.fromCharCode(27)), 'a piped watch writes no escape codes');
});

test('renderTimeline wraps the steps at the given width without splitting one', () => {
  const now = 20 * S + 70 * M;
  const lines = renderTimeline(buildTimeline(exampleLog(), now), { now, width: 60 });
  const stepLines = lines.filter((l) => l.includes('['));
  assert.ok(stepLines.length > 2);
  for (const l of stepLines) assert.ok(l.length <= 60 || (l.match(/\[/g) ?? []).length === 1, l);
});

test('loadTimelines reads every log, skips torn lines, prunes old ones; selectTimelines filters', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-'));
  roots.add(root);
  const dir = path.join(root, PHASE_DIR_NAME);
  fs.mkdirSync(dir);
  const now = Date.now();
  const line = (o) => `${JSON.stringify(o)}\n`;
  fs.writeFileSync(path.join(dir, 'live.jsonl'), line({ session: 'live', t: now - M, ev: 'SessionStart' }) + '{"torn\n');
  fs.writeFileSync(
    path.join(dir, 'ended.jsonl'),
    line({ session: 'ended', t: now - 2 * M, ev: 'SessionStart' }) + line({ session: 'ended', t: now - M, ev: 'SessionEnd' }),
  );
  const old = path.join(dir, 'old.jsonl');
  fs.writeFileSync(old, line({ session: 'old', t: now - RETENTION_MS - M, ev: 'SessionStart' }));
  const past = new Date(now - RETENTION_MS - M);
  fs.utimesSync(old, past, past);
  const all = loadTimelines(root, { now });
  assert.deepEqual(all.map((t) => t.session).sort(), ['ended', 'live']);
  assert.ok(!fs.existsSync(old), 'a log past retention is deleted');
  assert.deepEqual(selectTimelines(all, { now }).map((t) => t.session), ['live']);
  assert.deepEqual(selectTimelines(all, { now, all: true }).map((t) => t.session).sort(), ['ended', 'live']);
  assert.deepEqual(selectTimelines(all, { now, all: true, sinceMs: 30 * S }), []);
  assert.deepEqual(loadTimelines(path.join(root, 'missing'), { now }), []);
});

// ---------- Prometheus textfile ----------

/** Every sample line is `name{labels} number`; every family has HELP and TYPE first. */
function assertExposition(text) {
  assert.ok(text.startsWith(SESSION_PROM_HEADER), 'the header is how a later write recognises its own file');
  assert.ok(text.endsWith('\n'));
  for (const line of text.trimEnd().split('\n')) {
    if (line.startsWith('# HELP ') || line.startsWith('# TYPE ')) continue;
    assert.match(line, /^[a-z_]+(\{([a-z_]+="([^"\\]|\\.)*",?)*\})? -?\d+(\.\d+)?$/, line);
  }
}

const sample = (text, name, labels) =>
  text.split('\n').find((l) => l.startsWith(`${name}{`) && Object.entries(labels).every(([k, v]) => l.includes(`${k}="${v}"`)));

test('finishedStages leaves out the step a live session is still in; quantile is nearest-rank', () => {
  const tl = buildTimeline(exampleLog(), 20 * S + 70 * M);
  assert.deepEqual(finishedStages(tl).map(([id]) => id).sort(), ['coding', 'diagnose', 'push']);
  assert.deepEqual(finishedStages({ ...tl, ended: true }).map(([id]) => id).sort(), ['coding', 'diagnose', 'pr', 'push']);
  assert.equal(quantile([], 0.5), null);
  assert.equal(quantile([1, 2, 3, 4], 0.5), 2);
  assert.equal(quantile([1, 2, 3, 4], 0.9), 4);
  assert.equal(quantile([7], 0.9), 7);
});

test('renderSessionProm: live series, the duration summary, and valid exposition text', () => {
  const now = 20 * S + 70 * M;
  const live = buildTimeline(exampleLog(), now);
  const done = buildTimeline(
    [
      { session: 'donedone-1', t: 0, ev: 'SessionStart' },
      { session: 'donedone-1', t: 1 * M, ev: 'PreToolUse', phase: 'push', id: 'p', cmd: 'git push' },
      { session: 'donedone-1', t: 6 * M, ev: 'SessionEnd' },
    ],
    now,
  );
  const text = renderSessionProm({ live: [live], all: [live, done], now });
  assertExposition(text);
  assert.ok(sample(text, 'agent_session_info', { session: 's', title: 'feat/x', branch: 'feat/x' }), 'the branch names the work');
  assert.match(sample(text, 'agent_session_step', { session: 's', step: 'pr' }), / 6$/, 'pr is step 6 of the tracker');
  assert.match(sample(text, 'agent_session_step_seconds', { session: 's', step: 'coding' }), / 2820\.000$/);
  assert.match(sample(text, 'agent_session_waiting', { session: 's' }), / 0$/);
  assert.ok(!text.includes('donedone'), 'an ended session has no live series');
  assert.ok(!sample(text, 'agent_session_running_seconds', {}), 'nothing is running');
  // push: 21m in the live session, 5m in the ended one.
  assert.match(sample(text, 'agent_session_step_duration_seconds', { step: 'push', quantile: '0.5' }), / 300\.000$/);
  assert.match(sample(text, 'agent_session_step_duration_seconds', { step: 'push', quantile: '0.9' }), / 1260\.000$/);
  assert.match(sample(text, 'agent_session_step_duration_seconds_count', { step: 'push' }), / 2$/);
  assert.match(sample(text, 'agent_session_step_duration_seconds_sum', { step: 'push' }), / 1560\.000$/);
  assert.match(sample(text, 'agent_session_step_duration_seconds_count', { step: 'pr' }), / 0$/, 'the live pr step is not finished');
  assert.ok(!sample(text, 'agent_session_step_duration_seconds', { step: 'pr', quantile: '0.5' }), 'no quantile without data');
  assert.match(text, /\nagent_sessions_generated_timestamp_seconds\{writer="[a-z0-9]+"\} 4220\.000\n$/);
  const linux = renderSessionProm({ live: [live], all: [live, done], now, writer: 'linux' });
  for (const l of linux.trimEnd().split('\n').filter((x) => !x.startsWith('#'))) assert.match(l, /writer="linux"\}/, `every series names its writer: ${l}`);
  // Two writers' files in one textfile dir: node_exporter merges them, so no series may repeat.
  const series = (t) => t.split('\n').filter((l) => l && !l.startsWith('#')).map((l) => l.replace(/ [^ ]+$/, ''));
  const windows = new Set(series(renderSessionProm({ live: [live], all: [live, done], now, writer: 'windows' })));
  assert.deepEqual(series(linux).filter((s) => windows.has(s)), [], 'no duplicate series across two writers');
});

test('renderSessionProm escapes and caps label text, and shortens session ids', () => {
  const tl = buildTimeline(
    [
      { session: 'abcdefghijklmnop', agent: 'zyxwvutsrq', t: 0, ev: 'SessionStart', branch: 'main' },
      { session: 'abcdefghijklmnop', t: 1, ev: 'UserPromptSubmit', prompt: `say "hi" \\ ${'x'.repeat(200)}` },
      { session: 'abcdefghijklmnop', t: 2, ev: 'PreToolUse', phase: 'gates', id: 'g', cmd: 'npm test' },
    ],
    5 * M,
  );
  const text = renderSessionProm({ live: [tl], all: [tl], now: 5 * M });
  assertExposition(text);
  const info = sample(text, 'agent_session_info', { session: 'abcdefgh', agent: 'zyxwvuts' });
  assert.ok(info, text);
  assert.ok(info.includes('title="say \\"hi\\" \\\\ '), info);
  assert.ok(!text.includes('abcdefghi'), 'session ids are 8 characters');
  assert.match(sample(text, 'agent_session_running_seconds', { session: 'abcdefgh', step: 'gates' }), / 299\.998$/, 'started 2ms in');
});

test('sessionPromProblem: only this writer\'s file (or the legacy name), and only over a file it wrote', () => {
  const other = SESSION_PROM_FILE === 'agent_sessions_windows.prom' ? 'agent_sessions_linux.prom' : 'agent_sessions_windows.prom';
  assert.equal(sessionPromProblem(`/d/${SESSION_PROM_FILE}`, null), null);
  assert.equal(sessionPromProblem(`/d/${SESSION_PROM_FILE}`, `${SESSION_PROM_HEADER}x`), null);
  assert.equal(sessionPromProblem(`/d/${LEGACY_SESSION_PROM_FILE}`, `${SESSION_PROM_HEADER}x`), null, 'the legacy shared file may be removed');
  assert.match(sessionPromProblem(`/d/${other}`, `${SESSION_PROM_HEADER}x`), /only writes agent_sessions_/, 'the other writer\'s file is never touched');
  assert.match(sessionPromProblem('/d/scheduled_jobs.prom', null), /only writes agent_sessions_/);
  assert.match(sessionPromProblem(`/d/${SESSION_PROM_FILE}`, '# HELP something_else\n'), /refusing to replace it/);
});

test('writeSessionProm retires an owned legacy agent_sessions.prom, keeps a foreign one, and leaves the other writer alone', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-prom-legacy-'));
  roots.add(root);
  fs.mkdirSync(path.join(root, PHASE_DIR_NAME));
  const promDir = path.join(root, 'textfile');
  fs.mkdirSync(promDir);
  const other = path.join(promDir, SESSION_PROM_FILE === 'agent_sessions_windows.prom' ? 'agent_sessions_linux.prom' : 'agent_sessions_windows.prom');
  const legacy = path.join(promDir, LEGACY_SESSION_PROM_FILE);
  fs.writeFileSync(other, `${SESSION_PROM_HEADER}theirs\n`);
  fs.writeFileSync(legacy, `${SESSION_PROM_HEADER}old\n`);
  writeSessionProm(promDir, { commonDir: root, now: Date.now() });
  assert.ok(!fs.existsSync(legacy), 'the owned legacy file is retired');
  assert.equal(fs.readFileSync(other, 'utf8'), `${SESSION_PROM_HEADER}theirs\n`, 'the other writer\'s file is untouched');
  fs.writeFileSync(legacy, 'foreign\n');
  writeSessionProm(promDir, { commonDir: root, now: Date.now() });
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'foreign\n', 'a foreign legacy-named file is kept');
});

test('writeSessionProm writes atomically from the logs, and refuses a missing dir or a foreign file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-prom-'));
  roots.add(root);
  const dir = path.join(root, PHASE_DIR_NAME);
  fs.mkdirSync(dir);
  const now = Date.now();
  fs.writeFileSync(path.join(dir, 'live.jsonl'), `${JSON.stringify({ session: 'livelive', t: now - M, ev: 'SessionStart', branch: 'feat/y' })}\n`);
  const promDir = path.join(root, 'textfile');
  assert.throws(() => writeSessionProm(promDir, { commonDir: root, now }), /does not exist/);
  fs.mkdirSync(promDir);
  const file = writeSessionProm(promDir, { commonDir: root, now });
  assert.equal(file, path.join(promDir, SESSION_PROM_FILE));
  const text = fs.readFileSync(file, 'utf8');
  assertExposition(text);
  assert.ok(sample(text, 'agent_session_info', { session: 'livelive', branch: 'feat/y' }));
  assert.deepEqual(fs.readdirSync(promDir), [SESSION_PROM_FILE], 'no temp file left behind');
  writeSessionProm(promDir, { commonDir: root, now }); // its own file is replaced
  fs.writeFileSync(file, 'foreign\n');
  assert.throws(() => writeSessionProm(promDir, { commonDir: root, now }), /refusing to replace it/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'foreign\n');
});

test('writeSessionProm replaces a symlink at the destination, never writing through it', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-prom-link-'));
  roots.add(root);
  fs.mkdirSync(path.join(root, PHASE_DIR_NAME));
  const promDir = path.join(root, 'textfile');
  fs.mkdirSync(promDir);
  // A file that passes the ownership check, reached through a link swapped in at the destination.
  const target = path.join(root, 'elsewhere.prom');
  fs.writeFileSync(target, `${SESSION_PROM_HEADER}x\n`);
  const file = path.join(promDir, SESSION_PROM_FILE);
  try {
    fs.symlinkSync(target, file);
  } catch (err) {
    if (['EPERM', 'EACCES'].includes(err.code)) return t.skip('this host cannot create symlinks');
    throw err;
  }
  writeSessionProm(promDir, { commonDir: root, now: Date.now() });
  assert.equal(fs.readFileSync(target, 'utf8'), `${SESSION_PROM_HEADER}x\n`, 'the link target is untouched');
  assert.ok(!fs.lstatSync(file).isSymbolicLink(), 'the destination is now a regular file');
  assertExposition(fs.readFileSync(file, 'utf8'));
});

test('configWarning is empty for a good config and names the reason for a broken one', () => {
  assert.equal(configWarning({ config: {}, error: null }), '');
  assert.equal(configWarning(undefined), '');
  assert.equal(
    configWarning({ config: {}, error: 'agent-tooling.json: not valid JSON' }),
    '[session-tracker] agent-tooling.json could not be loaded (agent-tooling.json: not valid JSON); branch-based bead detection is off\n',
  );
});

test('the CLI prints the config warning once on stderr; a good config is silent', async () => {
  const { spawnSync } = await import('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-tracker-cfg-'));
  roots.add(root);
  fs.mkdirSync(path.join(root, '.git'));
  fs.mkdirSync(path.join(root, 'scripts', 'lib'), { recursive: true });
  const here = import.meta.dirname;
  for (const f of ['session-tracker.mjs', 'session-phase.mjs', 'session-lock.mjs', 'agent-tooling-config.mjs', 'lib/prom-text.mjs']) {
    fs.copyFileSync(path.join(here, f), path.join(root, 'scripts', f));
  }
  const run = () => spawnSync(process.execPath, [path.join(root, 'scripts', 'session-tracker.mjs')], { cwd: root, encoding: 'utf8' });
  assert.equal(run().stderr, '', 'no config file is not an error');
  fs.writeFileSync(path.join(root, 'agent-tooling.json'), '{ not json');
  const bad = run();
  assert.equal(bad.status, 0);
  assert.equal(bad.stderr.split('\n').filter((l) => l.includes('could not be loaded')).length, 1);
  assert.match(bad.stderr, /^\[session-tracker\] agent-tooling\.json could not be loaded \(.*not valid JSON.*\); branch-based bead detection is off$/m);
  fs.writeFileSync(path.join(root, 'agent-tooling.json'), '{}');
  assert.equal(run().stderr, '');
});
