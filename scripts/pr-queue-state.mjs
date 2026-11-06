#!/usr/bin/env node
/**
 * Where a PR stands in the merge pipeline, from ONE GraphQL read .
 *
 *   node scripts/pr-queue-state.mjs <pr> [--repo owner/name] [--json]
 *   node scripts/pr-queue-state.mjs <pr> <pr> ... [--repo owner/name] [--json]   # N PRs, ONE request
 *   node scripts/pr-queue-state.mjs <pr> --dequeue [--repo owner/name] [--json]
 *   node scripts/pr-queue-state.mjs <pr> --rearm [--repo owner/name] [--json]
 *
 * --rearm arms auto-merge only once the PR workflow (pr.yml, or AGENT_TOOLING_PR_WORKFLOW) has a pull_request run for the PR's current head, and
 * exits 1 without arming otherwise. Use it after a push instead of a bare
 * `gh pr merge --auto <n>`: arming straight after a push once re-queued a PR on its OLD head. It is
 * also how a draft is armed after `gh pr ready`: it refuses a draft, and a PR whose ready_for_review
 * run has not started yet.
 *
 * --dequeue takes a queued PR OUT of the merge queue, so a fix can be pushed to its locked branch
 * (re-arm with `--rearm` after the push). `gh pr merge --disable-auto` does NOT do
 * this: it prints "already queued to merge", exits 0 and leaves the PR queued, because the queue
 * entry has already consumed the auto-merge request . It reads the state again after
 * the mutation and exits 1 if the PR is still queued. A PR that is not queued is left alone and
 * its state printed.
 *
 * Prints one line, `<verdict> ...`, or with --json the whole answer:
 *
 *   merged    the PR merged (mergeCommit)
 *   closed    closed without merging
 *   queued    in the merge queue: `queued <STATE> <position>` (QUEUED, AWAITING_CHECKS, MERGEABLE,
 *             UNMERGEABLE, LOCKED). An agent treats this as DONE and moves on: the queue merges it, or ejects it and says so.
 *   ejected   open, not queued, and its last merge-queue event is a removal:
 *             `ejected <reason> <rearmed|unarmed>` (reason: failed_checks, merge_conflict, ...).
 *             `unarmed` needs a person: read the failing merge_group run, fix or rebase, then re-arm
 *             with `gh pr merge --auto <n>`. `rearmed` is waiting for its gate to re-enter.
 *   held      open, not queued, and the next move is the AUTHOR's: `held review` when a
 *             CHANGES_REQUESTED review stands on the CURRENT head (one on an older head means a fix
 *             was pushed and waits for re-review: that is plain `open`), `held conflict` when
 *             mergeStateStatus is DIRTY, `held gate` when the required `gate` check concluded red on
 *             the current head (single-PR read only). Nothing will queue it until the
 *             author acts, so a landing script should stop and a watchdog may
 *             comments on an armed one held by a review or a conflict.
 *   open      open and not queued for any other reason (CI pending, review pending, auto-merge
 *             unarmed)
 *
 * WHY THIS AND NOT `gh pr view`. `autoMergeRequest` reads null once a PR is queued, and
 * `gh pr merge --auto` only prints that the queue sets the strategy, so the REST/CLI views cannot
 * tell "queued" from "never armed", nor "ejected" from "not yet queued". The merge-queue entry and
 * the timeline's AddedToMergeQueueEvent / RemovedFromMergeQueueEvent are GraphQL-only.
 *
 * SEVERAL PRs are read in ONE aliased GraphQL query, never one call each: the shared
 * account's secondary rate limit counts requests across every session, so per-PR polling by a few
 * sessions stalls them all. Each PR prints `#<n> <verdict> ... checks:<rollup>` (the head commit's
 * statusCheckRollup: SUCCESS, FAILURE, PENDING, ERROR, EXPECTED, or none); --json prints an array.
 * A watcher polls this every 5 minutes or slower.
 *
 * RATE LIMITED: when GitHub answers with a rate limit (primary or secondary), stdout is the one
 * line `ratelimited` and the exit is 3, so a poller backs off instead of reading "no state".
 *
 * Exit 0 with an answer; 1 when GitHub could not be read; 2 on a usage error; 3 rate limited.
 * Env: GH_CLI (default `gh`), REPO (default: the checkout's origin). AGENT_TOOLING_PR_WORKFLOW
 * (the pull_request workflow file --rearm looks for, default pr.yml), AGENT_TOOLING_GATE_CHECK (the required
 * check name `held gate` reads, default gate).
 */
