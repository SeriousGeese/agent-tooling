#!/usr/bin/env bash
# worktree-dev.sh, start / stop / reap per-worktree dev servers for local testing.
#
# An app that keeps its state per working directory (a local database resolved from the
# process's cwd, say) lets worktrees run their own dev server in parallel, as long
# as each binds a distinct port. This helper:
#   * computes a stable port from the branch name (scripts/worktree-port.sh),
#   * installs node_modules (a real install, never a symlink) and links .env.local if missing,
#   * starts `<packageManager> run dev` in the background (the manager comes from
#     agent-tooling.json, default npm) and RECORDS it in a shared registry, and
#   * can STOP a worktree's server or REAP orphans whose worktree was removed.
#
# Why a reaper instead of a git hook: git has NO worktree-removal hook (post-checkout
# only fires on creation), so `git worktree remove` cannot trigger cleanup on its own.
# `reap` (wire it into a session-start hook, or run it by hand) kills any tracked
# server whose worktree directory no longer exists, so servers can't pile up.
#
# Env: AGENT_TOOLING_DEV_SERVER_PATTERN, the regex a node command line must match to count as
# a dev server in the untracked-server report (default: server(\.bundle)?\.js).
#
# Usage:
#   scripts/worktree-dev.sh start [--port N]   # start (or reuse) this worktree's server
#   scripts/worktree-dev.sh stop               # stop this worktree's server (the whole package manager → … → node tree)
#   scripts/worktree-dev.sh reap               # kill servers whose worktree is gone (same tree kill)
#   scripts/worktree-dev.sh list               # show tracked servers (and liveness)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
# Shared across all worktrees: the common git dir is the same for every worktree.
REGISTRY="$(git rev-parse --git-common-dir)/worktree-dev-servers.tsv"
# The primary checkout's working tree (main worktree), source of node_modules/.env.local.
# No `exit` in the awk body: an early exit closes
# the pipe, git dies of SIGPIPE, and pipefail makes that a fatal 141 on any machine with
# enough worktrees for git to still be writing.
PRIMARY="$(git worktree list --porcelain | awk '/^worktree /{if(!seen){print $2; seen=1}}')"

touch "$REGISTRY"

# The package manager comes from agent-tooling.json (default npm). Looked up only by `start`,
# the one command that runs it, so stop/reap/list never pay for a config read.
PM="npm"
load_package_manager() {
  if [ -f "$SCRIPT_DIR/lib/agent-config.sh" ]; then
    # shellcheck source=lib/agent-config.sh
    source "$SCRIPT_DIR/lib/agent-config.sh"
    agent_config_load "$REPO_ROOT"
    PM="$AGENT_CFG_PACKAGE_MANAGER"
  fi
}

# What counts as a dev server in the untracked-server report. Exported for the PowerShell
# listing, which matches it with -match.
DEV_SERVER_PATTERN="${AGENT_TOOLING_DEV_SERVER_PATTERN:-server(\.bundle)?\.js}"
export WORKTREE_DEV_SERVER_PATTERN="$DEV_SERVER_PATTERN"

port_for() { bash "$SCRIPT_DIR/worktree-port.sh" "$@"; }

# Remove a worktree path's row from the registry (portable in-place rewrite).
registry_drop() {
  local path="$1" tmp
  tmp="$(mktemp)"
  awk -F '\t' -v p="$path" '$3 != p' "$REGISTRY" > "$tmp" && mv "$tmp" "$REGISTRY"
}

# --- killing what `start` started ---
#
# `start` records the pid of the backgrounded `<packageManager> run dev`. That pid is NOT a process-group
# leader (the background job of a non-interactive script shares the script's group), so
# `kill -- -<pid>` always failed, and the fallback `kill <pid>` reached npm alone. The
# npm → cross-env → tsx → node server.js descendants survived, kept the port and kept
# the app's local database open. Nothing is killed by name or pattern here: `process_tree` walks the
# parent→child links from the one pid this script recorded, and only those pids are signalled.
#
# PID REUSE. A tree kill amplifies a recycled pid: a stale registry row (a crashed session, a
# reboot) can name a pid that an unrelated process now holds, and signalling it would take its
# whole subtree too. So a pid is only ever signalled after proving it is still the PROCESS this
# script saw: `proc_token` is a start-time fingerprint (/proc/<pid>/stat field 22; on Git Bash it
# also carries the winpid; no /proc, e.g. macOS, means no token at all). `start` records the root's
# token in the registry's 4th column; every pid in the tree gets one in a snapshot, and each is
# re-checked immediately before EACH signal (TERM and KILL alike). A mismatch or a vanished pid
# is skipped, never killed. A legacy 3-column row (and a bare .dev-server.pid) has NO token, so
# nothing can prove who holds its pid now: it is never signalled. `stop` and `reap` drop it with
# a warning on stderr, and `start` treats it as not running. (A command-line or cwd look-alike
# check was tried and rejected: neither proves identity, and a wrong guess kills a stranger.)

