// Tests for the bd, actor and dolt-sync plumbing the hygiene scripts share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  DISTINCT_ACTOR_RE,
  askLabel,
  bdCli,
  bdCloseAsAssignee,
  closeRefusalAssignee,
  doltSync,
  parseBdJsonRows,
  resolveActor,
  spawnWithShellFallback,
} from './hygiene-bd-lib.mjs';
import { removeTempDir } from './test-support/hygiene-temp-dir.mjs';

const REFUSAL = 'cannot close x-1: assignee is "ann-bot-1234abcd", actor is "ann (ci)"; reclaim or use --force to override';

test('closeRefusalAssignee reads only an anchored refusal that names this very bead', () => {
  assert.equal(closeRefusalAssignee(REFUSAL, 'x-1'), 'ann-bot-1234abcd');
  assert.equal(closeRefusalAssignee(`Error: ${REFUSAL}`, 'x-1'), null, 'a refusal that does not start a line is not one');
  assert.equal(closeRefusalAssignee(REFUSAL, 'x-2'), null, 'another bead refusal never counts');
  assert.equal(closeRefusalAssignee('boom', 'x-1'), null);
  assert.equal(closeRefusalAssignee(undefined, 'x-1'), null);
});

test('bdCloseAsAssignee retries once as the claimant, and rethrows every other failure', () => {
  const calls = [];
  const refusing = (args) => {
    calls.push(args);
    if (!args.includes('--actor')) throw Object.assign(new Error('bd close x-1'), { stderr: REFUSAL });
    return 'closed';
  };
  assert.equal(bdCloseAsAssignee(refusing, 'x-1', 'shipped'), 'closed');
  assert.deepEqual(calls, [
    ['close', 'x-1', '--reason', 'shipped'],
    ['close', 'x-1', '--reason', 'shipped', '--actor', 'ann-bot-1234abcd'],
  ]);

  const other = () => { throw Object.assign(new Error('nope'), { stderr: 'database is locked' }); };
  assert.throws(() => bdCloseAsAssignee(other, 'x-1', 'r'), /nope/);
  const refusalInReason = () => { throw Object.assign(new Error('x'), { stderr: `reason mentions: ${REFUSAL}` }); };
  assert.throws(() => bdCloseAsAssignee(refusalInReason, 'x-1', 'r'), /x/, 'refusal-shaped text that does not start a line is not retried');
});

test('parseBdJsonRows accepts an array, {issues}, a single object, and garbage', () => {
  assert.deepEqual(parseBdJsonRows('[{"id":"a"}]'), [{ id: 'a' }]);
  assert.deepEqual(parseBdJsonRows('{"issues":[{"id":"b"}]}'), [{ id: 'b' }]);
  assert.deepEqual(parseBdJsonRows('{"id":"c"}'), [{ id: 'c' }]);
  assert.deepEqual(parseBdJsonRows('not json'), []);
  assert.deepEqual(parseBdJsonRows(''), []);
});

test('DISTINCT_ACTOR_RE matches both per-session id formats and never a shared name', () => {
  assert.ok(DISTINCT_ACTOR_RE.test('ann-bot-0fc812d7'));
  assert.ok(DISTINCT_ACTOR_RE.test('ann-bot-window-3c-0fc812d7'));
  assert.ok(!DISTINCT_ACTOR_RE.test('ann'));
  assert.ok(!DISTINCT_ACTOR_RE.test('ann-bot-0fc812d'));
});

test('resolveActor: the actor-id script when it is installed, else BEADS_ACTOR, else empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hygiene-actor-'));
  try {
    const script = path.join(dir, 'agent-actor-id.mjs');
    writeFileSync(script, '');
    const ran = [];
    const run = (bin, args) => { ran.push([bin, ...args]); return { status: 0, stdout: 'ann-bot-0fc812d7\n' }; };
    assert.equal(resolveActor({ env: { BEADS_ACTOR: 'ignored-when-script-answers' }, run, script }), 'ann-bot-0fc812d7');
    assert.equal(ran.length, 1);
    assert.equal(ran[0][1], script);

    const failing = () => ({ status: 1, stdout: '' });
    assert.equal(resolveActor({ env: { BEADS_ACTOR: ' fallback-bot-12345678 ' }, run: failing, script }), 'fallback-bot-12345678');

    const absent = path.join(dir, 'nope.mjs');
    assert.equal(resolveActor({ env: { BEADS_ACTOR: 'env-bot-12345678' }, run: () => assert.fail('must not spawn'), script: absent }), 'env-bot-12345678');
    assert.equal(resolveActor({ env: {}, script: absent }), '');
  } finally {
    removeTempDir(dir, 'hygiene-bd-lib.node-test');
  }
});

test('doltSync: the verified sync CLI when installed, a bare bd call otherwise; ok is the exit status', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hygiene-sync-'));
  try {
    const script = path.join(dir, 'bd-dolt-sync.mjs');
    writeFileSync(script, '');
    const seen = [];
    const run = (cmd, args) => { seen.push([cmd, ...args]); return { status: seen.length === 1 ? 0 : 1 }; };
    assert.deepEqual(doltSync('pull', { run, script }), { ok: true });
    assert.equal(seen[0][1], script);
    assert.equal(seen[0][2], 'pull');
    assert.deepEqual(doltSync('push', { run, script: path.join(dir, 'missing.mjs') }), { ok: false });
    assert.deepEqual(seen[1].slice(1), ['dolt', 'push']);
  } finally {
    removeTempDir(dir, 'hygiene-bd-lib.node-test');
  }
});

test('bdCli honours BD_CLI at call time', () => {
  const before = process.env.BD_CLI;
  try {
    process.env.BD_CLI = 'my-bd';
    assert.equal(bdCli(), 'my-bd');
    delete process.env.BD_CLI;
    assert.equal(bdCli(), 'bd');
  } finally {
    if (before === undefined) delete process.env.BD_CLI;
    else process.env.BD_CLI = before;
  }
});

test('spawnWithShellFallback reports status and output, and a timeout as timedOut without a shell retry', () => {
  const ok = spawnWithShellFallback(process.execPath, ['-e', 'process.stdout.write("hi"); process.exit(3)']);
  assert.equal(ok.status, 3);
  assert.equal(ok.stdout, 'hi');
  const slow = spawnWithShellFallback(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { timeout: 300 });
  assert.equal(slow.timedOut, true);
  assert.notEqual(slow.status, 0);
});

test('askLabel lower-cases and prefixes a person key', () => {
  assert.equal(askLabel('Ann'), 'ask-ann');
  assert.equal(askLabel(' bob '), 'ask-bob');
});
