# git-no-fsmonitor.sh, sourced by the worktree scripts (worktree-new.sh, and any teardown script that shares it).
#
# With `core.fsmonitor=true` (the builtin daemon) in the shared .git/config,
# `git worktree add` hangs forever on a fleet of shared hosts: the child `git reset --hard` that does
# the checkout waits on an fsmonitor daemon for the half-made worktree that never
# answers, leaving an empty directory holding only its `.git` file, a `locked` file that
# reads "initializing", and a hung process that outlives the session that started it.
# Seen on 2026-09-28 and again 2026-09-29 and 2026-10-01, on the desktop host, each time
# with a sibling session wedged the same way. The same overrides made the identical
# command finish in about 30s every time. Inside a created worktree every git call also
# printed "error: daemon terminated", and a plain `git lfs status` hung holding
# index.lock.
#
# So these scripts run with the daemon OFF for the git they spawn. The override is
# process-scoped (GIT_CONFIG_COUNT/KEY/VALUE in this script's own environment, inherited
# by its git children, e.g. the `git reset --hard` under `git worktree add`). It writes no
# config file, so the primary checkout and the machine-global config are untouched.
#
# It APPENDS to a caller's GIT_CONFIG_COUNT rather than replacing it, because a caller
# (a test fixture, an orchestrator prompt prefix) may already be using that channel, and a
# later entry for the same key wins, so this one also overrides an earlier fsmonitor=true.
git_disable_fsmonitor() {
  local n="${GIT_CONFIG_COUNT:-0}"
  case "$n" in ''|*[!0-9]*) n=0 ;; esac
  export "GIT_CONFIG_KEY_${n}=core.fsmonitor" "GIT_CONFIG_VALUE_${n}=false"
  export GIT_CONFIG_COUNT=$(( n + 1 ))
}