is_alive() { kill -0 "$1" 2>/dev/null; }

# Git Bash / MSYS (not WSL, which also has powershell.exe on PATH): every MSYS pid has a
# /proc/<pid>/winpid. This is the only place real MSYS differs from Linux for process control.
is_msys() { [ -r "/proc/$$/winpid" ]; }

# A fingerprint of the process currently holding pid $1: stable for its life, different for a
# later process that reuses the number. Empty when it cannot be read (the process is gone).
# Contains no whitespace, so it fits a TSV column and a "<pid> <token>" line.
#
# The ONLY source is /proc/<pid>/stat field 22 (start time in clock ticks since boot), plus the
# winpid on Git Bash. There is deliberately no `ps -o lstart=` fallback: it has one-second
# resolution, so a pid recycled within the same second would pass the identity check. A host with
# no readable /proc/<pid>/stat (macOS) therefore gets an EMPTY token: `start` records a row with no
# 4th column, and `stop` / `reap` treat it like a legacy row (never signalled, dropped with a
# warning to stop that process by hand). Failing safe there is the point; do not add a coarser
# fingerprint to "fix" it. WORKTREE_DEV_PROC_ROOT overrides /proc (the test points it at an empty
# directory to simulate such a host).
proc_token() {
  local pid="$1" proc_root="${WORKTREE_DEV_PROC_ROOT:-/proc}" stat rest f w
  [ -r "$proc_root/$pid/stat" ] || return 0
  stat="$(cat "$proc_root/$pid/stat" 2>/dev/null)" || return 0
  rest="${stat##*) }"   # past the comm field, which may itself hold spaces and parens
  [ -n "$stat" ] && [ "$rest" != "$stat" ] || return 0
  f="$(awk '{print $20}' <<<"$rest")"   # field 22 overall: starttime
  [ -n "$f" ] || return 0
  w=""
  read -r w < "$proc_root/$pid/winpid" 2>/dev/null || true
  w="${w//[$' \r\n']/}"
  printf 'st:%s%s' "$f" "${w:+:w$w}"
}

# True only when live pid $1 is still the process whose start-time token $2 was recorded. An
# EMPTY token (a legacy row) is never ours: there is nothing to compare, so nothing is signalled.
root_is_ours() {
  local pid="$1" want="$2" now
  case "$pid" in ''|*[!0-9]*|0|1) return 1 ;; esac
  [ -n "$want" ] || return 1
  is_alive "$pid" || return 1
  now="$(proc_token "$pid")"
  [ -n "$now" ] && [ "$now" = "$want" ]
}

# One line on stderr for a registry row (or .dev-server.pid) that has no token but names a live pid.
warn_legacy_row() {
  echo "worktree-dev: legacy registry row for pid $1 has no identity token; not killing it. Stop it yourself if it is still your dev server." >&2
}

# One "<pid> <ppid>" line per process. MSYS: /proc/<pid>/ppid, which survives the exec hops that
# break Windows' own ParentProcessId chain. Elsewhere: ps. Setting WORKTREE_DEV_PROC_ROOT (tests
# only) makes the table come from that directory's <pid>/ppid files on every platform, so a test
# can hand the tree walk a fixture tree.
process_table() {
  if is_msys || [ -n "${WORKTREE_DEV_PROC_ROOT:-}" ]; then
    local proc_root="${WORKTREE_DEV_PROC_ROOT:-/proc}" d p
    for d in "$proc_root"/[0-9]*; do
      [ -r "$d/ppid" ] || continue
      p=""
      read -r p < "$d/ppid" 2>/dev/null || true
      p="${p//[$' \r\n']/}"
      [ -n "$p" ] && echo "${d##*/} $p"
    done
  else
    ps -A -o pid= -o ppid= 2>/dev/null || true
  fi
  return 0
}