import fs, { realpathSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isRateLimited } from './lib/gh-rate-limit.mjs';
import { parseFlags } from './lib/parse-flags.mjs';

class UsageError extends Error {}

/** The pullRequest fields classify() reads; scripts/pr-held-watchdog.mjs lists open PRs with the same set. */
export const PR_FIELDS = `id number state isDraft author{login} headRefOid mergeCommit{oid} autoMergeRequest{enabledAt}
mergeQueueEntry{state position} reviewDecision mergeStateStatus
latestOpinionatedReviews(first:20){nodes{state submittedAt author{login} commit{oid}}}
commits(last:1){nodes{commit{committedDate}}}
timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename ... on RemovedFromMergeQueueEvent{createdAt reason} ... on AddedToMergeQueueEvent{createdAt}}}`;

/**
 * The single-PR read adds the head's check runs for heldBy()'s `gate` reason. Only here: every other
 * caller reads many PRs at once, where a contexts connection on each costs far more than it answers.
 */
const HEAD_CHECKS = `headChecks: commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{
  __typename
  ... on CheckRun{name conclusion startedAt}
}}}}}}`;

/**
 * The single-PR read also carries when the PR last left draft, for rearm(): a draft's
 * PR workflow run on the same head skips every job, so "a run exists for the head" is not enough there.
 */
const READY_EVENT = 'readyEvents: timelineItems(last:1,itemTypes:[READY_FOR_REVIEW_EVENT]){nodes{... on ReadyForReviewEvent{createdAt}}}';

