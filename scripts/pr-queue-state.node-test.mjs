// scripts/pr-queue-state.mjs: the one GraphQL read of a PR's merge-pipeline state.
import test from 'node:test';
import assert from 'node:assert/strict';

import { batchQuery, classify, DEQUEUE, dequeue, line, main as stateMain, needsBash, QUERY, readState, readStates, rearm } from './pr-queue-state.mjs';

const node = (over = {}) => ({ number: 7, state: 'OPEN', mergeCommit: null, autoMergeRequest: null, mergeQueueEntry: null, timelineItems: { nodes: [] }, ...over });
const removed = (reason) => ({ timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: 't', reason }] } });
const added = { timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent', createdAt: 't' }] } };

test('classify: merged, closed, queued, ejected (armed or not) and plain open', () => {
  assert.equal(line(classify(node({ state: 'MERGED', mergeCommit: { oid: 'abc' } }))), 'merged abc');
  assert.equal(line(classify(node({ state: 'CLOSED' }))), 'closed');
  assert.equal(line(classify(node({ mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 3 }, ...added }))), 'queued AWAITING_CHECKS 3');
  assert.equal(line(classify(node(removed('failed_checks')))), 'ejected failed_checks unarmed');
  assert.equal(line(classify(node({ ...removed('merge_conflict'), autoMergeRequest: { enabledAt: 't' } }))), 'ejected merge_conflict rearmed');
  assert.equal(line(classify(node())), 'open', 'never queued');
  assert.equal(line(classify(node(added))), 'open', 'an add with no entry (it just merged or was dequeued by hand) is not an ejection');
  assert.throws(() => classify(null), /no such pull request/);
});

// #5543 went red before the queue and read plain `open` for two land.sh caps.
test('classify: a red gate on the head is held gate; only that check, and only a concluded red', () => {
  const headChecks = (...nodes) => ({ headChecks: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes } } } }] } });
  const run = (name, conclusion) => ({ __typename: 'CheckRun', name, conclusion });
  const red = classify(node(headChecks(run('e2e', 'FAILURE'), run('gate', 'FAILURE'))));
  assert.equal(line(red), 'held gate');
  assert.deepEqual(red.held, { reason: 'gate', since: null, by: [] });
  assert.equal(line(classify(node(headChecks(run('gate', 'TIMED_OUT'))))), 'held gate');
  assert.equal(line(classify(node(headChecks(run('e2e', 'FAILURE'), run('gate', null))))), 'open', 'gate still running');
  assert.equal(line(classify(node(headChecks(run('gate', 'SUCCESS'))))), 'open');
  assert.equal(line(classify(node(headChecks(run('gate', 'CANCELLED'))))), 'open', 'a superseded run is not a verdict');
  assert.equal(line(classify(node(headChecks({ __typename: 'StatusContext' })))), 'open', 'a commit status has no name');
  assert.equal(line(classify(node({}))), 'open', 'a read without headChecks never reports it');
  assert.equal(line(classify(node({ mergeStateStatus: 'DIRTY', ...headChecks(run('gate', 'FAILURE')) }))), 'held conflict', 'the rebase comes first');
  assert.match(QUERY, /headChecks: commits\(last:1\)/);

  // One head can carry several gate runs, listed in no time order (#5460: red before SKIPPED, the
  // reverse of #5508's SKIPPED before SUCCESS).
  const at = (conclusion, startedAt) => ({ ...run('gate', conclusion), startedAt });
  const both = (a, b) => [line(classify(node(headChecks(a, b)))), line(classify(node(headChecks(b, a))))];
  const failed = at('FAILURE', '2026-10-30T19:38:00Z');
  assert.deepEqual(both(failed, at('SKIPPED', '2026-10-30T19:19:00Z')), ['held gate', 'held gate']);
  assert.deepEqual(both(failed, at('SKIPPED', '2026-10-30T19:50:00Z')), ['held gate', 'held gate'], 'a skip is no verdict');
  assert.deepEqual(both(failed, at('SUCCESS', '2026-10-30T19:10:00Z')), ['held gate', 'held gate'], 'it went red after a green');
  assert.deepEqual(both(failed, at('SUCCESS', '2026-10-30T19:50:00Z')), ['open', 'open'], 'a stale red');
  assert.deepEqual(both(failed, at(null, '2026-10-30T19:50:00Z')), ['open', 'open'], 'a newer run is in flight');
  assert.deepEqual(both(failed, at(null, null)), ['open', 'open'], 'a newer run has not started');
  assert.match(QUERY, /\.\.\. on CheckRun\{name conclusion startedAt\}/);
});