# $1 and every descendant of it, one pid per line, $1 first, parents before children.
process_tree() {
  process_table | awk -v root="$1" '
    { kids[$2] = kids[$2] " " $1 }
    END {
      n = 0; q[n++] = root; seen[root] = 1
      for (i = 0; i < n; i++) {
        print q[i]
        m = split(kids[q[i]], a, " ")
        for (j = 1; j <= m; j++) if (!(a[j] in seen)) { seen[a[j]] = 1; q[n++] = a[j] }
      }
    }'
}

# Terminate root $1 and everything below it, given the root's registry token $2. Kills nothing at
# all when the root is not provably ours. Never touches this script's own pid. Reads kpt_root /
# kpt_tok / kpt_tree / kpt_snap, which only this function sets.
kill_process_tree() {
  local kpt_root="$1" kpt_tok="$2" kpt_tree="" kpt_snap="" p waited=0 any w
  root_is_ours "$kpt_root" "$kpt_tok" || return 0
  kpt_tree="$(process_tree "$kpt_root")"
  for p in $kpt_tree; do
    kpt_snap="$kpt_snap$p $(proc_token "$p")"$'\n'
  done
  # Test-only seam: a file run between the snapshot and the first signal, so a test can change
  # a pid's token at the one moment a pid-reuse race would. Unset in real use.
  if [ -n "${WORKTREE_DEV_TEST_AFTER_SNAPSHOT:-}" ]; then bash "$WORKTREE_DEV_TEST_AFTER_SNAPSHOT" || true; fi

  if is_msys; then
    # Native Windows children (node.exe spawned by node) are not in MSYS /proc, so each MSYS
    # process in the tree is taken down with `taskkill /T`, which follows the Windows
    # ParentProcessId links below it. `//` keeps MSYS from rewriting the switches. By PID only,
    # and only after the member check above has re-proved the winpid still belongs to it (the
    # MSYS token carries the winpid).
    for p in $kpt_tree; do
      tree_member_ok "$p" || continue
      w=""
      read -r w < "/proc/$p/winpid" 2>/dev/null || true
      w="${w//[$' \r\n']/}"
      [ -n "$w" ] && { taskkill //F //T //PID "$w" >/dev/null 2>&1 || true; }
    done
    return 0
  fi

  for p in $kpt_tree; do
    tree_member_ok "$p" && { kill "$p" 2>/dev/null || true; }
  done
  # Give a graceful shutdown a moment, then KILL whichever of OUR pids is still there.
  while [ "$waited" -lt 25 ]; do
    any=0
    for p in $kpt_tree; do tree_member_ok "$p" && any=1; done
    [ "$any" -eq 0 ] && return 0
    sleep 0.2
    waited=$((waited+1))
  done
  for p in $kpt_tree; do
    tree_member_ok "$p" && { kill -9 "$p" 2>/dev/null || true; }
  done
  return 0
}

# True when pid $1 is still the very process kill_process_tree snapshotted. NO TOKEN, NO SIGNAL:
# the root is held to the registry's token, every other member to the token read at snapshot time,
# and the token must be readable now too and equal. A pid whose token was unreadable at snapshot,
# is unreadable now, or has changed (it exited and the number was reused) is skipped. There is no
# looser fallback, such as "its parent is still in the tree": a recycled pid can satisfy that.
tree_member_ok() {
  local p="$1" want now
  [ "$p" = "$$" ] && return 1
  if [ "$p" = "$kpt_root" ]; then root_is_ours "$p" "$kpt_tok"; return; fi
  is_alive "$p" || return 1
  want="$(awk -v p="$p" '$1 == p {print $2}' <<<"$kpt_snap")"
  [ -n "$want" ] || return 1
  now="$(proc_token "$p")"
  [ -n "$now" ] && [ "$now" = "$want" ]
}

cmd_start() {
  # Reap any orphaned servers first so a fresh start never adds to a growing pile.
  cmd_reap >/dev/null 2>&1 || true
  local port=""
  if [ "${1:-}" = "--port" ]; then port="$2"; fi
  [ -z "$port" ] && port="$(port_for "$(git rev-parse --abbrev-ref HEAD)")"

  # Reuse an already-running server for this worktree.
  local existing existing_tok
  existing="$(awk -F '\t' -v p="$REPO_ROOT" '$3==p{print $1}' "$REGISTRY" | head -1)"
  existing_tok="$(awk -F '\t' -v p="$REPO_ROOT" '$3==p{print $4}' "$REGISTRY" | head -1)"
  # A live pid that is no longer the recorded process (a stale row after a reboot), or a legacy
  # row with no token to compare, is not "running": start proceeds and replaces the row.
  if [ -n "$existing" ] && [ -z "$existing_tok" ] && is_alive "$existing"; then warn_legacy_row "$existing"; fi
  if [ -n "$existing" ] && root_is_ours "$existing" "$existing_tok"; then
    echo "Already running: pid $existing → http://localhost:$(awk -F '\t' -v p="$REPO_ROOT" '$3==p{print $2}' "$REGISTRY" | head -1)"
    return 0
  fi

  load_package_manager
  # Provision the worktree: node_modules + .env.local are gitignored, so a fresh
  # worktree lacks them.
  #
  # node_modules gets a REAL install, never a symlink to the primary checkout. A linked
  # node_modules makes a bundler fail and fabricates dozens of unrelated test failures,
  # the worktree then resolves the primary's dependency tree, so a stale primary silently
  # poisons the worktree (e.g. a type error from a stale SDK that looked like a code
  # bug). Prefer scripts/worktree-new.sh, which installs at creation time in the
  # background; this is the fallback for a worktree made by hand.
  if [ -L "$REPO_ROOT/node_modules" ]; then
    echo "Replacing a symlinked node_modules with a real install (symlinks break bundlers)…"
    rm -f "$REPO_ROOT/node_modules"
  fi
  # Link .env.local BEFORE installing: a repository's postinstall may generate a fresh
  # .env.local (with its own secrets) when none exists. Linking first keeps
  # sharing the primary's, which is what this worktree wants.
  if [ ! -e "$REPO_ROOT/.env.local" ] && [ -f "$PRIMARY/.env.local" ]; then
    ln -s "$PRIMARY/.env.local" "$REPO_ROOT/.env.local"
    echo "Linked .env.local → $PRIMARY/.env.local"
  fi
  if [ ! -e "$REPO_ROOT/node_modules" ]; then
    echo "Installing dependencies ($PM), first run in this worktree, this takes a few minutes…"
    # Delegated so there is ONE install implementation. A bare `npm ci` here
    # node-gyp-rebuilds a native package that ships prebuilds, for no reason, and fails on a
    # Windows box without the VS C++ workload (see worktree-new.sh, "--ignore-scripts").
    bash "$SCRIPT_DIR/worktree-new.sh" --run-install "$REPO_ROOT" \
      || { echo "ERROR: dependency install failed in $REPO_ROOT" >&2; return 1; }
  fi

  local log="$REPO_ROOT/.dev-server.log"
  echo "Starting dev server on port $port (log: $log) …"
  # The backgrounded unit is a `{ …; exit $?; }` group, not a bare `nohup <pm> …`: a background
  # simple command is fork+exec, and on Git Bash every exec swaps the process's winpid and start
  # time, which would make the token recorded below stale. The trailing `exit` keeps this subshell
  # a plain forked bash that outlives nothing it started, so the pid and its token stay stable.
  ( cd "$REPO_ROOT" && { PORT="$port" nohup "$PM" run dev >"$log" 2>&1; exit $?; } & echo $! >"$REPO_ROOT/.dev-server.pid" )
  local pid tok
  pid="$(cat "$REPO_ROOT/.dev-server.pid")"
  tok="$(proc_token "$pid")"
  registry_drop "$REPO_ROOT"
  # 4th column: the root's start-time token, so stop/reap can tell it from a pid reuse.
  if [ -n "$tok" ]; then
    printf '%s\t%s\t%s\t%s\n' "$pid" "$port" "$REPO_ROOT" "$tok" >> "$REGISTRY"
  else
    printf '%s\t%s\t%s\n' "$pid" "$port" "$REPO_ROOT" >> "$REGISTRY"
    echo "worktree-dev: this host exposes no /proc/<pid>/stat, so pid $pid cannot be identity-checked later; 'stop' and 'reap' will not kill it. Stop it yourself." >&2
  fi
  echo "Started pid $pid → http://localhost:$port"
  echo "Tip: 'scripts/worktree-dev.sh stop' before 'git worktree remove'."
}

cmd_stop() {
  local pid tok=""
  pid="$(awk -F '\t' -v p="$REPO_ROOT" '$3==p{print $1}' "$REGISTRY" | head -1)"
  tok="$(awk -F '\t' -v p="$REPO_ROOT" '$3==p{print $4}' "$REGISTRY" | head -1)"
  if [ -z "$pid" ] && [ -f "$REPO_ROOT/.dev-server.pid" ]; then pid="$(cat "$REPO_ROOT/.dev-server.pid")"; tok=""; fi
  if [ -n "$pid" ] && root_is_ours "$pid" "$tok"; then
    # The whole tree this script started (npm → cross-env → tsx → node server.js), not just the manager.
    kill_process_tree "$pid" "$tok"
    echo "Stopped pid $pid ($REPO_ROOT)"
  elif [ -n "$pid" ] && is_alive "$pid"; then
    # A legacy row (no token) or a stale one (the pid now belongs to another process). Drop the
    # row below, signal nothing.
    [ -n "$tok" ] || warn_legacy_row "$pid"
    echo "No running server for $REPO_ROOT (registry pid $pid cannot be proven to be ours; left alone)"
  else
    echo "No running server for $REPO_ROOT"
  fi
  registry_drop "$REPO_ROOT"
  rm -f "$REPO_ROOT/.dev-server.pid"
}

# Kill servers whose worktree directory is gone or is no longer a registered worktree.
cmd_reap() {
  local live_worktrees reaped=0
  live_worktrees="$(git worktree list --porcelain | awk '/^worktree /{print $2}')"
  while IFS=$'\t' read -r pid port path tok; do
    [ -z "${pid:-}" ] && continue
    if [ ! -d "$path" ] || ! grep -Fxq "$path" <<<"$live_worktrees"; then
      if root_is_ours "$pid" "${tok:-}"; then
        kill_process_tree "$pid" "${tok:-}"
        echo "Reaped orphan pid $pid (port $port), worktree gone: $path"
      elif is_alive "$pid"; then
        [ -n "${tok:-}" ] || warn_legacy_row "$pid"
        echo "Dropped stale row for $path: pid $pid cannot be proven to be ours; left alone"
      fi
      registry_drop "$path"
      reaped=$((reaped+1))
    elif ! is_alive "$pid"; then
      registry_drop "$path"   # dead process, prune stale row
    fi
  done < "$REGISTRY"
  [ "$reaped" -eq 0 ] && echo "No orphaned dev servers." || echo "Reaped $reaped orphan(s)."

  # UNTRACKED servers: hand-started ones, `PORT=3109 node server.bundle.js &`
  # from a Bash call, are in no registry, so the sweep above cannot see them, and the
  # "No orphaned dev servers." line above was flatly false while four of them (~12h old)
  # held the local database open. That surfaced as `rm: Device or resource busy` and a
  # migrate FATAL that read like a DATABASE problem, not a process problem.
  #
  # Deliberately REPORT-ONLY: a detector cannot tell a dead session's leftover from a
  # LIVE concurrent session's server, and killing another session's server is the same
  # cross-session damage class as the worktree-glob incident. The incident was made safe
  # only by tracing each pid's parent chain to prove ownership, so that is what the
  # message tells the reader to do.
  report_untracked_servers
}

# Print any live `node … server[.bundle].js` process the registry does not account for.
# Never kills. Windows (Git Bash) goes through PowerShell CIM; elsewhere /proc via pgrep.
#
# "Accounted for" means the process IS a registry pid or DESCENDS from one. An
# exact-pid match alone never fires for a server this script started: `start` records the pid
# of `<packageManager> run dev`, and the process the listing matches is the server.js several levels below
# it (npm → cross-env → tsx → node server.js).
#
# Windows adds mismatches. The registry holds Git Bash (MSYS) pids while CIM reports Windows
# PIDs, so each registry pid is also known by its /proc/<pid>/winpid. CIM's ParentProcessId chain
# BREAKS at every MSYS exec (the subshell → nohup → npm hops each start a new Windows process and
# the creator exits), so the CIM chain alone never reaches the registry pid. Each CIM ancestor that
# is also an MSYS process is therefore mapped back to its MSYS pid and the MSYS ppid chain
# (/proc/<pid>/ppid, which survives exec) is walked from there. As a last resort a server whose
# command line runs from inside a registered worktree also counts as tracked, comparing the
# registry path in both its 8.3 short and long forms (cygpath), since a Temp path such as
# C:\Users\RUNNER~1\… is spelt differently by git and by node. POSIX does not get that path
# fallback: the ppid chain is reliable there, and a path match would hide a second, hand-started
# server in a worktree that also has a tracked one.
report_untracked_servers() {
  local known_pids known_paths="" winpid_map="" untracked=0 line
  known_pids="$(registry_pid_aliases)"
  if uses_windows_listing; then
    known_paths="$(registry_path_forms)"
    winpid_map="$(msys_winpid_map)"
  fi
  while IFS= read -r line; do
    [ -z "$line" ] && continue
    local pid ancestors started cmd rest
    pid="${line%%|*}";       rest="${line#*|}"
    ancestors="${rest%%|*}"; rest="${rest#*|}"
    started="${rest%%|*}";   cmd="${rest#*|}"
    is_tracked_server "$pid" "$ancestors" "$cmd" && continue
    if [ "$untracked" -eq 0 ]; then
      echo "[untracked-servers] Server process(es) NO registry knows about, the sweep above cannot reap these:"
    fi
    untracked=$((untracked+1))
    [ "${#cmd}" -gt 120 ] && cmd="${cmd:0:120}..."
    echo "[untracked-servers]   $pid|$started|$cmd"
  done < <(list_server_processes)
  if [ "$untracked" -gt 0 ]; then
    echo "[untracked-servers] Each may hold a local database open (rm -> 'Device or resource busy',"
    echo "[untracked-servers] migrate FATALs that read like DB problems). Before killing ANY of them, prove"
    echo "[untracked-servers] it is yours: trace the pid's parent chain / command line to YOUR worktree -"
    echo "[untracked-servers] another live session's server looks identical from here."
  fi
}

uses_windows_listing() { command -v powershell.exe >/dev/null 2>&1; }

# Every registry pid, plus (Git Bash) the Windows PID each one maps to. The /proc root is
# overridable only so the node-test can drive the Windows branch from a Linux fixture.
registry_pid_aliases() {
  local proc_root="${WORKTREE_DEV_PROC_ROOT:-/proc}" pid winpid
  while IFS=$'\t' read -r pid _; do
    [ -z "${pid:-}" ] && continue
    echo "$pid"
    if [ -r "$proc_root/$pid/winpid" ]; then
      winpid="$(tr -d ' \r\n' < "$proc_root/$pid/winpid" 2>/dev/null)" || winpid=""
      [ -n "$winpid" ] && echo "$winpid"
    fi
  done < "$REGISTRY"
  return 0
}

# Every registered worktree path, plus (where cygpath exists) its long and 8.3 short forms.
registry_path_forms() {
  local p
  while IFS=$'\t' read -r _ _ p _; do
    [ -z "${p:-}" ] && continue
    echo "$p"
    if command -v cygpath >/dev/null 2>&1; then
      cygpath -m -l "$p" 2>/dev/null || true
      cygpath -m -s "$p" 2>/dev/null || true
    fi
  done < "$REGISTRY"
  return 0
}

# "<winpid> <msys pid>" for every process Git Bash's /proc knows.
msys_winpid_map() {
  local proc_root="${WORKTREE_DEV_PROC_ROOT:-/proc}" d w
  for d in "$proc_root"/[0-9]*; do
    [ -r "$d/winpid" ] || continue
    w="$(tr -d ' \r\n' < "$d/winpid" 2>/dev/null)" || continue
    [ -n "$w" ] && echo "$w ${d##*/}"
  done
  return 0
}

# True when MSYS pid $1, or any MSYS ancestor of it (/proc/<pid>/ppid), is a registry pid.
msys_chain_is_known() {
  local proc_root="${WORKTREE_DEV_PROC_ROOT:-/proc}" p="$1" n=0
  while [ -n "$p" ] && [ "$p" != 0 ] && [ "$p" != 1 ] && [ "$n" -lt 64 ]; do
    grep -Fxq -- "$p" <<<"$known_pids" && return 0
    p="$(tr -d ' \r\n' < "$proc_root/$p/ppid" 2>/dev/null)" || return 1
    n=$((n+1))
  done
  return 1
}

# Lowercased, forward-slashed, `/c/x` → `c:/x`, so a Git Bash registry path and a Windows
# command line compare equal.
normalize_win_path() {
  local s="${1//\\//}"
  if [[ "$s" =~ ^/([A-Za-z])/ ]]; then s="${BASH_REMATCH[1]}:/${s:3}"; fi
  printf '%s' "$s" | tr '[:upper:]' '[:lower:]'
}

# Reads known_pids / known_paths / winpid_map from report_untracked_servers.
is_tracked_server() {
  local pid="$1" ancestors="$2" cmd="$3" p wt msys
  for p in $pid $ancestors; do
    grep -Fxq -- "$p" <<<"$known_pids" && return 0
  done
  if [ -n "$winpid_map" ]; then
    for p in $pid $ancestors; do
      msys="$(awk -v w="$p" '$1 == w {print $2}' <<<"$winpid_map")"
      [ -n "$msys" ] && msys_chain_is_known "${msys%%$'\n'*}" && return 0
    done
  fi
  if uses_windows_listing && [ -n "$known_paths" ]; then
    local ncmd
    ncmd="$(normalize_win_path "$cmd")"
    while IFS= read -r wt; do
      [ -z "$wt" ] && continue
      wt="$(normalize_win_path "$wt")"
      case "$ncmd" in *"${wt%/}/"*) return 0 ;; esac
    done <<<"$known_paths"
  fi
  return 1
}

