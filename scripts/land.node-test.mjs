// scripts/land.sh against a fixture repo (primary + bare origin + one worktree), a
// fake gh whose PR state and tag containment advance per call, a fake bd and a fake worktree-rm.sh:
// the three acceptance branches (exit 0 only after every Fixes bead reads closed and the worktree is
// gone; non-zero naming the bead that is not closed; --no-wait reports without blocking) plus the
// stops around them (CLOSED-not-merged, the wait cap, a copy of the script inside its own target).
// land.sh sequences scripts that other sets ship (the gate set's pr-queue-state.mjs and the libs it
// imports), so the tests that need them skip, with a reason, in a checkout that did not vendor them;
// the test that a missing sibling is reported by name runs either way.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeTempDir } from './test-support/cleanup.mjs';
import { shortForm } from './test-support/short-path.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// The gate set's files land.sh runs (and the libs pr-queue-state.mjs imports): the fixture copies them
// when they are here, and the tests that need them skip when they are not.
const GATE_FILES = ['pr-queue-state.mjs', 'lib/parse-flags.mjs', 'lib/gh-rate-limit.mjs'];
const MISSING_GATE = GATE_FILES.filter((f) => !existsSync(join(HERE, f)));
const NEEDS_GATE = MISSING_GATE.length > 0
  ? `needs the gate set (not vendored here: ${MISSING_GATE.join(', ')})` : false;
const gated = (name, fn) => test(name, { skip: NEEDS_GATE }, fn);
const HAS_WATCHER = existsSync(join(HERE, 'pr-watch.mjs'));
const watched = (name, fn) => test(name, { skip: NEEDS_GATE || (!HAS_WATCHER && 'needs pr-watch.mjs, which is not vendored here') }, fn);
const MERGE = 'm'.repeat(40);
const TAG = 't'.repeat(40);