test('QUERY is a balanced document: never closes more than it opened, and ends at depth 0', () => {
  let depth = 0;
  for (const ch of QUERY) {
    depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
    assert.ok(depth >= 0, 'closed a brace it never opened');
  }
  assert.equal(depth, 0);
});

// #5452 sat armed for 23 hours at CHANGES_REQUESTED and then DIRTY, reading plain `open`.
test('classify: held review on the current head, held conflict, and a review on an older head is open', () => {
  const blocked = (commit, extra = {}) => node({ headRefOid: 'h2', reviewDecision: 'CHANGES_REQUESTED', latestOpinionatedReviews: { nodes: [
    { state: 'APPROVED', submittedAt: '2026-10-29T10:00:00Z', author: { login: 'reviewer1' }, commit: { oid: 'h2' } },
    { state: 'CHANGES_REQUESTED', submittedAt: '2026-10-29T13:48:15Z', author: { login: 'bot' }, commit: { oid: commit } },
  ] }, ...extra });
  const s = classify(blocked('h2'));
  assert.equal(line(s), 'held review');
  assert.deepEqual(s.held, { reason: 'review', since: '2026-10-29T13:48:15Z', by: ['bot'] });
  assert.equal(line(classify(blocked('h1'))), 'open', 'a fix was pushed after the review: waiting on the reviewer, not the author');
  assert.equal(line(classify(blocked('h1', { mergeStateStatus: 'DIRTY' }))), 'held conflict', 'the conflict still holds it');
  assert.equal(line(classify(node({ reviewDecision: 'CHANGES_REQUESTED' }))), 'held review', 'no review detail read: trust the decision');
  const dirty = classify(node({ mergeStateStatus: 'DIRTY', commits: { nodes: [{ commit: { committedDate: '2026-10-29T13:47:00Z' } }] } }));
  assert.equal(line(dirty), 'held conflict');
  assert.equal(dirty.held.since, '2026-10-29T13:47:00Z');
  for (const ms of ['BLOCKED', 'BEHIND', 'UNKNOWN', 'CLEAN', 'UNSTABLE']) assert.equal(line(classify(node({ mergeStateStatus: ms }))), 'open', ms);
  // Queued and ejected keep their verdicts whatever the review says.
  assert.equal(classify(node({ reviewDecision: 'CHANGES_REQUESTED', mergeQueueEntry: { state: 'QUEUED', position: 1 } })).verdict, 'queued');
  assert.equal(classify(node({ mergeStateStatus: 'DIRTY', ...removed('merge_conflict') })).verdict, 'ejected');
});

test('readState sends one GraphQL query with the variables and surfaces GraphQL errors', () => {
  let seen;
  const gh = (args) => { seen = args; return JSON.stringify({ data: { repository: { pullRequest: node(removed('failed_checks')) } } }); };
  assert.equal(readState({ repo: 'o/r', number: 7, gh }).verdict, 'ejected');
  assert.deepEqual(seen.slice(0, 8), ['api', 'graphql', '-F', 'owner=o', '-F', 'name=r', '-F', 'number=7']);
  assert.match(seen[9], /mergeQueueEntry\{state position\}/);
  assert.throws(() => readState({ repo: 'o/r', number: 7, gh: () => JSON.stringify({ errors: [{ message: 'nope' }] }) }), /nope/);
});

