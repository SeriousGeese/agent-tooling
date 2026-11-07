#!/usr/bin/env bash
# worktree-new.sh, create a dedicated worktree the way a multi-agent repository needs, in one step.
#
# Replaces a four-step ritual that agents had to remember in the right order, and that
# went wrong in practice:
#
#   1. `git worktree add` WITHOUT -q floods ~100 lines of "Updating files: N%" into the
#      transcript, once per worktree. Pure noise; -q removes it.
#   2. The isolation check (toplevel == the path you asked for) is easy to skip, and a
#      worktree that isn't dedicated is how concurrent sessions corrupt each other's
#      state ("valid" is not "dedicated").
#   3. The branch must be PUBLISHED IMMEDIATELY, not at first commit. Deferring it leaves
#      a window where an issue is claimed in the tracker while `git branch -r` and
#      `gh pr list` look empty, which reads to another agent as abandoned work. A
#      re-claim landed 17 minutes into another session's work that way (2026-08-22). It
#      was a documented rule; a rule you must remember is weaker than a script that just
#      does it.
#   4. The dependency install is needed per worktree (never a symlinked node_modules: a
#      linked tree makes bundlers fail and fabricates unrelated test failures). It is
#      slow, so it runs in the BACKGROUND: the agent reads its task while it installs
#      instead of blocking, and an orchestrator's fan-out gets its installs in parallel
#      rather than serialized inside each subagent's turn.
#
# Usage:
#   scripts/worktree-new.sh <slug> <branch> [--base <ref>] [--wait] [--no-install]
#
#   <slug>    directory name suffix; the directory is <worktreeRoot>/<name> where the name
#             comes from `worktreeNamePattern` (default <repo>-<slug>, <repo> being the
#             PRIMARY checkout's directory name) and the root from AGENT_TOOLING_WORKTREE_ROOT,
#             else `worktreeRoot` in agent-tooling.json (default: the PRIMARY checkout's parent)
#   <branch>  branch to create (must not already exist)
#   --base    branch off this ref (default: origin/main, fetched first)
#             WARNING: a non-main base creates a STACKED PR, which a repository that merges
#             by deleting the head branch cannot support: when that base merges it is
#             deleted and GitHub CLOSES your PR instead of retargeting it. It also SKIPS
#             the fetch below, so you branch off whatever stale local ref you have.
#   --wait    block until the install finishes instead of backgrounding it
#   --no-install  skip dependency install entirely
#
# Env:
#   AGENT_TOOLING_WORKTREE_ROOT   directory bare slugs resolve under. Unset = the configured
#             `worktreeRoot`, by default a sibling of the primary checkout. Set it to place a
#             whole fan-out on another disk with ONE setting instead of a per-call full path:
#             each worktree is hundreds of MB, and on 2026-09-02 a C: drive at 2.2 GB free
#             killed a worker's build with ENOSPC and corrupted a jest transform cache into
#             four bogus suite failures. Use the POSIX form on Windows, /d/Worktrees, never
#             D:/Worktrees: MSYS rewrites arguments that mix a colon with slashes.
#             A full path as the slug still overrides it, per-call.
#   AGENT_TOOLING_WORKTREE_NO_LOCK=1  skip the creation mutex (see the lock block below)
#   AGENT_TOOLING_AWAIT_CREATION_DEADLINE_SECONDS  how long `--await` waits out an IN-PROGRESS
#             `git worktree add` (the checkout itself, not the install that follows it)
#             before giving up. Default 600s, matching an agent harness's usual
#             no-progress watchdog. See the creation marker below.
#
# Consumer hint file (optional): scripts/worktree-new.hint.sh, sourced when it exists (or the
# file named by WORKTREE_NEW_HINT_FILE). It is consumer-owned and never synced. Variables:
#   WORKTREE_NEW_NATIVE_PREBUILDS  space-separated packages that ship a prebuilt native binding
#             (prebuilds/<platform>-<arch>.node) or compile one (build/Release/*.node). A tree
#             is judged usable only if each has one, and their install scripts are not rebuilt.
#             Default: none.
#   WORKTREE_NEW_REQUIRED_PACKAGES  space-separated packages that must be present under
#             node_modules. Default: every dependency and devDependency in package.json.
#   WORKTREE_NEW_BROWSER_CHECK     auto (default: only when package.json declares Playwright),
#             1 (always), 0 (never): whether --await asserts Playwright's pinned browsers.
#   WORKTREE_NEW_BROWSERS          browsers the project runs (default: chromium).
#
#   scripts/worktree-new.sh --install <path>    provision an EXISTING worktree
#   scripts/worktree-new.sh --await <slug|path>  block until an install finishes
#
# --install is for worktrees this script did not create: an agent harness may make a
# worktree itself and provision nothing, so every such session used to hand-run the
# install before its first gate. It runs the SAME install block as creation, so --await
# works against those worktrees unchanged.
#
# --await exit codes, one code per verdict, because they are not the
# same news and the caller has to act differently on each:
#   0   dependencies are ready; run your gates
#   1   dependencies are NOT ready, run no gate until it is fixed (the message
#       names what is missing and the command that fixes it)
#   3   dependencies ARE ready; only Playwright's pinned browsers are absent, so
#       the e2e suite is unavailable and EVERY OTHER GATE IS FINE. A task that
#       does not run Playwright should carry on. It is still a non-zero exit, so a
#       `set -e` caller still stops and an e2e task cannot sail past it.
#   Read the message either way, the tree is the verdict, never the exit code.
#   This split makes 1 mean one thing; it does not promote the status to ground truth.
#
# `--await` also waits out an in-progress CREATION, not just an in-progress install.
# An orchestrator whose `worktree-new.sh <slug> <branch>` call ran past its shell tool's
# own timeout and got moved to the background, while `git worktree add` was still checking
# out, saw the worktree already listed by `git worktree list` (git adds the admin entry
# and starts checking out before the command returns) and launched a worker against it.
# That worker's `--await` found no `.npm-install.pid` (creation had not reached that far)
# and no lockfile either, read that as "created with --no-install", and exited 0 over an
# EMPTY index. `--await` now waits, bounded, on a creation marker this
# script writes before `git worktree add` and removes only after its own empty-index
# assertion passes, plus git's own transient `locked` file if the checkout is still
# holding one, then asserts the index is non-empty itself before trusting anything
# else. Same exit-code contract: this is part of what "1" already covers.
#
# Teardown is the configured `rm` command (worktreeScripts.rm), do not `rm -rf` a worktree by hand.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Every git this script runs, and every git THEY spawn (the `git reset --hard` under `git
# worktree add` is the one that hangs), runs with core.fsmonitor=false. See
# the header of the sourced file for the incident and why it is an env override, not config.
# shellcheck source=lib/git-no-fsmonitor.sh
source "$SCRIPT_DIR/lib/git-no-fsmonitor.sh"
git_disable_fsmonitor
# The repository's own names (package manager, worktree root and naming, hint commands).
# shellcheck source=lib/agent-config.sh
source "$SCRIPT_DIR/lib/agent-config.sh"
agent_config_load
# The await and install commands this script prints must work when pasted from ANY directory
# (an agent is often inside the worktree by then), so unless the repository configured its own
# wrapper they name this script by absolute path.
if [ "$AGENT_CFG_CMD_AWAIT" = "bash scripts/worktree-new.sh --await <path>" ]; then
  AGENT_CFG_CMD_AWAIT="bash \"$SCRIPT_DIR/worktree-new.sh\" --await <path>"
fi
if [ "$AGENT_CFG_CMD_INSTALL" = "bash scripts/worktree-new.sh --install <path>" ]; then
  AGENT_CFG_CMD_INSTALL="bash \"$SCRIPT_DIR/worktree-new.sh\" --install <path>"
fi
# No `exit` in the awk body: an early exit closes
# the pipe, git dies of SIGPIPE, and pipefail makes that a fatal 141 on any machine with
# enough worktrees for git to still be writing.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{if(!seen){print $2; seen=1}}')"

# Consumer hint (see the header). Defaults first, so the hint only has to name what differs.
WORKTREE_NEW_NATIVE_PREBUILDS=""
WORKTREE_NEW_REQUIRED_PACKAGES=""
WORKTREE_NEW_BROWSER_CHECK="auto"
WORKTREE_NEW_BROWSERS="chromium"
WORKTREE_NEW_HINT_FILE="${WORKTREE_NEW_HINT_FILE:-$SCRIPT_DIR/worktree-new.hint.sh}"
if [ -f "$WORKTREE_NEW_HINT_FILE" ]; then
  # shellcheck source=/dev/null
  source "$WORKTREE_NEW_HINT_FILE"
fi

# Written into node_modules after every successful install (all managers; only bun reads it). bun
# leaves no record file of its own, and node_modules' directory mtime moves with any file written
# under it, so it cannot say "installed after this lockfile". The stamp can.
INSTALL_STAMP=".agent-tooling-install-stamp"

# The package manager's own names. Only npm leaves the record (node_modules/.package-lock.json)
# and the lockfile shape the version-drift check reads, so that one check is npm-only; every
# other check is manager-neutral. (bun's record is the install stamp above, not its own file.)
case "$AGENT_CFG_PACKAGE_MANAGER" in
  npm)  PM_LOCKFILE="package-lock.json"; PM_RECORD="node_modules/.package-lock.json"; PM_LABEL="npm ci" ;;
  pnpm) PM_LOCKFILE="pnpm-lock.yaml";    PM_RECORD="node_modules/.modules.yaml";      PM_LABEL="pnpm install" ;;
  yarn) PM_LOCKFILE="yarn.lock";         PM_RECORD="node_modules/.yarn-integrity";    PM_LABEL="yarn install" ;;
  bun)  PM_LOCKFILE="bun.lock";          PM_RECORD="node_modules/$INSTALL_STAMP";     PM_LABEL="bun install" ;;
  *)    echo "ERROR: unsupported packageManager '$AGENT_CFG_PACKAGE_MANAGER'." >&2; exit 1 ;;
esac
PM="$AGENT_CFG_PACKAGE_MANAGER"

# The lockfile this tree carries: bun writes bun.lockb in older versions.
pm_lockfile_in() {
  if [ "$PM" = "bun" ] && [ ! -f "$1/bun.lock" ] && [ -f "$1/bun.lockb" ]; then
    printf 'bun.lockb'
  else
    printf '%s' "$PM_LOCKFILE"
  fi
}

# Frozen install. npm skips scripts (see the --ignore-scripts block below), then runs the
# targeted rebuild and the root package's own postinstall. The other managers run their install
# scripts normally: only npm has a by-name rebuild to put skipped scripts back, so skipping them
# elsewhere would leave a tree reported ready that was never built. Run inside the worktree.
pm_install() {
  case "$PM" in
    npm)  npm ci --prefer-offline --ignore-scripts ;;
    pnpm) pnpm install --frozen-lockfile --prefer-offline ;;
    yarn) yarn install --frozen-lockfile ;;
    bun)  bun install --frozen-lockfile ;;
  esac
}
# Only npm has a targeted rebuild: rebuildable_packages names nothing for any other manager, so
# this is never reached for them (their install scripts already ran).
pm_rebuild() { npm rebuild "$@"; }

