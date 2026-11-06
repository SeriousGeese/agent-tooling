#!/usr/bin/env bash
# land.sh, one command to land the plane after a PR is opened.
#
#   bash scripts/land.sh <worktree path> [--pr <n>] [--no-wait] [--queued-ok] [--timeout <minutes>]
#   bash scripts/land.sh --pr <n> [--no-wait]        # re-check a PR whose worktree is already gone
#
# QUEUED IS DONE. With --queued-ok the script exits 0 as soon as the PR
# is IN THE MERGE QUEUE (its gate was green), says what is still pending and keeps the worktree: the
# agent moves on to its next PR and re-runs land.sh later (it is idempotent) to finish steps 3-8.
# The queue merges the PR or ejects it; an ejection with auto-merge disarmed exits 5 (below), and
# a merge-queue workflow that comments on the PR is worth having, so neither path is silent.
#
# What it does, in order, sequencing scripts that already exist and adding no policy of its own:
#
#   1. Finds the PR for the worktree's branch (or takes --pr) and reads the bead ids on its
#      Fixes:/Closes:/Resolves:/Bead: lines, with the same rule the close-beads run applies:
#      anchor lines only, never the title, never prose.
#   2. Waits for the PR to be MERGED, one poll every 5 minutes. Each poll is ONE request:
#      scripts/pr-queue-state.mjs's GraphQL read answers merged/closed AND the queue state (never
#      `autoMergeRequest`, which reads null once queued). A CLOSED-not-merged PR is a hard stop. While the PR sits
#      in the MERGE QUEUE each poll prints its state and position and the cap restarts instead of
#      firing: a queue 15 deep on a saturated fleet outlived the 90-minute cap on 2026-10-24 and
#      2026-10-25 with nothing wrong. EJECTED from the queue with auto-merge disarmed is a
#      stop, exit 5, naming the reason: nothing will merge it until someone reads the failing
#      merge_group run and re-arms. Ejected but re-armed is a wait, with the cap counting.
#      HELD is a stop, exit 6: a CHANGES_REQUESTED review on the current head
#      (`held review`), a merge conflict (`held conflict`) or a red required check on the current
#      head (`held gate`) keeps the PR out of the queue until its author acts, so waiting
#      to the cap only hides it. A held PR once sat armed and silent for 23 hours.
#   3. Waits until the `beads-synced` tag contains the merge commit. the close-beads workflow
#      (AGENT_TOOLING_CLOSE_BEADS_WORKFLOW) moves that
#      tag to the pushed head only after it ran one close per PR in
#      the range and every close exited 0 with no bead in a FAILED or UNKNOWN-ORIGIN bucket, so "the
#      tag contains the merge" means "the close was attempted and verified on DoltHub". It does NOT
#      mean every bead closed: HELD, BLOCKED-BY, UNKNOWN, NO-FIXES-LINE and NOT-ON-MAIN do not hold
#      the tag (a re-do cannot change them), which is exactly why step 5 exists. The close runs on
#      every push to main in its own workflow; as a main.yml job it queued behind the
#      previous batch's full e2e and lagged the merge by 45 to 60+ minutes under load.
#      Containment is asked of the API (`compare/<merge>...beads-synced` status `ahead` or
#      `identical`; one request per poll, the tag named directly), not of a local clone, so the
#      answer never depends on what this checkout has fetched.
#   4. `node scripts/bd-dolt-sync.mjs pull`, so the local bd reads what DoltHub has.
#   5. `bd show <id>` for every Fixes id; any that is not `closed` is named on its own line and the
#      script exits 1 WITHOUT removing the worktree. Fix the bead (or read its notes: a [hold-close]
#      is a correct outcome) and re-run; every step here is idempotent.
#   6. scripts/worktree-rm.sh <path>, run from the primary checkout (it refuses to run from inside
#      the target and refuses a dirty tree; both refusals surface here unchanged).
#   7. Deletes the local branch (`git branch -D`; the merge already deleted it on origin) and
#      `git fetch --prune origin`.
#   8. Stashes: this script creates none, so it has none to clear. It lists any stash the primary
#      checkout carries so a leftover from some other step is seen, not silently kept.
#
# --no-wait prints the state of steps 2, 3 and 5 as they stand and exits: 0 when the PR has
# merged, the tag has passed it and every bead is closed; 3 when any of those is still pending;
# 1 when the PR is CLOSED without merging (the same hard stop as the waiting path). It never
# removes anything. It prints the merge-queue verdict while the PR is open.
#
# Exit codes: 0 landed (or queued, with --queued-ok); 1 closed unmerged, or a bead not closed;
# 2 usage; 3 --no-wait with something pending; 4 the wait cap; 5 ejected from the queue, unarmed;
# 6 held by a blocking review, a merge conflict or a red gate.
#
# Polling is ONE `gh` request per tick, every 300s (LAND_POLL_SECONDS), capped by --timeout (default
# 90 min; LAND_TIMEOUT_MINUTES), a cap that does not run while the PR is queued (step 2). When the cap
# fires the script says which step it was waiting on and exits 4. Why 300s and one request: every
# session on the shared account spends one SECONDARY rate limit, and per-minute, per-PR polling by a
# few sessions tripped it on 2026-10-30. A rate-limited
# poll is neither a failure nor "no state": the script backs off, doubling the sleep from
# max(poll, 60s) up to 30 min (AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS, LAND_BACKOFF_MAX_SECONDS), and never
# retries at once. RATE_LIMIT_RE below mirrors scripts/lib/gh-rate-limit.mjs (a parity test checks it); keep them in step.
# With the opt-in per-machine watcher running (scripts/pr-watch.mjs run) both reads are
# answered from its state file and this script sends no request of its own; without it, nothing changes.
#
# A LOCAL script: it may rely on the checkout's `origin` remote for REPO (override with REPO=o/r) and
# on the caller's gh auth. Not for a runner. Run it from the primary checkout, never from inside the
# worktree it is about to remove: bash reads a script incrementally, and deleting the file under a
# running shell is undefined.
#
# Env for tests: GH_CLI (fake gh), BD_CLI (fake bd), LAND_SYNC_CMD (replaces the bd-dolt-sync pull),
# LAND_WORKTREE_RM (replaces worktree-rm.sh), LAND_POLL_SECONDS, AGENT_TOOLING_PR_WATCH_DIR (the watcher's
# state directory). Test: scripts/land.node-test.mjs.
#
# Config (all names carry the consumer's env prefix after sync):
#   AGENT_TOOLING_CLOSE_BEADS_WORKFLOW  REQUIRED. The workflow file that closes a merged PR's beads and
#                                       moves the synced tag; named in messages. No default: it is
#                                       the consumer's own file name.
#   AGENT_TOOLING_SYNCED_TAG            the tag that moves once the close ran (default beads-synced)
#   AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS  rate-limit back-off floor (default 60)
#   AGENT_TOOLING_PR_WATCH=0            skip the optional per-machine watcher
# The bead id pattern comes from `beadPrefix` in agent-tooling.json (any prefix when it is unset).
#
# Siblings it needs from other sets, checked up front with a message naming the file and the set:
# scripts/pr-queue-state.mjs and its lib/parse-flags.mjs and lib/gh-rate-limit.mjs (the `gate` set);
# scripts/bd-dolt-sync.mjs (the `beads` set) unless LAND_SYNC_CMD is set or --no-wait is given.
# scripts/pr-watch.mjs is optional.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH="${GH_CLI:-gh}"
BD="${BD_CLI:-bd}"
POLL="${LAND_POLL_SECONDS:-300}"
BACKOFF_FLOOR="${AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS:-60}"
BACKOFF_MAX="${LAND_BACKOFF_MAX_SECONDS:-1800}"
RATE_LIMIT_RE='rate limit|RATE_LIMITED|abuse detection|HTTP 429'
TIMEOUT_MIN="${LAND_TIMEOUT_MINUTES:-90}"
TAG="${AGENT_TOOLING_SYNCED_TAG:-beads-synced}"
CLOSE_WORKFLOW="${AGENT_TOOLING_CLOSE_BEADS_WORKFLOW:-}"