export const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
${PR_FIELDS}
${HEAD_CHECKS}
${READY_EVENT}}}}`;

/**
 * The multi-PR read: one alias per PR, `p<n>: pullRequest(number:<n>)`, plus the head
 * commit's check rollup under its own alias. Numbers are validated integers, so inlining them is safe.
 * A watcher script may add to the same ONE request: `headChecks` (so a batched read can
 * still answer `held gate`), `extraPrFields` inside each PR, and `extra` beside them in the repository.
 */
export function batchQuery(numbers, { headChecks = false, extraPrFields = '', extra = '' } = {}) {
  const prs = numbers.map((n) => {
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`not a PR number: ${n}`);
    return `p${n}: pullRequest(number:${n}){${PR_FIELDS}
checks: commits(last:1){nodes{commit{statusCheckRollup{state}}}}${headChecks ? `\n${HEAD_CHECKS}` : ''}${extraPrFields ? `\n${extraPrFields}` : ''}}`;
  });
  return `query($owner:String!,$name:String!){repository(owner:$owner,name:$name){
${prs.join('\n')}${extra ? `\n${extra}` : ''}}}`;
}

/** The required check name `held gate` reads (default `gate`). */
export function gateCheckName(env = process.env) {
  return env.AGENT_TOOLING_GATE_CHECK || 'gate';
}

/** The pull_request workflow file rearm() looks for runs of (default `pr.yml`). */
export function prWorkflowFile(env = process.env) {
  return env.AGENT_TOOLING_PR_WORKFLOW || 'pr.yml';
}

/**
 * Why an open, unqueued PR waits on its AUTHOR, or null. Pure.
 * `review`: a CHANGES_REQUESTED review on the current head (a review with no commit counts as on it).
 * `conflict`: mergeStateStatus DIRTY. `since` is the newest blocking review's submittedAt, or for a
 * conflict the head commit's committedDate: GitHub does not timestamp the moment main moved under
 * the PR, so "no push since" is the age that matters.
 * `gate`: the required check concluded red on the current head. An armed PR in that
 * state reads as merely unqueued, and one sat there unread for two landing-script caps. Absent
 * `headChecks` (any read but the single-PR one) it is never reported.
 */
export function heldBy(pr) {
  const head = pr.headRefOid ?? null;
  if (pr.reviewDecision === 'CHANGES_REQUESTED') {
    const blocking = (pr.latestOpinionatedReviews?.nodes ?? []).filter((r) => r.state === 'CHANGES_REQUESTED');
    const onHead = blocking.filter((r) => !head || !r.commit?.oid || r.commit.oid === head);
    if (!blocking.length || onHead.length) {
      const since = onHead.map((r) => r.submittedAt).filter(Boolean).sort().at(-1) ?? null;
      return { reason: 'review', since, by: [...new Set(onHead.map((r) => r.author?.login).filter(Boolean))] };
    }
  }
  if (pr.mergeStateStatus === 'DIRTY') {
    return { reason: 'conflict', since: pr.commits?.nodes?.at(-1)?.commit?.committedDate ?? null, by: [] };
  }
  // One head can carry several `gate` runs, listed in no time order. The newest decides, one not
  // started yet counts as the newest, and a SKIPPED one is no verdict.
  const contexts = pr.headChecks?.nodes?.at(-1)?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const [gate] = contexts
    .filter((c) => c.name === gateCheckName() && c.conclusion !== 'SKIPPED')
    .sort((a, b) => (b.startedAt ?? '9').localeCompare(a.startedAt ?? '9'));
  if (gate?.conclusion === 'FAILURE' || gate?.conclusion === 'TIMED_OUT') {
    return { reason: 'gate', since: null, by: [] };
  }
  return null;
}

/** The verdict from the GraphQL pullRequest node. Pure. */
export function classify(pr) {
  if (!pr) throw new Error('no such pull request');
  const last = pr.timelineItems?.nodes?.at(-1) ?? null;
  const base = {
    id: pr.id ?? null,
    number: pr.number,
    state: pr.state,
    merge_commit: pr.mergeCommit?.oid ?? null,
    auto_merge: Boolean(pr.autoMergeRequest),
    queue: pr.mergeQueueEntry ? { state: pr.mergeQueueEntry.state, position: pr.mergeQueueEntry.position } : null,
    last_queue_event: last ? { type: last.__typename, at: last.createdAt ?? null, reason: last.reason ?? null } : null,
    draft: Boolean(pr.isDraft),
    author: pr.author?.login ?? null,
    head: pr.headRefOid ?? null,
    ready_at: pr.readyEvents?.nodes?.at(-1)?.createdAt ?? null,
    held: null,
  };
  if (pr.state === 'MERGED') return { verdict: 'merged', ...base };
  if (pr.state === 'CLOSED') return { verdict: 'closed', ...base };
  if (pr.mergeQueueEntry) return { verdict: 'queued', ...base };
  if (last?.__typename === 'RemovedFromMergeQueueEvent') return { verdict: 'ejected', ...base };
  const held = heldBy(pr);
  if (held) return { verdict: 'held', ...base, held };
  return { verdict: 'open', ...base };
}

/** One line for a shell caller: `<verdict>` plus what it needs. Pure. */
export function line(s) {
  if (s.verdict === 'queued') return `queued ${s.queue.state} ${s.queue.position}`;
  if (s.verdict === 'ejected') return `ejected ${s.last_queue_event.reason ?? 'unknown'} ${s.auto_merge ? 'rearmed' : 'unarmed'}`;
  if (s.verdict === 'merged') return `merged ${s.merge_commit ?? ''}`.trim();
  if (s.verdict === 'held') return `held ${s.held.reason}`;
  return s.verdict;
}

function repoFromOrigin() {
  const r = spawnSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' });
  const m = /github\.com[:/]([^/]+\/[^/.]+?)(\.git)?\/?$/.exec((r.stdout ?? '').trim());
  return m ? m[1] : null;
}

/** Reads and classifies; `gh(args) -> stdout` is injectable. */
export function readState({ repo, number, gh }) {
  const [owner, name] = repo.split('/');
  const out = gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `number=${number}`, '-f', `query=${QUERY}`]);
  const body = JSON.parse(out);
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  return classify(body.data?.repository?.pullRequest);
}

/**
 * Reads and classifies N PRs in ONE request; `gh(args) -> stdout` is injectable. Each
 * answer carries `checks`, the head commit's statusCheckRollup state or null. A PR GitHub does not
 * know is `{ number, verdict: 'missing' }` rather than failing the whole read.
 */
export function readStates({ repo, numbers, gh }) {
  return readBatch({ repo, numbers, gh }).states;
}

/**
 * readStates() plus the raw repository node, for a caller that put more into the same request
 * (batchQuery's options, e.g. a watcher script). Still ONE request.
 */
export function readBatch({ repo, numbers, gh, ...options }) {
  const [owner, name] = repo.split('/');
  const body = JSON.parse(gh(['api', 'graphql', '-F', `owner=${owner}`, '-F', `name=${name}`, '-f', `query=${batchQuery(numbers, options)}`]));
  const repoNode = body.data?.repository;
  // A missing PR is a per-alias NOT_FOUND error beside partial data; anything else fails the read.
  const fatal = (body.errors ?? []).filter((e) => e.type !== 'NOT_FOUND');
  if (fatal.length) throw new Error(fatal.map((e) => e.message).join('; '));
  if (!repoNode) throw new Error((body.errors ?? [{ message: 'no repository in the answer' }]).map((e) => e.message).join('; '));
  const states = numbers.map((n) => {
    const pr = repoNode[`p${n}`];
    if (!pr) return { number: n, verdict: 'missing', checks: null };
    return { ...classify(pr), checks: pr.checks?.nodes?.at(-1)?.commit?.statusCheckRollup?.state ?? null };
  });
  return { states, repoNode };
}

/** One line per PR for the multi-PR read. Pure. */
export function batchLine(s) {
  return `#${s.number} ${s.verdict === 'missing' ? 'missing' : line(s)} checks:${s.checks ?? 'none'}`;
}