# What is still npm-only, said once per install, because the support is thinner than the table
# above suggests. The other managers run their own install scripts normally (no --ignore-scripts),
# so a package that compiles on install is built. What they do NOT get:
#   - the targeted prebuild skip: WORKTREE_NEW_NATIVE_PREBUILDS packages are not exempted from
#     their install script, and the by-name rebuild list is npm's (lockfile-derived);
#   - the lockfile-vs-installed version-drift check (it reads npm's own record);
#   - a staleness check that compares the lockfile's mtime with a record file (for bun that record
#     is the install stamp this script writes, not a file bun maintains);
#   - yarn means yarn classic: yarn berry rejects --frozen-lockfile.
degraded_pm_notice() {
  [ "$PM" = "npm" ] && return 0
  echo "WARNING: packageManager '$PM' is only partly supported: dependencies are installed with the manager's own install scripts, but there is no targeted prebuild skip and no version-drift check, and the staleness check is weaker. npm is the fully supported manager." >&2
}
pm_run_script() { "$PM" run "$1"; }

SLUG="" BRANCH="" BASE="origin/main" WAIT=0 INSTALL=1 AWAIT=0 PROVISION=0 RUN_INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --base) BASE="${2:-}"; shift 2 ;;
    --wait) WAIT=1; shift ;;
    --await) AWAIT=1; shift ;;
    --install) PROVISION=1; shift ;;
    --run-install) RUN_INSTALL=1; shift ;;
    --no-install) INSTALL=0; shift ;;
    # The whole leading comment block from "Usage:" on, through the --await exit-code table:
    # it is the first thing a caller that just got a non-zero from the mandatory pre-gate
    # step needs. Selected by content, not by line range, so it cannot silently drift off the
    # end as the header grows; worktree-new-await.node-test.mjs asserts it still prints the table.
    -h|--help) awk '/^# Usage:/{on=1} on && /^set -euo pipefail/{exit} on{sub(/^# ?/, ""); print}' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [ -z "$SLUG" ]; then SLUG="$1"
      elif [ -z "$BRANCH" ]; then BRANCH="$1"
      else echo "Unexpected argument: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

# `<base>/<rel>` with `.` and `..` segments folded in, textually: the root need not exist yet
# (a first use of a fresh root is the normal case), so `cd` cannot do this.
normalize_join() {
  local out="$1" seg
  local -a segs
  IFS=/ read -r -a segs <<<"$2"
  for seg in "${segs[@]}"; do
    case "$seg" in
      ''|.) ;;
      ..) out="${out%/*}"; [ -n "$out" ] || out="/" ;;
      *) out="${out%/}/$seg" ;;
    esac
  done
  printf '%s' "$out"
}

# Where a bare slug lands: by default a sibling of the PRIMARY checkout, never under an
# agent harness's own worktree directory: that directory is shared by every concurrent
# session, and a stray glob there has destroyed other sessions' worktrees before.
#
# AGENT_TOOLING_WORKTREE_ROOT exists because the drive was not selectable per WAVE, only per
# CALL. Harness-created SESSION worktrees follow the harness's worktree-location setting,
# but an orchestrator's FAN-OUT worktrees, the hundreds-of-MB-each ones
# that actually consume the disk, resolved as a sibling of the primary checkout and
# so ignored it. Measured 2026-09-02: C: 238 GB total / 7.6 GB free, D: 932 GB / 654
# GB free; C: at 2.2 GB free killed a worker's build with ENOSPC and corrupted a jest
# transform cache into four bogus suite failures. The configured `worktreeRoot` gives a
# repository the same choice without an environment variable; the variable wins.
#
# "Path or slug?", anything with a separator is a path. Backslash separators
# count too and are normalized to forward slashes: interactive callers pass
# forward-slash paths on a Windows host, but a script that
# builds the argument with Node's path.join() on win32 hands over backslashes,
# and treating that as a SLUG silently resolved it to a nonsense sibling
# directory instead of erroring. Slugs never contain either separator.
worktree_root() {
  if [ -n "${AGENT_TOOLING_WORKTREE_ROOT:-}" ]; then
    printf '%s' "$AGENT_TOOLING_WORKTREE_ROOT"
    return
  fi
  case "$AGENT_CFG_WORKTREE_ROOT" in
    /*|[A-Za-z]:*) printf '%s' "$AGENT_CFG_WORKTREE_ROOT" ;;
    *) normalize_join "$PRIMARY" "$AGENT_CFG_WORKTREE_ROOT" ;;
  esac
}

resolve_dest() {
  case "$1" in
    *\\*) printf '%s' "$1" | tr '\\' '/' ;;
    */*) printf '%s' "$1" ;;
    *) printf '%s/%s' "$(worktree_root)" "$(agent_fill "$AGENT_CFG_WORKTREE_NAME_PATTERN" "slug=$1" "repo=$(basename "$PRIMARY")")" ;;
  esac
}

# A frozen install of the lockfile, not a symlink to the primary's node_modules: a linked
# node_modules breaks bundlers and fabricates dozens of unrelated test failures.
# --prefer-offline uses the already-warm package cache, which is most of the wall-clock.
# Backgrounded by default so the agent can read its task while hundreds of MB install, and so
# an orchestrator's fan-out gets its installs in parallel rather than serialized inside each
# subagent's turn.

# --- the shared .git/config is a contention point --------------
#
# Every worktree of a repo shares ONE .git/config, and git guards each write to
# it with a create-exclusive .git/config.lock. Git does NOT retry that lock. So
# concurrent callers collide, and an orchestrator that creates a WHOLE wave of
# worktrees up front (so the dependency installs overlap) makes the happy path the
# thing that triggers it.
# Measured on 2026-09-01 with 8 concurrent invocations: 7 of 8 died.
#
# There are two distinct config writes here and they fail in OPPOSITE ways:
#
#   `git worktree add -b <b> origin/main`  implies --track, so it writes
#       branch.<b>.remote/.merge. Losing the lock is FATAL: git exits nonzero
#       AFTER creating the branch ref, so set -e killed the script leaving a
#       branch with no worktree, half-provisioned state that neither the
#       toplevel check nor `git worktree list` reveals.
#
#   `git push -u`                          writes the same two keys, and losing
#       the lock there is SILENT: git prints the error, publishes the branch,
#       and still EXITS 0. Measured 6 of 8 in the same run. The script then
#       reported "(published)" and success while the branch carried no
#       upstream at all, invisible until someone runs `git pull` inside the
#       worktree and gets "no tracking information".
#
# Fix: don't make the fatal write at all (--no-track below, tracking origin/main
# from a feature branch was wrong anyway; the hint git prints on failure literally
# suggests the bogus `origin/refs/heads/main`), then set the upstream from the
# push and VERIFY it, retrying the config write on the lock error. Retry rather
# than a lock of our own: the racer is often not this script (a subagent's
# `git push -u`, claim.sh), so only retry is actually protective.
# How long to wait out a contended write. This is a wall-clock DEADLINE, not an
# attempt count, and that distinction matters.
#
# The previous budget was 10 attempts 0.1-0.4s apart. Measured 2026-09-02 by
# holding .git/config.lock exactly the way git does and varying the hold: it
# survived 4000ms and gave up at ~4700ms. Four seconds is the entire margin, and
# it is not proportionate to where this script runs. Racing 8 creations, the N
# the concurrency test uses and a plausible wave size for an orchestrator, takes
# ~2.5s on an idle box and 27s-to-20min on a saturated one (a self-hosted CI fleet
# of several runner pools on one box sees per-job latency rise 2.3x from ~5
# concurrent jobs). Losing that race is how a CI run failed this script's
# concurrency test on a change that touched nothing under scripts/.
#
# What we are waiting out is another process's config write: a millisecond of
# real work that a loaded box can schedule arbitrarily late. So budget the
# WAITING, not the tries. 60s keeps roughly the old margin under the ~10x stretch
# measured above and costs exactly nothing when uncontended, the first attempt
# wins and no sleep happens at all. The only run that pays it is one that would
# otherwise hand back a broken worktree.
#
# What this is NOT: a lost-update window that no budget could close. Probed with
# a config.lock flapping 3ms-on/1ms-off across a whole run, 15/15 runs still came
# out with both tracking keys, git's writes are properly lock-guarded and the
# retried command is idempotent, so the retry really does close the race. The
# budget was simply too small.
CONFIG_RETRY_SECONDS="${WORKTREE_NEW_CONFIG_RETRY_SECONDS:-60}"

# The three classifiers below match with `case`, not `printf | grep -q`. Same
# semantics, one less subshell and fork per call, a tidy-up, NOT a bug fix, and the
# distinction is worth writing down because the first draft of this comment claimed
# otherwise and was wrong.
#
# The SIGPIPE + `set -o pipefail` false negative (documented in the worktree teardown
# script, in its `git cherry` note) is real, and it is genuinely nasty: `grep -q` leaves on the
# first match, the writer dies of SIGPIPE, pipefail reports 141, and a MATCH is
# reported as NO-match. In a retry classifier that inverts to "not retryable", the
# one answer that turns a transient race into a hard failure.
#
# But it needs an EXTERNAL writer. Measured on this box 2026-09-03, under
# `set -euo pipefail`:
#   yes 'bad object' | head -c 5M | grep -q 'bad object'   -> rc 141, FALSE NEGATIVE
#   printf '%s' "<300KB>"         | grep -q 'aaa'          -> rc 0,   correct
# bash's `printf` BUILTIN absorbs EPIPE instead of dying, so the `printf | grep -q`
# form these three classifiers used was never exposed to it. `git cherry | grep -c`
# in the teardown script is, and that guard stays.
#
# Which means this rewrite does NOT explain the symptom it was reached for: a CI run
# bailing in ~150ms against a 600s retry budget, implying
# transient_git_error returned false on a string that plainly matches. That remains
# UNEXPLAINED; 200 local iterations reproduced no misclassification. The creation
# mutex below is what actually fixes the flake, by removing the race rather than
# classifying it better. Do not read this block as the root cause having been found.
#
# Git's lock-contention message above ("could not lock config file …:
# File exists") is what TWO WRITERS colliding on .git/config produces. There is a
# second, differently-worded shape for a WRITER-vs-READER collision: while one
# process is mid-rename of its config.lock onto .git/config (the atomic publish of
# a write already in flight, the creation mutex has nothing left to serialize once
# a sibling is past it and into `git push -u`), any OTHER git invocation that merely
# READS config right then can lose to Windows' own file-sharing rules rather than
# git's advisory lock, and reports it as a permissions failure instead of contention:
#
#   warning: unable to access '.git/config': Permission denied
#   fatal: unknown error occurred while reading the configuration files
#
# Reproduced directly against this script (not a synthetic shim) racing 8 real
# concurrent invocations on Windows: one run's `git worktree add` failed this way
# while an already-published sibling was mid `push -u`, and on another pass the same
# shape hit `git fetch origin main` instead, both READ config as an incidental part
# of an unrelated command, with no writer of their own. POSIX has no analogous
# failure (a reader is never denied by a concurrent renamer), which is why this
# needed a Windows box to find. Retryable for the same reason the lock message is:
# the writer holding the file finishes in milliseconds.
config_lock_error() {
  case "$1" in
    *'could not lock config file'*) return 0 ;;
    *'unable to access'*'Permission denied'*) return 0 ;;
    *'unknown error occurred while reading the configuration files'*) return 0 ;;
  esac
  return 1
}