test('the CLI prints one line or JSON; 1 on a read failure, 2 on usage', () => {
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  const gh = () => JSON.stringify({ data: { repository: { pullRequest: node({ mergeQueueEntry: { state: 'QUEUED', position: 4 } }) } } });
  assert.equal(stateMain(['7', '--repo', 'o/r'], { gh, ...io }), 0);
  assert.equal(out, 'queued QUEUED 4\n');
  out = '';
  assert.equal(stateMain(['7', '--json'], { env: { REPO: 'o/r' }, gh, ...io }), 0);
  assert.equal(JSON.parse(out).queue.position, 4);
  assert.equal(stateMain(['7', '--repo', 'o/r'], { gh: () => { throw new Error('HTTP 502'); }, ...io }), 1);
  assert.equal(stateMain([], { env: { REPO: 'o/r' }, gh, ...io }), 2);
  assert.equal(stateMain(['x7'], { env: { REPO: 'o/r' }, gh, ...io }), 2);
});

// N PRs are ONE request, never one call each (the shared account's secondary limit).
test('several PRs are one aliased GraphQL read: a line each with the check rollup; an unknown PR is missing', () => {
  const calls = [];
  const gh = (args) => {
    calls.push(args);
    return JSON.stringify({
      data: { repository: {
        p7: { ...node({ mergeQueueEntry: { state: 'QUEUED', position: 2 } }), checks: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] } },
        p8: { ...node({ number: 8, state: 'MERGED', mergeCommit: { oid: 'abc' } }), checks: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] } },
        p9: null,
      } },
      errors: [{ type: 'NOT_FOUND', path: ['repository', 'p9'], message: 'Could not resolve to a PullRequest with the number of 9.' }],
    });
  };
  let out = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: () => {} } };
  assert.equal(stateMain(['7', '8', '9', '--repo', 'o/r'], { gh, ...io }), 0);
  assert.equal(calls.length, 1, 'one request for three PRs');
  const query = calls[0].find((a) => a.startsWith('query='));
  for (const n of [7, 8, 9]) assert.match(query, new RegExp(`p${n}: pullRequest\\(number:${n}\\)\\{`));
  assert.equal(out, '#7 queued QUEUED 2 checks:PENDING\n#8 merged abc checks:SUCCESS\n#9 missing checks:none\n');
  out = '';
  assert.equal(stateMain(['7', '8', '--json'], { env: { REPO: 'o/r' }, gh, ...io }), 0);
  assert.deepEqual(JSON.parse(out).map((s) => [s.number, s.verdict, s.checks]), [[7, 'queued', 'PENDING'], [8, 'merged', 'SUCCESS']]);
  assert.throws(() => readStates({ repo: 'o/r', numbers: [7], gh: () => JSON.stringify({ data: null, errors: [{ type: 'FORBIDDEN', message: 'no' }] }) }), /no/);
  assert.throws(() => batchQuery([0]), /not a PR number/);
  // pr-watch.mjs's additions are opt-in per call: the plain batch stays as it was.
  assert.doesNotMatch(query, /headChecks|beadsSynced/);
  const watched = batchQuery([7], { headChecks: true, extraPrFields: 'mergeDate: mergeCommit{committedDate}', extra: 'beadsSynced: ref(qualifiedName:"refs/tags/x"){id}' });
  assert.match(watched, /p7: pullRequest\(number:7\)\{[^]*headChecks: commits[^]*mergeDate: mergeCommit[^]*\}\nbeadsSynced: ref/);
  assert.equal(stateMain(['7', '8', '--dequeue'], { env: { REPO: 'o/r' }, gh, ...io }), 2, '--dequeue takes one PR');
});

test('a rate-limited read prints `ratelimited` and exits 3, for a poller to back off on', () => {
  let out = ''; let err = '';
  const io = { stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } } };
  const secondary = () => { throw new Error('gh api graphql: gh: You have exceeded a secondary rate limit. (HTTP 403)'); };
  assert.equal(stateMain(['7', '--repo', 'o/r'], { gh: secondary, ...io }), 3);
  assert.equal(out, 'ratelimited\n');
  assert.match(err, /back off/);
  out = '';
  const graphqlLimited = () => JSON.stringify({ errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded for user ID 1.' }] });
  assert.equal(stateMain(['7', '8', '--repo', 'o/r'], { gh: graphqlLimited, ...io }), 3);
  assert.equal(out, 'ratelimited\n');
  assert.equal(stateMain(['7', '--repo', 'o/r'], { gh: () => { throw new Error('HTTP 502: Bad Gateway'); }, ...io }), 1, 'other failures stay 1');
});

