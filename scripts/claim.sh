#!/usr/bin/env bash
# Usage: bash scripts/claim.sh <issue-id> <feat/branch-name> [--slug <dir-suffix>]
#                              [--wait] [--no-install] [--in-place]
#
# Claims a beads issue through the shared tracker remote and creates a DEDICATED WORKTREE
# for its branch. Claims are published to the tracker remote (the source of truth), no
# direct push to main needed.
#
# Runtime dependencies from other tool sets (vendor them with --set, see the README):
#   scripts/agent-actor-id.mjs    per-session claim identity (base)
#   scripts/bd-dolt-sync.mjs      verified pull/push of the tracker (the `beads` set)
#   scripts/worktree-new.sh       the worktree half (this set)
#   the `bd` CLI on PATH
# A missing script is reported by name, with the set that ships it, before anything is
# synced or claimed.
#
# WORKTREE-FIRST, not checkout-first. This script used to end with
# `git checkout -b "$BRANCH"`, which, combined with the on-main precondition below,
# meant the only checkout it would run in was the SHARED primary one, and it left that
# checkout sitting on a feature branch. That is exactly what a multi-session repository
# forbids ("never switch branches in the main checkout"), and it was observed stranding
# the shared checkout twice on 2026-08-22. Any concurrent session using that checkout
# inherits the wrong HEAD, the same failure class as an orchestrator's worktree collision,
# arrived at through the sanctioned helper rather than a harness bug.
#
# The invoking checkout's HEAD is now left untouched. Worktree creation is delegated to
# scripts/worktree-new.sh, which already fails loudly on an existing directory or branch,
# verifies isolation, publishes the branch immediately, and installs deps in the
# background. --in-place restores the old behaviour for someone who deliberately wants to
# branch the current checkout.
#
# Env:
#   AGENT_TOOLING_CLAIM_COLLISION_HOURS  fresh-claim window for the refusal below (default 4)
#   AGENT_TOOLING_ALLOW_CLAIM_STEAL=1    deliberately take over another actor's fresh claim
#   AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1  claim under a shared (non-session) identity

set -euo pipefail

# Resolve directory aliases before invoking Node helpers (/home -> /var/home on some hosts).
SCRIPT_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/lib/to-node-path.sh"
# The repository's own names (here: the claim helper's path, for the hints below).
source "$SCRIPT_DIR/lib/agent-config.sh"
agent_config_load
# Native `node` (not bash) needs a Windows-native path on a host where MSYS's
# automatic argument conversion is off: SCRIPT_DIR's POSIX form otherwise
# resolves as C:\c\... instead of C:\... . Bash/git subcommands
# keep using $SCRIPT_DIR unchanged.
NODE_SCRIPT_DIR="$(to_node_path "$SCRIPT_DIR")"
CLAIM_CMD="bash $AGENT_CFG_CLAIM_HELPER"

# A cross-set runtime dependency that is not vendored: say which set ships it and stop
# before anything is synced or claimed, rather than failing mid-way on a missing file.
require_script() {
  local file="$1" shipped_by="$2"
  if [[ ! -f "$SCRIPT_DIR/$file" ]]; then
    echo "ERROR: $file is not vendored here, and $AGENT_CFG_CLAIM_HELPER needs it ($shipped_by). Nothing was synced or claimed." >&2
    echo "  Re-run the sync with the missing set added, e.g. --set asks,beads,worktree." >&2
    return 1
  fi
}

ISSUE_ID="" BRANCH="" SLUG="" IN_PLACE=0 CLAIM_ONLY=0
WT_ARGS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --slug) SLUG="${2:-}"; shift 2 ;;
    --in-place) IN_PLACE=1; shift ;;
    --claim-only) CLAIM_ONLY=1; shift ;;
    --wait|--no-install) WT_ARGS+=("$1"); shift ;;
    -h|--help) awk 'NR == 1 {next} /^#/ {sub(/^# ?/, ""); print; next} {exit}' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$ISSUE_ID" ]]; then ISSUE_ID="$1"
      elif [[ -z "$BRANCH" ]]; then BRANCH="$1"
      else echo "Unexpected argument: $1" >&2; exit 1
      fi
      shift ;;
  esac
done

# --claim-only: just the bead half: sync, per-session identity, stale-
# attribution clearing, claim, publish. No on-main precondition, no git pull, no
# worktree, no branch argument. For a session that is ALREADY inside a worktree and
# wants a second bead; without this every such session hand-replicated the
# clear-then-claim logic below.
if [[ -z "$ISSUE_ID" || ( -z "$BRANCH" && "$CLAIM_ONLY" != "1" ) ]]; then
  echo "Usage: $CLAIM_CMD <issue-id> <feat/branch-name> [--slug <dir-suffix>] [--wait] [--no-install] [--in-place]"
  echo "       $CLAIM_CMD <issue-id> --claim-only      # from inside an existing worktree"
  echo "Example: $CLAIM_CMD abc12 feat/my-feature"
  exit 1