# Capped exponential backoff with full jitter, in deciseconds: attempt 1 sleeps
# 0.1-0.2s, attempt 3 0.1-0.8s, attempt 5+ 0.1-2.0s. Exponential so a wave of
# racers spreads out instead of re-colliding at a fixed cadence; jittered so they
# never step in lockstep; capped at 2s so a 60s deadline still buys ~50 attempts
# rather than three long ones.
retry_backoff_sleep() {
  local attempt="$1" max_ds ds
  if [ "$attempt" -ge 5 ]; then max_ds=20; else max_ds=$(( 1 << attempt )); fi
  ds=$(( (RANDOM % max_ds) + 1 ))
  sleep "$(( ds / 10 )).$(( ds % 10 ))"
}

# Run "$@", retrying while it fails with git's config-lock error, until the
# deadline above elapses.
retry_config_write() {
  local attempt=1 err rc started=$SECONDS
  while :; do
    if err="$("$@" 2>&1 >/dev/null)"; then rc=0; else rc=$?; fi
    if [ "$rc" -eq 0 ]; then
      [ -n "$err" ] && printf '%s\n' "$err" >&2
      return 0
    fi
    if [ $(( SECONDS - started )) -ge "$CONFIG_RETRY_SECONDS" ] || ! config_lock_error "$err"; then
      printf '%s\n' "$err" >&2
      return "$rc"
    fi
    retry_backoff_sleep "$attempt"
    attempt=$(( attempt + 1 ))
  done
}

# Post-creation isolation reads race with siblings publishing their config too.
# Preserve stdout separately: mixing a warning into the toplevel would fail the
# isolation comparison. Retry only the same bounded config-sharing errors as
# writes; missing config values and genuine repository failures retain their exit.
retry_config_read() {
  local attempt=1 output err rc started=$SECONDS err_file
  err_file="$(mktemp)" || return 1
  while :; do
    rc=0
    output="$("$@" 2>"$err_file")" || rc=$?
    err="$(cat "$err_file")"
    if [ "$rc" -eq 0 ]; then
      rm -f "$err_file"
      [ -n "$err" ] && printf '%s\n' "$err" >&2
      printf '%s' "$output"
      return 0
    fi
    if [ $(( SECONDS - started )) -ge "$CONFIG_RETRY_SECONDS" ] || ! config_lock_error "$err"; then
      rm -f "$err_file"
      [ -n "$err" ] && printf '%s\n' "$err" >&2
      return "$rc"
    fi
    retry_backoff_sleep "$attempt"
    attempt=$(( attempt + 1 ))
  done
}

# The OTHER concurrency hazard, and it is not the config lock (found by the new
# concurrency test on a CI runner, reproduced on two different runners). git enumerates EVERY worktree's HEAD to work out what it
# already has, so a worktree created moments ago whose .git/worktrees/<name>/HEAD
# is not written yet breaks an UNRELATED transfer:
#
#   fatal: bad object worktrees/wt-s0/HEAD
#   error: <remote> did not send all necessary objects
#
# Nothing about that command involves wt-s0. It hits `git fetch origin main`
# (where it is FATAL under set -e, killing the run before the worktree exists)
# and `git push -u` alike. Transient by construction, the other creation
# finishes in milliseconds, so retry both.
#
# Shares config_lock_error's reader-vs-writer patterns too: `git fetch` and `git push -u`
# both read .git/config as a routine part of running at all, so either can be the
# READER that loses to a sibling's concurrent config WRITE on Windows, in the same
# "Permission denied" wording rather than git's own lock message. Reproduced
# directly on `git fetch origin main` racing 8 real invocations, see
# config_lock_error's comment for the full mechanism and the captured text.
transient_git_error() {
  case "$1" in
    *'bad object'*|*'did not send all necessary objects'*|*'could not lock config file'*) return 0 ;;
    *'unable to access'*'Permission denied'*) return 0 ;;
    *'unknown error occurred while reading the configuration files'*) return 0 ;;
  esac
  return 1
}

# Run "$@", retrying ONLY the transient concurrent-worktree shapes above.
# Anything else (auth, a rejected ref, a bad remote) fails on the first attempt
# with its real message rather than being retried into a slower identical error.
# Captured stderr is left in $GIT_RETRY_ERR for the caller to report.
# Same deadline as the config write, for the same reason: what both are waiting
# out is a sibling worktree creation finishing, and on a saturated box that is
# scheduling latency rather than work.
retry_transient_git() {
  local attempt=1 rc started=$SECONDS
  while :; do
    # `|| rc=$?`, never `if ! cmd; then rc=$?`: an `if` with no else returns 0
    # as a whole, so reading $? after the `fi` reports the IF's status, not the
    # command's, and every failure then looks like a success.
    rc=0
    GIT_RETRY_ERR="$("$@" 2>&1 >/dev/null)" || rc=$?
    [ "$rc" -eq 0 ] && return 0
    if [ $(( SECONDS - started )) -ge "$CONFIG_RETRY_SECONDS" ] || ! transient_git_error "$GIT_RETRY_ERR"; then
      return "$rc"
    fi
    retry_backoff_sleep "$attempt"
    attempt=$(( attempt + 1 ))
  done
}

# The THIRD race in this script, and the one that survived the retry-budget fix: `git
# worktree add` is not safe against a concurrent `git worktree add`. Every
# invocation prunes the worktree admin area first, and that prune can delete a
# sibling's half-built .git/worktrees/<name>/ before the sibling has finished
# writing it. The sibling then dies, fatally, on a path that vanished under it:
#
#   fatal: could not open '.git/worktrees/wt-s2/locked' for writing: No such file or directory
#
# Same family as the `bad object worktrees/<other>/HEAD` failure above, one
# creation breaking an unrelated one, but a different string, so
# transient_git_error did not match it and `set -e` made it fatal at the one
# point in the run where nothing is armed to clean up yet. Reproduced 2026-09-02
# by racing 8 creations on a saturated box; this is the shape that
# leaves the orphan branch ref (a branch with no worktree) that the config-lock race also leaves.
worktree_add_race_error() {
  case "$1" in
    *"could not open '"*"worktrees/"*"/locked'"*) return 0 ;;
  esac
  transient_git_error "$1"
}

# `git worktree add`, retried on the race above. Unlike retry_transient_git this
# has to CLEAN UP between attempts: a failed add can leave both the destination
# directory and the branch ref behind, and the retry would then fail with
# "branch already exists" over exactly the orphan this script exists to prevent.
#
# Removing them is safe precisely here and nowhere else, the caller has already
# established that neither $DEST nor $BRANCH existed before this run, so both can
# only be debris from an attempt we just made ourselves.
add_worktree() {
  local dest="$1" branch="$2" base="$3" attempt=1 rc started=$SECONDS
  while :; do
    rc=0
    WORKTREE_ADD_ERR="$(git worktree add -q --no-track "$dest" -b "$branch" "$base" 2>&1 >/dev/null)" || rc=$?
    [ "$rc" -eq 0 ] && return 0
    if [ $(( SECONDS - started )) -ge "$CONFIG_RETRY_SECONDS" ] || ! worktree_add_race_error "$WORKTREE_ADD_ERR"; then
      return "$rc"
    fi
    rm -rf "$dest"
    git worktree prune >/dev/null 2>&1 || true
    git branch -D "$branch" >/dev/null 2>&1 || true
    retry_backoff_sleep "$attempt"
    attempt=$(( attempt + 1 ))
  done
}

# ── the creation mutex: stop the three races at the source ───────
#
# Every race above has ONE cause: a `git worktree add` in flight mutates state that
# every OTHER git command in the repo reads. Retries treat the symptom, and a retry
# is only ever as deterministic as its budget, which is why the concurrency test
# went red on a UI-only change touching nothing under scripts/ with
#
#   fatal: bad object worktrees/wt-s2/HEAD
#   error: …/origin.git did not send all necessary objects
#   ERROR: could not fetch origin/main
#
# and green on a rerun of the same commit. Reproduced deterministically 2026-09-02
# by pointing one worktree's .git/worktrees/<name>/HEAD at an OID that does not
# resolve: `git fetch` then fails for the WHOLE repo, because its post-transfer
# connectivity check runs `rev-list --not --all` and `--all` includes every other
# worktree's HEAD. No git flag avoids it, `--negotiation-tip` and
# `fetch.negotiationAlgorithm=noop` were both measured making no difference, so
# the only fix is to not have a sibling mid-add while we fetch.
#
# So serialize the two commands that collide: our own `git worktree add` (which
# writes the admin entry, and prunes the admin area first) and our
# `git fetch` (which reads every sibling's). The mutex is a mkdir on the shared git
# common dir; mkdir is atomic on Windows and Linux alike, and `flock` does not exist
# under MSYS. Everything expensive stays parallel: the mutex covers ~0.3s of local
# git per run, is RELEASED before the push, and is long gone before the install, so an
# orchestrator's wave still installs concurrently.
#
# The existing retries stay as belt and braces, a human running a bare `git
# worktree add` in the same repo is not holding this lock, but they are no longer
# what the concurrency test rests on.
WORKTREE_LOCK_DIR=""
WORKTREE_LOCK_STALE_SECONDS="${WORKTREE_NEW_LOCK_STALE_SECONDS:-300}"
# How long a lock dir may be missing its owner stamp before a waiter breaks it.
#
# This is NOT a tuning knob, it is a correctness fix. `mkdir` is the atomic
# acquire; the stamp lands as a SECOND step, so there is a real window in which a
# lock is held by a LIVE process and has no readable stamp. The old code broke a
# stampless lock on sight, on the reasoning that "only a crash between the mkdir
# and the write produces one", which is the wrong half of the claim, because a
# live holder produces one too. Under load (N agent sessions on one box, the
# normal mode here) B deleted A's lock while A still held it, both ran
# `git worktree add` concurrently, and the loser died on Windows with
# `Permission denied` reading .git/config, the exact failure the lock exists to
# prevent.
#
# The window a live holder occupies is one printf, i.e. microseconds. Seconds of
# grace closes it with room to spare while still reaping a genuinely crashed
# holder well inside CONFIG_RETRY_SECONDS (60 by default).
WORKTREE_LOCK_STAMP_GRACE_SECONDS="${WORKTREE_NEW_LOCK_STAMP_GRACE_SECONDS:-5}"

