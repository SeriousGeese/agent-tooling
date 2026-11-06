#!/usr/bin/env node
// Tests for the per-session beads actor identity (see the agent-actor-id.mjs header for the
// same-person collision this exists to prevent).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  resolveActorId,
  slugifyActorBase,
  sessionSuffix,
  sessionIdSource,
  sharedIdentityMessage,
  claudeSessionName,
  isOldFormatOfSameSession,
  DISTINCT_ACTOR_RE,
  SESSION_SUFFIX_LEN,
} from './agent-actor-id.mjs';

const noGit = () => '';
const gitName = (n) => () => n;

test('derives <base>-bot-<session8> from git user.name plus the session id', () => {
  const r = resolveActorId({
    env: { CLAUDE_CODE_SESSION_ID: '0fc812d7-342e-4608-a4be-c4e7fa338d8f' },
    gitUserName: gitName('Ada Lovelace'),
  });
  assert.equal(r.id, 'ada-lovelace-bot-0fc812d7');
  assert.equal(r.base, 'ada-lovelace');
  assert.equal(r.distinct, true);
  assert.equal(r.source, 'derived');
});

test("two people's fleets' identities are distinguishable at a glance", () => {
  const mine = resolveActorId({
    env: { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-1111' },
    gitUserName: gitName('Ada Lovelace'),
  });
  const theirs = resolveActorId({
    env: { CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-2222' },
    gitUserName: gitName('Build Bot'),
  });
  assert.equal(mine.id, 'ada-lovelace-bot-aaaaaaaa');
  assert.equal(theirs.id, 'build-bot-bot-bbbbbbbb');
  assert.notEqual(mine.id, theirs.id);
});

test('THE POINT: two sessions of the SAME person get different ids', () => {
  const a = resolveActorId({ env: { CLAUDE_CODE_SESSION_ID: 'aaaaaaaa-x' }, gitUserName: gitName('Ada Lovelace') });
  const b = resolveActorId({ env: { CLAUDE_CODE_SESSION_ID: 'bbbbbbbb-x' }, gitUserName: gitName('Ada Lovelace') });
  assert.notEqual(a.id, b.id);
  assert.equal(a.base, b.base, 'but the human-readable base still shows whose fleet it is');
});

test('an explicit BEADS_ACTOR is honoured untouched', () => {
  const r = resolveActorId({ env: { BEADS_ACTOR: 'release-runner' }, gitUserName: gitName('Ada Lovelace') });
  assert.equal(r.id, 'release-runner');
  assert.equal(r.source, 'BEADS_ACTOR');
});

test('an explicit BEADS_ACTOR counts as distinct only when it already carries a session suffix', () => {
  assert.equal(resolveActorId({ env: { BEADS_ACTOR: 'Build Bot' }, gitUserName: noGit }).distinct, false);
  assert.equal(resolveActorId({ env: { BEADS_ACTOR: 'build-bot-a1b2c3d4' }, gitUserName: noGit }).distinct, true);
});

test('without a session id the identity is shared, and says so', () => {
  const r = resolveActorId({ env: {}, gitUserName: gitName('Ada Lovelace') });
  assert.equal(r.id, 'ada-lovelace');
  assert.equal(r.distinct, false);
  assert.equal(r.source, 'base-only');
});

test('BEADS_ACTOR_BASE overrides the git name for the base', () => {
  const r = resolveActorId({
    env: { BEADS_ACTOR_BASE: 'ci-runner', CLAUDE_CODE_SESSION_ID: 'deadbeef-9' },
    gitUserName: gitName('Ada Lovelace'),
  });
  assert.equal(r.id, 'ci-runner-bot-deadbeef');
});

test('falls back to the OS user when git has no name', () => {
  const r = resolveActorId({ env: { USER: 'evex', CLAUDE_CODE_SESSION_ID: 'abc12345-0' }, gitUserName: noGit });
  assert.equal(r.id, 'evex-bot-abc12345');
});

test('no identity at all resolves to empty rather than throwing', () => {
  const r = resolveActorId({ env: {}, gitUserName: noGit });
  assert.equal(r.id, '');
  assert.equal(r.distinct, false);
  assert.equal(r.source, 'none');
});

test('slugifyActorBase produces identifier-safe bases', () => {
  assert.equal(slugifyActorBase('Ada Lovelace'), 'ada-lovelace');
  assert.equal(slugifyActorBase('  Sam S (Greybeard) '), 'sam-s-greybeard');
  assert.equal(slugifyActorBase('already-slugged'), 'already-slugged');
  assert.equal(slugifyActorBase(''), '');
  assert.equal(slugifyActorBase(undefined), '');
});

test('sessionSuffix takes a fixed-length hex prefix and drops separators', () => {
  assert.equal(sessionSuffix({ CLAUDE_CODE_SESSION_ID: '0fc812d7-342e-4608' }), '0fc812d7');
  assert.equal(sessionSuffix({ CLAUDE_CODE_SESSION_ID: 'ABCDEF12-xyz' }).length, SESSION_SUFFIX_LEN);
  assert.equal(sessionSuffix({ CLAUDE_CODE_SESSION_ID: 'ABCDEF12-xyz' }), 'abcdef12');
  assert.equal(sessionSuffix({}), '');
  assert.equal(sessionSuffix({ CLAUDE_CODE_SESSION_ID: '   ' }), '');
});

test('a short session id is used as-is rather than padded', () => {
  assert.equal(sessionSuffix({ CLAUDE_CODE_SESSION_ID: 'ab12' }), 'ab12');
});

// ── Codex ───────────────────────────────────────────────────────

test('a Codex session derives a distinct id from CODEX_THREAD_ID', () => {
  const r = resolveActorId({
    env: { CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1' },
    gitUserName: gitName('Eve Example'),
  });
  assert.equal(r.id, 'eve-example-bot-daefdad1');
  assert.equal(r.distinct, true);
  assert.equal(r.source, 'derived');
  assert.equal(r.sessionVar, 'CODEX_THREAD_ID');
  assert.match(r.id, new RegExp(`-bot-[a-z0-9]{${SESSION_SUFFIX_LEN}}$`), 'the shape the collision hook trusts');
});

test('Codex thread ids are UUIDv7: two started within a minute share a PREFIX, so the random SUFFIX is used', () => {
  // Shaped like real Codex thread ids (openai/codex issues show 01a073bb-… and 01a0a510-…,
  // version nibble 7): the same leading timestamp, different random tails.
  const a = sessionSuffix({ CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1' });
  const b = sessionSuffix({ CODEX_THREAD_ID: '01a073bb-3213-7113-86a4-48290c3ff455' });
  assert.notEqual(a, b);
  assert.equal(a, 'daefdad1');
  assert.equal(b, '0c3ff455');
});

test('CLAUDE_CODE_SESSION_ID wins over CODEX_THREAD_ID, so existing Claude assignees do not change', () => {
  const src = sessionIdSource({ CLAUDE_CODE_SESSION_ID: '0fc812d7-342e', CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1' });
  assert.deepEqual(src, { name: 'CLAUDE_CODE_SESSION_ID', suffix: '0fc812d7' });
  assert.equal(sessionIdSource({ CLAUDE_CODE_SESSION_ID: '  ', CODEX_THREAD_ID: '' }), null);
});

test('with neither session variable the identity is shared', () => {
  const r = resolveActorId({ env: { CODEX_SANDBOX: 'seatbelt' }, gitUserName: gitName('Eve Example') });
  assert.equal(r.id, 'eve-example');
  assert.equal(r.distinct, false);
});

test('sharedIdentityMessage names the cause and both remedies', () => {
  const none = sharedIdentityMessage(resolveActorId({ env: {}, gitUserName: gitName('Eve Example') }));
  assert.match(none, /"eve-example" is NOT session-distinct/);
  assert.match(none, /CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID/);
  assert.match(none, /BEADS_ACTOR="eve-example-bot-</);
  // The hatch name carries the consumer's env prefix (sync rewrites it), so match any prefix.
  assert.match(none, /[A-Z][A-Z0-9]*_ALLOW_SHARED_CLAIM_ACTOR=1/);
  const explicit = sharedIdentityMessage(resolveActorId({ env: { BEADS_ACTOR: 'eve-example' }, gitUserName: noGit }));
  assert.match(explicit, /BEADS_ACTOR is set to a name with no -bot-/);
});

// A REAL helper invocation, not just the pure function: the CLI is what claim.sh gates on.
const CLI = fileURLToPath(new URL('./agent-actor-id.mjs', import.meta.url));
function cli(env) {
  const clean = { ...process.env, BEADS_ACTOR_BASE: 'cli-probe', BEADS_ACTOR: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '', CLAUDE_PID: '', CLAUDE_CONFIG_DIR: '' };
  return spawnSync(process.execPath, [CLI, '--check'], { encoding: 'utf8', env: { ...clean, ...env } });
}

test('--check without CLAUDE_CODE_SESSION_ID or CODEX_THREAD_ID exits 1 with the remedy and prints no id', () => {
  const r = cli({});
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.stdout, '');
  assert.match(r.stderr, /"cli-probe" is NOT session-distinct/);
});

test('--check under Codex exits 0 and prints the derived id', () => {
  const r = cli({ CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, 'cli-probe-bot-daefdad1');
});

// The window's name between the base and the session suffix.
const SID = 'c54b71a9-1111-4222-8333-444455556666';
const sessionsFile = (body) => (file) => {
  assert.match(file, /[\\/]sessions[\\/]847250\.json$/);
  if (body === undefined) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  return typeof body === 'string' ? body : JSON.stringify(body);
};
const claudeEnv = { CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PID: '847250', HOME: '/home/ada' };

test('in Claude Code, the id carries the window name: <base>-bot-<name>-<session8>', () => {
  const r = resolveActorId({ env: claudeEnv, gitUserName: gitName('Bob'), readSessionFile: sessionsFile({ sessionId: SID, name: 'win-3c' }) });
  assert.equal(r.id, 'bob-bot-win-3c-c54b71a9');
  assert.equal(r.sessionName, 'win-3c');
  assert.equal(r.distinct, true);
  assert.match(r.id, DISTINCT_ACTOR_RE);
});

test('the window name is slugified', () => {
  const r = resolveActorId({ env: claudeEnv, gitUserName: gitName('Ada Lovelace'), readSessionFile: sessionsFile({ sessionId: SID, name: ' Win A1! ' }) });
  assert.equal(r.id, 'ada-lovelace-bot-win-a1-c54b71a9');
});

test('falls back to <base>-bot-<session8> on every miss', () => {
  const cases = [
    ['no file', sessionsFile(undefined)],
    ['unparsable file', sessionsFile('{not json')],
    ['another session wrote it (stale or reused pid)', sessionsFile({ sessionId: 'deadbeef-0000', name: 'win-3c' })],
    ['no name', sessionsFile({ sessionId: SID })],
    ['a name that slugs to nothing', sessionsFile({ sessionId: SID, name: '!!' })],
  ];
  for (const [why, readSessionFile] of cases) {
    const r = resolveActorId({ env: claudeEnv, gitUserName: gitName('Bob'), readSessionFile });
    assert.equal(r.id, 'bob-bot-c54b71a9', why);
    assert.equal(r.distinct, true, why);
  }
});

test('reads no sessions file without CLAUDE_PID, or under Codex', () => {
  const refuse = () => { throw new Error('must not read'); };
  assert.equal(resolveActorId({ env: { CLAUDE_CODE_SESSION_ID: SID }, gitUserName: gitName('Bob'), readSessionFile: refuse }).id, 'bob-bot-c54b71a9');
  const codex = resolveActorId({ env: { CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1', CLAUDE_PID: '847250' }, gitUserName: gitName('Eve'), readSessionFile: refuse });
  assert.equal(codex.id, 'eve-bot-daefdad1');
});

test('CLAUDE_CONFIG_DIR relocates the sessions directory', () => {
  let read = '';
  claudeSessionName({ ...claudeEnv, CLAUDE_CONFIG_DIR: '/cfg' }, (file) => { read = file; return '{}'; });
  assert.match(read, /^[\\/]cfg[\\/]sessions[\\/]847250\.json$/);
});

test('DISTINCT_ACTOR_RE accepts both formats and refuses a shared name', () => {
  for (const id of ['build-bot-4cb3dc8c', 'build-bot-win-3c-c54b71a9', 'ada-lovelace-bot-win-a1-0fc812d7']) {
    assert.match(id, DISTINCT_ACTOR_RE, id);
    assert.equal(resolveActorId({ env: { BEADS_ACTOR: id }, gitUserName: noGit }).distinct, true, id);
  }
  for (const id of ['Build Bot', 'build-bot', 'build-bot-win-3c', 'build-bot-win-3c-']) {
    assert.doesNotMatch(id, DISTINCT_ACTOR_RE, id);
  }
});

test('isOldFormatOfSameSession: an old-format claim is the same session only when base and suffix agree', () => {
  assert.equal(isOldFormatOfSameSession('build-bot-c54b71a9', 'build-bot-win-3c-c54b71a9'), true);
  assert.equal(isOldFormatOfSameSession('build-bot-0fc812d7', 'build-bot-win-3c-c54b71a9'), false, 'another session');
  assert.equal(isOldFormatOfSameSession('ada-lovelace-bot-c54b71a9', 'build-bot-win-3c-c54b71a9'), false, 'another person');
  assert.equal(isOldFormatOfSameSession('build-bot-c54b71a9', 'build-bot-c54b71a9'), false, 'identical is sameActor’s case, not this one');
  assert.equal(isOldFormatOfSameSession('build-bot-win-3c-c54b71a9', 'build-bot-win-3c-c54b71a9'), false, 'not old-format');
});

test('--check passes for the new format, read from a real sessions file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'actor-id-'));
  try {
    mkdirSync(path.join(dir, 'sessions'));
    writeFileSync(path.join(dir, 'sessions', '847250.json'), JSON.stringify({ sessionId: SID, name: 'win-3c' }));
    const r = cli({ CLAUDE_CODE_SESSION_ID: SID, CLAUDE_PID: '847250', CLAUDE_CONFIG_DIR: dir });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'cli-probe-bot-win-3c-c54b71a9');
    const stale = cli({ CLAUDE_CODE_SESSION_ID: '0fc812d7-0000', CLAUDE_PID: '847250', CLAUDE_CONFIG_DIR: dir });
    assert.equal(stale.status, 0, stale.stderr);
    assert.equal(stale.stdout, 'cli-probe-bot-0fc812d7');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