fi
if [[ "$CLAIM_ONLY" == "1" && ( -n "$BRANCH" || "$IN_PLACE" == "1" || ${#WT_ARGS[@]} -gt 0 ) ]]; then
  echo "ERROR: --claim-only takes no branch and no worktree options." >&2
  exit 1
fi

# Strip the type prefix (feat/, fix/, chore/, ...) and flatten any remaining separators.
# The old trailing echo substituted only 'feat/' and pasted the rest verbatim, so a
# fix/ branch produced `../<repo>-fix/my-branch`, a nested directory under a stray
# parent rather than a sibling worktree.
if [[ -z "$SLUG" ]]; then
  SLUG="${BRANCH#*/}"
  SLUG="${SLUG//\//-}"
fi

# Per-session claim identity (2026-08-22 collision follow-up).
# `bd --claim` writes the resolved actor into issues.assignee, resolving
# $BEADS_ACTOR -> git user.name -> $USER. Unset, every session of one person
# claims under the SAME name, so you cannot tell which of your own sessions owns
# a bead and the claim-age check below cannot catch a same-person collision.
# scripts/agent-actor-id.mjs is the single source of truth for this string, so do
# not inline a different derivation here.
#
# REFUSE a shared identity HERE, before any pull, sync or bd write.
# This used to warn and carry on, and when the helper found no session id it simply
# printed the bare base: from a Codex session it announced "Claiming as: <person>"
# and published that. A PreToolUse hook is a Claude-only boundary, so
# the helper has to hold the line itself for every vendor and for a human shell.
# `--check` covers an explicit BEADS_ACTOR too: without a -bot-<8> suffix it is a
# shared name. Escape hatch unchanged.
if [[ -f "$SCRIPT_DIR/agent-actor-id.mjs" ]]; then
  if ACTOR_CHECK="$(node "$NODE_SCRIPT_DIR/agent-actor-id.mjs" --check 2>&1)" && [[ -n "$ACTOR_CHECK" ]]; then
    export BEADS_ACTOR="$ACTOR_CHECK"
    echo "Claiming as: $BEADS_ACTOR"
  elif [[ "${AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR:-}" == "1" ]]; then
    SHARED_ACTOR="$(node "$NODE_SCRIPT_DIR/agent-actor-id.mjs" 2>/dev/null || true)"
    if [[ -n "$SHARED_ACTOR" ]]; then export BEADS_ACTOR="$SHARED_ACTOR"; fi
    echo "WARNING: claiming under the SHARED identity '${BEADS_ACTOR:-bd default}' (AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1)."
  else
    echo "ERROR: refusing to claim $ISSUE_ID under a shared actor identity. Nothing was synced or claimed." >&2
    echo "${ACTOR_CHECK:-agent-actor-id: could not resolve an actor identity (is node on PATH?)}" >&2
    exit 1
  fi
elif [[ "${AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR:-}" == "1" ]]; then
  echo "WARNING: agent-actor-id.mjs is not vendored; claiming under '${BEADS_ACTOR:-bd default}' (AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1)."
else
  require_script agent-actor-id.mjs "the base files"
  exit 1
fi
require_script bd-dolt-sync.mjs "the beads set" || exit 1
require_script claim-age.mjs "the worktree set" || exit 1
if [[ "$CLAIM_ONLY" != "1" && "$IN_PLACE" != "1" ]]; then
  require_script worktree-new.sh "the worktree set" || exit 1
fi

CURRENT_BRANCH=$(git symbolic-ref --short HEAD 2>/dev/null || echo HEAD)
if [[ "$CLAIM_ONLY" != "1" ]]; then
  # The on-main precondition applies ONLY to --in-place, the one remaining mode that
  # branches the invoking checkout. The default (worktree) path delegates to
  # worktree-new.sh, which fetches and bases the new worktree on origin/main and never
  # touches this checkout's HEAD, so running it from inside another worktree is legal
  # and is the documented flow for a session picking up an additional bead (the
  # precondition predates the worktree-first rewrite and guarded a
  # `git checkout -b` ending this script no longer has).
  if [[ "$IN_PLACE" == "1" && "$CURRENT_BRANCH" != "main" ]]; then
    echo "ERROR: --in-place branches THIS checkout, so it must start on main. Currently on: $CURRENT_BRANCH"
    echo "Drop --in-place to get a dedicated worktree instead (works from any branch)."
    echo "Only want the bead? $CLAIM_CMD $ISSUE_ID --claim-only"
    exit 1
  fi

  # Only meaningful when this checkout is on main; the worktree path bases on a freshly
  # fetched origin/main inside worktree-new.sh, and pulling main into a feature branch
  # here would merge it into the invoking checkout as a side effect.
  if [[ "$CURRENT_BRANCH" == "main" ]]; then
    echo "Pulling latest main..."
    git pull origin main
  fi
fi

# VERIFIED sync, not a bare `bd dolt pull`. bd's pull can exit 0 and merge
# NOTHING on a diverged branch, with no conflict to explain it, after which every push is
# rejected while every pull keeps claiming success. bd-dolt-sync.mjs asks the dolt CLI for
# ground truth and merges with it when bd no-opped. Claiming on a stale DB is exactly how
# two sessions end up working the same bead.
echo "Syncing issues from the tracker remote..."
node "$NODE_SCRIPT_DIR/bd-dolt-sync.mjs" pull

# The fresh-claim check (it was once a PreToolUse hook that tried to find every claim
# hidden in a loop, a script or a substitution, and produced a steady stream of false
# refusals; it lives where the claim is made, so it covers every vendor and a human shell).
# Runs AFTER the verified pull, so it judges the claim every other session can see. Refuses
# another actor's in_progress claim younger than AGENT_TOOLING_CLAIM_COLLISION_HOURS
# (default 4); AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 is a deliberate takeover. Fails open on an
# unreadable lookup.
CLAIM_AGE_RC=0
bd show "$ISSUE_ID" --json 2>/dev/null | node "$NODE_SCRIPT_DIR/claim-age.mjs" "$ISSUE_ID" --actor "${BEADS_ACTOR:-}" || CLAIM_AGE_RC=$?
if [[ "$CLAIM_AGE_RC" == "3" ]]; then
  exit 1
fi

# A bead parked back to `open` but still carrying its old assignee is unclaimable
# through `--claim`: bd's guard keys off `assignee` alone and ignores `status`
# (reproduced 2026-08-23). Clear a STALE attribution first, but only
# when the bead is not in_progress. An in_progress bead held by someone else is a
# live claim, and deciding whether to steal it belongs to the age check above, not
# to a helper that quietly blanks the field.
CLAIM_STATE="$(bd show "$ISSUE_ID" --json 2>/dev/null | node -e '
  let s = ""; process.stdin.on("data", d => s += d).on("end", () => {
    try {
      const j = JSON.parse(s); const o = Array.isArray(j) ? j[0] : (j.issues ? j.issues[0] : j);
      process.stdout.write(String(o.status ?? "") + "\t" + String(o.assignee ?? ""));
    } catch { process.stdout.write("\t"); }
  });' 2>/dev/null || printf '\t')"
CLAIM_STATUS="${CLAIM_STATE%%	*}"
CLAIM_ASSIGNEE="${CLAIM_STATE#*	}"
if [[ -n "$CLAIM_ASSIGNEE" && "$CLAIM_STATUS" != "in_progress" && "$CLAIM_ASSIGNEE" != "${BEADS_ACTOR:-}" ]]; then
  echo "Clearing stale attribution '$CLAIM_ASSIGNEE' (bead is '$CLAIM_STATUS', not in_progress)..."
  bd update "$ISSUE_ID" -a ""
fi

echo "Claiming $ISSUE_ID..."
bd update "$ISSUE_ID" --claim

# A rejection here means another session pushed between our pull and this push: routine
# under concurrency and self-healing, so the helper pulls and retries once rather than
# leaving the claim invisible to every other session.
echo "Publishing claim to the tracker remote..."
node "$NODE_SCRIPT_DIR/bd-dolt-sync.mjs" push

if [[ "$CLAIM_ONLY" == "1" ]]; then
  echo ""
  echo "Done. Claim for $ISSUE_ID is live on the tracker remote, visible to all agents immediately."
  echo "No branch or worktree was created (--claim-only); git is untouched, still on $CURRENT_BRANCH."
  exit 0
fi

if [[ "$IN_PLACE" == "1" ]]; then
  echo "Creating branch $BRANCH IN PLACE (--in-place)..."
  echo "WARNING: this switches THIS checkout onto $BRANCH. If this is the shared primary"
  echo "         checkout, other sessions will inherit the wrong HEAD."
  git checkout -b "$BRANCH"
  echo ""
  echo "Done. Claim for $ISSUE_ID is live on the tracker remote, visible to all agents immediately."
  echo "You are now on branch $BRANCH."
  exit 0
fi

echo "Creating dedicated worktree for $BRANCH..."
bash "$SCRIPT_DIR/worktree-new.sh" "$SLUG" "$BRANCH" ${WT_ARGS+"${WT_ARGS[@]}"}

echo ""
echo "Done. Claim for $ISSUE_ID is live on the tracker remote, visible to all agents immediately."
echo "This checkout is untouched and still on $CURRENT_BRANCH."
