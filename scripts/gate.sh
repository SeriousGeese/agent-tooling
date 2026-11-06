#!/usr/bin/env bash
# scripts/gate.sh, run a gate so its VERDICT survives, whatever loses it.
#
# WHY THIS EXISTS.
#
# Three independent ways a gate's result has been lost, all of
# which read as a real answer rather than as tooling failing:
#
#   1. A BACKGROUNDED gate's reported exit code is not trustworthy in either
#      direction. A backgrounded `npm test` that finished with three failing
#      suites was reported to the agent as exit 0, a false GREEN,
#      the mirror of the already-documented false RED where a healthy
#      backgrounded server's task reports nonzero. The fix is not a better exit
#      code; it is to put the verdict in the OUTPUT, where nothing between the
#      shell and the reader can drop it.
#
#   2. The obvious hand-rolled capture puts the verdict in the WRONG PLACE:
#          npm test > .tmp-gates/out.txt 2>&1; echo "EXIT:$?"
#      the `echo` goes to the TERMINAL, not into the redirect, so the captured
#      artefact you read later contains no verdict at all.
#
#   3. That same line fails at SHELL level on a fresh worktree, because
#      `.tmp-gates/` does not exist yet, the gate never runs, and bash's
#      "No such file or directory" reads like the gate exploding. That is
#      exactly the hole in the usual advice: it said
#      "redirect into `.tmp-gates/` instead of bare `/tmp`" and never said to
#      create it.
#
# So this wrapper: creates `.tmp-gates/`, STREAMS the gate's output (a silent
# capture starves the harness's output watchdog: a silent
# multi-minute step got an agent killed at 600s), captures the
# same bytes to a log, and writes the verdict line INTO THE LOG as well as to
# stdout. It exits with the gate's own status, so it composes with `&&`.
#
# Usage:
#   bash scripts/gate.sh npm test
#   bash scripts/gate.sh --name types npm run type-check
#
# ON A LARGE SUITE THE LOG FILE IS THE READABLE ARTEFACT, NOT THE STREAM
# Streaming is deliberate (the watchdog, above), but `npm test` is
# 1300+ suites at ~180KB and the agent harness caps its own tool-result size, so
# the STREAMED copy is cut off mid-run, before the verdict, before the runner
# summary printed beside it, and before the `captured:` line that would have
# named the log. Output that simply stops is the EXPECTED shape of a big run,
# not the gate exploding and not a hang: do not re-run it, read
# `.tmp-gates/<name>.log` and take the verdict from its last lines. `<name>` is
# the `--name` slug, else the command slugified (`npm test` -> `npm-test`).
#
# `.tmp-gates/` is gitignored. Delete it when you are done with it.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="$ROOT/.tmp-gates"

name=""
if [ "${1:-}" = "--name" ]; then
  if [ -z "${2:-}" ]; then
    echo "gate.sh: --name needs a value" >&2
    exit 2
  fi
  name="$2"
  shift 2
  # The name becomes a filename under .tmp-gates/. A `/` or `..` would write the
  # log outside that directory, or into a subdirectory that does not exist, where the
  # redirect fails and the capture silently loses its log. A bounded plain slug cannot.
  if ! [[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$ ]]; then
    echo "gate.sh: --name must be 1-60 chars of [A-Za-z0-9._-], starting alphanumeric (got: $name)" >&2
    exit 2
  fi
fi

if [ "$#" -eq 0 ]; then
  echo "usage: bash scripts/gate.sh [--name <slug>] <command> [args...]" >&2
  echo "  runs <command>, streams its output, captures it under .tmp-gates/," >&2
  echo "  and writes the EXIT verdict into the log AND to stdout." >&2
  echo "  on a large suite the stream is truncated before the verdict prints -" >&2
  echo "  that is not a crash: read the verdict from .tmp-gates/<name>.log instead." >&2
  exit 2
fi

# Two natural wrong forms both exec down to a bare `command not found` (exit
# 127) with no hint, which reads exactly like a broken gate rather than a
# misused wrapper:
#
#   1. The whole gate passed as ONE quoted string, `"$@"` then execs a
#      program literally named e.g. "npm run type-check:unit-tests".
#   2. A bare npm-script name, `type-check` is not on PATH; `npm run` is
#      what resolves it.
#
# Catch both here, after gate.sh's own option parsing, and exit 2 (a usage
# error) instead of letting them fall through to exec's 127.
has_npm_script() {
  local script="$1"
  [ -f "$ROOT/package.json" ] || return 1
  node -e '
    let pkg;
    try {
      pkg = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    } catch {
      process.exit(1);
    }
    process.exit(
      pkg && pkg.scripts && Object.prototype.hasOwnProperty.call(pkg.scripts, process.argv[2])
        ? 0
        : 1
    );
  ' "$ROOT/package.json" "$script" >/dev/null 2>&1
}

