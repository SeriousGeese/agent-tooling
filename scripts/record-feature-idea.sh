#!/usr/bin/env bash
# scripts/record-feature-idea.sh
#
# Records a feature idea or feature request as a bead in the repo's beads project.
# Universal — works from any AI agent harness (Hermes, Claude, Gemini, Codex, etc.).
#
# Defaults: P3 priority, deferred (hidden from "bd ready" until 6 months out).
# Override with --priority <P0-P4> and/or --no-defer.
#
# Usage:
#   bash scripts/record-feature-idea.sh "Title" $'Description\nwith multiple lines'
#   bash scripts/record-feature-idea.sh --priority P2 "Title" $'Description'
#   bash scripts/record-feature-idea.sh --no-defer "Title" $'Description'
#   bash scripts/record-feature-idea.sh --priority P1 --no-defer "Title" $'Description'
#   bash scripts/record-feature-idea.sh --priority P2 --defer "2026-10-01" "Title" $'Description'

set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ── Resilient Dolt pull ───────────────────────────────────────
# The two `bd dolt pull`s below are retried with backoff rather than left as bare
# `... || true` calls. When the repo has the shared resilient-pull helper
# (scripts/lib/dolt-resilient-pull.sh) that is used; otherwise the plain retry defined
# below does the same job. This script always runs from a normal checkout (an agent
# invokes it directly, never staged into a bare temp dir by a workflow), so a plain
# sibling lookup is enough.
#
# DOLT_DIR is deliberately NOT set. With it, the helper's 2nd-failure recovery runs
# `dolt reset --hard` on that clone — correct for a disposable CI mirror, destructive here: this
# script runs from a real checkout whose embedded Dolt database every session on the machine
# shares, AFTER `bd create` has committed the new bead locally. A DoltHub blip then discarded the
# bead (and any other session's unpushed bead commits) while this script still printed "Feature
# idea recorded!". Unset, the helper degrades to plain retry-with-backoff. It is UNSET here, not
# merely left unassigned: the helper reads it from the environment, so a DOLT_DIR exported by the
# calling shell (a CI habit carried into a terminal) would otherwise re-enable the reset.
unset DOLT_DIR
BD="${BD_CLI:-bd}"
BEAD_PULL_ATTEMPTS="${BEAD_PULL_ATTEMPTS:-4}"
# shellcheck source=lib/dolt-resilient-pull.sh
if [[ -f "$REPO_DIR/scripts/lib/dolt-resilient-pull.sh" ]]; then
  source "$REPO_DIR/scripts/lib/dolt-resilient-pull.sh"
else
  # No shared helper installed: retry a pull with a growing pause, never reset anything.
  dolt_pull_resilient() {
    local attempt
    for ((attempt = 1; attempt <= BEAD_PULL_ATTEMPTS; attempt++)); do
      if "$BD" dolt pull; then return 0; fi
      sleep $((attempt * 2))
    done
    return 1
  }
fi

# Defaults
PRIORITY=3
DO_DEFER=true
DEFER_UNTIL="+6m"
SOURCE=""

# Parse flags
while [[ $# -gt 0 ]]; do
  case "$1" in
    --priority|-p)
      case "$2" in
        P0|0) PRIORITY=0 ;;
        P1|1) PRIORITY=1 ;;
        P2|2) PRIORITY=2 ;;
        P3|3) PRIORITY=3 ;;
        P4|4) PRIORITY=4 ;;
        *) echo "ERROR: Unknown priority '$2'. Use P0-P4 or 0-4."; exit 1 ;;
      esac
      shift 2 ;;
    --no-defer)
      DO_DEFER=false
      shift ;;
    --defer|-d)
      DEFER_UNTIL="$2"
      DO_DEFER=true
      shift 2 ;;
    --source|-s)
      SOURCE="$2"
      shift 2 ;;
    --help|-h)
      echo "Usage: bash scripts/record-feature-idea.sh [options] \"Title\" \"Description\""
      echo ""
      echo "Options:"
      echo "  --priority, -p P0-P4  Priority (default: P3)"
      echo "  --no-defer             Do not defer the issue (default: deferred)"
      echo "  --defer, -d <when>     Defer until date/time (default: +6m)"
      echo "  --source, -s <text>    Source attribution (e.g. 'Discord: Goose')"
      echo "  --help, -h             Show this help"
      exit 0 ;;
    --*) echo "ERROR: Unknown flag '$1'. Use --help for usage."; exit 1 ;;
    *) break ;;
  esac
done

