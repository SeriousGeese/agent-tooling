#!/usr/bin/env bash
# worktree-rm.sh, remove a worktree safely, including on Windows.
#
# Why this exists rather than "just run git worktree remove":
#
#   * On Windows, `git worktree remove --force` FAILS on this repo with
#     "Filename too long", node_modules nests past MAX_PATH. It reports success
#     (exit 0) while leaving the directory behind, so the failure is easy to miss.
#     The recipe that actually works is `rm -rf` followed by `git worktree prune`,
#     and until now that lived only in an agent's memory file.
#   * `.claude/worktrees/` is SHARED by every concurrent session. A glob like
#     `worktree remove worktrees/agent-*` has destroyed other sessions' live
#     worktrees. This script takes ONE literal path and refuses anything else.
#   * git has no worktree-removal hook, so a tracked dev server for the removed
#     worktree would linger; worktree-dev.sh reap is invoked to collect it.
#
# Usage:
#   scripts/worktree-rm.sh <path>            # remove one worktree
#   scripts/worktree-rm.sh <path> --force    # ... even with uncommitted changes
#   scripts/worktree-rm.sh <path> --dry-run  # run every guard, print what would happen, delete nothing
#   scripts/worktree-rm.sh --stale           # LIST removal candidates (never deletes)
#   scripts/worktree-rm.sh --help            # this message
#
# Argument parsing is fail-CLOSED: an unrecognised flag, or a second positional
# argument, exits 2 with the usage on stderr and removes nothing, never silently
# ignored or silently taken as the target. `bash scripts/worktree-rm.sh <path> --dry-run`
# and `... <path> --help` used to fall through the old `*) [ -z "$TARGET" ] && ...`
# catch-all, which took the FIRST argument as the target and silently dropped every
# other one, so both of those invocations actually REMOVED a live worktree. That
# reached two reviewers' trees on 2026-09-28 before this fix.
#
# Environment:
#   WORKTREE_RM_SKIP_GH=1  skip every `gh` lookup (offline / tests). The gh calls are
#                          best-effort in BOTH directions: without them a landing cannot
#                          be proven by PR, and an open PR cannot veto a nomination, so
#                          skipping them only ever removes nominations, never adds one.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# `git status` inside the target and `git worktree remove` are the same fsmonitor-daemon
# waits that hang worktree-new.sh's checkout; keep the daemon off for this run.
# shellcheck source=lib/git-no-fsmonitor.sh
source "$SCRIPT_DIR/lib/git-no-fsmonitor.sh"
git_disable_fsmonitor
# NOTE the awk does NOT `exit` after the first match, and must not. Exiting early closes the
# pipe while `git worktree list` is still writing, git takes SIGPIPE, and `set -o pipefail`
# turns that into status 141 for the whole command substitution, which `set -e` then treats
# as a fatal error, killing this script at line 1 before it can do anything. It is invisible on
# a machine with one or two worktrees (git finishes writing before awk exits) and fires
# reliably on a machine running several parallel sessions, which is exactly where a worktree
# script is used. Consuming all input and printing only the first match is behaviourally
# identical and cannot race.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree / && !seen {print $2; seen = 1}')"

norm() { (cd "$1" 2>/dev/null && pwd -P) || printf '%s' "$1"; }

# The session-lock checker, run with paths node can open. Git Bash hands a native
# program a `/c/…` argument verbatim whenever MSYS_NO_PATHCONV=1 is set, so node cannot even load
# the script and the check never runs; cygpath writes the `C:/…` form. A no-op off Windows.
session_lock() {
  local cmd="$1"; shift
  local args=() a
  for a in "$@"; do
    if command -v cygpath >/dev/null 2>&1; then a="$(cygpath -m -- "$a")"; fi
    args+=("$a")
  done
  local js="$SCRIPT_DIR/session-lock.mjs"
  if command -v cygpath >/dev/null 2>&1; then js="$(cygpath -m -- "$js")"; fi
  node "$js" "$cmd" ${args[@]+"${args[@]}"}
}

