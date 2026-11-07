Vendored from SeriousGeese/agent-tooling. A repository's own incidents and measurements live in its own docs, which link here.

# Shell guidelines for Windows hosts (PowerShell, Git Bash, MSYS)

Read this before your first shell command on a Windows host. Nothing here applies on Linux or
macOS. The cross-platform rules and their evidence are in [shell-guidelines.md](shell-guidelines.md).

`lib/windows-powershell-env.mjs` and its test ship in the `worktree` set. The guard hooks named here
(`block-masked-gates`) are the agent hooks a repository vendors separately. Hatch variables carry the
repository's env prefix (`envPrefix` in `agent-tooling.json`).

## PowerShell and rtk

On Windows hosts PowerShell 5.1 is the default shell, so use `;` not `&&` to chain commands.

`rtk` (the output-compressing wrapper described in [shell-guidelines.md](shell-guidelines.md))
wraps external executables; it does not run PowerShell cmdlets, aliases or script blocks directly.
Run PowerShell itself through it:

```powershell
rtk powershell -NoProfile -Command "Get-Content -LiteralPath 'C:\path\file.md'"
rtk powershell -NoProfile -Command 'Get-ChildItem | Where-Object { $_.Name -like "*.md" }'
```

For multi-statement nested PowerShell that assigns variables, **single-quote the whole `-Command`
script and double-quote inside it**. Otherwise the outer shell strips `$branches` and `$_` before the
inner process runs (symptom: `= : The term '=' is not recognized`):

```powershell
rtk powershell -NoProfile -Command '$branches = git branch --format="%(refname:short)" | Where-Object { $_ -ne "main" }; $branches'
```