export const DEQUEUE = 'mutation($id:ID!){dequeuePullRequest(input:{id:$id}){mergeQueueEntry{state}}}';

/**
 * Takes a queued PR out of the merge queue and returns its state AFTER, read again: a mutation
 * that answered without effect must not read as done. A PR that is not queued is returned as is.
 */
export function dequeue({ repo, number, gh }) {
  const before = readState({ repo, number, gh });
  if (before.verdict !== 'queued') return before;
  if (!before.id) throw new Error('the PR read carried no node id to dequeue');
  const body = JSON.parse(gh(['api', 'graphql', '-f', `id=${before.id}`, '-f', `query=${DEQUEUE}`]));
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  const after = readState({ repo, number, gh });
  // GitHub's read can lag its write; a PR that really left reads as out on a re-run.
  if (after.verdict === 'queued') throw new Error(`still in the merge queue after the dequeue (${line(after)}); re-run to confirm`);
  return after;
}

/**
 * Re-arms auto-merge, but only once the PR workflow has a pull_request run for the PR's CURRENT head.
 * A PR was dequeued, its fix pushed and `gh pr merge --auto` run at once: no PR workflow
 * run ever started for the new head, the PR went straight back into the queue, and the queue tested
 * the OLD head and ejected it again 40 minutes later. Merged, closed or still-queued PRs are
 * returned as they are; nothing is armed.
 *
 * A draft is refused, and so is a PR that left draft after the newest PR workflow run on its head started.
 * One PR ran `gh pr ready` and `gh pr merge --auto` back to back: the draft's run had
 * skipped every job, so mergeStateStatus read CLEAN and the arm ENQUEUED it before its
 * ready_for_review run began; the queue ejected it 18 minutes later on checks the PR never saw.
 */
export function rearm({ repo, number, gh }) {
  const before = readState({ repo, number, gh });
  if (['merged', 'closed', 'queued'].includes(before.verdict)) return before;
  if (!before.head) throw new Error('the PR read carried no head commit');
  if (before.draft) throw new Error('it is still a draft, so it was NOT armed: run gh pr ready first, then --rearm once its run has started');
  const runs = JSON.parse(gh(['api', `repos/${repo}/actions/workflows/${prWorkflowFile()}/runs?head_sha=${before.head}&event=pull_request&per_page=1`]));
  if (!runs.total_count) {
    throw new Error(
      `no ${prWorkflowFile()} run for the head ${before.head.slice(0, 9)} yet, so it was NOT armed: wait for the run ` +
        'to start and re-run --rearm; if none ever starts, push again (a rebase onto origin/main will do)',
    );
  }
  // Runs are listed newest first. One created before the PR left draft is the draft's skipped run.
  const newest = runs.workflow_runs?.[0]?.created_at ?? null;
  if (before.ready_at && (!newest || newest < before.ready_at)) {
    throw new Error(
      `the PR left draft at ${before.ready_at} and its ready_for_review ${prWorkflowFile()} run has not started yet, so it ` +
        "was NOT armed (arming now would enqueue it on the draft's skipped checks): re-run --rearm in a minute",
    );
  }
  gh(['pr', 'merge', '--auto', String(number), '--repo', repo]);
  return readState({ repo, number, gh });
}