if [[ $# -lt 2 ]]; then
  echo "ERROR: Title and description required."
  echo "Usage: bash scripts/record-feature-idea.sh [options] \"Title\" \"Description\""
  exit 1
fi

TITLE="$1"
DESCRIPTION="$2"

# Build label string
LABELS="feature-idea"
if [[ -n "$SOURCE" ]]; then
  # Sanitize source for label: lowercase, replace special chars with hyphens
  LABEL_SOURCE=$(echo "$SOURCE" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | sed 's/^-//;s/-$//')
  LABELS="${LABELS},source-${LABEL_SOURCE}"
fi

# Ensure repo is synced
echo "Syncing beads from DoltHub..."
dolt_pull_resilient || echo "WARNING: Dolt pull failed after retries, continuing..."

# Check for duplicates (search title in recent beads)
echo "Checking for duplicates..."
# `bd list --title-contains` lists non-closed beads on every bd version; `bd search` includes closed
# ones since bd 1.3, which would count every closed namesake as a duplicate.
DUPE_CHECK=$(bd list --title-contains "$TITLE" --json -n 0 2>/dev/null || echo "[]")
DUPE_COUNT=$(echo "$DUPE_CHECK" | jq 'length' 2>/dev/null || echo "0")
if [[ "$DUPE_COUNT" -gt 0 ]]; then
  echo "WARNING: Found $DUPE_COUNT potential duplicate(s). Creating anyway..."
fi

# Build description with source attribution
FULL_DESC="$DESCRIPTION"
if [[ -n "$SOURCE" ]]; then
  FULL_DESC="$FULL_DESC"$'\n\n---\n*Source: '"${SOURCE}"$'*'
fi

# Write description to tempfile for safe consumption
TMPFILE=$(mktemp)
printf '%s' "$FULL_DESC" > "$TMPFILE"
# bd's stderr goes here rather than into the captured stdout: a validation warning is not
# part of the JSON, and merging the two is what made the payload unparseable.
ERRFILE=$(mktemp)

echo "Creating bead..."
# --body-file - (not "$TMPFILE"): bd is a native binary with the same MSYS
# argv-path problem as jq — a raw POSIX temp path in argv only
# resolves because MSYS rewrites it, and MSYS_NO_PATHCONV=1 (routine in an
# agent shell) breaks that. Reading the body on STDIN never
# crosses the argv boundary.
# `set -e` is on, so a failing `bd create` would abort the script before the id check
# below ever runs — which is the WORST outcome here, because a create can fail with the
# row already committed (see below). Capturing the status through `|| CREATE_STATUS=$?`
# is the form that keeps `set -e` from killing us and lets the check do its job.
CREATE_STATUS=0
if [[ "$DO_DEFER" == "true" ]]; then
  CREATE_OUTPUT=$(bd create "$TITLE" \
    --type feature \
    --priority "$PRIORITY" \
    --label "$LABELS" \
    --defer "$DEFER_UNTIL" \
    --body-file - \
    --acceptance "Feature idea recorded for future triage." \
    --json < "$TMPFILE" 2> "$ERRFILE") || CREATE_STATUS=$?
else
  CREATE_OUTPUT=$(bd create "$TITLE" \
    --type feature \
    --priority "$PRIORITY" \
    --label "$LABELS" \
    --body-file - \
    --acceptance "Feature idea recorded for future triage." \
    --json < "$TMPFILE" 2> "$ERRFILE") || CREATE_STATUS=$?
fi

rm -f "$TMPFILE"

# Read the id from the JSON's `id` FIELD, never by a regex over the payload.
# bd emits the object's keys sorted, so `description` comes BEFORE `id` — a first-match
# grep therefore returns whatever id-shaped string the DESCRIPTION happened to mention.
# That is not hypothetical: a batch script doing exactly this ran `bd dep add` against ids
# lifted out of prose fragments.
#
# stderr is no longer folded into the captured stdout either. bd writes validation warnings
# there ("missing required sections for ..."), and merging them put non-JSON lines into the
# text this parses as JSON.
BEAD_ID=$(printf '%s' "$CREATE_OUTPUT" | jq -r '.id // .issue.id // empty' 2>/dev/null)

# Echo whatever bd wrote to stderr, now that it is no longer mixed into the parsed
# payload. An `if` rather than `[[ ... ]] && ...`: under `set -e` the one-liner form exits
# the script whenever the test is FALSE, i.e. in the ordinary no-warning case.
if [[ -s "$ERRFILE" ]]; then
  sed 's/^/  bd: /' "$ERRFILE" >&2
fi
rm -f "$ERRFILE"

# No id means the state is UNKNOWN, not "not created". bd runs dolt embedded, so every
# session on this box serializes writes on one lock with no feedback while blocked
# — a create killed by a timeout AFTER the row was committed exits non-zero
# with nothing on stdout while the bead very much exists. Retrying blind duplicates it.
if [[ -z "$BEAD_ID" ]]; then
  echo "ERROR: bd create returned no id (exit $CREATE_STATUS)." >&2
  echo "  The bead may still exist — CHECK before retrying, or you will file a duplicate:" >&2
  echo "    bd list -l $LABELS --json" >&2
  exit 1
fi

# Update status to deferred if flag was set (bd create doesn't have --status)
if [[ "$DO_DEFER" == "true" && -n "$BEAD_ID" ]]; then
  bd update "$BEAD_ID" --status deferred 2>&1 || true
fi

# Push to DoltHub
echo "Syncing to DoltHub..."
dolt_pull_resilient || true
# Never report a push that did not happen as if it had: the bead is committed LOCALLY either way
# (nothing above can discard it — see the DOLT_DIR note at the top), so say where it is.
bd dolt push 2>&1 || echo "WARNING: DoltHub push failed — the bead is recorded LOCALLY only and reaches DoltHub on the next successful 'bd dolt push'."

echo ""
echo "========================================="
echo "  Feature idea recorded!"
echo "  Title:    $TITLE"
echo "  Priority: P${PRIORITY}"
if [[ -n "$BEAD_ID" ]]; then
  echo "  Bead ID:  $BEAD_ID"
fi
echo "  Deferred: $DO_DEFER"
if [[ -n "$SOURCE" ]]; then
  echo "  Source:   $SOURCE"
fi
echo "========================================="