release_creation_lock() {
  [ -n "$WORKTREE_LOCK_DIR" ] || return 0
  rm -rf "$WORKTREE_LOCK_DIR" 2>/dev/null || true
  WORKTREE_LOCK_DIR=""
}

# Read a lock's owner timestamp, or print nothing when there is not a plausible
# one. "Plausible" is deliberately strict: digits only, non-zero.
#
# The strictness is the second half of that fix. `cut -d' ' -f2` prints the
# WHOLE line when the delimiter is absent, so a half-written stamp came back as
# the pid, a small integer that reads as an epoch in 1970 and therefore as an
# age of ~56 years. That is how the bug reported `1788632685s ago` as if it were
# a fact. An unparseable stamp is now "no stamp", which routes to the grace path
# above rather than to an instant break.
lock_owner_stamp() {
  local line stamp
  line="$(head -n 1 "$1/owner" 2>/dev/null || true)"
  case "$line" in
    *' '*) stamp="${line#* }"; stamp="${stamp%% *}" ;;
    *) return 0 ;;
  esac
  case "$stamp" in
    '' | *[!0-9]*) return 0 ;;
    0) return 0 ;;
  esac
  printf '%s' "$stamp"
}

# Acquire, or give up and proceed unlocked. Deliberately NEVER fatal: this is a
# throughput/ordering guard, not a correctness gate, and the retries below still
# cover the unlocked path. A lock that could wedge worktree creation outright would
# be a worse failure than the race it prevents.
acquire_creation_lock() {
  [ "${AGENT_TOOLING_WORKTREE_NO_LOCK:-0}" = "1" ] && return 0
  local common lock started=$SECONDS owner age now stampless_since=''
  common="$(git rev-parse --git-common-dir 2>/dev/null || echo '')"
  [ -n "$common" ] || return 0
  common="$(cd "$common" 2>/dev/null && pwd -P)" || return 0
  # The name carries the consumer prefix (lowercased, dashed), so a consumer keeps the lock name its
  # older copy used and an old and a new script on one machine still exclude each other.
  lock="$common/$(printf %s AGENT_TOOLING_WORKTREE_CREATE | tr 'A-Z_' 'a-z-').lock"
  while :; do
    if mkdir "$lock" 2>/dev/null; then
      WORKTREE_LOCK_DIR="$lock"
      # Stamp via a temp file + rename so the stamp is never observable
      # half-written. The rename is within one directory, so it is atomic on
      # Windows and Linux alike. This does not close the mkdir->stamp window,
      # nothing can, while mkdir is the acquire, it only guarantees that what a
      # waiter reads is either the whole stamp or no stamp, never a fragment.
      if printf '%s %s\n' "$$" "$(date +%s)" > "$lock/owner.tmp" 2>/dev/null; then
        mv -f "$lock/owner.tmp" "$lock/owner" 2>/dev/null || true
      fi
      # No trap installed here: the caller (the main creation flow) installs ONE
      # combined EXIT trap before ever reaching this function, see
      # on_worktree_creation_exit below, and it already checks WORKTREE_LOCK_DIR.
      # A second `trap … EXIT` here would silently REPLACE that combined trap and
      # drop the creation-marker and half-provisioned-worktree cleanup it also does.
      return 0
    fi
    now="$(date +%s)"
    owner="$(lock_owner_stamp "$lock")"
    if [ -z "$owner" ]; then
      # No usable stamp. NOT proof the holder is dead, see
      # WORKTREE_LOCK_STAMP_GRACE_SECONDS above. Time it from when WE first saw
      # it stampless and break it only if it is still stampless after the grace,
      # so a live holder mid-acquire is waited for rather than trampled.
      [ -n "$stampless_since" ] || stampless_since="$now"
      if [ $(( now - stampless_since )) -ge "$WORKTREE_LOCK_STAMP_GRACE_SECONDS" ]; then
        echo "  (breaking a worktree-creation lock that never wrote an owner stamp: $lock)" >&2
        rm -rf "$lock" 2>/dev/null || true
        stampless_since=''
        continue
      fi
    else
      # A stamp reappeared (or was there all along), the holder is alive and the
      # grace must not carry over to a LATER stampless lock from a different run.
      stampless_since=''
      age=$(( now - owner ))
      # Clock skew, or a stamp from the future: not evidence of staleness.
      [ "$age" -ge 0 ] || age=0
      if [ "$age" -ge "$WORKTREE_LOCK_STALE_SECONDS" ]; then
        echo "  (breaking a worktree-creation lock left behind ${age}s ago: $lock)" >&2
        rm -rf "$lock" 2>/dev/null || true
        continue
      fi
    fi
    if [ $(( SECONDS - started )) -ge "$CONFIG_RETRY_SECONDS" ]; then
      echo "  (worktree-creation lock held for ${CONFIG_RETRY_SECONDS}s; proceeding without it)" >&2
      return 0
    fi
    retry_backoff_sleep 5
  done
}

# ── the creation marker: let `--await` tell "still checking out" from "nothing
#    here" ──────────────────────────────────────────────────────
#
# A SIBLING file, not something inside $DEST, the whole point is to be readable
# before $DEST exists at all (the window between this script starting and `git
# worktree add` actually creating the directory), and both the writer (this
# script's creation flow) and the reader (`--await`, against nothing but the
# destination PATH) can derive the same location from $DEST alone with no need
# to agree on anything else first.
CREATION_MARKER=""

creation_marker_path() {
  # Prefix-derived like the creation lock above: a consumer's own prefix names it.
  printf '%s/.%s-%s' "$(dirname "$1")" "$(printf %s AGENT_TOOLING_WORKTREE_CREATING | tr 'A-Z_' 'a-z-')" "$(basename "$1")"
}

write_creation_marker() {
  CREATION_MARKER="$(creation_marker_path "$1")"
  printf '%s %s\n' "$$" "$(date +%s)" > "$CREATION_MARKER" 2>/dev/null || true
}

remove_creation_marker() {
  [ -n "$CREATION_MARKER" ] || return 0
  rm -f "$CREATION_MARKER" 2>/dev/null || true
  CREATION_MARKER=""
}

# Best-effort SECOND signal: recent git writes a transient `locked` file into a
# worktree's admin dir while `git worktree add` is still checking it out (reason
# "initializing"), to stop a concurrent prune from deleting the half-built entry
# (see the add_worktree() race comment above). It is visible via
# `git worktree list --porcelain` for the matching path. Never fabricated: a
# parse miss, an absent git, or no matching entry all just mean "no signal from
# git", the marker above is the authoritative source, this is a backstop for a
# worktree this script did not create (or one from a git version too old to
# write it), where no marker exists at all.
git_worktree_initializing() {
  local dest="$1" target
  if [ -d "$dest" ]; then
    target="$(cd "$dest" 2>/dev/null && pwd -P)" || target="$dest"
  else
    target="$dest"
  fi
  git worktree list --porcelain 2>/dev/null | awk -v want="$target" '
    /^worktree / { path=$2; gsub(/\\/, "/", path); ismatch = (path == want) }
    ismatch && /^locked/ { print; exit }
  ' | grep -qi 'initializing'
}

publish_branch() {
  local dest="$1" branch="$2" rc=0
  retry_transient_git env -u GITHUB_TOKEN git -C "$dest" push -u origin "$branch" --quiet || rc=$?
  PUSH_ERR="$GIT_RETRY_ERR"
  return "$rc"
}

upstream_set() { git -C "$1" rev-parse --abbrev-ref --symbolic-full-name '@{u}' >/dev/null 2>&1; }

# `push -u` may have published the branch and silently dropped the upstream (see
# above). Assert the tracking config is really there, and repair it if not.
#
# The repair is judged by RE-READING @{u}, never by the exit status of the
# command that wrote it. That is the same discipline as verifying an edited field
# instead of trusting a success line, and it is warranted for the
# same reason here: this whole block exists because `git push -u` reports success
# through a config write it did not make. git's install_branch_config also writes
# branch.<b>.remote and branch.<b>.merge in two SEPARATE lock/write/rename
# cycles, so "the command exited 0" is a weaker claim than "both keys are there".
# A flapping-lock probe never produced a half-written pair (the retry closes it),
# but the check costs one rev-parse and removes the need to be right about that.
ensure_upstream() {
  local dest="$1" branch="$2"
  if upstream_set "$dest"; then return 0; fi
  retry_config_write git -C "$dest" branch --set-upstream-to="origin/$branch" "$branch" || true
  upstream_set "$dest"
}

# Deps are stale when node_modules is missing, the package manager's own record of the last
# successful install (npm: node_modules/.package-lock.json, written by npm ci/install) is
# missing, or the lockfile has been modified more recently than that record. The rebase case
# is what makes the mtime check necessary
# rather than a bare existence check: git rewrites a file's mtime to "now" on
# any checkout that changes its content, so a rebase landing a new dependency
# touches the lockfile's mtime without touching node_modules at all, a
# worktree can have a COMPLETE, successfully-installed node_modules and still
# be wrong for the package.json it now carries. No JSON parsing needed: `-nt`
# is cheap and needs only two stats.
deps_stale() {
  local dest="$1" lock
  lock="$dest/$(pm_lockfile_in "$dest")"
  [ -d "$dest/node_modules" ] || return 0
  [ -e "$dest/$PM_RECORD" ] || return 0
  [ "$lock" -nt "$dest/$PM_RECORD" ] && return 0
  return 1
}