// `gh` as land.sh calls it. Sequences are comma-separated and consumed one value per call through
// a counter file, the last value repeating. Each poll of the PR is ONE GraphQL read
// (scripts/pr-queue-state.mjs) that consumes one value of FAKE_PR_STATES ("OPEN,MERGED")
// AND one of FAKE_QUEUE ("QUEUED 3,NONE": the merge-queue entry, NONE = not queued,
// "EJECTED failed_checks" = removed with auto-merge off, "REARMED failed_checks" = removed, re-armed,
// "HELD review" / "HELD conflict" / "HELD gate" = armed, unqueued, CHANGES_REQUESTED, DIRTY or a
// failed gate check, RATELIMIT = a
// secondary-limit 403). FAKE_COMPARE ("behind,ahead", or RATELIMIT) answers the tag compare;
// FAKE_TAG_SHA empty = the tag does not exist (a 404). Every call is appended to $FAKE_DIR/gh-calls.
const FAKE_GH = `#!/usr/bin/env bash
args="$*"
printf '%s\\n' "\${args:0:120}" >> "$FAKE_DIR/gh-calls"
next() { # $1 = sequence, $2 = counter file
  local n=0; [ -f "$2" ] && n="$(cat "$2")"
  echo $((n + 1)) > "$2"
  IFS=, read -r -a seq <<<"$1"
  local i=$n; [ "$i" -ge "\${#seq[@]}" ] && i=$(( \${#seq[@]} - 1 ))
  printf '%s\\n' "\${seq[$i]}"
}
ratelimit() { echo "gh: API rate limit exceeded for user ID 1. (HTTP 403)" >&2; exit 1; }
case "$args" in
  *"pr list"*) echo 7 ;;
  *"pr view 7"*"--json body"*) printf '%s\\n' "$FAKE_BODY" ;;
  *compare/${MERGE}...beads-synced*)
    s="$(next "\${FAKE_COMPARE:-ahead}" "$FAKE_DIR/compare-calls")"
    [ "$s" = "RATELIMIT" ] && ratelimit
    [ -n "$FAKE_TAG_SHA" ] || { echo "gh: Not Found (HTTP 404)" >&2; exit 1; }
    echo "$s" ;;
  *"api graphql"*"mergeQueueEntry"*)
    # scripts/pr-queue-state.mjs's one read, answered as GraphQL JSON.
    s="$(next "$FAKE_PR_STATES" "$FAKE_DIR/pr-calls")"
    read -r kind a <<<"$(next "\${FAKE_QUEUE:-NONE}" "$FAKE_DIR/queue-calls")"
    [ "$kind" = "RATELIMIT" ] && ratelimit
    commit=null; [ "$s" = "MERGED" ] && commit='{"oid":"${MERGE}"}'
    entry=null; auto=null; events='[]'; decision=null; merge_state='"CLEAN"'; checks=null
    case "$kind" in
      NONE) ;;
      HELD) auto='{"enabledAt":"t"}'
        case "$a" in
          conflict) merge_state='"DIRTY"' ;;
          gate) merge_state='"BLOCKED"'
            checks='{"nodes":[{"commit":{"statusCheckRollup":{"contexts":{"nodes":[{"__typename":"CheckRun","name":"e2e","conclusion":"FAILURE"},{"__typename":"CheckRun","name":"gate","conclusion":"FAILURE"}]}}}}]}' ;;
          *) decision='"CHANGES_REQUESTED"' ;;
        esac ;;
      EJECTED) events='[{"__typename":"RemovedFromMergeQueueEvent","createdAt":"t","reason":"'"$a"'"}]' ;;
      REARMED) events='[{"__typename":"RemovedFromMergeQueueEvent","createdAt":"t","reason":"'"$a"'"}]'; auto='{"enabledAt":"t"}' ;;
      *) entry='{"state":"'"$kind"'","position":'"$a"'}' ;;
    esac
    printf '{"data":{"repository":{"pullRequest":{"number":7,"state":"%s","mergeCommit":%s,"autoMergeRequest":%s,"mergeQueueEntry":%s,"reviewDecision":%s,"mergeStateStatus":%s,"timelineItems":{"nodes":%s},"headChecks":%s}}}}\\n' "$s" "$commit" "$auto" "$entry" "$decision" "$merge_state" "$events" "$checks" ;;
  *) echo "unexpected gh $args" >&2; exit 2 ;;
esac
`;
// `bd show <id> [--json]`; statuses from FAKE_BD ("bd-a=closed,bd-b=open"), default closed.
const FAKE_BD = `#!/usr/bin/env bash
id="$2"
status=closed
IFS=, read -r -a pairs <<<"\${FAKE_BD:-}"
for p in "\${pairs[@]}"; do [ "\${p%%=*}" = "$id" ] && status="\${p#*=}"; done
if [ "$3" = "--json" ]; then printf '[{"id":"%s","status":"%s"}]\\n' "$id" "$status"; else echo "● $id [$status]"; fi
`;
// worktree-rm.sh stand-in: records the call, removes the worktree for real.
const FAKE_RM = `#!/usr/bin/env bash
echo "$1" >> "$FAKE_DIR/rm-calls"
git -C "$FAKE_PRIMARY" worktree remove --force "$1"
`;

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// land.sh and every sibling it sources or runs, copied beside each other as in a consumer.
const SCRIPT_FILES = ['land.sh', 'lib/git-no-fsmonitor.sh', 'lib/to-node-path.sh', 'agent-tooling-config.mjs', 'pr-watch.mjs', ...GATE_FILES];
function installScripts(dir) {
  for (const rel of SCRIPT_FILES) {
    if (!existsSync(join(HERE, rel))) continue;
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    copyFileSync(join(HERE, rel), join(dir, rel));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'land-sh-'));
  const primary = join(root, 'primary');
  const origin = join(root, 'origin.git');
  mkdirSync(primary);
  git(root, 'init', '--bare', '-q', origin);
  git(primary, 'init', '-q', '-b', 'main');
  git(primary, 'config', 'user.email', 't@example.com');
  git(primary, 'config', 'user.name', 'T');
  writeFileSync(join(primary, 'README'), 'x\n');
  git(primary, 'add', 'README');
  git(primary, 'commit', '-q', '-m', 'init');
  git(primary, 'remote', 'add', 'origin', 'https://github.com/o/r.git');
  // The script under test lives in the primary, as in real use; its lib sibling comes along.
  mkdirSync(join(primary, 'scripts', 'lib'), { recursive: true });
  installScripts(join(primary, 'scripts'));
  const worktree = join(root, 'wt');
  git(primary, 'worktree', 'add', '-q', '-b', 'feat/x-bd-aaaa1', worktree);
  for (const [name, body] of [['gh', FAKE_GH], ['bd', FAKE_BD], ['worktree-rm.sh', FAKE_RM]]) {
    writeFileSync(join(root, name), body);
    chmodSync(join(root, name), 0o755);
  }
  return { root, primary, worktree };
}

