# shellcheck shell=bash
# bd_retry [--no-bd-stderr] <bd args...>
#
# Runs `bd`, and when it fails because ANOTHER bd (or dolt) process holds the embedded Dolt
# database, waits and tries again, a bounded number of times. The beads database is
# single-writer: with many sessions on one checkout family, `bd show`, `bd update` and the
# sync calls failed at once with a Windows file-lock message ("another process has locked a
# portion of the file", "share access flags are incompatible") that reads like a broken
# database. Every such call succeeded within ten attempts a few seconds apart.
#
# Only a lock failure is retried: any other failure returns at once with bd's own exit code
# and stderr. Each wait prints ONE line naming the cause on stderr, which --no-bd-stderr keeps
# (it drops only bd's own stderr, for a caller that used to send it to /dev/null).
#
# Knobs: AGENT_TOOLING_BD_LOCK_ATTEMPTS (default 8, 1 disables the retry) and
# AGENT_TOOLING_BD_LOCK_DELAY_SECONDS (a fixed wait; default a 2, 3, 5, 8 ... second ladder,
# about 40 s in all). The pattern matches bd-dolt-sync.mjs's BD_LOCK_PATTERN; keep them in step.

BD_LOCK_RE='another process has locked a portion of the file|being used by another process|share access flags are incompatible|database is locked|locked by another (dolt|bd) process|fslock'

# True when $1 (a failed command's stderr) is the database lock, not a real error.
bd_lock_error() {
  printf '%s' "$1" | grep -qiE "$BD_LOCK_RE"
}

bd_retry() {
  local keep_err=1
  if [ "${1:-}" = "--no-bd-stderr" ]; then keep_err=0; shift; fi
  local attempts="${AGENT_TOOLING_BD_LOCK_ATTEMPTS:-8}" attempt=1 rc out err errf delay idx
  local -a ladder=(2 3 5 8 8 8 8)
  case "$attempts" in ''|*[!0-9]*) attempts=8 ;; esac
  [ "$attempts" -ge 1 ] || attempts=1
  errf="$(mktemp)"
  while :; do
    rc=0
    out="$(bd "$@" 2>"$errf")" || rc=$?
    err="$(cat "$errf")"
    if [ "$rc" -ne 0 ] && [ "$attempt" -lt "$attempts" ] && bd_lock_error "$err"; then
      idx=$(( attempt - 1 ))
      [ "$idx" -lt "${#ladder[@]}" ] || idx=$(( ${#ladder[@]} - 1 ))
      delay="${AGENT_TOOLING_BD_LOCK_DELAY_SECONDS:-${ladder[$idx]}}"
      echo "bd $1: the beads database is locked by another bd process (attempt $attempt/$attempts); retrying in ${delay}s" >&2
      sleep "$delay"
      attempt=$(( attempt + 1 ))
      continue
    fi
    rm -f "$errf"
    if [ -n "$out" ]; then printf '%s\n' "$out"; fi
    if [ "$keep_err" = 1 ] && [ -n "$err" ]; then printf '%s\n' "$err" >&2; fi
    if [ "$rc" -ne 0 ] && bd_lock_error "$err"; then
      echo "bd $1: the beads database was still locked by another bd process after $attempt attempt(s); another session's bd is running: try again shortly" >&2
    fi
    return "$rc"
  done
}