# The mtime comparison above has one ORDERING it cannot see, and it is the common
# one where a session-start hook fast-forwards a clean worktree. That fast-forward
# rewrites package-lock.json WHILE the provisioning install is still running; the
# install then finishes, npm writes node_modules/.package-lock.json, and its
# record is NEWER than the lockfile. deps_stale() reads that as fresh while the
# tree holds the versions of the PREVIOUS lock. Observed 2026-09-05:
# playwright-core 1.56.0 on disk against a lockfile wanting 1.62.1, surfacing as
# 12 bogus errors in a test file the branch never touched.
#
# npm's own record of WHAT IT INSTALLED versus WHAT IS WANTED is immune to the
# ordering: both files are keyed by the same node_modules paths, and an entry
# present in both can only disagree if the install came from a different lock.
# Prints the drifted packages with BOTH versions and returns 0; returns 1
# (silently) when they agree, or when there is no verdict to give, which is the
# same discipline deps_missing_reason() uses for a missing `node`: never invent a
# failure out of a missing or unreadable tool. npm only: it is the manager whose
# lockfile and hidden record share this shape.
#
# Entries missing from either side are skipped on purpose. package-lock.json
# carries optional/platform-specific packages (fsevents on darwin, the unrs and
# esbuild platform binaries) that a healthy tree legitimately does not install,
# and npm's hidden lockfile carries link/workspace entries with no version. Only
# a shared entry with two differing versions is evidence of anything.
deps_version_drift() {
  local dest="$1"
  [ "$PM" = "npm" ] || return 1
  [ -f "$dest/package-lock.json" ] || return 1
  [ -f "$dest/node_modules/.package-lock.json" ] || return 1
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const dest = process.argv[1];
let wanted, installed;
try {
  wanted = JSON.parse(fs.readFileSync(path.join(dest, "package-lock.json"), "utf8"));
  installed = JSON.parse(fs.readFileSync(path.join(dest, "node_modules", ".package-lock.json"), "utf8"));
} catch {
  process.exit(1); // Unreadable or not JSON: no verdict, not a failure.
}
const marker = "node_modules/";
const want = (wanted && wanted.packages) || {};
const have = (installed && installed.packages) || {};
const drifted = [];
for (const [entry, meta] of Object.entries(have)) {
  if (!entry || !meta || typeof meta.version !== "string") continue;
  const w = want[entry];
  if (!w || typeof w.version !== "string") continue;
  if (w.version === meta.version) continue;
  const idx = entry.lastIndexOf(marker);
  const name = idx === -1 ? entry : entry.slice(idx + marker.length);
  drifted.push({ name, installed: meta.version, wanted: w.version });
}
if (drifted.length === 0) process.exit(1);
drifted.sort((a, b) => a.name.localeCompare(b.name));
const shown = drifted.slice(0, 5).map((d) => `${d.name} ${d.installed} installed, ${d.wanted} wanted`);
const rest = drifted.length - shown.length;
process.stdout.write(
  `${drifted.length} package(s) do not match package-lock.json: ` +
    shown.join("; ") +
    (rest > 0 ? `; and ${rest} more` : ""),
);
' "$dest" 2>/dev/null || return 1
}

# The packages a gate reaches for and so must be on disk: WORKTREE_NEW_REQUIRED_PACKAGES from the
# consumer hint when set, else every dependency and devDependency named in package.json. Prints
# nothing (no verdict) when there is no readable package.json.
required_packages() {
  local dest="$1"
  if [ -n "$WORKTREE_NEW_REQUIRED_PACKAGES" ]; then
    printf '%s' "$WORKTREE_NEW_REQUIRED_PACKAGES"
    return 0
  fi
  [ -f "$dest/package.json" ] || return 0
  node -e '
const fs = require("node:fs");
const path = require("node:path");
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8"));
} catch {
  process.exit(0);
}
process.stdout.write(Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).join(" "));
' "$dest" 2>/dev/null || true
}

# Is the tree actually USABLE? Prints what is missing and returns 0 when it is
# not; returns 1 (silently) when it looks fine. Deliberately separate from
# deps_stale() above, which answers a different question, "is this install for
# the right lockfile", and is mirrored by any session-start hook that provisions
# worktrees.
#
# One provisioning wave produced FOUR distinct end states, and the
# package manager's exit code separates none of them:
#   1. clean: exit 0, everything present.
#   2. exit NONZERO but fully usable, a native package's implicit node-gyp rebuild
#      failed after every package was already unpacked. Gates run fine. Judging
#      by the exit code alone THROWS AWAY A WORKING TREE.
#   3. genuinely broken: no packages at all, or packages without the binding.
#   4. worst, because it exits ZERO: two overlapping installs on one tree leave
#      MORE directories than a healthy install while the test runner, the
#      compiler and the framework are absent outright.
# So verify the artefacts a gate will actually reach for.
#
# On a native package (WORKTREE_NEW_NATIVE_PREBUILDS) specifically: the thing to assert is a
# loadable native binding, which is the SHIPPED prebuild (prebuilds/<platform>-<arch>.node,
# resolved at require time) or a local compile under build/Release. The absence of
# node_modules/<pkg>/build/ is evidence of NOTHING, a successful install has no build/ either.
deps_missing_reason() {
  local dest="$1" pkg plat binding compiled f
  # Direct dependencies every gate needs. Cheap, and the only thing that catches
  # end state 4, where node_modules is large and confidently wrong.
  for pkg in $(required_packages "$dest") $WORKTREE_NEW_NATIVE_PREBUILDS; do
    if [ ! -d "$dest/node_modules/$pkg" ]; then
      printf 'node_modules/%s is missing' "$pkg"
      return 0
    fi
  done
  [ -n "$WORKTREE_NEW_NATIVE_PREBUILDS" ] || return 1
  plat="$(node -p 'process.platform + "-" + process.arch' 2>/dev/null || true)"
  # No node → no verdict. Never invent a failure out of a missing tool.
  [ -n "$plat" ] || return 1
  for pkg in $WORKTREE_NEW_NATIVE_PREBUILDS; do
    binding="$dest/node_modules/$pkg/prebuilds/$plat.node"
    compiled=0
    for f in "$dest/node_modules/$pkg/build/Release/"*.node; do
      [ -f "$f" ] && compiled=1
    done
    if [ ! -f "$binding" ] && [ "$compiled" = "0" ]; then
      printf '%s has no native binding for %s (no prebuilds/%s.node, no build/Release/*.node)' "$pkg" "$plat" "$plat"
      return 0
    fi
  done
  return 1
}

# Does this project run Playwright at all? WORKTREE_NEW_BROWSER_CHECK: 0 never, 1 always, and
# `auto` (the default) only when package.json declares playwright, playwright-core or
# @playwright/test. Declared, not merely present: a transitive playwright-core under some other
# tool must not make an unrelated project fail on browsers it never launches.
browser_check_enabled() {
  case "$WORKTREE_NEW_BROWSER_CHECK" in
    0) return 1 ;;
    1) return 0 ;;
  esac
  [ -f "$1/package.json" ] || return 1
  node -e '
const fs = require("node:fs");
const path = require("node:path");
let pkg;
try {
  pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8"));
} catch {
  process.exit(1);
}
const declared = { ...pkg.dependencies, ...pkg.devDependencies };
process.exit(["@playwright/test", "playwright", "playwright-core"].some((n) => n in declared) ? 0 : 1);
' "$1" 2>/dev/null
}

# Playwright's BROWSERS are the one thing a complete, in-sync node_modules says
# nothing about. They are a separate, versioned, out-of-band download
# into a registry that lives OUTSIDE the worktree entirely
# ($PLAYWRIGHT_BROWSERS_PATH, else %LOCALAPPDATA%/ms-playwright,
# ~/Library/Caches/ms-playwright or ~/.cache/ms-playwright), and the pinned
# revision moves with every playwright-core bump. So a worktree passes every check
# above and still dies on its first e2e run, inside the auth setup, with
# `Executable doesn't exist at .../chromium-1234/...`. Observed 2026-09-06 in a
# fan-out worktree holding chromium-1194 and chromium-1228 while the pinned build
# was 1234, a shape no amount of reinstalling node_modules can fix, which is
# exactly why --await has to say so instead of printing "Dependencies ready".
#
# ASSERT, DO NOT INSTALL. The download is ~306 MB and an orchestrator provisions several
# worktrees at a time for tasks that mostly never touch e2e, so provisioning must
# not pay for it, but --await must not pretend it happened either.
#
# The pinned revision is never hardcoded here. `install --dry-run` is Playwright's
# OWN answer to "which build do I want, and where does it live", so it tracks a
# playwright-core bump and honours PLAYWRIGHT_BROWSERS_PATH for free. The dry run expands
# the browsers named in WORKTREE_NEW_BROWSERS to everything `install` would place (headless
# shell, ffmpeg, winldd).
#
# Same discipline as deps_missing_reason(): a project that does not run Playwright, no
# Playwright CLI in the tree, or a CLI that fails or prints something unparseable, yields NO
# verdict rather than a fabricated failure. An --omit=dev or --no-install tree is never slowed
# by a check it cannot need.
browsers_missing_reason() {
  local dest="$1" cli out locs loc missing=""
  browser_check_enabled "$dest" || return 1
  cli="$dest/node_modules/playwright-core/cli.js"
  [ -f "$cli" ] || return 1
  # shellcheck disable=SC2086 # deliberate word-splitting: a browser list
  out="$(node "$cli" install --dry-run $WORKTREE_NEW_BROWSERS 2>/dev/null)" || return 1
  locs="$(printf '%s\n' "$out" \
    | sed -n 's/^[[:space:]]*Install location:[[:space:]]*//p' \
    | sed 's/[[:space:]]*$//')"
  [ -n "$locs" ] || return 1
  while IFS= read -r loc; do
    [ -n "$loc" ] || continue
    # win32 prints a backslash path; MSYS `test` wants forward slashes.
    loc="${loc//\\//}"
    # INSTALLATION_COMPLETE is the marker Playwright writes LAST and reads back
    # itself, so a half-extracted directory reads as missing rather than present.
    [ -f "$loc/INSTALLATION_COMPLETE" ] && continue
    missing="${missing:+$missing, }${loc##*/}"
  done <<< "$locs"
  [ -n "$missing" ] || return 1
  printf '%s' "$missing"
  return 0
}

# `--await`'s exit code for "Playwright's browsers are absent, and NOTHING else is
# wrong". Distinct from 1 because those are two unrelated verdicts and
# only one of them is fatal to the step that follows:
#
#   1  dependencies are not ready, do NOT run a gate, any gate
#   3  the tree is ready; it just cannot run the e2e suite
#
# Why that matters more here than it would elsewhere: a process that makes `--await`
# MANDATORY before every gate, with no carve-out, hands a worker whose task never touches
# e2e (changing 11 PNGs, or one data module) a non-zero exit from a step it was required
# to run, for a reason that has no bearing on whether its gates can run. Both workers in
# a 2026-09-20 fan-out hit exactly that and both reported it unprompted; both judged it
# correctly and continued, which is the right outcome reached without a guardrail. A
# subagent cannot be course-corrected mid-task, which is precisely why the ritual is
# written so prescriptively, so the next wave should not need that luck.
#
# This narrows what the exit code MEANS; it must not make the exit code load-bearing.
# The neighbouring rule still governs, judge the TREE, never the exit code,
# and the message below is still the part to read.
EXIT_BROWSERS_MISSING=3

# The prescription is NOT `--install`: reinstalling node_modules cannot put a
# browser in the registry, and worktree-new.sh deliberately never downloads one.
#
# It leads with what IS ready, because that is the question the caller actually has.
# Do NOT weaken or remove this assertion: a tree that cannot run e2e has to
# say so up front, rather than provisioning ~306 MB into every fan-out worktree or
# letting the first e2e run discover it inside the auth setup.
browsers_fail() {
  echo "NOTE: dependencies in $1 ARE ready, every gate except e2e can run now." >&2
  echo "ERROR: Playwright's pinned browsers are not installed for $1: $2." >&2
  echo "  node_modules is complete and in sync with the lockfile, but Playwright's browsers" >&2
  echo "  are a SEPARATE, versioned download in a registry outside this worktree, so nothing" >&2
  echo "  above can see them. Do NOT run e2e: it dies in its first test reporting that the" >&2
  echo "  executable does not exist at that path. Fix (~306 MB, shared by every worktree):" >&2
  echo "    node node_modules/playwright-core/cli.js install $WORKTREE_NEW_BROWSERS" >&2
  echo "  This exits ${EXIT_BROWSERS_MISSING}, NOT 1. Exit 1 from --await means your dependencies are not ready and" >&2
  echo "  no gate should run; ${EXIT_BROWSERS_MISSING} means only the e2e run is unavailable. If your task does" >&2
  echo "  not run Playwright, this is not a reason to stop, carry on with your gates." >&2
}

