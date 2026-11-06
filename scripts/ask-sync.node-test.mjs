import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildPeople } from './ask-lib.mjs';
import { defaultDeps, main, resetSyncState, syncExitCode } from './ask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ask = readFileSync(path.join(HERE, 'ask.mjs'), 'utf8');
const skill = readFileSync(
  path.join(HERE, '..', '.agents', 'skills', 'ask-review', 'SKILL.md'),
  'utf8',
);

/**
 * Guardrail: an answered ask must never silently fail to publish.
 *
 * ask.mjs once ran `bd dolt push` with `allowFailure: true`, which catches the error and
 * returns ''. A REJECTED PUSH therefore reported success: the answer stayed local, the asker
 * kept seeing the bead as unanswered, and both sides believed the other was the blocker. A
 * non-fast-forward rejection is routine with concurrent sessions, so this was not an edge case.
 *
 * The first group are source assertions: the failure mode is a swallowed exit status, and the
 * cheapest durable check is that the swallowing constructs cannot come back. The second group
 * drives the real command flows with a stub bd and a stub sync, so no bd binary is needed.
 */
describe('asks always reach the remote, or say loudly that they did not', () => {
  test('ask.mjs never runs a bare `bd dolt push` through its bd runner', () => {
    // The bare form cannot be trusted: on a diverged branch `bd dolt pull` exits 0 having
    // merged nothing, after which every push is rejected indefinitely.
    assert.ok(
      !/\bbd\(\s*\[\s*'dolt'\s*,\s*'push'/.test(ask) && !/deps\.bd\(\s*\[\s*'dolt'/.test(ask),
      'ask.mjs must sync via scripts/bd-dolt-sync.mjs, not a bare `bd dolt push`',
    );
    assert.ok(
      !/\bbd\(\s*\[\s*'dolt'\s*,\s*'pull'/.test(ask),
      'ask.mjs must sync via scripts/bd-dolt-sync.mjs, not a bare `bd dolt pull`',
    );
  });

  test('ask.mjs prefers the verified sync helper, run as a child process and never imported', () => {
    assert.ok(/bd-dolt-sync\.mjs/.test(ask), 'ask.mjs must name scripts/bd-dolt-sync.mjs');
    assert.ok(!/from\s+'\.\/bd-dolt-sync\.mjs'/.test(ask) && !/import\(\s*'\.\/bd-dolt-sync\.mjs'/.test(ask),
      'the helper belongs to another set, so ask.mjs may not import it');
  });

  test('a failed push is never swallowed: it sets a non-zero exit', () => {
    assert.ok(
      /syncExitCode\(\)/.test(ask),
      'a sync failure must be able to escalate the process exit code',
    );
    // assert.ok, not assert.match: a failing assert.match dumps the ENTIRE file into the
    // output, which buries the message that says what is actually wrong.
    assert.ok(
      /process\.exitCode\s*=\s*main\(.*\)\s*\|\|\s*syncExitCode\(\)/.test(ask),
      "the entry point must OR main()'s code with syncExitCode(), so a failed push cannot exit 0",
    );
  });

  test('a failed push explains that the change is local-only', () => {
    // The operator needs to know two things: the write is not lost, and it has not published.
    assert.ok(/LOCAL ONLY/i.test(ask), 'the failure message must say the change is local-only');
    assert.ok(/bd-dolt-sync\.mjs push/.test(ask), 'the failure message must name the retry command');
  });

  test('the ask-review skill tells the reader to use the verified helper', () => {
    assert.ok(
      /bd-dolt-sync\.mjs/.test(skill),
      'SKILL.md close-out must route through scripts/bd-dolt-sync.mjs',
    );
    assert.ok(
      !/^\s*bd dolt pull && bd dolt push\s*$/m.test(skill),
      'SKILL.md must not instruct the bare `bd dolt pull && bd dolt push` sequence',
    );
  });

  test('behavioural: syncExitCode starts clean', () => {
    assert.equal(typeof syncExitCode, 'function');
    assert.equal(syncExitCode(), 0);
  });
});

// ── the real flows, against stub edges ─────────────────────────────────────────

const PEOPLE = buildPeople(['alice', 'bob']);
const FIXED_NOW = new Date('2026-08-22T12:00:00Z');

/** A deps object with a recording bd, a scriptable sync, and captured output. */
function harness({ beads = [], syncOk = { pull: true, push: true }, actorBase = 'alice', env = {} } = {}) {
  const calls = { bd: [], sync: [] };
  const out = { log: [], warn: [], error: [] };
  const deps = {
    ...defaultDeps(),
    bd(args) {
      calls.bd.push(args);
      if (args[0] === 'list' && args[1] === '--id') {
        return JSON.stringify(beads.filter((b) => b.id === args[2]));
      }
      if (args[0] === 'list' && args[1] === '--label') {
        const label = args[2];
        return JSON.stringify(beads.filter((b) => (b.labels ?? []).includes(label)));
      }
      return '';
    },
    sync(kind) {
      calls.sync.push(kind);
      return { ok: syncOk[kind] };
    },
    gitEmail: () => '',
    actor: () => ({ base: actorBase }),
    env,
    people: PEOPLE,
    now: () => FIXED_NOW,
    log: (l) => out.log.push(l),
    warn: (l) => out.warn.push(l),
    error: (l) => out.error.push(l),
  };
  return { deps, calls, out };
}

const bead = (extra = {}) => ({ id: 'bd-1', title: 'Pick a debounce', status: 'open', labels: [], ...extra });

describe('ask.mjs flows with a stub bd', () => {
  beforeEach(() => resetSyncState());

  test('add: pulls, writes label + metadata + audit note in one update, then pushes', () => {
    const { deps, calls, out } = harness({ beads: [bead()] });
    const code = main(['bd-1', 'bob', 'two', 'fixes', 'trade', 'off'], deps);
    assert.equal(code, 0);
    assert.deepEqual(calls.sync, ['pull', 'push']);
    const update = calls.bd.find((a) => a[0] === 'update');
    assert.deepEqual(update.slice(0, 4), ['update', 'bd-1', '--add-label', 'ask-bob']);
    assert.ok(update.includes('ask_bob_by=alice'), 'the requester is the resolved person, not the raw base');
    assert.ok(update.includes('ask_bob_at=2026-08-22T12:00:00.000Z'));
    assert.ok(update.includes('ask_bob_reason=two fixes trade off'));
    assert.ok(update.includes('[ask→bob by alice 2026-08-22] two fixes trade off'));
    assert.match(out.log[0], /Asked Bob to look at bd-1: Pick a debounce/);
    assert.equal(syncExitCode(), 0);
  });

  test('add with no reason unsets any old reason and records the no-reason note', () => {
    const { deps, calls } = harness({ beads: [bead()] });
    main(['bd-1', 'bob'], deps);
    const update = calls.bd.find((a) => a[0] === 'update');
    assert.ok(update.includes('--unset-metadata') && update.includes('ask_bob_reason'));
    assert.ok(update.some((a) => /\(no reason given/.test(a)));
  });

  test('add refuses an unknown person, a missing bead and a closed bead without writing', () => {
    for (const [argv, beads, message] of [
      [['bd-1', 'mallory'], [bead()], /Unknown person "mallory"\. Known people: alice, bob/],
      [['bd-404', 'bob'], [bead()], /Bead bd-404 not found/],
      [['bd-1', 'bob'], [bead({ status: 'closed' })], /is closed/],
    ]) {
      const { deps, calls } = harness({ beads });
      assert.throws(() => main(argv, deps), message);
      assert.ok(!calls.bd.some((a) => a[0] === 'update'), 'nothing may be written');
      assert.ok(!calls.sync.includes('push'));
    }
  });

  test('add refuses to overwrite an existing ask unless --replace is given', () => {
    const existing = bead({ labels: ['ask-bob'], metadata: { ask_bob_reason: 'old reason' } });
    const refused = harness({ beads: [existing] });
    assert.throws(() => main(['bd-1', 'bob', 'new'], refused.deps), /already has an open ask on bd-1:\n {2}"old reason"/);
    assert.ok(!refused.calls.bd.some((a) => a[0] === 'update'));

    const replaced = harness({ beads: [existing] });
    assert.equal(main(['bd-1', 'bob', 'new', '--replace'], replaced.deps), 0);
    assert.ok(replaced.calls.bd.some((a) => a[0] === 'update'));
  });

  test('clear removes the label, unsets all three keys and records who cleared it', () => {
    const { deps, calls, out } = harness({ beads: [bead({ labels: ['ask-bob'] })] });
    assert.equal(main(['clear', 'bd-1', 'bob', 'going', 'with', 'A'], deps), 0);
    const update = calls.bd.find((a) => a[0] === 'update');
    assert.ok(update.includes('--remove-label') && update.includes('ask-bob'));
    for (const key of ['ask_bob_by', 'ask_bob_at', 'ask_bob_reason']) assert.ok(update.includes(key), key);
    assert.ok(update.includes('[ask→bob CLEARED by alice 2026-08-22] going with A'));
    assert.match(out.log.join('\n'), /Cleared the ask for Bob on bd-1/);
    assert.deepEqual(calls.sync, ['pull', 'push']);
  });

  test('clear with no ask on the bead is a quiet no-op: no write, no push', () => {
    const { deps, calls, out } = harness({ beads: [bead()] });
    assert.equal(main(['clear', 'bd-1', 'bob'], deps), 0);
    assert.ok(!calls.bd.some((a) => a[0] === 'update'));
    assert.ok(!calls.sync.includes('push'));
    assert.match(out.log[0], /nothing to clear/);
  });

  test('list reads one inbox call, for me by default and for someone else with --for', () => {
    const beads = [
      bead({ id: 'bd-a', labels: ['ask-alice'], metadata: { ask_alice_by: 'bob', ask_alice_at: '2026-08-20T12:00:00Z' } }),
      bead({ id: 'bd-b', labels: ['ask-bob'] }),
    ];
    const mine = harness({ beads });
    assert.equal(main(['list'], mine.deps), 0);
    assert.deepEqual(mine.calls.bd, [['list', '--label', 'ask-alice', '--all', '--json', '-n', '0']]);
    assert.deepEqual(mine.calls.sync, [], 'a read-only list does not sync');
    assert.match(mine.out.log.join('\n'), /1 bead is waiting on Alice:[\s\S]*bd-a/);

    const theirs = harness({ beads });
    main(['list', '--for', 'bob', '--json'], theirs.deps);
    const parsed = JSON.parse(theirs.out.log[0]);
    assert.equal(parsed.person, 'bob');
    assert.deepEqual(parsed.asks.map((a) => a.id), ['bd-b']);
  });

  test('list says all clear for an empty inbox and explains an unknown identity', () => {
    const empty = harness({ beads: [] });
    main(['list'], empty.deps);
    assert.match(empty.out.log[0], /No beads are waiting on Alice\. All clear\./);

    const stranger = harness({ beads: [], actorBase: 'someone-new' });
    assert.throws(() => main(['list'], stranger.deps), /Could not tell which person "someone-new" is\. Known people: alice, bob/);
  });

  test('no people configured: the error says where to add them', () => {
    const { deps } = harness({ beads: [bead()] });
    deps.people = [];
    assert.throws(() => main(['bd-1', 'bob'], deps), /Add a handle to "people" in agent-tooling\.json/);
    assert.match(
      (() => { const h = harness(); h.deps.people = []; main(['--help'], h.deps); return h.out.log[0]; })(),
      /none configured/,
    );
  });

  test('a failed push is loud, keeps the local write, and escalates the exit code', () => {
    const { deps, calls, out } = harness({ beads: [bead()], syncOk: { pull: true, push: false } });
    const code = main(['bd-1', 'bob', 'why'], deps);
    assert.equal(code, 0, "main()'s own result is unaffected");
    assert.ok(calls.bd.some((a) => a[0] === 'update'), 'the local write still happened');
    assert.match(out.error.join('\n'), /PUSH FAILED[\s\S]*LOCAL ONLY[\s\S]*Retry with:/);
    assert.equal(syncExitCode(), 1);
    assert.match(out.log[0], /Asked Bob/, 'the user-facing result is still printed');
  });

  test('a failed pull warns that the asks may be stale and also escalates the exit code', () => {
    const { deps, out } = harness({ beads: [bead()], syncOk: { pull: false, push: true } });
    main(['bd-1', 'bob'], deps);
    assert.match(out.warn.join('\n'), /could not verify a pull[\s\S]*STALE/);
    assert.equal(syncExitCode(), 1);
  });

  test('help prints usage with the configured people and exits 0; no args and bad flags behave', () => {
    const { deps, out } = harness();
    assert.equal(main(['-h'], deps), 0);
    assert.match(out.log[0], /People: alice, bob/);
    assert.throws(() => main(['bd-1'], deps), /Usage: node scripts\/ask\.mjs/);
    assert.throws(() => main(['clear', 'bd-1'], deps), /Usage: node scripts\/ask\.mjs clear/);
  });
});