function run(f, args, extraEnv = {}) {
  const env = {
    ...process.env,
    GH_CLI: join(f.root, 'gh'),
    BD_CLI: join(f.root, 'bd'),
    LAND_SYNC_CMD: 'echo "(fake dolt pull)"',
    LAND_WORKTREE_RM: join(f.root, 'worktree-rm.sh'),
    LAND_POLL_SECONDS: '0',
    AGENT_TOOLING_CLOSE_BEADS_WORKFLOW: 'close-beads.yml',
    AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS: '0',
    // The per-machine watcher's directory, empty unless a test writes a state file: never ~/.cache.
    AGENT_TOOLING_PR_WATCH_DIR: join(f.root, 'pr-watch'),
    FAKE_DIR: f.root,
    FAKE_PRIMARY: f.primary,
    FAKE_BODY: '## Summary\n\nFixes: bd-aaaa1, bd-bbbb2\n',
    FAKE_PR_STATES: 'MERGED',
    FAKE_TAG_SHA: TAG,
    FAKE_COMPARE: 'ahead',
    FAKE_BD: '',
    ...extraEnv,
  };
  const r = spawnSync('bash', [join(f.primary, 'scripts', 'land.sh'), ...args], { encoding: 'utf8', env, cwd: f.primary, timeout: 60_000 });
  return { status: r.status, out: `${r.stdout}\n${r.stderr}` };
}

// The fake worktree-rm.sh records the path bash handed it. On Windows Git Bash that is the MSYS form of the temp
// dir (/tmp/land-sh-…/wt), not the native one Node made (C:\Users\…\Temp\land-sh-…\wt), so translate it back.
const nativePath = (p) => (process.platform === 'win32' && p.startsWith('/')
  ? execFileSync('cygpath', ['-w', p], { encoding: 'utf8' }).trim() : p);
const rmCalls = (f) => (existsSync(join(f.root, 'rm-calls'))
  ? readFileSync(join(f.root, 'rm-calls'), 'utf8').trim().split('\n').map(nativePath) : []);

// The script reports a path in git's spelling, so compare canonical forms: os.tmpdir() is
// C:/Users/RUNNER~1/... on the GitHub Windows runner while git and the script say runneradmin.
const canon = (p) => join(realpathSync.native(dirname(p)), basename(p));

