# to_node_path <path>
#
# Converts a path for use as an argument to native `node`, never for `bash`/git
# subcommands. `SCRIPT_DIR="$(cd ... && pwd)"` yields a POSIX-style path
# (/c/git/...) under Git Bash. MSYS normally rewrites that automatically when
# exec'ing a native Windows binary, but a host with MSYS_NO_PATHCONV=1 (or any
# other reason automatic conversion is off) disables that rewrite, so node.exe
# receives the POSIX string unmodified and resolves the leading "/" as the
# CURRENT drive's root, not "C:\" ("/c/git/foo" becomes "C:\c\git\foo"), and the
# module is "not found" before claim.sh can do anything.
#
# cygpath -m produces the Windows form with forward slashes (C:/git/foo), which
# node accepts directly and needs no backslash-escaping. Fall back to the input
# unchanged when cygpath isn't on PATH (non-Windows hosts, where the path was
# already a normal absolute path node can resolve as-is).
to_node_path() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m "$1"
  else
    printf '%s\n' "$1"
  fi
}