/**
 * True when GH_CLI names a shell script, which node cannot exec on Windows (a test's fake
 * gh, a wrapper), so bash has to run it; there the read failed and every queued PR read as plain
 * "open". Only a file that EXISTS and starts with `#!` qualifies: a landing script exported
 * GH_CLI=gh, `bash gh` found gh.exe on PATH and died with "cannot execute binary file", so it
 * never read the PR on Windows. A native gh (`gh`, `gh.exe`, a path to either) is spawned directly.
 */
export function needsBash(bin, { platform = process.platform, readHead = readTwoBytes } = {}) {
  if (platform !== 'win32' || !bin || /\.(exe|cmd|bat|com)$/i.test(bin)) return false;
  return readHead(bin) === '#!';
}

function readTwoBytes(file) {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(2);
      return buf.toString('utf8', 0, fs.readSync(fd, buf, 0, 2, 0));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

export function ghCli(args) {
  const bin = process.env.GH_CLI || 'gh';
  const r = needsBash(bin) ? spawnSync('bash', [bin, ...args], { encoding: 'utf8' }) : spawnSync(bin, args, { encoding: 'utf8' });
  // `gh api graphql` exits 1 on ANY error, partial ones included (one unknown PR in a multi-PR read);
  // a GraphQL body on stdout is returned so the caller judges its `errors` itself.
  if (r.status !== 0 && args[1] === 'graphql' && /^\{"(data|errors)"/.test((r.stdout ?? '').trim())) return r.stdout;
  if (r.status !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')}: ${(r.stderr || r.error?.message || '').trim().slice(0, 300)}`);
  return r.stdout;
}

export function main(argv, { env = process.env, gh = ghCli, stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags; let positionals;
  try {
    ({ flags, positionals } = parseFlags(argv, { ErrorClass: UsageError, flags: { repo: {}, json: { type: 'boolean' }, dequeue: { type: 'boolean' }, rearm: { type: 'boolean' } } }));
    if (!positionals.length || positionals.some((p) => !/^[0-9]+$/.test(p))) throw new UsageError('give one or more PR numbers');
    if (positionals.length > 1 && (flags.dequeue || flags.rearm)) throw new UsageError('--dequeue and --rearm take exactly one PR number');
    if (flags.dequeue && flags.rearm) throw new UsageError('--dequeue and --rearm are separate steps: dequeue, push the fix, then --rearm');
  } catch (err) {
    if (err instanceof UsageError) { stderr.write(`pr-queue-state: ${err.message}\nusage: node scripts/pr-queue-state.mjs <pr> [<pr> ...] [--dequeue | --rearm] [--repo owner/name] [--json]\n`); return 2; }
    throw err;
  }
  const repo = flags.repo ?? env.REPO ?? repoFromOrigin();
  if (!/^[^/]+\/[^/]+$/.test(repo ?? '')) { stderr.write('pr-queue-state: cannot tell the repo; pass --repo owner/name or set REPO\n'); return 2; }
  const action = flags.dequeue ? 'dequeue' : flags.rearm ? 'rearm' : 'read';
  const many = positionals.length > 1;
  let state;
  try {
    state = many
      ? readStates({ repo, numbers: positionals.map(Number), gh })
      : { dequeue, rearm, read: readState }[action]({ repo, number: Number(positionals[0]), gh });
  } catch (err) {
    const what = many ? `PRs ${positionals.map((p) => `#${p}`).join(' ')}` : `PR #${positionals[0]}`;
    if (isRateLimited(err.message)) {
      // A poller backs off on this; it is neither "no state" nor a hard failure.
      stderr.write(`pr-queue-state: GitHub rate-limited the ${action} of ${what}; back off 5+ min, never retry at once: ${err.message}\n`);
      stdout.write('ratelimited\n');
      return 3;
    }
    stderr.write(`pr-queue-state: could not ${action} ${what}: ${err.message}\n`);
    return 1;
  }
  if (flags.json) stdout.write(`${JSON.stringify(state)}\n`);
  else stdout.write(many ? state.map((s) => `${batchLine(s)}\n`).join('') : `${line(state)}\n`);
  return 0;
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
