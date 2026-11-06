// Tests for the bd, actor and dolt-sync plumbing the hygiene scripts share.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  CLOSE_ASSIGNEE_REFUSAL_RE,
  DISTINCT_ACTOR_RE,
  askLabel,
  bdCli,
  bdCloseAsAssignee,
  closeRefusalAssignee,
  doltSync,
  parseBdJsonRows,
  resolveActor,
  slugifyActorBase,
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
    assert.equal(resolveActor({ env: {}, script: absent, gitUserName: () => '' }), '');
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

test('resolveActor without the actor-id script: BEADS_ACTOR, then the slug of BEADS_ACTOR_BASE, git user.name or $USER', () => {
  const absent = path.join(tmpdir(), 'no-such-agent-actor-id.mjs');
  const never = () => assert.fail('must not spawn');
  assert.equal(resolveActor({ env: { BEADS_ACTOR: 'env-bot-12345678' }, run: never, script: absent, gitUserName: () => 'Ann Lee' }), 'env-bot-12345678');
  assert.equal(resolveActor({ env: { BEADS_ACTOR_BASE: 'Base Name' }, run: never, script: absent, gitUserName: () => 'Ann Lee' }), 'base-name');
  assert.equal(resolveActor({ env: {}, run: never, script: absent, gitUserName: () => 'Ann Lee' }), 'ann-lee');
  assert.equal(resolveActor({ env: { USER: 'Some User' }, run: never, script: absent, gitUserName: () => '' }), 'some-user');
  assert.equal(resolveActor({ env: {}, run: never, script: absent, gitUserName: () => '' }), '');
  assert.equal(slugifyActorBase('  Captain  Goose! '), 'captain-goose');
});

test('doltSync without the beads set warns that the sync is NOT verified, once per call; with it, no warning', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'hygiene-warn-'));
  try {
    const warnings = [];
    const run = () => ({ status: 0 });
    doltSync('pull', { run, script: path.join(dir, 'missing.mjs'), warn: (l) => warnings.push(l) });
    doltSync('push', { run, script: path.join(dir, 'missing.mjs'), warn: (l) => warnings.push(l) });
    assert.equal(warnings.length, 2);
    assert.match(warnings[0], /sync NOT verified \(beads set not installed\)/);
    const present = path.join(dir, 'bd-dolt-sync.mjs');
    writeFileSync(present, '');
    doltSync('pull', { run, script: present, warn: (l) => warnings.push(l) });
    assert.equal(warnings.length, 2, 'the verified CLI path says nothing');
  } finally {
    removeTempDir(dir, 'hygiene-bd-lib.node-test');
  }
});

// ── drift guard: the copies in hygiene-bd-lib.mjs against the sets they stand in for ──
// Each copy exists only because a set may import nothing outside base and itself. When the real
// file is installed beside this one, the copy must still say the same thing.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const sibling = (...rel) => path.join(HERE, ...rel);

async function load(file) {
  return import(pathToFileURL(file).href);
}

test('drift: the close-refusal pattern matches scripts/lib/bd-cli.mjs', async (t) => {
  const file = sibling('lib', 'bd-cli.mjs');
  if (!existsSync(file)) return t.skip('scripts/lib/bd-cli.mjs is not installed here');
  const real = await load(file);
  assert.equal(CLOSE_ASSIGNEE_REFUSAL_RE.source, real.CLOSE_ASSIGNEE_REFUSAL_RE.source);
  assert.equal(closeRefusalAssignee(REFUSAL, 'x-1'), real.closeRefusalAssignee(REFUSAL, 'x-1'));
});

test('drift: DISTINCT_ACTOR_RE and the name slug match scripts/agent-actor-id.mjs', async (t) => {
  const file = sibling('agent-actor-id.mjs');
  if (!existsSync(file)) return t.skip('scripts/agent-actor-id.mjs is not installed here');
  const real = await load(file);
  assert.equal(DISTINCT_ACTOR_RE.source, real.DISTINCT_ACTOR_RE.source);
  for (const name of ['Ann Lee', '  Captain  Goose! ', 'x', '', undefined]) assert.equal(slugifyActorBase(name), real.slugifyActorBase(name));
});

test('drift: askLabel matches scripts/ask-lib.mjs', async (t) => {
  const file = sibling('ask-lib.mjs');
  if (!existsSync(file)) return t.skip('scripts/ask-lib.mjs is not installed here');
  const real = await load(file);
  for (const key of ['ann', 'Bob', ' carol ', '', undefined]) assert.equal(askLabel(key), real.askLabel(key));
});

test('drift: spawnWithShellFallback and bdCli match scripts/bd-dolt-sync.mjs', async (t) => {
  const file = sibling('bd-dolt-sync.mjs');
  if (!existsSync(file)) return t.skip('scripts/bd-dolt-sync.mjs is not installed here');
  const real = await load(file);
  assert.equal(spawnWithShellFallback.toString(), real.spawnWithShellFallback.toString());
  assert.equal(bdCli.toString(), real.bdCli.toString());
});