**Preserve a native command's exit code across the PowerShell boundary.** When the exact status
controls a workflow decision (for example, an adapter's `0`, `1`, `3`, `5` or `9` outcomes), make
`exit $LASTEXITCODE` the final PowerShell statement:

```powershell
rtk proxy node <your-gate>.mjs; exit $LASTEXITCODE
```

PowerShell's implicit exit can normalize an external-command failure to `1`; explicit propagation
keeps the native status intact. `$?` reports only success/failure and cannot preserve distinctions
such as an adapter's idle timeout (`3`). This applies to Codex `exec_command` when its outer shell
is PowerShell too. A repository can document the boundary, but changing Codex's shell runner itself
requires a change to that runner.

Also quote Git format strings containing `%(...)` in PowerShell. Unquoted, `%(...)` parses as
PowerShell syntax instead of reaching Git.

## Plain git and chained bash commands are refused after EnterWorktree

Both refusals come from the harness's worktree-isolation check, not from the repository's hooks.
Seen in a session that entered a worktree made by `scripts/claim.sh`.

- **Every plain `git ...` in the Bash tool is refused** ("this command runs rtk with a git command
  among its operands ... cannot be shown not to be git. Refusing to run it"), even
  `git -C <worktree path> status`. A user-global RTK PreToolUse rewrite turns `git X` into
  `rtk git X`, and the check cannot prove where the wrapped git runs. **The fix is the rtk
  exclusion** in [shell-guidelines.md](shell-guidelines.md#keep-rtk-away-from-git-and-grep). On a
  machine without it, run git through the PowerShell tool, which RTK does not rewrite.
- **`bash a && bash b` is refused** ("bash inside a construct too complex to verify"). Run each gate
  as its own single command, or redirect each to a file and chain with `;`. Read each verdict from
  its own log, never from a chain's last exit code.

## A `powershell.exe` child started under pwsh cannot load `Get-Acl`

**Windows PowerShell 5.1 started from anything pwsh 7 launched inherits PowerShell 7's module
folders first on `PSModulePath`, and then fails to import `Microsoft.PowerShell.Security`**:
`Error in TypeData "System.Security.AccessControl.ObjectSecurity": The member AuditToString is
already present` (and `AccessToString`, `Sddl`, `Access`, `Group`, `Owner`, `Path`), so `Get-Acl` /
`Set-Acl` do not exist in that child. pwsh puts `Documents\PowerShell\Modules`,
`Program Files\PowerShell\Modules` and `Program Files\PowerShell\7\Modules` ahead of 5.1's own
folders, a node script started from a pwsh terminal (Codex's shell, or yours) carries that order,
and a bare `spawn('powershell.exe')` hands it on; 5.1 then autoloads PowerShell 7's copy of the
module. The same import succeeds with 5.1's own path and fails with PS7's folders first.
`CimCmdlets` happens to survive it; `Security` does not.

- **Node code that spawns `powershell.exe` passes `env: windowsPowerShellEnv()`**
  (`scripts/lib/windows-powershell-env.mjs`), which drops PowerShell 7's folders and keeps every
  other entry. `scripts/windows-powershell-env.node-test.mjs` fails a new spawn without it. Run that
  test on a real Windows runner under pwsh in CI.
- **From a shell:** `env -u PSModulePath powershell.exe ...` lets 5.1 build its default path, or
  call `pwsh` instead when the script does not need 5.1.
- **Security-critical code should not depend on cmdlet autoload anyway:** use .NET's
  `File` / `Directory` `GetAccessControl` / `SetAccessControl`, which work in either host.

## Git and GitHub auth

**Git and GitHub auth on Windows:** if `GITHUB_TOKEN` is present but invalid (even an empty string)
it overrides Git Credential Manager's valid stored token and breaks `git push`, `git pull` and `gh`.
Unset it first: PowerShell `$env:GITHUB_TOKEN = $null`; bash `unset GITHUB_TOKEN`, or per-command
`env -u GITHUB_TOKEN gh ...`.

## `.cmd` shims and Git Bash's bundled grep

**A `|` inside an ARGUMENT is eaten by any `.cmd` shim.** `npx.cmd jest --testPathPatterns 'a|b'`
dies with `'b' is not recognized ...` (exit 255): the shim re-parses the whole line through
cmd.exe, which treats the (unquoted at that layer) `|` as a pipe, and POSIX quoting does not survive
the hand-off. Regex alternation is the natural place this bites. Call the JS entrypoint instead:
`node node_modules/jest/bin/jest.js --testPathPatterns 'a|b'`. A masked-gate guard has to recognise
that form as a gate, or `node node_modules/jest/bin/jest.js ... | tail` goes through unblocked: the
invocation this paragraph prescribes would be the one shape the guard could not see. The guard
matches on the PACKAGE under `node_modules`, so `.bin/jest`, `jest/bin/jest.js`,
`typescript/bin/tsc` and `vitest/vitest.mjs` all count, while `next` and `playwright` still need
their `build` / `test` subcommand.

**Git Bash's bundled `grep` (GNU grep 3.0) ABORTS on `-F` combined with `-i`**, clustered (`-Fi`,
`-iF`) or as separate flags (`grep -F ... -i ...`), with `Aborted (core dumped)`, exit 134;
`LC_ALL=C` does not save it. `grep -F` alone and `grep -i` alone both work. The dangerous shape is
a NEGATIVE assertion built on the combo: `if grep -Fi 'x' log; then fail ...; fi` reads the abort
as "no match" and passes silently. CI usually runs on Linux, where GNU grep does not abort, so this
is Windows-local-only and CI never sees it. Use `-F` and `-i` as separate `grep` calls, or the Grep
tool (or `git grep` / `rtk proxy grep` when the harness has no Grep tool). A guardrail test can fail
on any tracked script or workflow file invoking `grep`/`egrep`/`fgrep` with both active in one
call.

## Git Bash path mangling

**Windows Git-Bash path mangling is a CLASS, not a fixed list of commands.** Assume MSYS's heuristic
may rewrite ANY argument that looks like a Windows path, **including an env-var assignment**, not
just the specific shapes below. Each known instance cost a real diagnosis cycle:

- `git show <rev>:<path>` is rewritten by MSYS path conversion (`origin/main:x` becomes
  `origin\main;x`) and git reports a bogus *"ambiguous argument ... unknown revision"*. The tell is
  the backslashes and `;` in the error's own quoting. Prefix with `MSYS_NO_PATHCONV=1`. Any argument
  combining a colon with slashes is vulnerable (`docker run -w /work` mangles the same way), while
  `--pretty=format:%H` is safe (no slashes). **Never pair a `rev:path` read with a
  `|| echo` / `grep -q` fallback when verifying a claim:** the mangle makes git fail like the file is
  absent, and the fallback converts that into a confident FALSE CLEAN.
- **`MSYS_NO_PATHCONV=1` is the TRIGGER for a separate failure mode, not a fix for one.** It
  suppresses MSYS's argv rewrite for every child process in that shell, not just the `git show` call
  above. So a script handing a raw POSIX temp path to a NATIVE binary (`jq --rawfile`,
  `bd` / `gh --body-file <path>`, a Windows `python3 <path>`) breaks the moment it inherits the same
  env var, because the rewrite was the only reason that path ever resolved. The error names the path
  the binary RECEIVED (`jq: Could not open /tmp/foo: No such file or directory`), which reads like a
  bad rewrite; it is the rewrite being suppressed. Fix: a `<` redirect (opened by BASH, so no path
  crosses the argv boundary either way) or, when the interpreter needs a real path to execute, `cd`
  into its directory and pass a bare relative filename (no slash for MSYS to rewrite in the first
  place).
- **A quoted argument that merely BEGINS with `/` is rewritten too, including plain PROSE.**
  A bead filed with the title `"/deploy has no peer ping..."` is stored as
  `C:/Program Files/Git/deploy has no peer ping...`; `bd create "/conditions/ renders prose..."`
  does the same. No error, no warning, and the corrupted title is what the active log, `bd list` and
  every later sweep show. Quoting does not protect it, it fires on a single token, and every other
  case in this list is path-SHAPED, where you are at least thinking about paths, so nothing cues the
  check here. A repository whose slash commands are named like paths (`/bead`, `/asks`) steers you
  into it: a bead about one opens with its name. Prefix with `MSYS_NO_PATHCONV=1`, or reword so the
  title does not lead with the slash, and **read the field back after any `bd create` / `bd update`
  whose title begins with `/`**. `oddity.mjs` (in the `hygiene` set) repairs this one shape in a title
  through `repairMsysMangledTitle` and says so loudly; `bd`, `gh pr create --title` and every other
  free-text CLI do not.
- `sha256sum` / `md5sum` on a backslash-bearing path emit an ESCAPED output line (`\<hash>  <path>`),
  silently shifting `cut` / `awk` fields so every comparison mismatches, uniformly, which reads as a
  real finding. Prefer `cmp` for identity checks, or feed hashing tools forward-slash paths.
- Shell `grep -E` with a bracket character class (e.g. `[*^$]`) can have its pattern altered before
  grep sees it, returning thousands of bogus matches. Same family as `rtk` eating patterns that
  start with `/`. Use the dedicated Grep tool (or `git grep` / `rtk proxy grep` when the harness
  has no Grep tool) for any pattern with a character class, anchor, or leading `/`, and treat an
  implausibly large match count as a tooling failure to re-run differently, never as a result.
- A shell-level `export PATH="$WIN_STYLE_PATH:$PATH"` gets the same rewrite, and unlike the cases
  above, it **fails silently upward into a green result** instead of a visible error. A hermeticity
  test that puts a hard-failing interceptor ahead of `PATH` this way can pass while the interceptor
  was never actually on `PATH`, proving nothing. Build the path where the test already runs
  instead: Node's `path.delimiter` + `process.env.PATH`, not a shell `export`. The other half of
  the mechanism: even a `C:/...`-form `PATH` entry that survives INTACT is one **bash cannot
  resolve**, so the stub silently shadows nothing; only the POSIX `/c/...` form works. Both failures
  present identically as "my stub is broken".
- The other side of the same confusion: a `/d/Worktrees/x` string literal INSIDE `node -e` code is
  NOT rewritten (bash converts argv, not string literals), and Node resolves it drive-relative
  (`C:\d\Worktrees\x`). Use `D:/...` inside JS. When a probe needs `require` plus top-level
  `await`, write a scratch `.mjs` inside the worktree instead of fighting `-e`
  (`ERR_AMBIGUOUS_MODULE_SYNTAX` on Node 22; Node 24 accepts it).

## Verification traps beyond path mangling

- **An eol/CRLF fix CANNOT be verified on a Windows checkout.** Git Bash's `bash` runs CRLF scripts
  fine (Linux bash exits 2 at line 1), and suites that need real Linux behaviour skip their live
  cases on win32, so a Windows re-verify goes green from three directions while the Linux gate is
  red. The honest local proof is a real Linux run (a node container over an LF-normalized copy,
  `MSYS_NO_PATHCONV=1 docker run ...`). A simulation that builds a "Windows checkout" with
  `git checkout-index -c core.autocrlf=true` cannot produce CRLF for any file covered by a
  `* text=auto eol=lf` attribute, so once the repository carries that attribute, do not reach for
  it. The residual risk it cannot cover (content that never goes through a git checkout at all:
  fetched, generated, or piped in at runtime) still needs the real Linux run.
- **A backgrounded server's captured log can read empty, and its task can report a nonzero exit,
  while the server works fine.** Never conclude "it never started" from the log or exit code alone,
  and never restart onto its port on that evidence. Poll the real condition instead:
  `until curl -sf http://localhost:PORT >/dev/null; do sleep 1; done`. The reported status is wrong
  in the other direction too (see the both-directions rule in
  [shell-guidelines.md](shell-guidelines.md#processes-exit-codes-and-capturing-a-gate)); this bullet
  is the false-RED case only.
- **Scripts in the session scratchpad cannot import repository dependencies** (`better-sqlite3`
  etc.). Node resolution never reaches the repository's `node_modules` from outside it. Run
  `node -e` from the worktree, or write the helper inside the worktree and delete it before
  committing.
- **A redirect to bare `/tmp/...` is not a safe home for gate output.** Workers in one batch got
  `Permission denied` on `npm test > /tmp/out.txt`-style redirects, and a ROOT-level path like
  `/tmp_migrate.log` is `C:\Program Files\Git\tmp_migrate.log` and always fails. The shell rejects
  the redirect BEFORE the command runs, so the gate's own exit code never exists and the error reads
  as the gate exploding: one worker started diagnosing a migration that had succeeded. Stream the
  gate bare, or capture it with `bash scripts/gate.sh <full command>` (the original advice,
  "redirect into `.tmp-gates/`", fails the same way on a fresh worktree, where that directory does
  not exist yet). The `/tmp/...` form is not reproducible from every session (it can map to
  `%LOCALAPPDATA%\Temp`), so treat it as unreliable rather than diagnosable.
- **A pid from Node's `child_process.spawn()` is a native Windows pid, invisible to a DIFFERENT MSYS
  bash's `kill -0`.** Unlike the `/proc` case, the pid namespaces themselves do not line up, so a
  node:test fixture that hands a spawned child's pid to a bash wait loop sees the process as already
  gone even while it is very much alive: a false "the process exited" read, not a false hang. Fix:
  create the process FROM bash, not from Node. `nohup <cmd> >/dev/null 2>&1 & echo $!` run inside a
  throwaway bash puts the pid in the same job-control namespace the checking bash's `kill -0` can
  actually resolve. Keep the `nohup`: without it the backgrounded process dies the moment its
  launching `bash -c` exits, which reads identically to the process never having started. Worked
  example: `backgroundedPid()` in `scripts/worktree-new-await.node-test.mjs`, which documents the same
  distinction inline.