// `gh pr merge --disable-auto` leaves a queued PR queued, so --dequeue is the recipe.
test('--dequeue takes a queued PR out by its node id, and proves it by reading again', () => {
  const queued = node({ id: 'PR_kw7', mergeQueueEntry: { state: 'QUEUED', position: 4 }, ...added });
  const out = { text: '' };
  const io = { stdout: { write: (s) => { out.text += s; } }, stderr: { write: () => {} } };
  const calls = [];
  let left = false;
  const gh = (args) => {
    calls.push(args);
    if (args.includes(`query=${DEQUEUE}`)) { left = true; return JSON.stringify({ data: { dequeuePullRequest: { mergeQueueEntry: null } } }); }
    return JSON.stringify({ data: { repository: { pullRequest: left ? node({ id: 'PR_kw7', ...removed('manual') }) : queued } } });
  };
  assert.equal(stateMain(['7', '--dequeue', '--repo', 'o/r'], { gh, ...io }), 0);
  assert.equal(out.text, 'ejected manual unarmed\n');
  const mutation = calls.find((args) => args.includes(`query=${DEQUEUE}`));
  assert.deepEqual(mutation.slice(0, 4), ['api', 'graphql', '-f', 'id=PR_kw7']);
  assert.equal(calls.length, 3, 'read, dequeue, read again');

  // A mutation that answers but leaves it queued is a failure, not a quiet success.
  const stuck = (args) => (args.includes(`query=${DEQUEUE}`) ? '{"data":{}}' : JSON.stringify({ data: { repository: { pullRequest: queued } } }));
  assert.throws(() => dequeue({ repo: 'o/r', number: 7, gh: stuck }), /still in the merge queue after the dequeue \(queued QUEUED 4\)/);
  assert.equal(stateMain(['7', '--dequeue', '--repo', 'o/r'], { gh: stuck, ...io }), 1);
  // Not queued: nothing is sent, the state is the answer.
  const sent = [];
  const open = (args) => { sent.push(args); return JSON.stringify({ data: { repository: { pullRequest: node({ id: 'PR_kw7' }) } } }); };
  assert.equal(dequeue({ repo: 'o/r', number: 7, gh: open }).verdict, 'open');
  assert.equal(sent.length, 1);
});

// #5522 was armed straight after a push; no pr.yml run started for the new head and
// the queue re-tested the old one.
test('--rearm arms only once pr.yml has a run for the current head', () => {
  const out = { text: '', err: '' };
  const io = { stdout: { write: (s) => { out.text += s; } }, stderr: { write: (s) => { out.err += s; } } };
  const fake = (runCount) => {
    const calls = [];
    let armed = false;
    const gh = (args) => {
      calls.push(args);
      if (args[0] === 'pr') { armed = true; return ''; }
      if (args[0] === 'api' && args[1].startsWith('repos/')) return JSON.stringify({ total_count: runCount });
      const pr = armed ? node({ headRefOid: 'abc123def456', autoMergeRequest: { enabledAt: 't' }, ...removed('failed_checks') }) : node({ headRefOid: 'abc123def456', ...removed('failed_checks') });
      return JSON.stringify({ data: { repository: { pullRequest: pr } } });
    };
    return { gh, calls };
  };

  const ready = fake(1);
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: ready.gh, ...io }), 0);
  assert.equal(out.text, 'ejected failed_checks rearmed\n');
  assert.equal(ready.calls[1][1], 'repos/o/r/actions/workflows/pr.yml/runs?head_sha=abc123def456&event=pull_request&per_page=1');
  assert.deepEqual(ready.calls[2], ['pr', 'merge', '--auto', '7', '--repo', 'o/r']);

  const noRun = fake(0);
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: noRun.gh, ...io }), 1);
  assert.match(out.err, /no pr\.yml run for the head abc123def yet, so it was NOT armed/);
  assert.ok(!noRun.calls.some((args) => args[0] === 'pr'), 'nothing armed without a run');

  // Queued, merged and closed PRs are answered as they are: nothing is looked up or armed.
  for (const pr of [node({ mergeQueueEntry: { state: 'QUEUED', position: 2 } }), node({ state: 'MERGED', mergeCommit: { oid: 'm' } }), node({ state: 'CLOSED' })]) {
    const sent = [];
    const gh = (args) => { sent.push(args); return JSON.stringify({ data: { repository: { pullRequest: pr } } }); };
    rearm({ repo: 'o/r', number: 7, gh });
    assert.equal(sent.length, 1);
  }
  assert.equal(stateMain(['7', '--rearm', '--dequeue', '--repo', 'o/r'], { gh: ready.gh, ...io }), 2);
});