# --- why the install is --ignore-scripts + a targeted rebuild ---
#
# A native package that ships a binding.gyp and NO install script of its own gets npm's
# implicit rule for exactly that combination: `node-gyp rebuild`. So a plain `npm ci` COMPILES
# it, and on a Windows box whose Visual Studio lacks the "Desktop development with C++"
# workload the compile fails, npm exits nonzero, and provisioning reads as a broken dev machine.
#
# When the package also ships prebuilt binaries for every platform (prebuilds/, resolved at
# require time), the compile was never needed: an --ignore-scripts tree was measured NOT
# degraded for such a package. Those are the packages named in WORKTREE_NEW_NATIVE_PREBUILDS;
# they are skipped by the rebuild below and judged by deps_missing_reason() instead.
#
# Scope is deliberately the PROVISIONING path only. A repo-wide `.npmrc` with
# ignore-scripts=true would also silence tools like esbuild or a Sentry CLI,
# which really do download platform binaries in their install scripts, and would
# change CI's install with no way to verify it from here. So: skip every script,
# then explicitly run the ones that matter.
#
# Two things --ignore-scripts skips that we must put back by hand:
#   * the dependencies that download binaries, rebuilt below, from a list
#     DERIVED from the lockfile rather than hardcoded, so a newly added native
#     dependency cannot go silently unbuilt in worktrees only (npm only: the other
#     managers have no by-name rebuild).
#   * the root package's OWN postinstall, which in some repositories generates the
#     gitignored environment file a worktree needs to run anything.

# Every hasInstallScript entry in the lockfile except the prebuilt natives, filtered to
# the ones actually installed in this tree (fsevents is darwin-only, and npm
# rebuild on an absent package is a silent no-op we would rather not rely on).
# Emitted space-separated for `npm rebuild`, which matches by NAME and so covers
# nested copies (a CLI's own bundled esbuild) along with the top-level one.
rebuildable_packages() {
  [ "$PM" = "npm" ] || return 0
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const dest = process.argv[1];
const skip = new Set((process.argv[2] || "").split(/\s+/).filter(Boolean));
const lock = JSON.parse(fs.readFileSync(path.join(dest, "package-lock.json"), "utf8"));
const marker = "node_modules/";
const names = new Set();
for (const [entry, meta] of Object.entries(lock.packages || {})) {
  if (!entry || !meta.hasInstallScript) continue;
  if (!fs.existsSync(path.join(dest, entry))) continue;
  const name = entry.slice(entry.lastIndexOf(marker) + marker.length);
  if (skip.has(name)) continue;
  names.add(name);
}
process.stdout.write([...names].join(" "));
' "$1" "$WORKTREE_NEW_NATIVE_PREBUILDS"
}

# Does the root package.json declare a postinstall script? Exit 0 when it does.
has_postinstall() {
  [ -f "$1/package.json" ] || return 1
  node -e '
const fs = require("node:fs");
const path = require("node:path");
try {
  const pkg = JSON.parse(fs.readFileSync(path.join(process.argv[1], "package.json"), "utf8"));
  process.exit(pkg.scripts && pkg.scripts.postinstall ? 0 : 1);
} catch {
  process.exit(1);
}
' "$1" 2>/dev/null
}

# The install itself. Runs as its own process (see --run-install below) so the
# recorded .npm-install.pid covers the WHOLE sequence, not just the install itself,
# otherwise --await would return while the rebuild was still going. (The pid file keeps its
# npm-era name whichever manager is configured: hooks that provision worktrees read it.)
run_install() {
  local dest="$1" targets
  ( cd "$dest" && pm_install ) || return 1
  targets="$(rebuildable_packages "$dest")" || return 1
  if [ -n "$targets" ]; then
    echo "Rebuilding packages whose install scripts we DO want: $targets"
    # shellcheck disable=SC2086 # deliberate word-splitting: a package list
    ( cd "$dest" && pm_rebuild $targets ) || return 1
  fi
  # npm's --ignore-scripts skipped the root package's own postinstall; put it back. The other
  # managers ran it themselves, so running it again would do it twice.
  if [ "$PM" = "npm" ] && has_postinstall "$dest"; then
    ( cd "$dest" && pm_run_script postinstall ) || return 1
  fi
  # The install record bun lacks (see INSTALL_STAMP): written last, so it is newer than the lockfile
  # this install used, and only on success.
  # A missing stamp reads as stale (safe: one more install), so a failed write is not fatal here.
  if [ -d "$dest/node_modules" ]; then
    date -u +%Y-%m-%dT%H:%M:%SZ > "$dest/node_modules/$INSTALL_STAMP" 2>/dev/null || true
  fi
}

install_deps() {
  DEST="$1"; AWAIT_ARG="$2"
  degraded_pm_notice
  LOG="$DEST/.npm-install.log"
  if [ "$WAIT" = "1" ]; then
    echo "Installing dependencies ($PM_LABEL)…"
    if ! run_install "$DEST" >"$LOG" 2>&1; then
      echo "ERROR: dependency install failed, see $LOG" >&2
      return 1
    fi
    echo "Dependencies installed."
  else
    # Deliberately NOT `cd "$DEST"` first: run_install cd's per step, and the
    # re-invoked script resolves PRIMARY from its cwd, which must stay a repo.
    # Some command runners terminate the whole process group when the shell
    # command returns. nohup only ignores SIGHUP; it does not protect the
    # installer from that group signal. Where setsid is available, give the
    # installer its own session so the recorded PID can finish after this
    # invocation returns. Git Bash environments without setsid retain the
    # existing nohup behavior and can use --wait for foreground provisioning.
    if command -v setsid >/dev/null 2>&1; then
      ( nohup setsid bash "$SCRIPT_DIR/worktree-new.sh" --run-install "$DEST" >"$LOG" 2>&1 & echo $! >"$DEST/.npm-install.pid" )
    else
      ( nohup bash "$SCRIPT_DIR/worktree-new.sh" --run-install "$DEST" >"$LOG" 2>&1 & echo $! >"$DEST/.npm-install.pid" )
    fi
    echo "Installing dependencies in the BACKGROUND (pid $(cat "$DEST/.npm-install.pid")), log: $LOG"
    echo "  Wait for it before running any gate:  $(agent_cmd await "path=$AWAIT_ARG")"
  fi
}

# `--run-install <path>`: INTERNAL. The backgrounded half of install_deps, split
# out so one pid owns the whole install sequence. Not a caller-facing entry
# point, use --install (which decides whether an install is needed at all).
if [ "$RUN_INSTALL" = "1" ]; then
  [ -n "$SLUG" ] || { echo "Usage: scripts/worktree-new.sh --run-install <path>" >&2; exit 1; }
  run_install "$(resolve_dest "$SLUG")" || exit 1
  exit 0
fi


# `--install <path>`: provision an EXISTING worktree the harness created for us.
# An agent harness may make a worktree itself and install nothing, so without
# this every such session hand-ran the install before its first gate, and a session that
# forgot got failures that look like real breakage, because the worktree resolves the
# PRIMARY's node_modules through npm's lockfile-root heuristic.
if [ "$PROVISION" = "1" ]; then
  degraded_pm_notice
  [ -n "$SLUG" ] || { echo "Usage: scripts/worktree-new.sh --install <path>" >&2; exit 1; }
  PV="$(resolve_dest "$SLUG")"
  [ -d "$PV" ] || { echo "ERROR: $PV is not a directory." >&2; exit 1; }
  PV_ABS="$(cd "$PV" && pwd -P)"
  # Never the primary checkout: it is shared by every session and already installed.
  if [ "$PV_ABS" = "$(cd "$PRIMARY" && pwd -P)" ]; then
    echo "ERROR: refusing to provision the PRIMARY checkout ($PV_ABS)." >&2
    exit 1
  fi
  PV_LOCK="$(pm_lockfile_in "$PV")"
  [ -f "$PV/package.json" ] && [ -f "$PV/$PV_LOCK" ] \
    || { echo "ERROR: $PV has no package.json + $PV_LOCK, nothing to install." >&2; exit 1; }
  # An INCOMPLETE tree needs installing just as much as a stale one, and it is
  # not stale by the lockfile test, node_modules and its install record can
  # both be there while the packages a gate needs are not (end
  # states 3 and 4 of deps_missing_reason). Without this, --await's "fix: --install" prescription
  # answered "already present and up to date" and left the caller in a loop.
  # deps_version_drift() belongs in this condition for the same reason
  # deps_missing_reason() does: --await's prescription IS `--install`, so a
  # state --await refuses that --install calls "nothing to do" is a loop with no
  # way out (that shape was hit in practice).
  if ! deps_stale "$PV" && ! PV_REASON="$(deps_missing_reason "$PV")" \
    && ! PV_REASON="$(deps_version_drift "$PV")"; then
    echo "Dependencies already present and up to date in $PV_ABS, nothing to do."
    exit 0
  fi
  [ -n "${PV_REASON:-}" ] && echo "Reinstalling: $PV_REASON."
  install_deps "$PV" "$PV_ABS"
  exit 0
fi
# How often the `--await` wait loop below prints a heartbeat while it blocks on
# a backgrounded install. The loop used to be silent from "Waiting
# for npm ci…" until the pid exited, and a full install routinely runs past an
# agent harness's 600s no-stream-progress watchdog, which killed two of three
# workers in one wave on 2026-09-09: on relaunch --await returned in 2.5s,
# meaning the install had already succeeded and the workers died for nothing.
# Overridable so a test can shorten it instead of waiting out the real default.
AGENT_TOOLING_AWAIT_HEARTBEAT_SECS="${AGENT_TOOLING_AWAIT_HEARTBEAT_SECS:-30}"

# Best-effort detail to attach to a heartbeat line: the install log's line
# count plus its last non-empty line, trimmed to a sane width so a noisy npm
# progress line cannot flood the stream. An unreadable or empty log yields
# nothing rather than an error, the heartbeat exists to prove liveness, not
# to diagnose the install; deps_missing_reason() is what does that once the
# wait ends.
await_heartbeat_detail() {
  local log="$1" lines last
  [ -f "$log" ] || return 0
  lines="$(wc -l < "$log" 2>/dev/null | tr -d '[:space:]')"
  last="$(grep -v '^[[:space:]]*$' "$log" 2>/dev/null | tail -n 1)"
  if [ -n "$last" ] && [ "${#last}" -gt 120 ]; then
    last="${last:0:117}..."
  fi
  if [ -n "$last" ]; then
    printf ' (%s lines, last: %s)' "${lines:-0}" "$last"
  elif [ -n "${lines:-}" ]; then
    printf ' (%s lines)' "$lines"
  fi
}

