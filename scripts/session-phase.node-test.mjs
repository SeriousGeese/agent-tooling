/**
 * scripts/session-phase.mjs: the hook that feeds the session tracker. A fake checkout
 * (a .git dir, and a linked worktree's .git file) in a temp dir; no git spawn, as in the hook.
 */
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-support/cleanup.mjs';
import { CMD_MAX, PHASE_DIR_NAME, classifyCommand, entryFor, readBranch, record } from './session-phase.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'session-phase.mjs');

const roots = new Set();
after(() => {
  for (const r of roots) removeTempDir(r, 'session-phase.node-test');
});

/** A primary checkout at <root>/main and a linked worktree at <root>/wt on branch feat/x. */
function fakeCheckout() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-phase-'));
  roots.add(root);
  const main = path.join(root, 'main');
  const common = path.join(main, '.git');
  const wtGitDir = path.join(common, 'worktrees', 'wt');
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.writeFileSync(path.join(common, 'HEAD'), 'ref: refs/heads/main\n');
  fs.writeFileSync(path.join(wtGitDir, 'HEAD'), 'ref: refs/heads/feat/x-acme-abc\n');
  fs.writeFileSync(path.join(wtGitDir, 'commondir'), '../..\n');
  const wt = path.join(root, 'wt');
  fs.mkdirSync(wt);
  fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${wtGitDir}\n`);
  return { root, main, common, wt };
}

function readLog(common, name) {
  return fs
    .readFileSync(path.join(common, PHASE_DIR_NAME, name), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
}

test('classifyCommand maps the bead workflow commands to their steps', () => {
  const cases = [
    ['bash scripts/claim.sh feat/y', 'claim'],
    ['bash scripts/worktree-new.sh --await /c/x', 'claim'],
    ['bash scripts/gate.sh npm run type-check', 'gates'],
    ['npm test -- scripts/foo', 'gates'],
    ['scripts/verify-local.sh', 'gates'],
    ['git commit -F msg.txt', 'commit'],
    ['git -c core.hooksPath=/tmp/x commit -m x', 'commit'],
    ['git push -u origin HEAD', 'push'],
    ['GIT_CONFIG_COUNT=1 git --no-pager push', 'push'],
    ['gh pr create --body-file body.md', 'pr'],
    ['gh pr merge --auto 5678', 'armed'],
    ['node scripts/pr-queue-state.mjs 5678', 'landing'],
    ['bash scripts/land.sh /c/wt', 'landing'],
    ['bash scripts/worktree-rm.sh /c/wt', 'cleanup'],
  ];
  for (const [cmd, want] of cases) assert.equal(classifyCommand(cmd), want, cmd);
});

test('classifyCommand takes the LAST step of a compound command, and ignores lookalikes', () => {
  assert.equal(classifyCommand('git add -A && git commit -m x && git push'), 'push');
  assert.equal(classifyCommand('npm run lint; git commit -m x'), 'commit');
  assert.equal(classifyCommand('git log --oneline -3 -- scripts/push.sh'), '');
  assert.equal(classifyCommand('git status --short'), '');
  assert.equal(classifyCommand('bd show'), '');
  assert.equal(classifyCommand(undefined), '');
});

test('entryFor logs milestones only', () => {
  const now = 1000;
  assert.equal(entryFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { now }), null);
  assert.equal(entryFor({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: {} }, { now }), null, 'an edit logs once, after');
  assert.equal(entryFor({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }, { now }), null);
  assert.deepEqual(entryFor({ hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: {} }, { now }), {
    t: now,
    ev: 'PostToolUse',
    phase: 'coding',
    tool: 'Edit',
  });
  const push = entryFor(
    { hook_event_name: 'PreToolUse', tool_name: 'PowerShell', tool_use_id: 'tu1', agent_id: 'ag', tool_input: { command: 'git push' } },
    { now, branch: 'feat/x' },
  );
  assert.deepEqual(push, { t: now, ev: 'PreToolUse', agent: 'ag', branch: 'feat/x', phase: 'push', tool: 'PowerShell', cmd: 'git push', id: 'tu1' });
  assert.deepEqual(entryFor({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'tu1' }, { now }), {
    t: now,
    ev: 'PostToolUseFailure',
    tool: 'Bash',
    id: 'tu1',
  }, 'a failure with no command still closes its span by id');
  assert.equal(entryFor({ hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'ls' } }, { now }), null);
  assert.deepEqual(entryFor({ hook_event_name: 'Stop' }, { now }), { t: now, ev: 'Stop' });
  assert.equal(entryFor({ hook_event_name: 'Notification' }, { now }), null);
});

test('entryFor flattens and caps the command and the prompt', () => {
  const long = `git push ${'x'.repeat(500)}\nsecond line`;
  const e = entryFor({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: long } });
  assert.equal(e.cmd.length, CMD_MAX);
  assert.ok(!e.cmd.includes('\n'));
  const p = entryFor({ hook_event_name: 'UserPromptSubmit', prompt: 'BD read\n\nP0/P1 bugs' });
  assert.equal(p.prompt, 'BD read P0/P1 bugs');
});

test('readBranch reads a linked worktree and a primary checkout', () => {
  const { main, wt, root } = fakeCheckout();
  assert.equal(readBranch(wt), 'feat/x-acme-abc');
  assert.equal(readBranch(main), 'main');
  assert.equal(readBranch(path.join(root, 'nowhere')), '');
});

test('record appends to the COMMON git dir, one file per agent, and skips non-milestones', () => {
  const { common, wt } = fakeCheckout();
  assert.equal(record({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }, { cwd: wt }), 'skipped');
  assert.equal(record({ session_id: 's1', hook_event_name: 'SessionStart' }, { cwd: wt, now: 1 }), 'wrote');
  assert.equal(record({ session_id: 's1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push' } }, { cwd: wt, now: 2 }), 'wrote');
  assert.equal(record({ session_id: 's1', agent_id: 'a/1', hook_event_name: 'Stop' }, { cwd: wt, now: 3 }), 'wrote');
  const lines = readLog(common, 's1.jsonl');
  assert.deepEqual(
    lines.map((l) => [l.session, l.ev, l.phase ?? '', l.branch]),
    [
      ['s1', 'SessionStart', '', 'feat/x-acme-abc'],
      ['s1', 'PreToolUse', 'push', 'feat/x-acme-abc'],
    ],
  );
  assert.equal(readLog(common, 's1--a_1.jsonl').length, 1, 'a subagent gets its own file, its id sanitised');
});

test('record falls back to the session env and the project dir, and skips outside a checkout', () => {
  const { common, wt, root } = fakeCheckout();
  const outside = path.join(root, 'nowhere');
  fs.mkdirSync(outside);
  assert.equal(record({ hook_event_name: 'Stop' }, { cwd: outside }), 'skipped');
  assert.equal(record({ hook_event_name: 'Stop' }, { cwd: outside, sessionId: 'env1' }), 'skipped');
  assert.equal(record({ hook_event_name: 'Stop' }, { cwd: outside, fallbackCwd: wt, sessionId: 'env1' }), 'wrote');
  assert.equal(readLog(common, 'env1.jsonl')[0].session, 'env1');
});

test('the CLI always exits 0, even on a garbage payload, and writes the line', () => {
  const { common, wt } = fakeCheckout();
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  const bad = spawnSync(process.execPath, [SCRIPT, 'record'], { cwd: wt, input: 'not json', env, encoding: 'utf8' });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout + bad.stderr, '');
  const payload = JSON.stringify({ session_id: 'cli', cwd: wt, hook_event_name: 'PostToolUse', tool_name: 'Write', tool_input: {} });
  const ok = spawnSync(process.execPath, [SCRIPT, 'record'], { cwd: wt, input: payload, env, encoding: 'utf8' });
  assert.equal(ok.status, 0);
  assert.equal(readLog(common, 'cli.jsonl')[0].phase, 'coding');
  assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8' }).status, 2);
});