# Classify a branch's relationship to what has LANDED on origin/main: prints exactly
# one of
#   upstream           positively proven landed, its work is already on origin/main
#   pushed-not-merged  published and in sync with origin/<branch>, but NOT proven landed
#   unpushed           origin/<branch> exists but the branch is ahead of it
#   never-pushed       no origin/<branch>, and the work is not on origin/main either
#
# `upstream` means LANDED, and nothing else may print it. "Pushed" and "landed" are
# different facts and conflating them is a bug: the fallback below used to print
# `upstream` for any branch that merely matched its own remote ref, so every ordinary
# published feature branch with an OPEN PR was classified as merged. On 2026-09-02 that
# nominated four live branches (#2883, #2880, #2879, #2865) for deletion under a banner
# saying their work had landed, the zero-own-commits failure class on the other code path,
# reaching the busy case (real branch, real work, open PR) that the zero-commit guard in
# `--stale` does not cover. The fallback is now the CONSERVATIVE branch, which is the
# principle the zero-commit comment in `--stale` already states.
#
# Landing has to be tested THREE ways, because the remote branch ref is deleted the
# moment a PR merges, so "origin/<branch> is missing" on its own proves nothing:
#   1. ancestry, covers merge-commit and rebase merges.
#   2. patch-id, `git cherry` prints '-' for a commit whose patch already exists
#      upstream. This is what covers a SQUASH merge of a single-commit branch, the
#      merge method an auto-merging bot typically uses (an ancestry-only check printed a
#      false "never pushed" on the branch's own worktree).
#   3. a merged PR for that head, covers a multi-commit squash, where no single
#      commit's patch-id can match the one squashed commit. Network; best-effort.
# All three are POSITIVE tests. Anything they cannot prove is not landed.
upstream_state() {
  local wt="$1" br="$2"
  if git -C "$wt" merge-base --is-ancestor "$br" origin/main 2>/dev/null; then
    echo upstream; return
  fi
  # `git cherry` lists '+' for commits NOT upstream. None → everything is.
  # Counted with `grep -c`, not tested with `grep -q`, for the SIGPIPE reason above:
  # `grep -q` leaves on the first match, git cherry dies of SIGPIPE, pipefail reports 141,
  # and `!` then flips that failure into a bogus "upstream", the one classification that
  # tells the caller it is safe to delete the directory.
  local ahead
  ahead="$(git -C "$wt" cherry origin/main "$br" 2>/dev/null | grep -c '^+' || true)"
  if [ -n "$(git -C "$wt" rev-list -n1 "$br" 2>/dev/null)" ] && [ "${ahead:-0}" -eq 0 ] 2>/dev/null; then
    echo upstream; return
  fi
  if [ "${WORKTREE_RM_SKIP_GH:-0}" != "1" ] && command -v gh >/dev/null 2>&1; then
    local merged
    merged="$(env -u GITHUB_TOKEN gh pr list --head "$br" --state merged --json number --jq 'length' 2>/dev/null || echo 0)"
    if [ "${merged:-0}" -gt 0 ] 2>/dev/null; then echo upstream; return; fi
  fi
  if ! git -C "$wt" rev-parse --verify --quiet "origin/$br" >/dev/null; then
    echo never-pushed; return
  fi
  if [ -n "$(git -C "$wt" log --oneline "origin/$br..$br" 2>/dev/null)" ]; then
    echo unpushed; return
  fi
  # Published and in sync with origin/<branch>, and that is ALL it means. Every one of
  # the three landing tests above said no, so this branch has not landed.
  echo pushed-not-merged
}

# `--check-upstream <path>`: print the classification and exit, one of `upstream`,
# `pushed-not-merged`, `unpushed` or `never-pushed`. Exists so the logic above is
# testable against a fixture repo without performing a removal.
if [ "${1:-}" = "--check-upstream" ]; then
  [ -n "${2:-}" ] || { echo "Usage: scripts/worktree-rm.sh --check-upstream <path>" >&2; exit 1; }
  upstream_state "$(norm "$2")" "$(git -C "$2" rev-parse --abbrev-ref HEAD)"
  exit 0
fi