usage() {
  cat <<'USAGE'
Usage:
  scripts/land.sh <worktree path> [--pr <n>] [--no-wait] [--queued-ok] [--timeout <minutes>]
  scripts/land.sh --pr <n> [--no-wait] [--queued-ok]
USAGE
}

TARGET=""; PR=""; NO_WAIT=0; QUEUED_OK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --pr) PR="${2:?--pr needs a number}"; shift ;;
    --no-wait) NO_WAIT=1 ;;
    --queued-ok) QUEUED_OK=1 ;;
    --timeout) TIMEOUT_MIN="${2:?--timeout needs minutes}"; shift ;;
    -h|--help) usage; exit 0 ;;
    -*) echo "ERROR: unrecognised option '$1'." >&2; usage >&2; exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then echo "ERROR: unexpected extra argument '$1'." >&2; usage >&2; exit 2; fi
      TARGET="$1" ;;
  esac
  shift
done
if [ -z "$TARGET" ] && [ -z "$PR" ]; then usage >&2; exit 2; fi
[[ -z "$PR" || "$PR" =~ ^[0-9]+$ ]] || { echo "ERROR: --pr wants a number, got '$PR'." >&2; exit 2; }

# ── the checkout we stand on ─────────────────────────────────────────────────────────────────────
# shellcheck source=lib/git-no-fsmonitor.sh
source "$HERE/lib/git-no-fsmonitor.sh"
git_disable_fsmonitor
# shellcheck source=lib/to-node-path.sh
source "$HERE/lib/to-node-path.sh"
# The bead id pattern: `beadPrefix` from agent-tooling.json, or any prefix when there is none (or no
# node, or no config module). A broken config file is reported on stderr and read as unset.
_LAND_PREFIX_PROBE='
import { pathToFileURL } from "node:url";
const { tryLoadConfig } = await import(pathToFileURL(process.argv[1]).href);
const { config, error } = tryLoadConfig();
if (error) process.stderr.write("WARNING: agent-tooling.json is unusable, reading every bead prefix: " + error + "\n");
process.stdout.write(config.beadPrefix ?? "");
'
BEAD_PREFIX=""
if [ -f "$HERE/agent-tooling-config.mjs" ] && command -v node >/dev/null 2>&1; then
  BEAD_PREFIX="$(node --input-type=module -e "$_LAND_PREFIX_PROBE" "$(to_node_path "$HERE/agent-tooling-config.mjs")" || true)"
