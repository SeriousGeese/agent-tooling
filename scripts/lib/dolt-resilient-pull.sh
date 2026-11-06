# dolt_pull_resilient
#
# Shared retry-with-recovery wrapper around `bd dolt pull`, extracted from the
# near-identical copies that used to live separately in two CI scripts (a close
# script and a stale-bead reconcile script). It is that copy, relocated verbatim
# rather than rewritten: the two were byte-identical apart from which log helper
# wrapped `echo ... >&2`.
#
# A bare `bd dolt pull` aborts a `set -e` caller when it races a concurrent
# bead write: Dolt returns "Error 1105: Merge conflict detected, @autocommit
# transaction rolled back" (non-zero). The conflict is DATA-level, so a plain
# retry alone is not enough - a runner's LOCAL clone can hold an unpushed
# commit that conflicts with DoltHub and blocks every future pull. So: retry
# for the pure timing race, and if it persists, reset the local clone to its
# DoltHub upstream (discarding the conflicting unpushed commit) before
# retrying.
#
# Why discarding local state is safe and self-healing: every caller's local
# Dolt clone is a disposable mirror - pull -> mutate -> push, every run - and
# DoltHub is the source of truth. Any local mutation the reset discards is
# therefore re-detected and re-applied by whichever recovery path the caller
# already has (for a close script, the next CI batch re-does every PR past
# its sync marker). The reset
# here re-syncs TO origin and NEVER force-pushes (the one action the agent
# rules forbid) - it only ever resets a LOCAL clone to its own upstream.
#
# EXCEPT a store a bd sql-server serves in place: that is the live
# store every session on the host writes to, not a mirror, so the reset is
# refused there and only the pull is retried.
#
# ── Usage ────────────────────────────────────────────────────────────────
# `source` this file, then call `dolt_pull_resilient` (no arguments). Unlike
# the scripts that source it, this file never sets `set -e`/`set -u`/
# `pipefail` itself - a sourced file must not change the caller's shell
# options out from under it - but it is written to behave correctly under
# either, since every current caller runs with at least one of them: no
# unset-variable reads, and every non-zero exit inside the retry loop is
# handled explicitly rather than left for `set -e` to act on.
#
# Reads three CALLER-SET variables (matching the pre-extraction convention -
# every caller already defines these, or must define them before sourcing):
#   BD            (required)  the bd binary to invoke, e.g. `BD="${BD_CLI:-bd}"`
#   BEAD_PULL_ATTEMPTS  (required)  total pull attempts before giving up,
#                               e.g. `BEAD_PULL_ATTEMPTS="${BEAD_PULL_ATTEMPTS:-4}"`
#   DOLT_DIR      (optional)  path to the embedded Dolt clone to reset on a
#                              stuck merge (2nd+ failure). When unset or not a
#                              directory, the reset step is skipped and this
#                              degrades to plain retry-with-backoff.
#                              ONLY for a DISPOSABLE clone that no interactive
#                              session writes to. Never point it
#                              at a working checkout's database: the reset
#                              discards every unpushed local commit there,
#                              including one the caller itself just made.
#                              It is read from the ENVIRONMENT too, so a caller
#                              that runs from a working checkout must `unset
#                              DOLT_DIR` before sourcing, not merely leave it
#                              unassigned (record-feature-idea.sh does).
#                              Whatever a reset discards is printed first as
#                              ::warning:: lines, so it is never silent.
#
# The caller is also responsible for being in (or explicitly `cd`-ing into)
# the directory `"$BD" dolt pull` should run from - this function never `cd`s
# for the pull itself, only for the DOLT_DIR reset. a close script may do a global
# `cd "$BEADS_DIR"` once, up front; wrapping each call as
# `( cd "$BEADS_DIR" && dolt_pull_resilient )` works just as well.
#
# Returns 0 once `bd dolt pull` succeeds; returns 1 once BEAD_PULL_ATTEMPTS is
# exhausted.
# True when a running dolt sql-server serves the store DOLT_DIR lives in: dolt writes
# <store root>/.dolt/sql-server.info as <pid>:<port>:<uuid> and removes it on a clean stop.
dolt_dir_is_served() {
  local info pid
  info="$(dirname "$1")/.dolt/sql-server.info"
  [ -f "$info" ] || return 1
  # dolt writes the file WITHOUT a trailing newline, so `read` returns non-zero after reading it.
  IFS=: read -r pid _ < "$info" || true
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

dolt_pull_resilient() {
  local i
  for (( i = 1; i <= BEAD_PULL_ATTEMPTS; i++ )); do
    if "$BD" dolt pull; then
      return 0
    fi
    echo "::warning::bd dolt pull failed (attempt ${i}/${BEAD_PULL_ATTEMPTS})" >&2
    if [ "$i" -ge "$BEAD_PULL_ATTEMPTS" ]; then
      break
    fi
    # 2nd+ failure: the local clone is wedged with a conflicting unpushed commit a
    # plain retry can never clear - reset it to DoltHub first. Local-only and
    # best-effort: any command that is unavailable or fails just falls through to
    # the next plain-pull retry, so this can never do worse than a bare retry.
    if [ "$i" -ge 2 ] && [ -n "${DOLT_DIR:-}" ] && [ ! -d "$DOLT_DIR" ]; then
      # Never skip the recovery silently: a moved store would otherwise just retry.
      echo "::warning::DOLT_DIR ${DOLT_DIR} does not exist - the stuck-merge reset is SKIPPED; check where the beads store lives" >&2
    elif [ "$i" -ge 2 ] && [ -n "${DOLT_DIR:-}" ] && dolt_dir_is_served "$DOLT_DIR"; then
      # A bd sql-server serves this store in place: it is the LIVE store every session
      # on the host writes to, not a disposable mirror, so a reset would discard their unpushed
      # bead commits. Never reset it; retry the pull only.
      echo "::warning::DOLT_DIR ${DOLT_DIR} is served by a live bd sql-server - the stuck-merge reset is REFUSED (it is the shared store); retrying the pull only" >&2
    elif [ "$i" -ge 2 ] && [ -n "${DOLT_DIR:-}" ] && [ -d "$DOLT_DIR" ]; then
      echo "resetting local Dolt clone to DoltHub to clear a stuck merge" >&2
      (
        cd "$DOLT_DIR" || exit 0
        dolt merge --abort 2>/dev/null || true
        dolt fetch origin 2>/dev/null || true
        reset_branch="$(dolt branch --show-current 2>/dev/null || echo main)"
        # Name what the reset is about to throw away. On a disposable mirror that
        # is the intended recovery, but a discard nobody can see afterwards is how a caller
        # pointed at the wrong database lost work without a trace.
        discarded="$(dolt log --oneline "origin/${reset_branch}..${reset_branch}" 2>/dev/null || true)"
        if [ -n "$discarded" ]; then
          while IFS= read -r line; do
            echo "::warning::dolt reset --hard discards unpushed local commit: ${line}" >&2
          done <<< "$discarded"
        fi
        dolt reset --hard "origin/${reset_branch}" 2>/dev/null \
          || dolt reset --hard origin/main 2>/dev/null || true
      ) || true
    fi
    sleep "$(( i * 5 ))"
  done
  return 1
}

# dolt_snapshot_retry CMD [ARGS...]
#
# Runs CMD until it succeeds, at most DOLT_SNAPSHOT_ATTEMPTS times (default 3,
# clamped to 1..5), sleeping DOLT_SNAPSHOT_BACKOFF * attempt seconds between
# tries (default 5: waits of 5s then 10s, so a default run gives up within ~15s
# plus the commands' own time). Returns 0 on the first success, 1 once the
# attempts are spent.
#
# For the read-only DoltHub snapshot fetch that a close script uses to VERIFY a
# close. A CI run once went
# red on one failed fetch while the bead was already closed: a single transient
# DoltHub hiccup read as a lost close and invites a hand close that races the
# workflow. CMD runs in THIS shell (not a subshell), so a function
# that records the hash in a global keeps it. Bounded on purpose: these callers
# hold the bead-sync concurrency group.
#
# Retry chatter goes to stderr as plain lines, not annotations: the caller
# raises its own ::error:: when the last attempt fails.
dolt_snapshot_retry() {
  local attempts="${DOLT_SNAPSHOT_ATTEMPTS:-3}" backoff="${DOLT_SNAPSHOT_BACKOFF:-5}" i
  [[ "$attempts" =~ ^[0-9]+$ ]] || attempts=3
  [[ "$backoff" =~ ^[0-9]+$ ]] || backoff=5
  [ "$attempts" -ge 1 ] || attempts=1
  [ "$attempts" -le 5 ] || attempts=5
  [ "$backoff" -le 30 ] || backoff=30
  for (( i = 1; i <= attempts; i++ )); do
    if "$@"; then
      [ "$i" -eq 1 ] || echo "DoltHub snapshot fetch succeeded on attempt ${i}/${attempts}" >&2
      return 0
    fi
    if [ "$i" -lt "$attempts" ]; then
      echo "DoltHub snapshot fetch failed (attempt ${i}/${attempts}); retrying in $(( i * backoff ))s" >&2
      sleep "$(( i * backoff ))"
    else
      echo "DoltHub snapshot fetch failed (attempt ${i}/${attempts}); giving up" >&2
    fi
  done
  return 1
}