// #5599 ran gh pr ready and gh pr merge --auto back to back. The draft's run on the same
// head had skipped every job, mergeStateStatus read CLEAN, and the arm enqueued it before its
// ready_for_review run started.
test('--rearm refuses a draft, and a PR whose ready_for_review run has not started yet', () => {
  const out = { text: '', err: '' };
  const io = { stdout: { write: (s) => { out.text += s; } }, stderr: { write: (s) => { out.err += s; } } };
  const fake = ({ isDraft = false, readyAt = null, runCreatedAt = null }) => {
    const calls = [];
    const gh = (args) => {
      calls.push(args);
      if (args[0] === 'pr') return '';
      if (args[0] === 'api' && args[1].startsWith('repos/')) {
        return JSON.stringify({ total_count: 1, workflow_runs: runCreatedAt ? [{ created_at: runCreatedAt }] : [] });
      }
      const readyEvents = { nodes: readyAt ? [{ createdAt: readyAt }] : [] };
      return JSON.stringify({ data: { repository: { pullRequest: node({ headRefOid: 'abc123def456', isDraft, readyEvents }) } } });
    };
    return { gh, calls };
  };
  const armed = (f) => f.calls.some((args) => args[0] === 'pr');

  const draft = fake({ isDraft: true, runCreatedAt: '2026-11-01T17:00:00Z' });
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: draft.gh, ...io }), 1);
  assert.match(out.err, /still a draft, so it was NOT armed/);
  assert.ok(!armed(draft));

  // The only run on the head is the draft's, from before it left draft: not armed.
  const early = fake({ readyAt: '2026-11-01T17:02:30Z', runCreatedAt: '2026-11-01T16:50:00Z' });
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: early.gh, ...io }), 1);
  assert.match(out.err, /left draft at 2026-11-01T17:02:30Z and its ready_for_review pr\.yml run has not started yet/);
  assert.ok(!armed(early));

  // The ready_for_review run exists: armed.
  const ready = fake({ readyAt: '2026-11-01T17:02:30Z', runCreatedAt: '2026-11-01T17:02:33Z' });
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: ready.gh, ...io }), 0);
  assert.ok(armed(ready));

  // Never a draft (no ready event): one run for the head is enough, as before.
  const neverDraft = fake({ runCreatedAt: '2026-11-01T10:00:00Z' });
  assert.equal(stateMain(['7', '--rearm', '--repo', 'o/r'], { gh: neverDraft.gh, ...io }), 0);
  assert.ok(armed(neverDraft));

  assert.match(QUERY, /readyEvents: timelineItems\(last:1,itemTypes:\[READY_FOR_REVIEW_EVENT\]\)/);
});

// land.sh exported GH_CLI=gh, and on Windows `bash gh` ran gh.exe as a script.
test('needsBash: only an existing #! script on win32 goes through bash, never a native gh', () => {
  const script = () => '#!';
  const binary = () => 'MZ';
  const missing = () => null;
  assert.equal(needsBash('/tmp/fake-gh', { platform: 'win32', readHead: script }), true);
  assert.equal(needsBash('gh', { platform: 'win32', readHead: missing }), false, 'a bare name is not a file here');
  assert.equal(needsBash('/c/Program Files/GitHub CLI/gh', { platform: 'win32', readHead: binary }), false);
  for (const bin of ['gh.exe', 'C:/x/gh.EXE', 'gh.cmd']) assert.equal(needsBash(bin, { platform: 'win32', readHead: script }), false, bin);
  assert.equal(needsBash('/tmp/fake-gh', { platform: 'linux', readHead: script }), false);
});