# `--await <slug|path>`: block until a backgrounded install finishes, then report. Gates
# run against a half-installed node_modules fail in ways that look like real breakage, so
# always await before type-check/lint/test/build.
if [ "$AWAIT" = "1" ]; then
  [ -n "$SLUG" ] || { echo "Usage: scripts/worktree-new.sh --await <slug|path>" >&2; exit 1; }
  AW="$(resolve_dest "$SLUG")"

  # A CREATION still in progress, this script's own `git worktree add`
  # has not finished checking out, is a different state from "nothing backgrounded
  # here", and treating them the same was the bug. An orchestrator's
  # `worktree-new.sh <slug> <branch>` call that ran past its shell tool's
  # own timeout and got moved to the background left the worktree already
  # visible in `git worktree list` (git adds the admin entry and starts checking
  # out before the command returns) while the checkout was still running. A worker
  # launched against it then found no `.npm-install.pid` (creation had not reached
  # that far) and no lockfile either, and the branch below read that as
  # "created with --no-install" and returned 0, ready, over an EMPTY index.
  # Wait out both signals of an in-progress checkout
  # before asking any readiness question at all: the marker this script writes
  # before `git worktree add` (authoritative for a worktree THIS script created),
  # and git's own transient `locked`/"initializing" file (a backstop for one it
  # did not, an older harness-created worktree, say).
  AWAIT_CREATION_DEADLINE="${AGENT_TOOLING_AWAIT_CREATION_DEADLINE_SECONDS:-600}"
  AWAIT_CREATION_MARKER="$(creation_marker_path "$AW")"
  if [ -f "$AWAIT_CREATION_MARKER" ] || git_worktree_initializing "$AW"; then
    echo "Waiting for worktree creation to finish in $AW (checkout in progress)…"
    CREATION_WAIT_STARTED=$SECONDS
    CREATION_LAST_HEARTBEAT=$SECONDS
    while [ -f "$AWAIT_CREATION_MARKER" ] || git_worktree_initializing "$AW"; do
      if [ $(( SECONDS - CREATION_WAIT_STARTED )) -ge "$AWAIT_CREATION_DEADLINE" ]; then
        echo "ERROR: worktree creation in $AW has not finished after ${AWAIT_CREATION_DEADLINE}s." >&2
        echo "  Either it is still genuinely checking out on a heavily loaded box, or the" >&2
        echo "  creating process died without cleaning up after itself. Check whether a" >&2
        echo "  worktree-new.sh process for $AW is still running; if not:" >&2
        echo "    rm -f \"$AWAIT_CREATION_MARKER\"" >&2
        echo "    git -C \"$AW\" ls-files | head -1   # empty output means the checkout never finished" >&2
        echo "    git -C \"$AW\" reset --hard HEAD    # recovery, if the index is empty" >&2
        exit 1
      fi
      sleep 2
      if [ $(( SECONDS - CREATION_LAST_HEARTBEAT )) -ge "$AGENT_TOOLING_AWAIT_HEARTBEAT_SECS" ]; then
        CREATION_LAST_HEARTBEAT=$SECONDS
        echo "  … still waiting on worktree creation in $AW, $(( SECONDS - CREATION_WAIT_STARTED ))s elapsed"
      fi
    done
    echo "Worktree creation finished in $AW."
  fi

  # Whether or not we waited above: a worktree that EXISTS but has an empty index
  # is a checkout that did not complete, and every question below ("is there a pid
  # file", "does node_modules match the lockfile") is meaningless against a tree
  # with no files in it. This is the assertion the marker wait exists to gate:
  # skip it only when $AW is not a git worktree at all (nothing created yet is a
  # caller error the branches below already report).
  if [ -e "$AW/.git" ] && [ -z "$(git -C "$AW" ls-files 2>/dev/null | head -1)" ]; then
    echo "ERROR: worktree at $AW has an EMPTY index, checkout did not complete." >&2
    echo "  Do NOT run any gate. Recovery for a valid worktree with an empty index:" >&2
    echo "    git -C \"$AW\" reset --hard HEAD" >&2
    exit 1
  fi

  PIDF="$AW/.npm-install.pid"; LOGF="$AW/.npm-install.log"
  AW_LOCK="$(pm_lockfile_in "$AW")"
  if [ ! -f "$PIDF" ]; then
    # Nothing backgrounded here right now. That is only really "done" when deps
    # are actually present AND in sync with the lockfile, a
    # harness worktree that never got an install recorded (a session-start provisioning
    # hook skipped it, or never ran at all) used to hit this branch, print success,
    # and let every later gate silently resolve modules against the PRIMARY
    # checkout's node_modules instead, a false red (or false green) in files
    # the branch never touched.
    if [ ! -f "$AW/$AW_LOCK" ]; then
      echo "No backgrounded install recorded for $AW, and no $AW_LOCK, assuming --no-install was used."
      exit 0
    fi
    if deps_stale "$AW"; then
      echo "ERROR: no install is running in $AW, and node_modules is missing or stale against $AW_LOCK." >&2
      echo "  Running a gate now would silently resolve modules against a DIFFERENT checkout. Fix:" >&2
      echo "    $(agent_cmd install "path=$AW")" >&2
      exit 1
    fi
    if AW_REASON="$(deps_missing_reason "$AW")"; then
      echo "ERROR: no install is running in $AW, and the tree is INCOMPLETE: $AW_REASON." >&2
      echo "  node_modules exists and matches $AW_LOCK, so the staleness check passes," >&2
      echo "  but a gate run now fails in ways that look like real breakage. Fix:" >&2
      echo "    $(agent_cmd install "path=$AW")" >&2
      exit 1
    fi
    if AW_DRIFT="$(deps_version_drift "$AW")"; then
      echo "ERROR: node_modules in $AW was installed from a DIFFERENT package-lock.json: $AW_DRIFT." >&2
      echo "  The mtime check reads fresh because npm's record is NEWER than the lockfile, that is what" >&2
      echo "  happens when the lockfile is rewritten WHILE an install runs. Fix:" >&2
      echo "    $(agent_cmd install "path=$AW")" >&2
      exit 1
    fi
    if AW_BROWSERS="$(browsers_missing_reason "$AW")"; then
      browsers_fail "$AW" "$AW_BROWSERS"
      exit "$EXIT_BROWSERS_MISSING"
    fi
    echo "No backgrounded install recorded for $AW (already finished and up to date)."
    exit 0
  fi
  PID="$(cat "$PIDF")"
  echo "Waiting for $PM_LABEL (pid $PID) in $AW…"
  AWAIT_STARTED=$SECONDS
  AWAIT_LAST_HEARTBEAT=$SECONDS
  while kill -0 "$PID" 2>/dev/null; do
    sleep 2
    if [ $(( SECONDS - AWAIT_LAST_HEARTBEAT )) -ge "$AGENT_TOOLING_AWAIT_HEARTBEAT_SECS" ]; then
      AWAIT_LAST_HEARTBEAT=$SECONDS
      echo "  … still waiting on $PM_LABEL (pid $PID), $(( SECONDS - AWAIT_STARTED ))s elapsed$(await_heartbeat_detail "$LOGF")"
    fi
  done
  rm -f "$PIDF"
  # The VERDICT IS THE TREE, not the log and not an exit code.
  # The nohup'd child's status is not reap-able here anyway, and the log is a
  # poor proxy for it in both directions: an install can print `npm error` after
  # unpacking every package (a native postinstall that failed on a machine
  # lacking a compiler) and leave a tree every gate runs green on, while two
  # overlapping installs leave a bigger-than-healthy node_modules with no test runner,
  # exiting 0 and logging nothing. So check the artefacts first, and demote the
  # log to a warning that is worth reading rather than a verdict.
  if AW_REASON="$(deps_missing_reason "$AW")"; then
    echo "ERROR: the install in $AW did not leave a usable tree: $AW_REASON." >&2
    echo "  Do NOT run a gate, it will fail in files your branch never touched. Fix:" >&2
    echo "    $(agent_cmd install "path=$AW")" >&2
    echo "  Install log: $LOGF" >&2
    tail -20 "$LOGF" >&2
    exit 1
  fi
  # The install FINISHED, and that is precisely when the ordering trap bites: a
  # session-start fast-forward that rewrote the lockfile mid-install
  # leaves npm's record newer than the lockfile, so nothing above this line can
  # see it and `--await` used to print "Dependencies ready" over a tree holding
  # the previous lock's versions.
  if AW_DRIFT="$(deps_version_drift "$AW")"; then
    echo "ERROR: the install in $AW finished against a DIFFERENT package-lock.json: $AW_DRIFT." >&2
    echo "  package-lock.json was rewritten while the install was running (a session-start" >&2
    echo "  fast-forward, or a rebase), so npm's record is NEWER than the" >&2
    echo "  lockfile and the mtime check cannot see it. Do NOT run a gate, you would be" >&2
    echo "  testing the wrong package versions, and the failures land in files your branch" >&2
    echo "  never touched. Fix:" >&2
    echo "    $(agent_cmd install "path=$AW")" >&2
    exit 1
  fi
  # An install that succeeded outright still leaves this open: nothing in the
  # install path downloads a browser, on purpose.
  if AW_BROWSERS="$(browsers_missing_reason "$AW")"; then
    browsers_fail "$AW" "$AW_BROWSERS"
    exit "$EXIT_BROWSERS_MISSING"
  fi
  if grep -qiE '^npm (error|ERR!)' "$LOGF" 2>/dev/null; then
    echo "WARNING: npm reported errors, but the tree verifies as complete, see $LOGF." >&2
    echo "         Proceeding: a failed OPTIONAL step is not a broken worktree." >&2
  fi
  echo "Dependencies ready in $AW."
  exit 0
fi

if [ -z "$SLUG" ] || [ -z "$BRANCH" ]; then
  echo "Usage: scripts/worktree-new.sh <slug> <branch> [--base <ref>] [--wait] [--no-install]" >&2
  echo "       scripts/worktree-new.sh --await <slug|path>" >&2
  echo "Example: scripts/worktree-new.sh my-feature feat/my-feature" >&2
  exit 1
fi

DEST="$(resolve_dest "$SLUG")"

if [ -e "$DEST" ]; then
  echo "ERROR: $DEST already exists. Pick another slug, or remove it with: $(agent_cmd rm "path=$DEST")" >&2
  exit 1
fi
if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  echo "ERROR: branch '$BRANCH' already exists. A worktree's branch is created with it, pick a new name." >&2
  exit 1
fi

