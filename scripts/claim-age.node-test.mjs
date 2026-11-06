// Tests for scripts/claim-age.mjs, the 4h claim-age check claim.sh runs.
// The decide() cases are ported from the tests of the hook this check replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKED_EXIT, decide, formatAge, main, parseIssue, positiveNumber } from './claim-age.mjs';

const NOW = Date.parse('2026-08-22T01:54:42Z');
const minutesAgo = (m) => new Date(NOW - m * 60_000).toISOString();
const claim = (over = {}) => ({ assignee: 'Captain Goose', status: 'in_progress', started_at: minutesAgo(17), ...over });

test('blocks the 2026-08-22 collision: a 17-minute-old claim by another actor', () => {
  const v = decide({ issue: claim(), me: 'Strickdd Bot', now: NOW });
  assert.equal(v.blocked, true);
  assert.equal(v.holder, 'Captain Goose');
  assert.equal(formatAge(v.ageHours), '17 minutes');
});

test('a claim older than the window is reclaimable, and the boundary is exclusive', () => {
  assert.equal(decide({ issue: claim({ started_at: minutesAgo(5 * 60) }), me: 'Other', now: NOW }).blocked, false);
  assert.equal(decide({ issue: claim({ started_at: minutesAgo(4 * 60) }), me: 'Other', now: NOW }).blocked, false);
});

test('a custom window is honoured in both directions', () => {
  const issue = claim({ started_at: minutesAgo(3 * 60) });
  assert.equal(decide({ issue, me: 'Other', windowHours: 8, now: NOW }).blocked, true);
  assert.equal(decide({ issue, me: 'Other', windowHours: 2, now: NOW }).blocked, false);
});

test('your own claim is never blocked, ignoring case and surrounding whitespace', () => {
  assert.equal(decide({ issue: claim(), me: 'Captain Goose', now: NOW }).blocked, false);
  assert.equal(decide({ issue: claim({ assignee: '  captain goose ' }), me: 'Captain Goose', now: NOW }).blocked, false);
});

test('two sessions of one person with distinct ids collide; the same session does not', () => {
  const issue = claim({ assignee: 'captain-goose-bot-aaaaaaaa' });
  assert.equal(decide({ issue, me: 'captain-goose-bot-bbbbbbbb', meBase: 'captain-goose', now: NOW }).blocked, true);
  assert.equal(decide({ issue, me: 'captain-goose-bot-aaaaaaaa', meBase: 'captain-goose', now: NOW }).blocked, false);
});

test('a bare team-name claim from before per-session ids is treated as possibly ours', () => {
  assert.equal(decide({ issue: claim(), me: 'captain-goose-bot-bbbbbbbb', meBase: 'Captain Goose', now: NOW }).blocked, false);
});

test('every uncertain case fails open', () => {
  for (const status of ['open', 'closed', 'deferred']) {
    assert.equal(decide({ issue: claim({ status }), me: 'Other', now: NOW }).blocked, false, status);
  }
  assert.equal(decide({ issue: claim({ assignee: '' }), me: 'Other', now: NOW }).blocked, false);
  for (const started_at of [undefined, null, '', 'not a date']) {
    assert.equal(decide({ issue: claim({ started_at }), me: 'Other', now: NOW }).blocked, false);
  }
  assert.equal(decide({ issue: claim({ started_at: minutesAgo(-30) }), me: 'Other', now: NOW }).blocked, false);
  assert.equal(decide({ issue: null, me: 'Other', now: NOW }).blocked, false);
});

test('the camelCase startedAt spelling is read too', () => {
  const issue = { assignee: 'Captain Goose', status: 'in_progress', startedAt: minutesAgo(5) };
  assert.equal(decide({ issue, me: 'Other', now: NOW }).blocked, true);
});

test('parseIssue reads bd show --json array, wrapper and object shapes, and null on junk', () => {
  assert.equal(parseIssue('[{"id":"bd-a"}]').id, 'bd-a');
  assert.equal(parseIssue('{"issues":[{"id":"bd-b"}]}').id, 'bd-b');
  assert.equal(parseIssue('{"id":"bd-c"}').id, 'bd-c');
  assert.equal(parseIssue('[]'), null);
  assert.equal(parseIssue('not json'), null);
});

test('positiveNumber accepts only finite positive numbers', () => {
  assert.equal(positiveNumber('8'), 8);
  for (const raw of ['', '0', '-1', 'x', undefined]) assert.equal(positiveNumber(raw), null);
});

test('main: refuses with exit 3 and names claim.sh and the hatch; the hatch and junk input pass', () => {
  const fresh = JSON.stringify([{ assignee: 'other-bot-bbbbbbbb', status: 'in_progress', started_at: new Date().toISOString() }]);
  const argv = ['bd-x', '--actor', 'me-bot-aaaaaaaa', '--base', 'me'];
  const r = main(argv, {}, () => fresh);
  assert.equal(r.code, BLOCKED_EXIT);
  assert.match(r.message, /refusing to claim bd-x: it is held by "other-bot-bbbbbbbb"/);
  assert.match(r.message, /AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 bash scripts\/claim\.sh bd-x/);
  assert.equal(main(argv, { AGENT_TOOLING_ALLOW_CLAIM_STEAL: '1' }, () => fresh).code, 0);
  const hourAgo = JSON.stringify([{ assignee: 'other-bot-bbbbbbbb', status: 'in_progress', started_at: new Date(Date.now() - 3_600_000).toISOString() }]);
  assert.equal(main(argv, { AGENT_TOOLING_CLAIM_COLLISION_HOURS: '0.5' }, () => hourAgo).code, 0, 'the window env var is honoured');
  assert.equal(main(argv, {}, () => 'garbage').code, 0);
  assert.equal(
    main(argv, {}, () => {
      throw new Error('no stdin');
    }).code,
    0,
  );
});

test('main: the takeover hint names the configured claim helper, not a hardcoded path', () => {
  const fresh = JSON.stringify([{ assignee: 'other-bot-bbbbbbbb', status: 'in_progress', started_at: new Date().toISOString() }]);
  const argv = ['bd-x', '--actor', 'me-bot-aaaaaaaa', '--base', 'me'];
  const r = main(argv, {}, () => fresh, 'tools/take.sh');
  assert.equal(r.code, BLOCKED_EXIT);
  assert.match(r.message, /AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 bash tools\/take\.sh bd-x/);
});