# Space-separated ppid chain of a POSIX pid, nearest first, stopping at init. Never fails:
# a pid that exits mid-walk just ends the chain.
ancestors_of() {
  local p="$1" out="" n=0
  while [ "$n" -lt 64 ]; do
    p="$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')" || break
    case "$p" in ''|0|1) break ;; esac
    out="$out $p"
    n=$((n+1))
  done
  printf '%s' "${out# }"
}

# One line per candidate: "<pid>|<ancestor pids, space-separated>|<started>|<full command line>".
#
# Every per-pid read tolerates the pid having exited since pgrep listed it. Under
# `set -euo pipefail` a failed `$( … )` assignment used to end this whole subshell, silently
# truncating the listing at the first vanished pid, on a shared host, where other jobs start and
# stop server.js processes all the time, that dropped every later (higher) pid from the report.
list_server_processes() {
  if uses_windows_listing; then
    # ParentProcessId is only trusted when the parent is no younger than the child: Windows
    # reuses PIDs, and a dead parent's PID may now name an unrelated, newer process.
    powershell.exe -NoProfile -Command '
      $procs = @(Get-CimInstance Win32_Process)
      $parent = @{}; $born = @{}
      foreach ($p in $procs) { $parent[[int]$p.ProcessId] = [int]$p.ParentProcessId; $born[[int]$p.ProcessId] = $p.CreationDate }
      $procs |
        Where-Object { $_.Name -eq "node.exe" -and $_.CommandLine -match $env:WORKTREE_DEV_SERVER_PATTERN } |
        ForEach-Object {
          $chain = @(); $cur = [int]$_.ProcessId; $up = $parent[$cur]
          while ($up -and $parent.ContainsKey($up) -and $chain.Count -lt 64 -and $born[$up] -le $born[$cur]) {
            $chain += $up; $cur = $up; $up = $parent[$cur]
          }
          "$($_.ProcessId)|$($chain -join " ")|$($_.CreationDate.ToString("yyyy-MM-dd HH:mm"))|$($_.CommandLine)"
        }' 2>/dev/null | tr -d '\r' || true
  elif command -v pgrep >/dev/null 2>&1; then
    local pid
    for pid in $(pgrep -f "$DEV_SERVER_PATTERN" 2>/dev/null); do
      local cmd started ancestors
      cmd="$(tr '\0' ' ' 2>/dev/null < "/proc/$pid/cmdline")" || continue
      [ -n "$cmd" ] || continue
      case "${cmd:0:120}" in *node*) : ;; *) continue ;; esac
      started="$(ps -o lstart= -p "$pid" 2>/dev/null | sed 's/^ *//')" || started=""
      ancestors="$(ancestors_of "$pid")"
      echo "$pid|$ancestors|${started:-?}|$cmd"
    done
  fi
}

cmd_list() {
  printf 'PID\tPORT\tALIVE\tWORKTREE\n'
  while IFS=$'\t' read -r pid port path; do
    [ -z "${pid:-}" ] && continue
    printf '%s\t%s\t%s\t%s\n' "$pid" "$port" "$(is_alive "$pid" && echo yes || echo no)" "$path"
  done < "$REGISTRY"
}

case "${1:-start}" in
  start) shift || true; cmd_start "$@" ;;
  stop)  cmd_stop ;;
  reap)  cmd_reap ;;
  list)  cmd_list ;;
  *) echo "usage: $0 {start [--port N]|stop|reap|list}" >&2; exit 2 ;;
esac