# gate.sh captures exactly one executable invocation. A list of bare npm script
# names (a natural-looking way to ask it to run several gates) would otherwise
# be treated as one command plus arguments and fail with a misleading command
# error. Refuse that shape with an example that preserves one log per gate.
all_args_are_npm_scripts() {
  [ "$#" -ge 2 ] || return 1
  local arg
  for arg in "$@"; do
    has_npm_script "$arg" || return 1
  done
}

if all_args_are_npm_scripts "$@"; then
  echo "gate.sh: accepts one command per invocation; it does not run a list of npm scripts." >&2
  echo "  did you mean: bash scripts/gate.sh --name ${1} npm run ${1} && bash scripts/gate.sh --name ${2} npm run ${2}" >&2
  exit 2
fi

if [ "$#" -eq 1 ] && [[ "$1" == *" "* ]]; then
  echo "gate.sh: one quoted argument runs as a single executable name, not a shell command." >&2
  echo "  did you mean: bash scripts/gate.sh $1" >&2
  exit 2
fi

# A lone word that names an npm script is a script name even when it ALSO resolves
# on PATH: `test` is a shell builtin and /usr/bin/test, so `gate.sh test` would
# otherwise exec test(1), exit 1 with no output and read as a red gate.
if has_npm_script "$1" && { [ "$#" -eq 1 ] || ! command -v "$1" >/dev/null 2>&1; }; then
  echo "gate.sh: '$1' is not a command on PATH, it's an npm script." >&2
  echo "  did you mean: bash scripts/gate.sh npm run $1" >&2
  exit 2
fi

if [ -z "$name" ]; then
  # Slugify the command itself so two different gates do not share a log.
  name="$(printf '%s' "$*" | tr -c 'A-Za-z0-9' '-' | tr -s '-' | sed 's/^-//; s/-$//' | cut -c1-60)"
  [ -n "$name" ] || name="gate"
fi

if ! mkdir -p "$LOG_DIR"; then
  echo "gate.sh: cannot create $LOG_DIR, refusing to run the gate blind" >&2
  exit 2
fi

log="$LOG_DIR/$name.log"
started="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# Truncate, then append: the header must survive the gate's own output.
: > "$log"
printf '=== GATE: %s\n=== started: %s\n\n' "$*" "$started" >> "$log"

"$@" 2>&1 | tee -a "$log"
status="${PIPESTATUS[0]}"

# The verdict goes to BOTH sinks on purpose. Point 2 in the header above is the
# whole reason this script exists: a verdict that only ever reached the terminal
# is absent from the artefact the next reader opens.
verdict="=== GATE VERDICT: $* EXIT:$status ==="
printf '\n%s\n' "$verdict" >> "$log"
printf '%s\n' "$verdict"

# The exit code is a claim about the PROCESS, never about what it ASSERTED
# (a repository's rules usually say so), so pull the runner's own summary line(s) out of
# the captured log and print them right next to the verdict too. This is what a
# reader actually needs, and on a large suite (npm test currently runs 1300+
# suites at ~180KB of output) it is exactly the line the agent harness's output
# truncation drops, forcing a round trip to reopen the log file just to read it.
#
# Supported shapes: jest's default reporter (`Test Suites: …` / `Tests: …`) and
# node --test's TAP reporter (`# tests N` / `# fail N`). A gate with neither
# shape (lint, type-check, build) prints no summary, never fabricate one.
summary=""
if suites_line="$(grep -E '^Test Suites: ' "$log" | tail -n 1)" && [ -n "$suites_line" ]; then
  tests_line="$(grep -E '^Tests: *' "$log" | tail -n 1)"
  summary="$suites_line"$'\n'"$tests_line"
elif tests_tap="$(grep -E '^# tests [0-9]+' "$log" | tail -n 1)" && [ -n "$tests_tap" ]; then
  fail_tap="$(grep -E '^# fail [0-9]+' "$log" | tail -n 1)"
  summary="$tests_tap"$'\n'"$fail_tap"
fi

if [ -n "$summary" ]; then
  printf '%s\n' "$summary" >> "$log"
  printf '%s\n' "$summary"
fi

printf 'captured: %s\n' "${log#"$ROOT"/}"

exit "$status"
