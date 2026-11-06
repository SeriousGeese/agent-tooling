#!/usr/bin/env bash
# worktree-port.sh, deterministic dev-server port for a git worktree/branch.
#
# Why: parallel worktrees can each run their own dev server and test locally in isolation
# (when the app keeps its state per working directory), but they must not collide on a TCP
# port. This maps a branch/worktree name to a stable port so the same worktree always gets
# the same port (predictable across sessions and agents).
#
# A test run may take a BLOCK of three ports, not one: the app on PORT and two stand-in
# services on PORT+1 and PORT+2. So the printed port is always 3100 plus a multiple of
# PORT_STRIDE: two worktrees either get the same port (a loud bind failure) or blocks that
# cannot overlap. Before this, two worktrees one port apart silently shared a stand-in.
#
# Range 3100-3498 deliberately avoids 3000 (a developer's primary dev server) and 3010 (a
# common deploy-helper default). 133 slots is ample for the handful of worktrees ever live at
# once; on the rare bind collision, pass an explicit name or bump the printed port by
# PORT_STRIDE (never by 1).
#
# Usage:
#   PORT=$(scripts/worktree-port.sh)                 # derive from current branch
#   PORT=$(scripts/worktree-port.sh my-branch-name)  # derive from an explicit name
#   PORT=$(scripts/worktree-port.sh) npm run dev
set -euo pipefail

PORT_BASE=3100
PORT_STRIDE=3
PORT_SLOTS=133

name="${1:-}"
if [ -z "$name" ]; then
  name="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || basename "$PWD")"
fi

# cksum is POSIX and deterministic; take its numeric checksum modulo the slot count.
checksum="$(printf '%s' "$name" | cksum | cut -d' ' -f1)"
echo "$(( PORT_BASE + (checksum % PORT_SLOTS) * PORT_STRIDE ))"