fi
ID_RE="${BEAD_PREFIX:-[A-Za-z][A-Za-z0-9]*}-[a-z0-9]+(\.[0-9]+)*"
norm() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }
# The awk must not `exit` early: SIGPIPE on `git worktree list` becomes 141 under pipefail.
PRIMARY="$(git -C "$HERE" worktree list --porcelain | awk '/^worktree / && !seen {print $2; seen = 1}')"
[ -n "$PRIMARY" ] || { echo "ERROR: $HERE is not inside a git checkout." >&2; exit 2; }
PRIMARY="$(norm "$PRIMARY")"

BRANCH=""
TARGET_ABS=""
if [ -n "$TARGET" ]; then
  [ -e "$TARGET" ] || { echo "ERROR: $TARGET does not exist. To re-check a PR whose worktree is gone: scripts/land.sh --pr <n>" >&2; exit 2; }
  TARGET_ABS="$(norm "$TARGET")"
  if [ "$TARGET_ABS" = "$PRIMARY" ]; then
    echo "ERROR: $TARGET is the PRIMARY checkout, not a worktree." >&2; exit 2
  fi
  case "$HERE/" in
    "$TARGET_ABS"/*)
      echo "ERROR: this copy of land.sh lives INSIDE the worktree it would remove ($HERE)." >&2
      echo "  Run the primary checkout's copy: bash $PRIMARY/scripts/land.sh $TARGET_ABS" >&2
      exit 2 ;;
  esac
  registered=0
  while read -r p; do
    [ -n "$p" ] && [ "$(norm "$p")" = "$TARGET_ABS" ] && registered=1
  done < <(git -C "$PRIMARY" worktree list --porcelain | awk '/^worktree /{print $2}')
  [ "$registered" = "1" ] || { echo "ERROR: $TARGET is not a registered git worktree of $PRIMARY." >&2; exit 2; }
  BRANCH="$(git -C "$TARGET_ABS" rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  if [ -z "$BRANCH" ] || [ "$BRANCH" = "HEAD" ]; then
    echo "ERROR: $TARGET is on a detached HEAD; pass --pr <n>." >&2; exit 2
  fi
fi

# REPO from the primary's origin unless given: `git@github.com:o/r(.git)` or `https://github.com/o/r(.git)`.
if [ -z "${REPO:-}" ]; then
  url="$(git -C "$PRIMARY" remote get-url origin 2>/dev/null || true)"
  REPO="$(printf '%s' "$url" | sed -E 's#^(git@github\.com:|https?://github\.com/)##; s#\.git$##; s#/$##')"
  [[ "$REPO" =~ ^[^/]+/[^/]+$ ]] || { echo "ERROR: cannot derive owner/repo from origin '$url'; set REPO=owner/repo." >&2; exit 2; }
fi

# ── what this script needs that is not its own ───────────────────────────────────────────────────
# Fail up front and by name: a missing sibling found after a 90 minute wait is the worst time.
require_script() { # $1 file under scripts/, $2 the set that ships it, $3 what it is used for
  [ -f "$HERE/$1" ] && return 0
  echo "ERROR: land.sh needs scripts/$1 ($3), which is not vendored here. It ships in the $2 set;" >&2
  echo "  re-run the sync with that set added (for example --set gate,beads,worktree). Nothing was waited on or removed." >&2
  exit 2
}
require_script pr-queue-state.mjs gate "the one-request PR state read"
require_script lib/parse-flags.mjs gate "pr-queue-state.mjs imports it"
require_script lib/gh-rate-limit.mjs gate "pr-queue-state.mjs imports it"
if [ "$NO_WAIT" != "1" ] && [ -z "${LAND_SYNC_CMD:-}" ]; then
  require_script bd-dolt-sync.mjs beads "the verified bead pull after the close"
fi
if [ -z "$CLOSE_WORKFLOW" ]; then
  echo "ERROR: AGENT_TOOLING_CLOSE_BEADS_WORKFLOW is not set. Name the workflow file that closes a merged PR's" >&2
  echo "  beads and moves the '$TAG' tag (set it in the environment your agents run with); land.sh" >&2
  echo "  names it in its messages and has no default for it." >&2
  exit 2
fi

# ── the PR ──────────────────────────────────────────────────────────────────────────────────────
if [ -z "$PR" ]; then
  # Newest PR for the branch, any state: a branch re-pushed after its PR merged (the push that
  # recreates a deleted branch) has two, and the newest is the one this worktree is about.
  PR="$($GH pr list --repo "$REPO" --head "$BRANCH" --state all --limit 20 --json number --jq 'map(.number) | max // empty')"
  [ -n "$PR" ] || { echo "ERROR: no PR found for branch '$BRANCH' in $REPO." >&2; exit 2; }
fi
echo "PR #${PR} (${REPO})${BRANCH:+, branch ${BRANCH}}${TARGET_ABS:+, worktree ${TARGET_ABS}}"

body="$($GH pr view "$PR" --repo "$REPO" --json body --jq .body)"
mapfile -t ids < <(grep -iE '^[[:space:]]*(fixes|closes|resolves|beads?):' <<<"$body" \
  | sed -E 's/\([Ee]pic[^)]*\)//g' \
  | grep -oE "$ID_RE" | sort -u || true)
if [ "${#ids[@]}" -eq 0 ]; then
  echo "Fixes: (none): the PR body anchors no bead id, so there is no bead to verify."
else
  echo "Fixes: ${ids[*]}"
fi

# ── waits ───────────────────────────────────────────────────────────────────────────────────────
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
rl_hits=0
# $1 = what we are waiting on; $2 non-empty = the PR is still queued, so the cap restarts;
# $3 non-empty = this poll was rate-limited, so sleep the doubling back-off instead of the poll.
wait_or_die() {
  if [ -n "${2:-}" ]; then
    deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
  elif [ "$(date +%s)" -ge "$deadline" ]; then
    echo "ERROR: gave up after ${TIMEOUT_MIN} min waiting on: $1" >&2
    exit 4
  fi
  if [ -n "${3:-}" ]; then
    rl_hits=$(( rl_hits + 1 ))
    local base=$(( POLL > BACKOFF_FLOOR ? POLL : BACKOFF_FLOOR )) s
    s=$(( base * (1 << (rl_hits < 10 ? rl_hits : 10)) ))
    [ "$s" -le "$BACKOFF_MAX" ] || s="$BACKOFF_MAX"
    echo "  backing off ${s}s (rate-limited poll ${rl_hits} in a row); not retrying at once"
    sleep "$s"
  else
    rl_hits=0
    sleep "$POLL"
  fi
}

# The PR's whole state in ONE request: scripts/pr-queue-state.mjs's GraphQL read
# prints `merged <sha>`, `closed`, `queued <STATE> <position>`,
# `ejected <reason> <rearmed|unarmed>`, `held <review|conflict|gate>`, `open`, or `ratelimited`.
# Sets qline (that line), verdict v1 v2, and state: MERGED (merge = the sha), CLOSED, OPEN,
# RATELIMITED, or empty when the read failed (its stderr is shown; the PR is then waited on and
# the cap applies).
#
# The per-machine watcher answers first when one runs (scripts/pr-watch.mjs): exit 0 is
# its line, 3 is `ratelimited`, anything else (no watcher, a stale state file, a PR it has not read
# yet, or a missing pr-watch.mjs) means the direct read below, exactly as before. AGENT_TOOLING_PR_WATCH=0
# skips it.
WATCH_NOTED=0
read_pr() {
  local wrc=0
  qline=""
  if [ "${AGENT_TOOLING_PR_WATCH:-1}" != "0" ]; then
    qline="$(REPO="$REPO" node "$HERE/pr-watch.mjs" read "$PR" --watch-only 2>/dev/null)" || wrc=$?
    if [ "$wrc" -eq 0 ] || [ "$wrc" -eq 3 ]; then
      [ "$WATCH_NOTED" = "1" ] || echo "  (answered by the per-machine PR watcher, scripts/pr-watch.mjs: no request of our own)"
      WATCH_NOTED=1
    else
      qline=""
    fi
  fi
  # GH_CLI reaches it only when the caller set it (it is in the environment then): exporting the
  # default `gh` made pr-queue-state run `bash gh` on Windows, which never read the PR.
  [ -n "$qline" ] || qline="$(REPO="$REPO" node "$HERE/pr-queue-state.mjs" "$PR")" || true
  verdict=""; v1=""; v2=""; merge=""
  read -r verdict v1 v2 <<<"$qline"
  case "$verdict" in
    merged) state=MERGED; merge="$v1" ;;
    closed) state=CLOSED ;;
    queued|ejected|held|open) state=OPEN ;;
    ratelimited) state=RATELIMITED ;;
    *) state="" ;;
  esac
}
rate_limited_msg() {
  echo "rate-limited: GitHub refused the poll for PR #${PR} (the shared account's secondary limit counts every session's requests; 'gh api rate_limit' is free and tells it from the core quota)"
}
ejected_stop() { # $1 reason
  echo "ERROR: PR #${PR} was EJECTED from the merge queue (${1:-unknown}) and auto-merge is not armed; nothing will merge it." >&2
  echo "  Read its failing merge_group run (gh run list --repo ${REPO} --event merge_group). A spec already red on" >&2
  echo "  main: re-arm with gh pr merge --auto ${PR}. Its own failure: fix and push. A conflict: merge origin/main, push, re-arm." >&2
  exit 5
}
held_stop() { # $1 review|conflict|gate
  if [ "$1" = "conflict" ]; then
    echo "ERROR: PR #${PR} is HELD by a merge conflict with main; it cannot enter the merge queue until main is merged into it." >&2
    echo "  In its worktree: git fetch origin main && git merge origin/main (resolve, commit), then a plain git push" >&2
  elif [ "$1" = "gate" ]; then
    echo "ERROR: PR #${PR} is HELD by a red gate on its current head; it cannot enter the merge queue." >&2
    echo "  Read it: gh pr checks ${PR} --repo ${REPO}. Fix and push, or do a full gh run rerun if it is a runner fault." >&2
  else
    echo "ERROR: PR #${PR} is HELD by a blocking review (CHANGES_REQUESTED on its current head); it cannot enter the merge queue." >&2
    echo "  Read it: gh pr view ${PR} --repo ${REPO} --comments. Fix and push (the reviewer dismisses its own" >&2
    echo "  stale REQUEST_CHANGES); a wrong finding is dismissed by a maintainer in the GitHub UI with a reason." >&2
  fi
  echo "  Auto-merge stays armed: once cleared the PR queues on a green gate. Then re-run this command." >&2
  exit 6
}
# Does the tag contain the merge commit? ONE request: `compare/<merge>...beads-synced`,
# the tag named directly instead of resolved first. Status `ahead` or `identical` means the tag is
# at or past the merge (exit 0); `behind`/`diverged`, a tag that does not exist, or a failed read
# means no (exit 1); a rate limit is exit 2, for the back-off. Sets tag_status for the messages.
# A running watcher answers from its own read when it can tell (scripts/pr-watch.mjs `tag`); when it
# cannot, the compare below runs as before.
tag_check() {
  local errf out rc=0 st wrc=0
  if [ "${AGENT_TOOLING_PR_WATCH:-1}" != "0" ]; then
    out="$(REPO="$REPO" node "$HERE/pr-watch.mjs" tag "$PR" --merge "$merge" 2>/dev/null)" || wrc=$?
    if [ "$wrc" -eq 3 ]; then tag_status="rate-limited (pr-watch)"; return 2; fi
    if [ "$wrc" -eq 0 ]; then
      read -r st <<<"$out"
      tag_status="${st:-empty} (pr-watch)"
      [ "$st" = "ahead" ] || [ "$st" = "identical" ]
      return
    fi
  fi
  errf="$(mktemp)"
  out="$($GH api "repos/${REPO}/compare/${merge}...${TAG}" --jq .status 2>"$errf")" || rc=$?
  if [ "$rc" -ne 0 ]; then
    cat "$errf" >&2
    if grep -qiE "$RATE_LIMIT_RE" "$errf"; then rm -f "$errf"; tag_status="rate-limited"; return 2; fi
    rm -f "$errf"; tag_status="unreadable (no tag yet?)"; return 1
  fi
  rm -f "$errf"
  read -r st <<<"$out"
  tag_status="${st:-empty}"
  [ "$st" = "ahead" ] || [ "$st" = "identical" ]
}

read_pr
if [ "$NO_WAIT" = "1" ]; then
  pending=0
  echo "state: ${state:-unknown}${merge:+ merge ${merge}}"
  if [ "$state" = "CLOSED" ]; then
    # The same hard stop as the waiting path: a closed-not-merged PR is not pending, it is over.
    echo "ERROR: PR #${PR} is CLOSED without merging; nothing to land." >&2
    exit 1
  fi
  if [ "$state" = "RATELIMITED" ]; then
    pending=1
    rate_limited_msg
  elif [ "$state" != "MERGED" ]; then
    pending=1
    echo "merge queue: ${qline:-(unread)}"
  else
    tc=0; tag_check || tc=$?
    if [ "$tc" -eq 0 ]; then
      echo "${TAG}: contains the merge (compare: ${tag_status}; the batch close ran and was verified)"
    else
      echo "${TAG}: does not contain the merge yet (compare: ${tag_status}; ${CLOSE_WORKFLOW} has not closed this PR's beads)"
      pending=1
    fi
  fi
  for id in "${ids[@]+"${ids[@]}"}"; do
    st="$($BD show "$id" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const o=Array.isArray(j)?j[0]:j;console.log(o?.status??"?")}catch{console.log("?")}})')"
    echo "bead ${id}: ${st}"
    [ "$st" = "closed" ] || pending=1
  done
  [ "$pending" = "0" ] && { echo "landed: nothing left to wait on (run without --no-wait to remove the worktree)"; exit 0; }
  echo "not landed yet"
  exit 3
fi

while [ "$state" != "MERGED" ]; do
  q=""; rl=""
  case "$state" in
    CLOSED) echo "ERROR: PR #${PR} is CLOSED without merging; nothing to land." >&2; exit 1 ;;
    RATELIMITED) rl=1; rate_limited_msg ;;
    OPEN)
      case "${verdict:-}" in
        queued)
          q="${v1} ${v2}"
          if [ "$QUEUED_OK" = "1" ]; then
            echo "queued: PR #${PR} is in the merge queue (${v1}, position ${v2}): done for now (--queued-ok)."
            echo "  still pending: the merge, then ${CLOSE_WORKFLOW} closing ${ids[*]:-no beads}; the worktree is kept."
            echo "  finish later from the primary checkout: bash scripts/land.sh ${TARGET_ABS:-"--pr ${PR}"}"
            exit 0
          fi
          echo "waiting: PR #${PR} is in the merge queue (${v1}, position ${v2}); no cap while queued; next check in ${POLL}s" ;;
        ejected)
          [ "${v2:-}" = "rearmed" ] || ejected_stop "$v1"
          echo "waiting: PR #${PR} was ejected from the merge queue (${v1}) and auto-merge is re-armed; waiting for it to re-enter; next check in ${POLL}s" ;;
        held) held_stop "${v1:-review}" ;;
        *) echo "waiting: PR #${PR} is OPEN and not queued (CI or review pending, or blocked); next check in ${POLL}s" ;;
      esac ;;
    *) echo "waiting: PR #${PR} could not be read (state unknown); next check in ${POLL}s" ;;
  esac
  wait_or_die "PR #${PR} to merge (last state: ${state:-unknown}${q:+, queued: ${q}})" "$q" "$rl"
  read_pr
done
[ -n "$merge" ] || { echo "ERROR: PR #${PR} is MERGED but reports no merge commit." >&2; exit 1; }
echo "merged: PR #${PR} as ${merge}"

while :; do
  tc=0; tag_check || tc=$?
  [ "$tc" -ne 0 ] || break
  if [ "$tc" -eq 2 ]; then
    echo "rate-limited: GitHub refused the ${TAG} compare (the shared account's secondary limit)"
  else
    echo "waiting: ${TAG} does not contain ${merge} yet (compare: ${tag_status}); ${CLOSE_WORKFLOW} closes beads on every push to main; next check in ${POLL}s"
  fi
  wait_or_die "${TAG} to contain ${merge} (compare: ${tag_status})" "" "$([ "$tc" -eq 2 ] && echo 1 || true)"
done
echo "${TAG}: contains ${merge} (compare: ${tag_status}); the close for this PR ran and was verified"

# ── beads ───────────────────────────────────────────────────────────────────────────────────────
if [ -n "${LAND_SYNC_CMD:-}" ]; then
  bash -c "$LAND_SYNC_CMD"
else
  node "$HERE/bd-dolt-sync.mjs" pull
fi
open_ids=()
for id in "${ids[@]+"${ids[@]}"}"; do
  echo "── ${id} ──"
  $BD show "$id" || true
  st="$($BD show "$id" --json 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const j=JSON.parse(s);const o=Array.isArray(j)?j[0]:j;console.log(o?.status??"?")}catch{console.log("?")}})')"
  [ "$st" = "closed" ] || open_ids+=("$id")
done
if [ "${#open_ids[@]}" -gt 0 ]; then
  echo "ERROR: PR #${PR} merged and ${TAG} passed it, but these beads are NOT closed:" >&2
  for id in "${open_ids[@]}"; do echo "  NOT CLOSED: ${id}" >&2; done
  echo "  ${CLOSE_WORKFLOW} put each in a bucket a re-do cannot change (HELD, BLOCKED-BY, UNKNOWN," >&2
  echo "  NO-FIXES-LINE, NOT-ON-MAIN); read the bead's notes and the run's beads-unclosed artifact, then" >&2
  echo "  close it by hand if that is right and re-run this command. The worktree was NOT removed." >&2
  exit 1
fi
[ "${#ids[@]}" -eq 0 ] || echo "beads: all closed (${ids[*]})"

# ── worktree, branch, remote refs ───────────────────────────────────────────────────────────────
if [ -n "$TARGET_ABS" ]; then
  cd "$PRIMARY"
  if [ -n "${LAND_WORKTREE_RM:-}" ]; then
    bash "$LAND_WORKTREE_RM" "$TARGET_ABS"
  else
    bash "$HERE/worktree-rm.sh" "$TARGET_ABS"
  fi
  [ ! -e "$TARGET_ABS" ] || { echo "ERROR: $TARGET_ABS still exists after worktree-rm.sh." >&2; exit 1; }
  if git -C "$PRIMARY" show-ref --verify --quiet "refs/heads/${BRANCH}"; then
    git -C "$PRIMARY" branch -D "$BRANCH"
  fi
fi
git -C "$PRIMARY" fetch --prune origin 2>&1 | sed 's/^/  /' || echo "  note: fetch --prune failed; stale origin/* refs may remain"
stashes="$(git -C "$PRIMARY" stash list 2>/dev/null | wc -l | tr -d ' ')"
if [ "${stashes:-0}" -gt 0 ]; then
  echo "note: this script created no stash, but the primary checkout carries ${stashes}: review with: git -C $PRIMARY stash list"
fi
echo "landed: PR #${PR}${ids[0]+, beads ${ids[*]} closed}${TARGET_ABS:+, worktree ${TARGET_ABS} removed}"