gated('a worktree given in its 8.3 short spelling is the registered worktree, and the removal gets the long one', (t) => {
  const f = fixture();
  try {
    const short = shortForm(f.worktree);
    if (!short) {
      t.skip('no 8.3 short spelling of the temp path here (not Windows, or short names are disabled on this volume)');
      return;
    }
    const r = run(f, [short]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(rmCalls(f).map(canon), [canon(f.worktree)]);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('lands: waits through OPEN and a tag that has not passed the merge, then verifies the beads and removes the worktree', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], { FAKE_PR_STATES: 'OPEN,OPEN,MERGED', FAKE_COMPARE: 'behind,behind,ahead' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /Fixes: bd-aaaa1 bd-bbbb2/);
    assert.match(r.out, /waiting: PR #7 is OPEN/);
    assert.match(r.out, /waiting: beads-synced does not contain m{40} yet \(compare: behind\)/);
    assert.match(r.out, /beads-synced: contains m{40} \(compare: ahead\)/);
    // One request per tick in each wait phase: three PR polls, three compares, and
    // nothing else beyond the one-off PR lookup and body read.
    const calls = readFileSync(join(f.root, 'gh-calls'), 'utf8').trim().split('\n');
    assert.equal(calls.filter((c) => c.includes('graphql')).length, 3, calls.join('\n'));
    assert.equal(calls.filter((c) => c.includes('compare/')).length, 3, calls.join('\n'));
    assert.equal(calls.length, 8, `pr list + body + 3 + 3:\n${calls.join('\n')}`);
    assert.match(r.out, /\(fake dolt pull\)/, 'the dolt pull ran before the beads were read');
    assert.match(r.out, /beads: all closed/);
    assert.deepEqual(rmCalls(f).map(canon), [canon(f.worktree)]);
    assert.equal(existsSync(f.worktree), false, 'the worktree is gone');
    assert.equal(spawnSync('git', ['-C', f.primary, 'show-ref', '--verify', '--quiet', 'refs/heads/feat/x-bd-aaaa1']).status, 1, 'the local branch was deleted');
    assert.match(r.out, /^landed: PR #7, beads bd-aaaa1 bd-bbbb2 closed, worktree /m);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('a bead that is not closed after the tag passed the merge exits 1 naming it, and the worktree stays', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], { FAKE_BD: 'bd-bbbb2=open' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /NOT CLOSED: bd-bbbb2/);
    assert.doesNotMatch(r.out, /NOT CLOSED: bd-aaaa1/);
    assert.deepEqual(rmCalls(f), [], 'worktree-rm.sh was not called');
    assert.equal(existsSync(f.worktree), true);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('--no-wait reports the state and exits 3 while anything is pending, 0 once everything landed; it never removes', () => {
  const f = fixture();
  try {
    const open = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN' });
    assert.equal(open.status, 3, open.out);
    assert.match(open.out, /state: OPEN/);
    assert.match(open.out, /bead bd-aaaa1: closed/);
    assert.match(open.out, /not landed yet/);

    const tagBehind = run(f, [f.worktree, '--no-wait'], { FAKE_COMPARE: 'behind', FAKE_BD: 'bd-aaaa1=in_progress' });
    assert.equal(tagBehind.status, 3, tagBehind.out);
    assert.match(tagBehind.out, /does not contain the merge yet/);
    assert.match(tagBehind.out, /bead bd-aaaa1: in_progress/);

    const closed = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'CLOSED' });
    assert.equal(closed.status, 1, `a closed-not-merged PR is a hard stop, not "pending":\n${closed.out}`);
    assert.match(closed.out, /PR #7 is CLOSED without merging/);
    assert.doesNotMatch(closed.out, /not landed yet/);

    const done = run(f, [f.worktree, '--no-wait']);
    assert.equal(done.status, 0, done.out);
    assert.match(done.out, /landed: nothing left to wait on/);
    assert.deepEqual(rmCalls(f), []);
    assert.equal(existsSync(f.worktree), true, '--no-wait removed nothing');
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('a PR closed without merging is a hard stop', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], { FAKE_PR_STATES: 'CLOSED' });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /PR #7 is CLOSED without merging/);
    assert.equal(existsSync(f.worktree), true);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('the wait cap says what it was waiting on and exits 4', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree, '--timeout', '0'], { FAKE_PR_STATES: 'OPEN' });
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /gave up after 0 min waiting on: PR #7 to merge/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('a QUEUED PR prints its position and never hits the cap; ejected, the cap fires again', () => {
  const f = fixture();
  try {
    // --timeout 0: any poll outside the queue gives up at once, so reaching the third poll proves
    // the two queued polls did not. The third reads NONE: ejected, plain OPEN, and the cap fires.
    const r = run(f, [f.worktree, '--timeout', '0'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'QUEUED 13,AWAITING_CHECKS 1,NONE' });
    assert.equal(r.status, 4, r.out);
    assert.match(r.out, /waiting: PR #7 is in the merge queue \(QUEUED, position 13\); no cap while queued/);
    assert.match(r.out, /waiting: PR #7 is in the merge queue \(AWAITING_CHECKS, position 1\)/);
    assert.match(r.out, /waiting: PR #7 is OPEN and not queued/);
    assert.match(r.out, /gave up after 0 min waiting on: PR #7 to merge \(last state: OPEN\)$/m);

    // Queued all the way to the merge: lands with a zero cap.
    const f2 = fixture();
    try {
      const landed = run(f2, [f2.worktree, '--timeout', '0'], { FAKE_PR_STATES: 'OPEN,OPEN,MERGED', FAKE_QUEUE: 'QUEUED 2,MERGEABLE 1' });
      assert.equal(landed.status, 0, landed.out);
      assert.match(landed.out, /^landed: PR #7/m);
    } finally {
      removeTempDir(f2.root, 'land.node-test');
    }

    const report = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'QUEUED 4' });
    assert.equal(report.status, 3, report.out);
    assert.match(report.out, /merge queue: queued QUEUED 4/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('--queued-ok: QUEUED is done, exit 0, the worktree kept and the rest named', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree, '--queued-ok'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'NONE,QUEUED 9' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /waiting: PR #7 is OPEN and not queued/, 'not queued yet: it waits');
    assert.match(r.out, /queued: PR #7 is in the merge queue \(QUEUED, position 9\): done for now \(--queued-ok\)/);
    assert.match(r.out, /still pending: the merge, then close-beads\.yml closing bd-aaaa1 bd-bbbb2; the worktree is kept/);
    assert.match(r.out, /finish later from the primary checkout: bash scripts\/land\.sh .*wt/);
    assert.deepEqual(rmCalls(f), [], 'nothing removed');
    assert.equal(existsSync(f.worktree), true);
    assert.doesNotMatch(r.out, /^landed:/m);
    // Already merged: --queued-ok changes nothing, it lands the whole way.
    const merged = run(f, [f.worktree, '--queued-ok']);
    assert.equal(merged.status, 0, merged.out);
    assert.match(merged.out, /^landed: PR #7/m);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('ejected with auto-merge off stops with exit 5 and the recovery; re-armed, it waits', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'REARMED failed_checks,EJECTED failed_checks' });
    assert.equal(r.status, 5, r.out);
    assert.match(r.out, /was ejected from the merge queue \(failed_checks\) and auto-merge is re-armed; waiting/);
    assert.match(r.out, /PR #7 was EJECTED from the merge queue \(failed_checks\) and auto-merge is not armed/);
    assert.match(r.out, /re-arm with gh pr merge --auto 7/);
    assert.equal(existsSync(f.worktree), true);
    const report = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'EJECTED merge_conflict' });
    assert.match(report.out, /merge queue: ejected merge_conflict unarmed/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('held by a blocking review or a conflict stops with exit 6 and the remedy, never the cap', () => {
  const f = fixture();
  try {
    const review = run(f, [f.worktree, '--queued-ok'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'NONE,HELD review' });
    assert.equal(review.status, 6, review.out);
    assert.match(review.out, /waiting: PR #7 is OPEN and not queued/, 'CI pending first: it waits');
    assert.match(review.out, /PR #7 is HELD by a blocking review \(CHANGES_REQUESTED on its current head\)/);
    assert.match(review.out, /gh pr view 7 --repo o\/r --comments/);
    assert.equal(existsSync(f.worktree), true);
    const conflict = run(f, [f.worktree], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'HELD conflict' });
    assert.equal(conflict.status, 6, conflict.out);
    assert.match(conflict.out, /PR #7 is HELD by a merge conflict with main/);
    assert.match(conflict.out, /git merge origin\/main \(resolve, commit\), then a plain git push/);
    const report = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'HELD conflict' });
    assert.equal(report.status, 3, report.out);
    assert.match(report.out, /merge queue: held conflict/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

// A PR that went red before the queue once made land.sh print "CI or review pending" until its cap.
gated('a red gate on the current head stops with exit 6 and how to read it, never the cap', () => {
  const f = fixture();
  try {
    const red = run(f, [f.worktree, '--queued-ok'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'NONE,HELD gate' });
    assert.equal(red.status, 6, red.out);
    assert.match(red.out, /waiting: PR #7 is OPEN and not queued/, 'CI pending first: it waits');
    assert.match(red.out, /PR #7 is HELD by a red gate on its current head/);
    assert.match(red.out, /gh pr checks 7 --repo o\/r/);
    assert.equal(existsSync(f.worktree), true);
    const report = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'HELD gate' });
    assert.equal(report.status, 3, report.out);
    assert.match(report.out, /merge queue: held gate/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

// A secondary-limit 403 arrived with the core quota nearly full and stalled every
// session polling on the shared account. A rate-limited poll backs off; it is neither a failure,
// nor "no state", nor a reason to retry at once.
gated('a rate-limited poll backs off with a doubling sleep in both wait phases, then carries on', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], {
      FAKE_PR_STATES: 'OPEN,OPEN,OPEN,MERGED', FAKE_QUEUE: 'RATELIMIT,RATELIMIT,QUEUED 1,NONE',
      FAKE_COMPARE: 'RATELIMIT,ahead', AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS: '0', LAND_POLL_SECONDS: '0',
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /rate-limited: GitHub refused the poll for PR #7/);
    assert.match(r.out, /backing off 0s \(rate-limited poll 1 in a row\)/);
    assert.match(r.out, /backing off 0s \(rate-limited poll 2 in a row\)/);
    assert.match(r.out, /rate-limited: GitHub refused the beads-synced compare/);
    assert.match(r.out, /^landed: PR #7/m);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('the back-off doubles from max(poll, floor) and stops at the cap', () => {
  const f = fixture();
  try {
    // A stub `sleep` on PATH records the seconds instead of sleeping them.
    writeFileSync(join(f.root, 'sleep'), '#!/usr/bin/env bash\necho "$1" >> "$FAKE_DIR/sleeps"\n');
    chmodSync(join(f.root, 'sleep'), 0o755);
    const r = run(f, [f.worktree, '--timeout', '600'], {
      PATH: `${f.root}:${process.env.PATH}`,
      FAKE_PR_STATES: 'OPEN,OPEN,OPEN,OPEN,OPEN,MERGED', FAKE_QUEUE: 'RATELIMIT,RATELIMIT,RATELIMIT,RATELIMIT,NONE,NONE',
      LAND_POLL_SECONDS: '300', AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS: '60', LAND_BACKOFF_MAX_SECONDS: '1800',
    });
    assert.equal(r.status, 0, r.out);
    const sleeps = readFileSync(join(f.root, 'sleeps'), 'utf8').trim().split('\n');
    assert.deepEqual(sleeps, ['600', '1200', '1800', '1800', '300'], 'doubling from the 300s poll, capped, then the poll again');
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('--no-wait on a rate-limited read reports it as pending, exit 3', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree, '--no-wait'], { FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'RATELIMIT' });
    assert.equal(r.status, 3, r.out);
    assert.match(r.out, /rate-limited: GitHub refused the poll for PR #7/);
    assert.match(r.out, /not landed yet/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('--pr alone re-checks a PR whose worktree is already gone; a copy of the script inside its own target refuses', () => {
  const f = fixture();
  try {
    const byPr = run(f, ['--pr', '7']);
    assert.equal(byPr.status, 0, byPr.out);
    assert.match(byPr.out, /^landed: PR #7, beads bd-aaaa1 bd-bbbb2 closed$/m);
    assert.deepEqual(rmCalls(f), []);

    installScripts(join(f.worktree, 'scripts'));
    const inside = spawnSync('bash', [join(f.worktree, 'scripts', 'land.sh'), f.worktree], {
      encoding: 'utf8', env: { ...process.env, GH_CLI: join(f.root, 'gh'), AGENT_TOOLING_CLOSE_BEADS_WORKFLOW: 'close-beads.yml' }, cwd: f.primary, timeout: 60_000,
    });
    assert.equal(inside.status, 2, `${inside.stdout}\n${inside.stderr}`);
    assert.match(inside.stderr, /lives INSIDE the worktree it would remove/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

// The per-machine watcher (scripts/pr-watch.mjs) is opt-in: with no live leader, or a
// state file that is stale or names a dead leader, land.sh makes exactly the direct reads it made
// before the watcher existed. With a fresh one it answers both waits and land.sh sends nothing.
const watchState = (f, { pid = process.pid, freshFor = 3_600_000, ratelimited = false, prs = {} }) => {
  const dir = join(f.root, 'pr-watch');
  mkdirSync(dir, { recursive: true });
  const now = Date.now();
  writeFileSync(join(dir, 'state.json'), `${JSON.stringify({
    version: 1, pid, tick_seconds: 300, read_at: now, next_read_at: now + 300_000, fresh_until: now + freshFor,
    repos: { 'o/r': { read_at: now, ratelimited, error: null, prs } },
  })}\n`);
};
const merged7 = {
  number: 7, verdict: 'merged', state: 'MERGED', merge_commit: MERGE, auto_merge: false, queue: null,
  last_queue_event: null, draft: false, author: null, head: null, held: null, checks: 'SUCCESS', tag: 'ahead',
};

watched('no live watcher (none, stale, dead leader, PR not covered): the same direct reads as before', () => {
  const deadPid = spawnSync('true').pid;
  for (const [label, setup] of [
    ['no state file', () => {}],
    ['a stale state file', (f) => watchState(f, { freshFor: -1, prs: { 7: merged7 } })],
    ['a dead leader', (f) => watchState(f, { pid: deadPid, prs: { 7: merged7 } })],
    ['a PR the watcher has not read', (f) => watchState(f, { prs: { 8: { ...merged7, number: 8 } } })],
  ]) {
    const f = fixture();
    try {
      setup(f);
      const r = run(f, [f.worktree], { FAKE_PR_STATES: 'OPEN,MERGED', FAKE_COMPARE: 'behind,ahead' });
      assert.equal(r.status, 0, `${label}\n${r.out}`);
      assert.doesNotMatch(r.out, /per-machine PR watcher/, label);
      const calls = readFileSync(join(f.root, 'gh-calls'), 'utf8').trim().split('\n');
      assert.equal(calls.filter((c) => c.includes('graphql')).length, 2, `${label}\n${calls.join('\n')}`);
      assert.equal(calls.filter((c) => c.includes('compare/')).length, 2, `${label}\n${calls.join('\n')}`);
      assert.equal(existsSync(join(f.root, 'pr-watch', 'watch')), false, `${label}: nothing registered without a leader`);
    } finally {
      removeTempDir(f.root, 'land.node-test');
    }
  }
});

watched('a fresh watcher answers the PR read and the tag check: land.sh sends no request of its own', () => {
  const f = fixture();
  try {
    watchState(f, { prs: { 7: merged7 } });
    // pr-watch.mjs registers only while a leader holds the lock; this test process stands in for it.
    writeFileSync(join(f.root, 'pr-watch', 'leader.lock'), `${process.pid}\n`);
    const r = run(f, [f.worktree], { FAKE_PR_STATES: 'OPEN' });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /answered by the per-machine PR watcher/);
    assert.match(r.out, /beads-synced: contains m{40} \(compare: ahead \(pr-watch\)\)/);
    const graphqlOrCompare = () => readFileSync(join(f.root, 'gh-calls'), 'utf8').split('\n')
      .filter((c) => c.includes('graphql') || c.includes('compare/'));
    assert.deepEqual(graphqlOrCompare(), []);
    assert.ok(existsSync(join(f.root, 'pr-watch', 'watch', 'o__r__7.json')), 'the read registered the PR with the leader');

    // A rate-limited watcher read is a back-off for land.sh too, not a reason to send its own.
    watchState(f, { ratelimited: true });
    const limited = run(f, ['--pr', '7', '--no-wait']);
    assert.equal(limited.status, 3, limited.out);
    assert.match(limited.out, /rate-limited: GitHub refused the poll for PR #7/);
    assert.deepEqual(graphqlOrCompare(), []);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

// land.sh once exported GH_CLI="$GH" (default `gh`) to pr-queue-state.mjs, whose Windows
// shell-script path then ran `bash gh` and never read the PR. GH_CLI reaches it only from the caller.
test('land.sh never sets GH_CLI for pr-queue-state.mjs itself', () => {
  const src = readFileSync(join(HERE, 'land.sh'), 'utf8');
  const calls = src.split('\n').filter((l) => !/^\s*#/.test(l) && l.includes('pr-queue-state.mjs'));
  assert.ok(calls.length > 0, 'land.sh still calls pr-queue-state.mjs');
  for (const l of calls) assert.doesNotMatch(l, /GH_CLI=/, l.trim());
});

// ── what land.sh needs from other sets, and what it will not guess ───────────────────────────────

test('a sibling that is not vendored is reported by file and set before anything is waited on', () => {
  const f = fixture();
  try {
    // The gate set's reader, deleted from the fixture whether or not it was copied in.
    rmSync(join(f.primary, 'scripts', 'pr-queue-state.mjs'), { force: true });
    const r = run(f, [f.worktree]);
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /needs scripts\/pr-queue-state\.mjs/);
    assert.match(r.out, /ships in the gate set/);
    assert.equal(existsSync(join(f.root, 'gh-calls')), false, 'nothing was asked of GitHub');
    assert.equal(existsSync(f.worktree), true);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('the verified bead pull is the beads set\'s: absent, and no LAND_SYNC_CMD, it is named up front', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree], { LAND_SYNC_CMD: '' });
    assert.equal(r.status, 2, r.out);
    assert.match(r.out, /needs scripts\/bd-dolt-sync\.mjs/);
    assert.match(r.out, /ships in the beads set/);
    // --no-wait never pulls, so it does not need the file.
    const peek = run(f, [f.worktree, '--no-wait'], { LAND_SYNC_CMD: '' });
    assert.equal(peek.status, 0, peek.out);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('the close-beads workflow defaults to a generic phrase in messages when unset', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree, '--no-wait'], { AGENT_TOOLING_CLOSE_BEADS_WORKFLOW: '', FAKE_COMPARE: 'behind' });
    assert.doesNotMatch(r.out, /is not set/);
    assert.match(r.out, /does not contain the merge yet.*the close-beads workflow has not closed/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('the workflow and tag names in the messages are the configured ones', () => {
  const f = fixture();
  try {
    const r = run(f, [f.worktree, '--queued-ok'], {
      AGENT_TOOLING_CLOSE_BEADS_WORKFLOW: 'closer.yml', AGENT_TOOLING_SYNCED_TAG: 'synced-here',
      FAKE_PR_STATES: 'OPEN', FAKE_QUEUE: 'QUEUED 1',
    });
    assert.equal(r.status, 0, r.out);
    assert.match(r.out, /still pending: the merge, then closer\.yml closing/);
    const landed = run(f, [f.worktree, '--no-wait'], { AGENT_TOOLING_SYNCED_TAG: 'synced-here', FAKE_COMPARE: 'behind' });
    assert.match(landed.out, /synced-here: does not contain the merge yet/);
    assert.doesNotMatch(landed.out, /beads-synced/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

gated('bead ids are read with the configured prefix, and with any prefix when none is configured', () => {
  const f = fixture();
  try {
    const body = '## Summary\n\nFixes: Acme-aaaa1, bd-zzzz9\n';
    const any = run(f, ['--pr', '7', '--no-wait'], { FAKE_BODY: body, FAKE_PR_STATES: 'OPEN' });
    assert.match(any.out, /Fixes: Acme-aaaa1 bd-zzzz9/, 'no config: any prefix');
    writeFileSync(join(f.primary, 'agent-tooling.json'), `${JSON.stringify({ beadPrefix: 'Acme' })}\n`);
    const scoped = run(f, ['--pr', '7', '--no-wait'], { FAKE_BODY: body, FAKE_PR_STATES: 'OPEN' });
    assert.match(scoped.out, /^Fixes: Acme-aaaa1$/m, scoped.out);
    assert.doesNotMatch(scoped.out, /bd-zzzz9/);
  } finally {
    removeTempDir(f.root, 'land.node-test');
  }
});

// land.sh carries a grep copy of the gate set's rate-limit pattern (its bash cannot import the
// module). They must stay one pattern, or a rate-limited compare is mistaken for a failure the
// poller does not back off from.
test('land.sh\'s RATE_LIMIT_RE equals lib/gh-rate-limit.mjs\'s', async (t) => {
  if (!existsSync(join(HERE, 'lib', 'gh-rate-limit.mjs'))) {
    t.skip('needs the gate set (lib/gh-rate-limit.mjs is not vendored here)');
    return;
  }
  const { RATE_LIMIT_RE } = await import(pathToFileURL(join(HERE, 'lib', 'gh-rate-limit.mjs')).href);
  const src = readFileSync(join(HERE, 'land.sh'), 'utf8');
  const m = /^RATE_LIMIT_RE='([^']+)'$/m.exec(src);
  assert.ok(m, 'land.sh still declares RATE_LIMIT_RE');
  assert.equal(m[1], RATE_LIMIT_RE.source);
  assert.ok(RATE_LIMIT_RE.flags.includes('i'), 'the module pattern is case-insensitive');
  assert.match(src, /grep -qiE "\$RATE_LIMIT_RE"/, 'and land.sh greps case-insensitively');
});