# ── --stale: report only ────────────────────────────────────────────────────
# Deliberately does NOT delete, and nominates ONLY on positive proof that the branch's
# work landed. Ancestry can only prove a branch IS merged, never that it isn't: a
# squash-merged PR leaves its branch un-ancestored, so this under-reports rather than
# over-reports. Erring toward keeping is correct when the blast radius is another
# session's uncommitted work.
#
# Two independent things must both hold for a nomination:
#   * the classifier says `upstream`, i.e. LANDED, proven by ancestry, patch-id or a
#     merged PR. `pushed-not-merged` is not landing and never nominates.
#   * there is no OPEN PR for the branch. This is a deliberately redundant backstop on
#     a cheaper signal than the classifier's: on 2026-09-02 it alone would have caught
#     all four wrongly-nominated branches regardless of how they were classified. An
#     open PR means a session is very likely still holding that worktree.
#
# The nominations are also stamped with a caveat when THIS SCRIPT is itself behind
# origin/main, see self_stale_commits below.
if [ "${1:-}" = "--stale" ]; then
  git fetch origin main --quiet 2>/dev/null || true
  HERE="$(git rev-parse --show-toplevel 2>/dev/null || echo '')"

  # Is the copy of this script that is RUNNING older than origin/main's?
  #
  # Every rule in this file is a fix for a case where `--stale` nominated a live
  # worktree, and a worktree runs the files it was cut with, the SessionStart banner's
  # background refresh runs the session's own copy of this script, and restarting Claude
  # Code does not pick up fixes. So a session on a checkout cut before the open-PR veto
  # and the zero-own-commits rule keeps emitting the OLD over-nomination on every session start, under a
  # banner that states its conclusions as fact.
  #
  # `[hooks-stale]` already warns about exactly this and even names this file, and it is
  # NOT enough: on 2026-09-03 an agent read that banner, quoted it back, and then filed
  # a P1 bug against a fallthrough fixed 13 hours earlier, diagnosed from
  # the stale source in the same tree. A peer session "corroborated" it with 30 of 36
  # worktrees nominated as MERGED; that session was stale too. Two independent-looking
  # confirmations, one cause. The signal was not missing, it LOST: a generic warning at
  # the top of the session against a confident, specific claim further down. So the
  # caveat has to travel with the output that gets acted on, not sit beside it.
  #
  # Prints the commit count when behind and nothing otherwise. Three-dot on purpose
  # (same reasoning as scripts/hooks/check-stale-hooks.mjs): it asks "what landed on
  # main that I do not have", so a session editing THIS file is not nagged about its own
  # in-flight work, two-dot would flag every such session and train the reader to skip
  # the line. Resolved against the repo the SCRIPT lives in, not the caller's cwd, since
  # that is the checkout whose copy is actually executing.
  self_stale_commits() {
    local top rel
    top="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)" || return 0
    [ -n "$top" ] || return 0
    rel="${BASH_SOURCE[0]}"
    case "$rel" in /*) rel="${rel#"$top"/}" ;; *) rel="${SCRIPT_DIR#"$top"/}/$(basename "${BASH_SOURCE[0]}")" ;; esac
    # No origin/main ref (fresh clone, detached CI checkout), say nothing.
    git -C "$top" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null 2>&1 || return 0
    [ -n "$(git -C "$top" diff --name-only HEAD...origin/main -- "$rel" 2>/dev/null)" ] || return 0
    git -C "$top" rev-list --count HEAD..origin/main 2>/dev/null || true
  }
  SELF_BEHIND="$(self_stale_commits)"

  # The set of branch names whose PR is MERGED, fetched ONCE. `upstream_state` asks per
  # branch, which is fine for a single removal but is N network round-trips here, this
  # repo routinely carries 35+ worktrees.
  # The open set is fetched the same way and for the same reason. An empty MERGED_HEADS can
  # only WITHDRAW a nomination, but an empty OPEN_HEADS silently drops the veto, so a branch
  # with an open PR and locally upstream commits would be nominated. So when the whole open set
  # cannot be read this nominates NOTHING and exits non-zero, which keeps the banner's last good
  # report. A result that reaches the limit counts, because gh truncates without saying so. Only
  # WORKTREE_RM_SKIP_GH=1, the test fixtures' offline mode, runs without it.
  MERGED_HEADS=""
  OPEN_HEADS=""
  if [ "${WORKTREE_RM_SKIP_GH:-0}" != "1" ]; then
    OPEN_OK=0
    OPEN_LIMIT="${WORKTREE_RM_OPEN_PR_LIMIT:-1000}"
    if command -v gh >/dev/null 2>&1; then
      MERGED_HEADS="$(env -u GITHUB_TOKEN gh pr list --state merged --limit 200       --json headRefName --jq '.[].headRefName' 2>/dev/null || true)"
      OPEN_HEADS="$(env -u GITHUB_TOKEN gh pr list --state open --limit "$OPEN_LIMIT"       --json headRefName --jq '.[].headRefName' 2>/dev/null)" && OPEN_OK=1
      open_count="$(printf '%s\n' "$OPEN_HEADS" | grep -c . || true)"
      if [ "${open_count:-0}" -ge "$OPEN_LIMIT" ]; then OPEN_OK=0; fi
    fi
    if [ "$OPEN_OK" != 1 ]; then
      echo "[worktree-stale] could not read every open PR from gh, so nothing is nominated: an open PR vetoes removal." >&2
      exit 1
    fi
  fi
  # Counted, never `grep -q`: an early exit gives printf SIGPIPE and pipefail reports 141,
  # which would read as "not merged" here and as a hard error under set -e. Same hazard the
  # `git cherry` call above documents.
  pr_merged() {
    [ -n "$MERGED_HEADS" ] || return 1
    local n
    n="$(printf '%s\n' "$MERGED_HEADS" | grep -cxF "$1" || true)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null
  }
  pr_open() {
    [ -n "$OPEN_HEADS" ] || return 1
    local n
    n="$(printf '%s\n' "$OPEN_HEADS" | grep -cxF "$1" || true)"
    [ "${n:-0}" -gt 0 ] 2>/dev/null
  }

  # Worktrees another live agent session is in, read once. Removal refuses them, so
  # nominating one only invites a refusal; and a merged branch is exactly what a session that
  # finished its PR but is still working sits on. `filter-live` echoes back the paths it is given,
  # so they compare verbatim with the porcelain paths below. A read that failed says so: a silent
  # failure here would quietly drop the veto.
  LIVE_RC=0
  LIVE_ERR=""
  LIVE_ERR_FILE="$(mktemp)"
  LIVE_PATHS="$(git worktree list --porcelain | awk '/^worktree /{sub(/^worktree /, ""); print}' |
    session_lock filter-live 2>"$LIVE_ERR_FILE")" || LIVE_RC=$?
  [ "$LIVE_RC" = 0 ] || LIVE_ERR="$(sed 's/^/[worktree-stale]   /' "$LIVE_ERR_FILE")"
  rm -f "$LIVE_ERR_FILE"

  total=0; stale=0; NOMINATIONS=""
  while read -r path branch; do
    total=$((total + 1))
    [ "$(norm "$path")" = "$(norm "$PRIMARY")" ] && continue
    # Never nominate the worktree the caller is standing in.
    [ -n "$HERE" ] && [ "$(norm "$path")" = "$(norm "$HERE")" ] && continue
    [ -n "$branch" ] || continue
    # Exact whole-line match without a pipe (the grep -q SIGPIPE hazard above).
    case $'\n'"$LIVE_PATHS"$'\n' in *$'\n'"$path"$'\n'*) continue ;; esac
    br="${branch#refs/heads/}"

    # An OPEN PR vetoes the nomination outright, whatever the classifier concludes
    # Checked FIRST and independently of everything below: it is the cheap
    # signal that a branch is still in flight, and it does not share a failure mode with
    # the local-history tests. Deliberately redundant, a redundant guard is the point.
    if pr_open "$br"; then continue; fi

    # How much work does this branch actually have of its own?
    #
    # This is the question the old ancestry-only test could not ask, and getting it wrong
    # destroyed another session's uncommitted work on 2026-09-01. A branch that
    # `worktree-new.sh` created minutes ago sits at whatever origin/main was AT THAT MOMENT,
    # so it is trivially an ancestor of main and reported as MERGED. The previous guard
    # compared the tip against origin/main's CURRENT tip, which only holds while main has not
    # moved, and `--stale` fetches main first, so on a repo merging all day it almost never
    # holds. Five in-flight worker worktrees were nominated for deletion this way, under a
    # banner saying they were safe to remove even if another session made them.
    own="$(git rev-list --count "origin/main..$br" 2>/dev/null || echo 0)"
    if [ "${own:-0}" -eq 0 ] 2>/dev/null; then
      # No commits of its own. That is EITHER a branch merged by fast-forward/merge-commit
      # OR one nobody has committed to yet, and the two are genuinely indistinguishable from
      # local refs alone. So require positive evidence that work landed; with no evidence,
      # keep the worktree. Erring toward keeping is the whole point when the blast radius is
      # somebody else's unpushed work.
      pr_merged "$br" || continue
    else
      # It has commits of its own, so it is not an ancestor of main. Ask the full
      # classifier, which covers the SQUASH merge this repo's bot actually performs
      # (patch-id, then a merged PR for the head). The old ancestry-only check missed
      # every squash-merged branch, which is most of them.
      [ "$(upstream_state "$path" "$br")" = "upstream" ] || continue
    fi

    stale=$((stale + 1))
    # Buffered rather than printed here so the staleness caveat below can lead. A reader
    # who has already scrolled past the caveat has already been failed by it.
    NOMINATIONS="${NOMINATIONS}$(printf '  MERGED  %s  [%s]' "$path" "$br")
"
    # awk emits one "<path> <branch>" line per porcelain record. The final record has no
    # trailing blank line, so END flushes it too, otherwise the last worktree is dropped.
  done < <(git worktree list --porcelain |
    awk '/^worktree /{if(p)print p, b; p=$2; b=""} /^branch /{b=$2} END{if(p)print p, b}')
  if [ "$stale" -gt 0 ]; then
    # FIRST, ahead of the list, when the running script predates origin/main's.
    if [ -n "$SELF_BEHIND" ]; then
      echo "[worktree-stale] ⚠ READ THIS FIRST: the list below was produced by a STALE copy of"
      echo "[worktree-stale]   scripts/worktree-rm.sh: this checkout is $SELF_BEHIND commit(s) behind"
      echo "[worktree-stale]   origin/main and that file is one of the differences. A worktree runs the"
      echo "[worktree-stale]   files it was cut with, and restarting Claude Code does NOT pick up fixes,"
      echo "[worktree-stale]   so these nominations may be a bug that is already fixed."
      echo "[worktree-stale]   Every past defect in this script over-nominated LIVE worktrees as MERGED,"
      echo "[worktree-stale]   so the dangerous direction is the one shown here."
      echo "[worktree-stale]   Do NOT remove anything below, and do NOT file a bug about this output,"
      echo "[worktree-stale]   until you re-run it from a current tree:"
      echo "[worktree-stale]     git -C $PRIMARY pull --ff-only && bash $PRIMARY/scripts/worktree-rm.sh --stale"
      echo "[worktree-stale]   Another session agreeing with you is NOT corroboration: it is probably"
      echo "[worktree-stale]   stale too. That is exactly how a bug gets filed against a fix that had"
      echo "[worktree-stale]   already landed 13 hours earlier."
    fi
    # Only alongside nominations, like the caveat above: a list that names nothing has nothing
    # this could make unsafe.
    if [ -n "$LIVE_ERR" ]; then
      echo "[worktree-stale] WARNING: the session locks could not all be read (exit $LIVE_RC), so a worktree"
      echo "[worktree-stale]   below may have a live session in it (removal re-checks and refuses):"
      printf '%s\n' "$LIVE_ERR"
    fi
    printf '%s' "$NOMINATIONS"
    echo "[worktree-stale] $stale of $total worktrees are on branches whose work has LANDED."
    echo "[worktree-stale] Each keeps ~0.7 GB of node_modules. Remove one with:"
    echo "[worktree-stale]   bash scripts/worktree-rm.sh <path>"
    echo "[worktree-stale] Nomination needs positive evidence the branch did work that landed"
    echo "[worktree-stale] (a merged PR, or its own commits already upstream). Merely being pushed"
    echo "[worktree-stale] and in sync with origin/<branch> is NOT landing and is never listed,"
    echo "[worktree-stale] nor is any branch with an OPEN PR. A branch with no commits"
    echo "[worktree-stale] of its own is treated as UNSTARTED, never merged, so another session's"
    echo "[worktree-stale] freshly-provisioned worktree is not listed here."
    echo "[worktree-stale] Anything NOT listed, only remove if you created it. Removal REFUSES a"
    echo "[worktree-stale] worktree with uncommitted changes; --force overrides and is unrecoverable."
  fi
  exit 0
fi

# Printed on stdout for `--help` (a normal, exit-0 request for information) and
# redirected to stderr by every error path below: the caller decides the stream,
# this only decides the words.
usage_rm() {
  cat <<'USAGE'
Usage:
  scripts/worktree-rm.sh <path>              # remove one worktree
  scripts/worktree-rm.sh <path> --force      # ... even with uncommitted changes
  scripts/worktree-rm.sh <path> --force-live-session  # ... even while another live session is in it
  scripts/worktree-rm.sh <path> --dry-run    # run every guard, print what would happen, delete nothing
  scripts/worktree-rm.sh --stale             # LIST removal candidates (never deletes)
  scripts/worktree-rm.sh --help              # this message
USAGE
}

# `--force` and `--dry-run` may appear before or after the path, in either order.
# `--force` ONLY relaxes the uncommitted-changes refusal below; it does not bypass
# the glob, primary-checkout, inside-cwd or not-a-worktree guards, which protect
# against mistakes no amount of intent makes safe.
#
# Fail CLOSED on anything else: an unrecognised `-`-prefixed argument, or a SECOND
# positional argument, exits 2 and removes nothing, rather than being silently
# dropped or silently taken as the target. The old catch-all here,
# `*) [ -z "$TARGET" ] && TARGET="$1"`, took the FIRST bare word as the target no
# matter what it was and silently ignored every argument after it, so
# `<path> --dry-run` and `<path> --help` both took the "remove one worktree" branch
# and deleted a live worktree. `--help`/`-h` is handled here, before
# TARGET is required, so `scripts/worktree-rm.sh --help` alone prints usage and
# exits 0 without ever asking for a path.
FORCE=0
FORCE_LIVE=0
DRY_RUN=0
TARGET=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --force-live-session) FORCE_LIVE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    -h|--help) usage_rm; exit 0 ;;
    -*)
      echo "ERROR: unrecognised option '$1'." >&2
      usage_rm >&2
      exit 2 ;;
    *)
      if [ -n "$TARGET" ]; then
        echo "ERROR: unexpected extra argument '$1' (a target, '$TARGET', was already given)." >&2
        usage_rm >&2
        exit 2
      fi
      TARGET="$1" ;;
  esac
  shift
done
if [ -z "$TARGET" ]; then
  usage_rm >&2
  exit 1
fi
case "$TARGET" in
  *'*'*|*'?'*)
    echo "ERROR: refusing a glob. Pass ONE literal worktree path." >&2
    echo "  .claude/worktrees/ is shared by concurrent sessions; a glob there has" >&2
    echo "  destroyed other sessions' live worktrees before." >&2
    exit 1 ;;
esac

[ -e "$TARGET" ] || { echo "ERROR: $TARGET does not exist." >&2; exit 1; }
TARGET_ABS="$(norm "$TARGET")"

if [ "$TARGET_ABS" = "$(norm "$PRIMARY")" ]; then
  echo "ERROR: $TARGET is the PRIMARY checkout, not a worktree. Refusing." >&2
  exit 1
fi

# Refuse to remove the directory this process is standing in, or any ancestor of
# it. This is the MOST natural way to call the script, finish a bead,
# the PR merges, clean up from where you sit, and it was the worst: on Windows the
# rm -rf fallback deleted the process's own cwd, every later command ran with an
# invalid working directory ("fatal: Unable to read current working directory"),
# and an unrelated sibling worktree was gone afterwards. Run it from the primary.
CWD_ABS="$(norm "$(pwd -P 2>/dev/null || echo /)")"
case "$CWD_ABS/" in
  "$TARGET_ABS"/*)
    echo "ERROR: refusing to remove $TARGET: you are running from INSIDE it ($CWD_ABS)." >&2
    echo "  Deleting your own cwd leaves every later command with an invalid working" >&2
    echo "  directory. Run from the primary checkout instead:" >&2
    echo "    cd $PRIMARY && bash scripts/worktree-rm.sh $TARGET_ABS" >&2
    exit 1 ;;
esac

# Must be a registered worktree, never rm -rf an arbitrary directory. Process
# substitution (not a pipe) so the loop runs in THIS shell and the flag survives it.
IS_WORKTREE=0
while read -r p; do
  [ -n "$p" ] && [ "$(norm "$p")" = "$TARGET_ABS" ] && IS_WORKTREE=1
done < <(git worktree list --porcelain | awk '/^worktree /{print $2}')
if [ "$IS_WORKTREE" != "1" ]; then
  echo "ERROR: $TARGET is not a registered git worktree. Refusing to delete it." >&2
  echo "  If it is a leftover directory, remove it by hand, then: git worktree prune" >&2
  exit 1
fi

# Refuse a worktree another LIVE agent session is in. On 2026-10-23 a live lead
# session's harness worktree was emptied mid-session and its next commands ran against the
# primary checkout. Sessions record where they are through the session-lock hooks
# (scripts/session-lock.mjs); a record goes stale when its process dies or it is 12h old, so a
# crashed session never pins a worktree. The caller's own session never blocks, which keeps
# land.sh working from the session that owns the worktree. A check that could not RUN refuses
# too: removal is the one step here nothing can undo, and "could not look" is not "nobody is
# there" (a review of this change found two ways the check used to fail open).
LIVE_RC=0
LIVE_MSG="$(session_lock check "$TARGET_ABS" 2>&1)" || LIVE_RC=$?
if [ "$LIVE_RC" != 0 ]; then
  if [ "$LIVE_RC" = 3 ]; then
    WHY="a live agent session is working in it:"
  else
    WHY="could not check whether a live agent session is in it (session-lock exit $LIVE_RC):"
  fi
  if [ "$FORCE_LIVE" = 1 ]; then
    echo "WARNING: --force-live-session given; removing $TARGET although $WHY"
    echo "$LIVE_MSG" | sed 's/^/    /'
  else
    echo "ERROR: refusing to remove $TARGET: $WHY" >&2
    echo "$LIVE_MSG" | sed 's/^/    /' >&2
    echo "  Removing a live session's worktree empties its checkout under it, and its next git" >&2
    echo "  command runs against the primary checkout. Let that session finish or end" >&2
    echo "  it, or, if you know nobody is working there:" >&2
    echo "    bash scripts/worktree-rm.sh $TARGET_ABS --force-live-session" >&2
    exit 1
  fi
fi

# Snapshot every OTHER registered worktree before touching anything, recording for
# each one whether its directory ACTUALLY EXISTS ON DISK right now. That entry-time
# existence is the whole distinguishing signal.
#
# After the removal this script can observe that a registered path is absent. Absence
# alone cannot tell these two apart, and they are opposites:
#
#   * present at entry, gone at exit, not the argument, this removal reached a path
#     other than its argument. That is the sibling-deletion failure and it
#     must be LOUD.
#   * ALREADY gone at entry, its registration was dangling before this script ran,
#     and `git worktree prune` clearing it is prune doing exactly its job. Routine.
#
# The second case is not exotic, it is the normal weather here: a PR merges, the head
# ref disappears (the repo sets delete_branch_on_merge, or a review tool deletes the ref
# explicitly), `--stale` therefore nominates that worktree, somebody removes the
# directory, and the registration lingers until the next prune, which is any later
# removal, on any drive, by any session. This check used to report that as damage it
# had just caused, naming an incident bead and demanding the operator report their
# invocation (observed 2026-09-03 removing an unrelated worktree on another drive).
# Accusing a correct run of destroying a peer's work is how a false P1 gets filed
# (a false-alarm shape), and it trains sessions off the only sanctioned removal path
# back onto the bare `git worktree remove` that silently no-ops on Windows.
#
# NOTE this is deliberately NOT a diff of the registration LIST before and after.
# A registration vanishing is the EXPECTED outcome whenever its directory was already
# missing, so the list alone can only observe absence, it can never observe causation.
# On-disk existence captured at ENTRY is the fact that separates the two.
#
# Taken HERE, before the upstream-state warnings (which make network `gh` calls) and
# before the dev-server reap, rather than immediately before the delete: the window
# between this snapshot and the delete is time during which this run is provably doing
# something OTHER than removing directories, so a sibling that vanishes inside it is
# attributable to a concurrent process and to nothing else.
#
# PATH FORMS, and there are two of them for two different jobs.
#
# Compare EXISTENCE in normalised form: git prints Windows-style paths (C:/…) while
# norm() yields the MSYS form (/c/…), so a raw string compare never matches the target
# and the invariant would fire on the target itself. Every existence test below uses the
# SAME predicate on the SAME normalised string, an asymmetry there would reintroduce
# the bug from the other side.
#
# Compare REGISTRATIONS raw, which is why OTHERS carries both forms tab-separated.
# `norm()` falls back to its argument when the directory does not exist, so a path
# normalised while it EXISTS yields /c/… and the same path normalised once DELETED
# yields C:/…; they never compare equal. The registration check below necessarily runs
# after the delete, so it must compare the raw strings git itself emits on both sides.
# Getting that wrong silently reclassified a genuine cross-path deletion as a concurrent
# one, it turned the loud path OFF, and the sibling-deletion test caught it.
OTHERS=""        # registered AND present on disk at entry, as "<normalised>\t<raw>"
ALREADY_GONE=""  # registered but already absent at entry: prunable, never damage
while read -r p; do
  [ -n "$p" ] || continue
  pn="$(norm "$p")"
  [ "$pn" = "$TARGET_ABS" ] && continue
  if [ -e "$pn" ]; then
    OTHERS="$OTHERS$pn"$'\t'"$p"$'\n'
  else
    ALREADY_GONE="$ALREADY_GONE$pn"$'\n'
  fi
done < <(git -C "$PRIMARY" worktree list --porcelain | awk '/^worktree /{print $2}')

# Uncommitted changes are the ONE thing removal destroys unrecoverably: they were never
# git objects, so no ref, reflog or remote can bring them back. Commits, pushed or not,
# survive, because the branch ref is deliberately left behind.
#
# This used to print a warning and delete anyway. The docs said to "heed the unpushed-work
# warning", but the warning and the deletion were emitted in the same non-interactive run,
# so by the time anyone could read it the directory was gone; a human at a TTY had no
# opening either. It destroyed three files of another session's work on 2026-09-01.
# A warning nobody can act on is not a guard.
if [ -n "$(git -C "$TARGET_ABS" status --porcelain 2>/dev/null)" ]; then
  echo "WARNING: $TARGET has UNCOMMITTED changes:"
  git -C "$TARGET_ABS" status --short | sed 's/^/    /'
  if [ "$FORCE" != "1" ]; then
    echo "ERROR: refusing to remove $TARGET: the changes above are NOT recoverable." >&2
    echo "  They exist only in the working tree: no commit, no reflog, no remote." >&2
    echo "  Commit or copy them out first, or re-run with --force to discard them:" >&2
    echo "    bash scripts/worktree-rm.sh $TARGET_ABS --force" >&2
    exit 1
  fi
  if [ "$DRY_RUN" = "1" ]; then
    echo "  --force given: would discard the changes above (--dry-run: nothing removed)."
  else
    echo "  --force given: discarding the changes above."
  fi
fi
BR="$(git -C "$TARGET_ABS" rev-parse --abbrev-ref HEAD 2>/dev/null || echo '')"
if [ -n "$BR" ] && [ "$BR" != "HEAD" ]; then
  case "$(upstream_state "$TARGET_ABS" "$BR")" in
    never-pushed)
      echo "WARNING: branch '$BR' has never been pushed: its commits exist ONLY here." ;;
    unpushed)
      echo "WARNING: branch '$BR' has commits not on origin:"
      git -C "$TARGET_ABS" log --oneline "origin/$BR..$BR" | sed 's/^/    /' ;;
    pushed-not-merged)
      # Pushed, so the commits survive on origin/<branch> and this is not data loss -
      # but the work has NOT landed, which usually means a PR is still open and someone
      # may still be using this directory. Say so rather than stay silent.
      echo "WARNING: branch '$BR' is pushed but has NOT landed on origin/main." ;;
    upstream) : ;; # landed: nothing to lose
    *)
      # An unrecognised classification must never read as "nothing to lose". A new state
      # added above without an arm here would otherwise fall through to silence, which is
      # exactly how a fail-open default hides.
      echo "WARNING: branch '$BR' has an unrecognised upstream state: assuming NOT landed." ;;
  esac
fi

# `--dry-run` exits HERE, after every guard above has run (glob, exists, primary-checkout,
# inside-cwd, not-a-worktree, and the uncommitted-changes refusal just above, which still
# exits 1 on a dirty target with no --force, exactly as a real run would) and before the
# first command that touches disk or the worktree registry. Nothing below this line may
# run under --dry-run.
if [ "$DRY_RUN" = "1" ]; then
  echo "DRY RUN: would remove worktree $TARGET_ABS (branch: ${BR:-<none>}). Nothing was removed."
  exit 0
fi

# Stop/collect any dev server this worktree registered, before the path disappears.
bash "$SCRIPT_DIR/worktree-dev.sh" reap >/dev/null 2>&1 || true

# Re-read the entry snapshot immediately before the delete.
#
# Two concurrent `worktree-rm.sh` runs is the normal mode here, not an edge case:
# post-merge cleanup is exactly what several sessions do at the same moment without
# coordinating, and each removal is ~0.7 GB of node_modules, so the overlap window is
# wide. A peer that legitimately removes ITS OWN argument during this run leaves a
# sibling that was present at entry and absent at exit, byte-identical to the
# sibling-deletion evidence, under the loudest message this script has.
#
# So split the entry snapshot at the moment the delete begins. Anything that vanished
# BEFORE the first destructive command cannot have been vanished by it: this run was
# classifying a branch and reaping a dev server, not deleting directories. That half is
# reported as concurrent cleanup and never as damage. The remaining half is the only
# set the invariant below may accuse, and it is still checked the same way.
PRE_RM=""           # present at entry AND still present when the delete starts
VANISHED_BEFORE=""  # present at entry, gone before this run deleted anything
while IFS=$'\t' read -r pn praw; do
  [ -n "$pn" ] || continue
  if [ -e "$pn" ]; then
    PRE_RM="$PRE_RM$pn"$'\t'"$praw"$'\n'
  else
    VANISHED_BEFORE="$VANISHED_BEFORE    $pn"$'\n'
  fi
done <<<"$OTHERS"

# Every command from here on uses -C "$PRIMARY" / absolute paths and never relies
# on the process cwd: the cwd may be INSIDE a sibling worktree, and once anything
# is deleted a relative resolution is the first thing to go wrong.
cd "$PRIMARY"

echo "Removing worktree $TARGET_ABS…"
if git -C "$PRIMARY" worktree remove --force "$TARGET_ABS" 2>/dev/null && [ ! -e "$TARGET_ABS" ]; then
  echo "Removed."
else
  # The Windows MAX_PATH path: git reports success but leaves the tree behind.
  echo "  git worktree remove did not clear it (Windows long paths): falling back to rm -rf…"
  # `|| true`: under `set -e` a failing rm used to END the script here, after
  # `git worktree remove` had already deregistered the tree, leaving a directory that no later
  # run would touch ("not a registered git worktree"). The check below decides instead.
  rm -rf -- "$TARGET_ABS" || true
  if [ -e "$TARGET_ABS" ] && command -v powershell.exe >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    # MSYS rm cannot reach a node_modules path past MAX_PATH ("Is a directory", "File too
    # large"). PowerShell can, through the \\?\ prefix. The path rides an environment
    # variable so no quoting layer can mangle it.
    echo "  rm -rf could not clear it either (paths past MAX_PATH): retrying through PowerShell…"
    WORKTREE_RM_WIN_TARGET="$(cygpath -w "$TARGET_ABS")" powershell.exe -NoProfile -NonInteractive -Command \
      'Remove-Item -LiteralPath ("\\?\" + $env:WORKTREE_RM_WIN_TARGET) -Recurse -Force' || true
  fi
  if [ -e "$TARGET_ABS" ]; then
    # `git worktree remove` has usually deregistered it by now, so a re-run refuses it ("not a
    # registered git worktree") and `--stale` never lists it: an orphan nothing looks at again
    # Usually another process's cwd is in it (the session that made it, a dev
    # server). Record it so a periodic sweep (a consumer-owned job that reads this file) can
    # finish the delete.
    PENDING="$(git -C "$PRIMARY" rev-parse --path-format=absolute --git-common-dir)/worktree-pending-delete.txt"
    printf '%s\t%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$TARGET_ABS" >> "$PENDING" || true
    echo "ERROR: could not delete $TARGET_ABS. Something still holds it open (a session or dev server in it)." >&2
    echo "  Recorded in $PENDING for a periodic worktree sweep to retry. Or, once whatever holds it" >&2
    echo "  has exited, remove it by hand, then: git worktree prune" >&2
    exit 1
  fi
  echo "Removed (rm -rf + git worktree prune)."
fi

# The registration list AS IT STANDS after the delete and BEFORE this run prunes
# anything. This is the fact that separates a peer's removal from this
# run's own overreach, and it is only available in this one-command window.
#
# Neither destructive step above can deregister a SIBLING: `git worktree remove` clears
# the registration of its argument and nothing else, and `rm -rf` clears no registration
# at all. So a sibling whose directory is gone AND whose registration is ALREADY gone
# here was deregistered by another process, a peer `worktree-rm.sh`, or a bare
# `git worktree remove`. The sibling-deletion failure leaves the opposite fingerprint: the
# directory is gone because this run's `rm -rf` reached it, while its registration is
# untouched and survives until the prune on the next line.
#
# Kept RAW, deliberately un-normalised: every path in it has just been deleted, and
# `norm()` on a missing directory returns its argument unchanged, so normalising here
# would produce git's Windows form while the entry snapshot holds the MSYS form, and
# nothing would ever match. Compared against the raw half of PRE_RM, which is the same
# string from the same `git worktree list`.
REG_BEFORE_PRUNE=""
while read -r p; do
  [ -n "$p" ] || continue
  REG_BEFORE_PRUNE="$REG_BEFORE_PRUNE$p"$'\n'
done < <(git -C "$PRIMARY" worktree list --porcelain | awk '/^worktree /{print $2}')

# Prune on BOTH paths, not only the rm -rf fallback. `git worktree remove` clears the
# argument's own registration and nothing else, so a registration left dangling by an
# EARLIER removal survives it untouched. Pruning here is idempotent, prune deletes a
# registration precisely BECAUSE its directory is already gone, and it is what makes
# the "already gone" report below a statement of what happened rather than a guess.
git -C "$PRIMARY" worktree prune

# Invariant: nothing that existed on disk when the DELETE STARTED, other than the
# argument, is gone. Registrations that were already dangling when this run started are
# excluded by construction (they are in ALREADY_GONE), so a routine prune can no longer
# be reported as a sibling deletion; siblings that vanished before the
# delete are excluded too (VANISHED_BEFORE).
#
# What remains is split once more by the registration fingerprint captured above:
#
#   * still registered when the delete finished, nothing but this run's own `rm -rf`
#     removes a directory while leaving its registration standing. That is the sibling-deletion failure
#     and it stays as loud as it has ever been.
#   * already deregistered, a peer process removed it deliberately. Concurrent
#     cleanup, reported as such and not as an incident.
#
# The distinction is deliberately drawn on what THIS run can and cannot do, not on
# plausibility: a false positive here is byte-indistinguishable from the real incident,
# and a warning that fires on correct runs is a warning that gets discounted, which
# would cost exactly the one message that must never be discounted.
MISSING=""
CONCURRENT=""
while IFS=$'\t' read -r pn praw; do
  [ -n "$pn" ] || continue
  [ -e "$pn" ] && continue
  # Counted with `grep -cxF`, never `grep -q`: an early exit gives printf SIGPIPE,
  # pipefail reports 141, and under `set -e` that kills the script, the hazard the
  # `git cherry` call above already documents.
  n="$(printf '%s\n' "$REG_BEFORE_PRUNE" | grep -cxF "$praw" || true)"
  if [ "${n:-0}" -gt 0 ] 2>/dev/null; then
    MISSING="$MISSING  $pn"$'\n'
  else
    CONCURRENT="$CONCURRENT    $pn"$'\n'
  fi
done <<<"$PRE_RM"

# Concurrent cleanup first, so the loud block below stays the last word when both fire.
if [ -n "$VANISHED_BEFORE" ] || [ -n "$CONCURRENT" ]; then
  echo "  note: worktree(s) present at entry are gone, and this run did not remove them:"
  [ -n "$VANISHED_BEFORE" ] && printf '%s' "$VANISHED_BEFORE"
  [ -n "$CONCURRENT" ] && printf '%s' "$CONCURRENT"
  echo "  Another process removed them while this one was working: either before this"
  echo "  removal began, or leaving no registration for the prune to clear, which only a"
  echo "  deliberate deregistration does. Concurrent cleanup is routine here: several"
  echo "  sessions share this machine and post-merge cleanup is unsynchronised."
  echo "  Nothing to do unless you know no peer was cleaning up: then say so, and"
  echo "  include the command you ran."
fi

if [ -n "$MISSING" ]; then
  echo "ERROR: a worktree OTHER than the argument is now missing from disk:" >&2
  printf '%s' "$MISSING" >&2
  echo "  Each path above existed on disk when this removal STARTED DELETING, and was" >&2
  echo "  still registered when it finished: so this removal reached a path other than" >&2
  echo "  its argument. A concurrent cleanup would have cleared the registration too." >&2
  echo "  This is the sibling-deletion failure." >&2
  echo "  Its branch is untouched; restore with git worktree add <path> <branch>." >&2
  echo "  Please report the exact invocation." >&2
  exit 2
fi

# Registrations whose directories were ALREADY gone before this script touched
# anything. Clearing them is the correct outcome and gets one informational line -
# no error, no incident bead, no request to report the invocation.
if [ -n "$ALREADY_GONE" ]; then
  # Registration list AFTER the prune, so this reports what actually happened rather
  # than assuming the prune took. A LOCKED worktree is deliberately not prunable, and
  # would otherwise be reported as pruned when it is still registered.
  STILL_REGISTERED=""
  while read -r p; do
    [ -n "$p" ] || continue
    STILL_REGISTERED="$STILL_REGISTERED$(norm "$p")"$'\n'
  done < <(git -C "$PRIMARY" worktree list --porcelain | awk '/^worktree /{print $2}')

  PRUNED=""; PRUNED_N=0
  KEPT=""; KEPT_N=0
  while read -r p; do
    [ -n "$p" ] || continue
    # Counted with `grep -cxF`, never `grep -q`: an early exit gives printf SIGPIPE,
    # pipefail reports 141, and under `set -e` that kills the script, the hazard the
    # `git cherry` and `pr_merged` calls above already document.
    n="$(printf '%s\n' "$STILL_REGISTERED" | grep -cxF "$p" || true)"
    if [ "${n:-0}" -gt 0 ] 2>/dev/null; then
      KEPT="$KEPT    $p"$'\n'; KEPT_N=$((KEPT_N + 1))
    else
      PRUNED="$PRUNED    $p"$'\n'; PRUNED_N=$((PRUNED_N + 1))
    fi
  done <<<"$ALREADY_GONE"

  if [ "$PRUNED_N" -gt 0 ]; then
    echo "  also pruned $PRUNED_N stale registration(s) whose directories were already gone:"
    printf '%s' "$PRUNED"
    echo "  (absent before this run started: routine cleanup, not caused by this removal.)"
  fi
  if [ "$KEPT_N" -gt 0 ]; then
    echo "  note: $KEPT_N registration(s) point at a directory that was already gone and"
    echo "  survived the prune (a LOCKED worktree does):"
    printf '%s' "$KEPT"
  fi
fi

echo "The branch itself is untouched: delete it separately if the PR is merged:"
echo "  git branch -D ${BR:-<branch>}   &&   git push origin --delete ${BR:-<branch>}"
