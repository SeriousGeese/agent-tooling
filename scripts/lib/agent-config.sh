# agent-config.sh, sourced by the worktree scripts (claim.sh, worktree-new.sh, worktree-dev.sh).
#
# Reads the consumer's `agent-tooling.json` through scripts/agent-tooling-config.mjs, the one
# reader of that file, so a shell script says the repository's own names (its package manager,
# where its worktrees go, how they are named, which commands to print as hints) without any
# consumer's name appearing in the shared copy.
#
#   source "$SCRIPT_DIR/lib/agent-config.sh"
#   agent_config_load                 # from the repository the caller is standing in
#   agent_config_load /some/root      # from an explicit root
#
# Afterwards these are set (each falls back to the neutral default when there is no config
# file, no node, or no config loader next to this file):
#
#   AGENT_CFG_PACKAGE_MANAGER         npm | pnpm | yarn | bun
#   AGENT_CFG_WORKTREE_ROOT           where bare slugs land, relative to the primary checkout
#   AGENT_CFG_WORKTREE_NAME_PATTERN   e.g. <repo>-<slug>
#   AGENT_CFG_CLAIM_HELPER            repo-relative path of the claim script
#   agent_cmd <new|await|install|rm|stale> [name=value ...]
#                                     the configured command template with <name> filled in
#   agent_fill <template> [name=value ...]
#
# Degrades instead of failing: a broken agent-tooling.json is reported on stderr and the
# defaults are used, because a script that creates a worktree must not die on a typo in a
# hint. A missing node is silent (the defaults are what the file would have said).

_AGENT_CONFIG_LIB_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=to-node-path.sh
source "$_AGENT_CONFIG_LIB_DIR/to-node-path.sh"

# The neutral defaults, mirroring DEFAULTS in agent-tooling-config.mjs.
AGENT_CFG_PACKAGE_MANAGER="npm"
AGENT_CFG_WORKTREE_ROOT=".."
AGENT_CFG_WORKTREE_NAME_PATTERN="<repo>-<slug>"
AGENT_CFG_CLAIM_HELPER="scripts/claim.sh"
AGENT_CFG_CMD_NEW="bash scripts/worktree-new.sh <slug> <branch>"
AGENT_CFG_CMD_AWAIT="bash scripts/worktree-new.sh --await <path>"
AGENT_CFG_CMD_INSTALL="bash scripts/worktree-new.sh --install <path>"
AGENT_CFG_CMD_RM="bash scripts/worktree-rm.sh <path>"
AGENT_CFG_CMD_STALE="bash scripts/worktree-rm.sh --stale"

# One node call prints every value as `key<TAB>value`; a broken file warns on stderr.
_AGENT_CONFIG_PROBE='
import { pathToFileURL } from "node:url";
const [, mod, root] = process.argv;
const { tryLoadConfig } = await import(pathToFileURL(mod).href);
const { config, error } = tryLoadConfig(root ? { root } : {});
if (error) process.stderr.write("WARNING: agent-tooling.json is unusable, using the defaults: " + error + "\n");
const s = config.worktreeScripts;
const rows = [
  ["packageManager", config.packageManager],
  ["worktreeRoot", config.worktreeRoot],
  ["worktreeNamePattern", config.worktreeNamePattern],
  ["claimHelper", config.claimHelper],
  ["new", s.new],
  ["await", s.await],
  ["install", s.install],
  ["rm", s.rm],
  ["stale", s.stale],
];
process.stdout.write(rows.map(([k, v]) => k + "\t" + v + "\n").join(""));
'

agent_config_load() {
  local root="${1:-}" mod out key val
  if [ -z "$root" ]; then root="$(git rev-parse --show-toplevel 2>/dev/null || true)"; fi
  mod="$_AGENT_CONFIG_LIB_DIR/../agent-tooling-config.mjs"
  [ -f "$mod" ] || return 0
  command -v node >/dev/null 2>&1 || return 0
  [ -z "$root" ] || root="$(to_node_path "$root")"
  out="$(node --input-type=module -e "$_AGENT_CONFIG_PROBE" "$(to_node_path "$mod")" "$root")" || return 0
  while IFS=$'\t' read -r key val; do
    case "$key" in
      packageManager) AGENT_CFG_PACKAGE_MANAGER="$val" ;;
      worktreeRoot) AGENT_CFG_WORKTREE_ROOT="$val" ;;
      worktreeNamePattern) AGENT_CFG_WORKTREE_NAME_PATTERN="$val" ;;
      claimHelper) AGENT_CFG_CLAIM_HELPER="$val" ;;
      new) AGENT_CFG_CMD_NEW="$val" ;;
      await) AGENT_CFG_CMD_AWAIT="$val" ;;
      install) AGENT_CFG_CMD_INSTALL="$val" ;;
      rm) AGENT_CFG_CMD_RM="$val" ;;
      stale) AGENT_CFG_CMD_STALE="$val" ;;
    esac
  done <<<"$out"
}

# Fill <name> placeholders. Quoted on both sides of the substitution so a value holding `&`
# (a bash 5.2 replacement metacharacter) or a glob character is inserted literally.
agent_fill() {
  local out="$1" kv name val
  shift
  for kv in "$@"; do
    name="${kv%%=*}"
    val="${kv#*=}"
    out="${out//"<$name>"/"$val"}"
  done
  printf '%s' "$out"
}

agent_cmd() {
  local key="$1" template
  shift
  case "$key" in
    new) template="$AGENT_CFG_CMD_NEW" ;;
    await) template="$AGENT_CFG_CMD_AWAIT" ;;
    install) template="$AGENT_CFG_CMD_INSTALL" ;;
    rm) template="$AGENT_CFG_CMD_RM" ;;
    stale) template="$AGENT_CFG_CMD_STALE" ;;
    *) echo "agent_cmd: unknown command key '$key'" >&2; return 2 ;;
  esac
  agent_fill "$template" "$@"
}