# Create the containing directory, not AGENT_TOOLING_WORKTREE_ROOT itself: a first use of a
# fresh root is the normal case, and an explicit full-path slug must not cause a
# root it is deliberately overriding to be created.
DEST_PARENT="$(dirname "$DEST")"
if [ ! -d "$DEST_PARENT" ]; then
  mkdir -p "$DEST_PARENT" || {
    echo "ERROR: $DEST_PARENT does not exist and could not be created." >&2
    exit 1
  }
fi

# Write the creation marker and install ONE combined EXIT trap for the rest of this
# run, before the mutex, before the fetch, before `git worktree add`,
# because a caller's `--await` needs to see "creation is in progress" for the WHOLE
# span between this line and the empty-index assertion below, not just the part
# after `git worktree add` returns. A single trap, not one installed per phase: this
# script used to hand the EXIT trap between acquire_creation_lock's own
# `release_creation_lock` and cleanup_partial(), and each `trap … EXIT` call REPLACES
# the previous handler outright, which is exactly why they had to be sequenced by
# hand. on_worktree_creation_exit folds all of it, lock release, marker removal,
# half-provisioned-worktree teardown, into the one function so nothing can silently
# drop a later handler again.
write_creation_marker "$DEST"
on_worktree_creation_exit() {
  local rc=$?
  release_creation_lock
  remove_creation_marker
  if [ "$rc" -eq 0 ] || [ -z "${CREATED_WORKTREE:-}" ]; then return 0; fi
  echo "Removing the half-provisioned worktree and its branch ref (no orphan left behind)…" >&2
  git worktree remove --force "$CREATED_WORKTREE" >/dev/null 2>&1 || rm -rf "$CREATED_WORKTREE"
  git worktree prune >/dev/null 2>&1 || true
  git branch -D "$BRANCH" >/dev/null 2>&1 || true
}
trap on_worktree_creation_exit EXIT

# Everything from here to the end of `git worktree add` runs under the creation
# mutex: the fetch READS every sibling worktree's HEAD and the add WRITES ours, so
# these are exactly the two commands a concurrent creation breaks.
acquire_creation_lock

if [ "$BASE" = "origin/main" ]; then
  echo "Fetching origin/main…"
  # Retried anyway: the mutex only covers callers that went through this script, so
  # a hand-run `git worktree add` elsewhere in the repo can still break this fetch.
  # Under set -e it killed the run before the worktree existed, so it left no orphan
  # to notice and read as "the fetch failed" with no hint that a sibling creation
  # caused it.
  if ! retry_transient_git git fetch origin main --quiet; then
    [ -n "$GIT_RETRY_ERR" ] && printf '%s\n' "$GIT_RETRY_ERR" >&2
    echo "ERROR: could not fetch origin/main." >&2
    exit 1
  fi
fi

echo "Creating worktree $DEST on $BRANCH (from $BASE)…"
# --no-track: see the config-contention block above. This is the write that used
# to be FATAL under concurrency, and the tracking it set (feature branch ->
# origin/main) was wrong regardless, `git push -u` below sets the right one.
if ! add_worktree "$DEST" "$BRANCH" "$BASE"; then
  [ -n "$WORKTREE_ADD_ERR" ] && printf '%s\n' "$WORKTREE_ADD_ERR" >&2
  echo "ERROR: could not create the worktree at $DEST." >&2
  exit 1
fi

# From here until the branch is published, a failure would leave an orphan:
# a branch ref with no worktree, which `git worktree list` does
# not show and the toplevel check cannot see, so the next run only fails with
# "branch already exists" and someone has to `git branch -D` it by hand. Undo
# our own half-provision instead of leaving it for them. The trap that acts on
# this state (on_worktree_creation_exit) is already installed, above.
CREATED_WORKTREE="$DEST"

# The admin-area writes are done. Release BEFORE the isolation checks and the push:
# the push is the slow, network-bound part of the run, and holding a mutex across it
# would serialize a fan-out wave for no benefit (a sibling's push cannot corrupt our
# admin entry, measured, and push has its own retry regardless).
release_creation_lock

# Isolation check. `toplevel == cwd` proves this is A worktree; comparing against the
# path we ASKED for is what proves it is the RIGHT one (valid != dedicated).
ACTUAL="$(retry_config_read git -C "$DEST" rev-parse --show-toplevel)"
if [ "$(cd "$ACTUAL" && pwd -P)" != "$(cd "$DEST" && pwd -P)" ]; then
  echo "ERROR: isolation check failed, expected toplevel $DEST, got $ACTUAL" >&2
  echo "Do NOT run any git-mutating command: this is not the dedicated worktree you asked for." >&2
  exit 1
fi

# Provisioning check (2026-08-30). A `git worktree add` KILLED mid-checkout,
# e.g. by a caller that presumed a lock-contention stall was a hang, leaves a THIRD
# kind of broken worktree: valid HEAD, right branch, pushable… and a ZERO-entry index with
# files missing from disk. Every check above passes on it; every later content lookup just
# says "No such file". Assert the index is populated so a half-provision fails HERE, loudly,
# with its one-command fix, instead of surfacing as phantom missing-file errors later.
TRACKED="$(retry_config_read git -C "$DEST" ls-files)"
if [ -z "$TRACKED" ]; then
  echo "ERROR: worktree at $DEST has an EMPTY index, checkout did not complete" >&2
  echo "  (interrupted mid-add?). Fix: git -C \"$DEST\" reset --hard HEAD" >&2
  echo "  then re-run this script's remaining steps, or remove and recreate." >&2
  exit 1
fi

# Pre-create the gitignored gate-capture directory. scripts/gate.sh only makes
# .tmp-gates/ lazily, so a fresh worktree had none, and a worker's
# `worktree-new.sh --await <path> > <path>/.tmp-gates/await-test.log` failed the redirect
# BEFORE --await ran. .tmp-gates/ is in .gitignore, so this causes no index churn. Never fatal.
mkdir -p "$DEST/.tmp-gates" 2>/dev/null \
  || echo "WARNING: could not create $DEST/.tmp-gates; mkdir -p it before redirecting a log there." >&2

# Keep the daemon off for every LATER git call in this worktree too: inside
# one, each git call printed "error: daemon terminated" and a plain `git lfs status` hung
# holding index.lock. The env override above dies with this script, so pin it in the
# worktree's OWN config. Only when `extensions.worktreeConfig` is ALREADY on: enabling it
# rewrites the shared .git/config and changes how every other worktree reads its config,
# which is not this script's call. Never fatal; the env override already got the add done.
if [ "$(retry_config_read git -C "$DEST" config --type=bool --get extensions.worktreeConfig 2>/dev/null || true)" = "true" ]; then
  git -C "$DEST" config --worktree core.fsmonitor false 2>/dev/null \
    || echo "WARNING: could not pin core.fsmonitor=false in $DEST's worktree config." >&2
fi

# The checkout is proven complete, this is the exact point the creation-marker fix names
# ("removes it after its own empty-index assertion passes"). From here on a
# concurrent `--await` must stop waiting and judge the tree on its own merits.
remove_creation_marker

# Publish immediately, see the header. This is the half that closes the collision window.
echo "Publishing branch…"
# Capture stderr rather than streaming it: push exits 0 straight THROUGH a lost
# config-lock write, so its complaint is a false alarm once ensure_upstream has
# repaired it, and that exact string reads as fatal.
PUBLISH_RC=0
publish_branch "$DEST" "$BRANCH" || PUBLISH_RC=$?

# The push has run. Either the branch reached the remote, where deleting it now
# would strand a remote ref, or it did not, and the warning arm below
# deliberately KEEPS the worktree rather than tearing it down. Either way we are
# past the point where on_worktree_creation_exit's worktree-removal arm is the
# right answer, so stand it down HERE, before the upstream repair. That ordering
# is what lets the repair fail loudly without destroying an already-published
# branch (it used to sit after the whole block, which is why the repair could
# only ever warn). The lock and the creation marker are already released by this
# point (release_creation_lock above, remove_creation_marker right after the
# empty-index assertion), so disarming the trap here drops nothing.
trap - EXIT
CREATED_WORKTREE=""

if [ "$PUBLISH_RC" -eq 0 ]; then
  RACED=0
  if config_lock_error "$PUSH_ERR"; then
    RACED=1
    PUSH_ERR="$(printf '%s\n' "$PUSH_ERR" \
      | grep -vE 'could not lock config file|unable to write upstream branch configuration|^hint:' || true)"
  fi
  # Keep everything else push had to say, the "Create a pull request" URL lives here.
  [ -n "${PUSH_ERR//[[:space:]]/}" ] && printf '%s\n' "$PUSH_ERR" >&2
  if ensure_upstream "$DEST" "$BRANCH"; then
    [ "$RACED" = "1" ] && echo "  (a concurrent worktree creation held .git/config; upstream set on retry)"
  else
    # LOUD, not a warning. This used to print three WARNING lines and
    # then exit 0 under "Worktree ready … (published)", so every caller, and CI,
    # read a success over a branch that had no upstream at all. That is the same
    # fails-upward defect fixed for the node_modules case, and it is why
    # the concurrency flake surfaced as a mysterious missing branch.<b>.remote in
    # a run where all 8 processes had exited 0.
    echo "ERROR: '$BRANCH' is published but has NO upstream after ${CONFIG_RETRY_SECONDS}s of retries." >&2
    echo "       git pull in that worktree answers 'no tracking information', and other" >&2
    echo "       tooling reads the branch as unpublished work." >&2
    echo "       The worktree and the published branch are INTACT. Set the upstream by hand:" >&2
    echo "         git -C \"$DEST\" branch --set-upstream-to=origin/$BRANCH" >&2
    echo "       If this repeats with no concurrent worktree creation running, look for a" >&2
    echo "       stale lock left by a killed git: $PRIMARY/.git/config.lock" >&2
    exit 1
  fi
else
  # Deliberately NOT fatal, unlike the upstream failure above: the branch never
  # reached the remote, so nothing is inconsistent, and a machine that is offline
  # or has no push credentials must still be able to create a worktree.
  [ -n "$PUSH_ERR" ] && printf '%s\n' "$PUSH_ERR" >&2
  echo "WARNING: could not publish '$BRANCH'. Push it by hand before starting work:" >&2
  echo "         an unpublished branch looks to other sessions like abandoned work." >&2
fi

if [ "$INSTALL" = "1" ]; then
  install_deps "$DEST" "$SLUG"
fi

cat <<INFO

Worktree ready.

  Path:   $DEST
  Branch: $BRANCH (published)

Pin a subagent to that EXACT absolute path, and never create or switch branches inside it.
Block on the dependency install before any gate, pass the PATH, not the slug, since a
shell without AGENT_TOOLING_WORKTREE_ROOT resolves a bare slug somewhere else entirely:
  $(agent_cmd await "path=$DEST")
Teardown when the PR merges, from the PRIMARY checkout, never from inside the worktree:
  cd $PRIMARY && $(agent_cmd rm "path=$DEST")
INFO
