Vendored from SeriousGeese/agent-tooling. A repository's own incidents and measurements live in its own docs, which link here.

# Worktrees and claims: why the ritual is shaped the way it is

Several agents and humans work in one repository at once. The ritual is: claim a bead under your
own identity, work in a dedicated worktree, publish the branch at claim time, verify isolation
before any git-mutating command, and remove only worktrees that are provably yours or landed. Each
rule below exists because the cheaper shortcut failed in a way that was hard to see. Read the
section when a rule looks like ceremony, or when recovering from a broken worktree.

Scripts named here ship in these sets: `claim.sh`, `worktree-new.sh`, `worktree-rm.sh`, `land.sh`
and `session-lock.mjs` in the `worktree` set; `repair-hookspath.mjs` in the `session` set;
`agent-actor-id.mjs` in the `asks` set; `bd-dolt-sync.mjs` in the `beads` set; `gate.sh` in the
`gate` set. Hatch variables carry the repository's env prefix (`envPrefix` in
`agent-tooling.json`). The Dolt side
of the same ritual (sync, locks, conflicts) is in [beads-sync.md](beads-sync.md).

## Contents

- [Session start](#session-start)
- [Peer pings need `crossSessionInbound`](#peer-pings-need-crosssessioninbound)
- [Publish the branch at claim time](#publish-the-branch-at-claim-time)
- [Reading a claim correctly](#reading-a-claim-correctly)
- [One identity per session](#one-identity-per-session)
- [`claim.sh` does not switch your checkout's branch](#claimsh-does-not-switch-your-checkouts-branch)
- [Entering a script-created worktree in Claude Code](#entering-a-script-created-worktree-in-claude-code)
- [Isolation failure modes](#isolation-failure-modes)
- [A fanned-out subagent starts its own dev server](#a-fanned-out-subagent-starts-its-own-dev-server)
- [Removing worktrees: `worktree-rm.sh`](#removing-worktrees-worktree-rmsh)
- [Sizing a wave and choosing the disk](#sizing-a-wave-and-choosing-the-disk)
- [The creation mutex](#the-creation-mutex)
- [Why `worktree-new.sh` exists at all](#why-worktree-newsh-exists-at-all)
- [Which hooks run is `core.hooksPath`, and it can be hijacked](#which-hooks-run-is-corehookspath-and-it-can-be-hijacked)
- [Stale hooks](#stale-hooks)
- [Rebasing inside a worktree](#rebasing-inside-a-worktree)
- [Dependency installs in a worktree](#dependency-installs-in-a-worktree)
- [Resolving append-versus-append conflicts](#resolving-append-versus-append-conflicts)

## Session start

Always sync beads after pulling, or your issue database is stale and you may duplicate work:

```bash
git pull origin main
bd dolt pull
bd prime
```

On a first clone, once per machine, run the repository's setup script. It should repair
`core.hooksPath`, set `beads.role maintainer`, add the DoltHub remote, install the agent
SessionStart hooks and sync issues. Without it beads hooks are silently disabled and the issue
database is stale.

**Codex specifically: a `workdir` passed to `exec_command` is not self-enforcing.** The Claude Code
SessionStart worktree check has no Codex equivalent, so a login profile that resets cwd on shell
start, or a bare `bash` resolving to the WSL launcher instead of Git Bash, can silently defeat an
explicitly requested worktree directory. Pin a stable cwd and an explicit Git Bash path, and run
the isolation checks below from inside the shell you will actually use.

## Peer pings need `crossSessionInbound`

Parallel Claude Code sessions on one machine coordinate with `ListAgents` and `SendMessage` (the
collision ping before a claim, or a product-decision question). By default Claude Code delivers a
peer message only when the sender and the receiver run in the same permission-mode class (bypass
or prompting). Otherwise it holds the message for the receiving user's approval, and an unattended
hold expires unseen. `SendMessage` still returns `success: true`, so the sender reads a ping nobody
got as no objection.

Every maintainer and agent host sets this in the **user** Claude Code settings
(`~/.claude/settings.json`; `%USERPROFILE%\.claude\settings.json` on Windows):

```json
{ "crossSessionInbound": "accept" }
```

- It takes effect in running sessions without a restart.
- It grants peers nothing: a message still cannot approve a permission prompt or get past the
  receiving session's own rules. `hold` and `refuse` are the other values; there is no per-peer
  allowlist.
- A setup script may print a NOTE when it is missing. It must never edit user settings.
- It covers one machine only. A peer on another machine (Remote Control, another contributor) is
  not reached this way, so any cross-machine marker a skill requires (for example a tracker note
  that a gate is pending) stays mandatory.

## Publish the branch at claim time

`worktree-new.sh` pushes the empty branch the moment the worktree exists. That is what makes a
claim visible in git to everyone else. Skip it and you open a window where the bead is claimed in
Dolt but `git branch -r` and `gh pr list` both look empty, which reads to another agent exactly
like an abandoned bead. A real collision of this kind was twenty minutes wide:

```
T+0     session A claims the bead, bd dolt push
T+17m   session B checks gh pr list + git branch -r, sees nothing, re-claims
T+20m   session A opens its PR, three minutes too late
```

**Corollary for the auditing side: the claim is the authority, not the PR list.** A claim
legitimately precedes its branch and PR, so "no branch, no PR" is not evidence a bead is free.
Check `bd show <id> --json` for `assignee` and `started_at` before re-claiming. `claim.sh` refuses a
claim when another actor holds an `in_progress` claim younger than
`AGENT_TOOLING_CLAIM_COLLISION_HOURS` (default 4h), and a PreToolUse hook refuses a bare
`bd update --claim` so claims go through the script. A deliberate takeover of abandoned work uses
`AGENT_TOOLING_ALLOW_CLAIM_STEAL=1` plus a `bd note` saying why.

**The age check holds only through `claim.sh`.** A bare `bd update -a` skips it. The hook therefore
unwraps `bash -c`, `eval`, substitutions and scripts run by path, and fails closed on a script it
cannot read (unreadable, a broken symlink, over 256 KB). Where the command mentions bd or a claim it
also refuses what it cannot resolve statically: a `$VAR` or substitution as the command word or
script path, `eval`/`source` of a non-literal, inline code that runs a command built at run time,
nesting more than four deep. In a tracked, unmodified script only a line that mentions a claim
counts. The refusal reads "could not resolve; use claim.sh or the hatch".

## Reading a claim correctly

- `bd show <id> --json` returns a bare JSON **array**, one element per id. Read `[0]`; there is no
  `{issue: ...}` wrapper.
- The text view's `Owner:` line is the bead's **creator**, not the claim holder. A bead with an
  empty `assignee` still prints an Owner, so auditing claims from the text view reads every
  candidate as taken.
- Plain `bd show` prints `Started:` as a **date only**, which cannot distinguish a 17-minute-old
  claim from a 17-hour-old one. `--json` gives the full timestamp.

## One identity per session

`bd update --claim` writes the resolved actor into `issues.assignee`, resolving `$BEADS_ACTOR`, then
`git user.name`, then `$USER`. With `BEADS_ACTOR` unset, every session belonging to one person
claims under the same name. That is worse than cosmetic: the claim-age check compares the assignee
to your identity and treats a match as "already yours, `--claim` is idempotent", so **two parallel
sessions of the same person sail straight through it**. That is the likelier collision, because a
bulk fan-out is exactly what runs several of one person's sessions at once.

`agent-actor-id.mjs` is the single source of truth for the identity string: the base is slugged
from the git name and suffixed with the first 8 characters of `CLAUDE_CODE_SESSION_ID`. Under
Codex, which injects `CODEX_THREAD_ID` into every command it spawns, the suffix is the **last** 8
characters of the thread id, since Codex thread ids are UUIDv7 and their leading characters are a
shared timestamp. `claim.sh` exports the id before claiming and the hook resolves it identically;
if those diverged, the hook would read your own fresh claim as a stranger's and block it. Do not
re-implement the derivation anywhere else. A bare `bd` call needs
`--actor "$(node scripts/agent-actor-id.mjs)"`.

### Claude Code ids name the window

In Claude Code the id also carries the session's name, the one `ListAgents` and cross-session
messages use: `<base>-bot-<name>-<session8>`. A lead reading `bd show` can then tell which window
holds a claim. The name is read from `~/.claude/sessions/<CLAUDE_PID>.json` (or under
`CLAUDE_CONFIG_DIR`). That file is undocumented harness state, so it is used only when its
`sessionId` is this session's. Any miss falls back to `<base>-bot-<session8>`, and so does Codex.
The suffix stays because a name is two hex characters that recur across a person's sessions, and
it survives `/clear` while the session id does not. Without the suffix, a stale claim from an
earlier task in the same window would read as "already mine". Both formats match one regex,
`DISTINCT_ACTOR_RE`, exported from `agent-actor-id.mjs` for the hook, the friction filer and the
ritual tests. The hook also treats an old-format claim with this session's base and suffix as this
session's, so a claim made before the format changed is not blocked.

### `claim.sh` refuses a shared identity itself

The collision hook trusts any `claim.sh` invocation, and it is a Claude Code PreToolUse hook: no
enforcement boundary at all for Codex or a human shell. If the helper it trusts never checks the
id it resolves, then with no session variable it returns the bare base and publishes a shared
identity. So `claim.sh` gates on `node scripts/agent-actor-id.mjs --check` **before any pull, sync
or `bd` write**, and exits 1 with the remedy when the identity is shared. That includes an explicit
`BEADS_ACTOR` with no `-bot-<8>` suffix, the same rule the hook applies. With no session variable,
set `BEADS_ACTOR=<base>-bot-<8 unique lowercase alphanumerics>` yourself. A deliberately shared
claim uses `AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1`.

Cutover is self-healing: claims written before the rule carry the bare team name, and the hook
treats a bare-base match as possibly-yours rather than blocking your own work. Once a claim carries
a `-bot-<session>` suffix that tolerance no longer applies, so it lapses on its own.

## `claim.sh` does not switch your checkout's branch

The helper once ended with a bare `git checkout -b`, so, given its own on-main precondition, the
only checkout it could run in was the shared primary one, and it left that checkout sitting on a
feature branch. That strands the shared checkout for every other session. The recipe is now:
sync Dolt, claim under the per-session identity, publish the claim, then hand the branch to
`worktree-new.sh`, which creates a dedicated worktree, publishes the branch immediately and
installs dependencies in the background. It prints the absolute path to `cd` into.
`--in-place` restores the old behaviour for a caller who deliberately wants it; nothing else
should reach for it.

```bash
bash scripts/claim.sh <id> feat/<branch-name>     # new bead, new dedicated worktree
bash scripts/claim.sh <id> --claim-only           # already inside a worktree
bash scripts/worktree-new.sh <slug> <branch>      # pure git, no Dolt
bash scripts/worktree-new.sh --await <path>       # block until dependencies finish, BEFORE any gate
bash scripts/land.sh <path>                       # after the PR: wait for merge, then remove
bash scripts/worktree-rm.sh <path>                # when the PR merges
bash scripts/worktree-rm.sh --stale               # list worktrees whose work landed
```

## Entering a script-created worktree in Claude Code

From a session already inside a harness-created worktree that runs `claim.sh <id> <branch>`:

- **Edit and Write into the new worktree are refused ("belongs to a different worktree") until the
  session calls `EnterWorktree` with that path.** After a later switch the previous worktree is no
  longer writable, so finish or commit there first.
- **A subagent cannot do the switching for you.** Its `EnterWorktree` into a different worktree is
  refused, and it can write only to the worktree the lead session is currently in. The lead enters
  the target worktree first, then dispatches. Two subagents in two different worktrees at once is
  not possible: pin both to the session's current worktree, on disjoint files. The prompt to such a
  worker says not to call `EnterWorktree` (workers told to call it were all refused and stopped with
  no changes). A bulk run is therefore serial for writers, and a lead held in one worktree by a
  running worker cannot fix a different PR until it finishes. Read-only reviewers can read other
  worktrees by absolute path.
- Plain `git` and `bash a && bash b` in the Bash tool are refused in that state. Use `git -C <path>`
  and separate calls, or the consumer's shell notes.

## Isolation failure modes

Verify isolation before any git-mutating command:

```bash
git rev-parse --show-toplevel                     # must equal your assigned worktree path
git worktree list | grep "$(basename "$PWD")"     # your directory must appear here
git ls-files | wc -l                              # thousands, not 0
```

The three checks catch different failures and none substitutes for another. A SessionStart hook
that prints a verdict (`OK` or `BROKEN`) covers the first two: treat `BROKEN` as stop-everything,
and an `OK` means the directory is *a* valid worktree, not that it is *yours alone*.

### Failure mode 1: no `.git` link at all

The assigned session directory exists and file edits land in it correctly, but it has no `.git`
link of its own. Every git command run from inside it walks up the directory tree, finds the
PARENT repo's `.git`, and silently operates on that shared checkout instead. `git checkout -b`
there switches the SHARED main checkout's branch out from under any other session using it, while
`git status` and `git diff` in your own session report "clean" because they are inspecting the
wrong tree entirely. This can orphan a finished commit on the shared checkout, to be
garbage-collected before anyone notices.

Recover: check `git -C <parent-repo-path> reflog` for the last `checkout: moving from X to Y` entry
and switch the parent checkout back to `X`, so you do not leave it stranded on a branch you were
never meant to touch. Then create a real worktree yourself
(`git -C <parent-repo-path> worktree add ../<name> -b <branch> origin/main`) and do all further work
there using absolute paths. The Bash tool can target other absolute paths per command even when
the shell's working directory keeps resetting back to the broken session path.

### Failure mode 2: a valid worktree that is not yours

A harness that creates no dedicated worktree for spawned subagents drops them into the LAUNCHING
session's own worktree. There `git rev-parse --show-toplevel == cwd` and `.git` is a file, so the
check above (and the SessionStart hook) FALSELY report OK: the directory really is a valid
worktree, just not a *dedicated* one. Multiple agents then share one working tree, index and HEAD.
One agent's `git checkout -b` silently moves the shared HEAD, and another agent's commits land on
the wrong branch.

**`toplevel == cwd` proves you are in a worktree, not that it is yours alone.** So:

- When an orchestrator assigns you a worktree, verify `toplevel` equals that EXACT assigned path.
- Never run `git checkout -b` or `git switch` inside a worktree you did not create. Your branch is
  pre-assigned; make a NEW worktree instead. A PreToolUse guard enforces this for Claude Code
  (escape hatch `AGENT_TOOLING_ALLOW_WORKTREE_BRANCH_SWITCH=1`).
- An orchestrator spawning parallel workers pre-creates one dedicated worktree per worker and pins
  each worker to its absolute path rather than relying on `isolation: "worktree"`.
- When two orchestrations run against the same epic, partition it up front (disjoint child ranges,
  or one takes an area). Detection is a backstop, not a substitute for splitting the work.

### Failure mode 3: a valid worktree with an empty index

Typically produced when a slow, silent `claim.sh` (silent because of embedded-`bd` lock
contention, see [beads-sync.md](beads-sync.md#embedded-bd-serializes-writes-on-one-lock-and-silence-is-not-a-signal)) is
killed mid-`git worktree add` on the presumption that minutes of silence meant a hang.

The resulting worktree passes every check an agent would think to run: HEAD is set and the branch
is correct; `git rev-parse --show-toplevel` matches the directory; `git push` works;
`git sparse-checkout list` reports "not sparse". But `git ls-files` returns **0** and the working
tree is missing its files. Every content lookup then reports "No such file", which reads as "the
file does not exist in this branch" rather than "this checkout never finished", a much harder
story to catch.

**Detect:** `git ls-files | wc -l` returns several thousand in a healthy tree (the decision
boundary is 0 versus non-zero, not an exact figure).

**Recover**, one command from inside the worktree:

```bash
git reset --hard HEAD
```

`worktree-new.sh` asserts that `git ls-files` is non-empty for every worktree it creates, and
fails loudly with this recovery command before publishing a broken branch. That guard only covers
worktrees created through the script. For a worktree from any other source (a harness-created
directory, or one you are auditing) run the check yourself.

**A second entry point: `--await` racing a still-running creation.** The guard above only runs
inside the creating process. It says nothing about a DIFFERENT process (a worker) that looks at the
same worktree while the checkout is still in flight. If an orchestrator's `worktree-new.sh` call
runs past the Bash tool's timeout and is moved to the background while `git worktree add` is still
checking out, `git worktree list` already lists the entry: git writes the admin entry and starts
checking out before the command returns, so listing it is not evidence the checkout finished. A
worker launched against it that runs `--await` finds no `.npm-install.pid` (creation had not
reached that far) and no `package-lock.json`, can read that as "created with `--no-install`", and
return ready over an empty index.

`--await` therefore has its own two-part check, ahead of every other readiness question:

1. `worktree-new.sh` writes a small marker file, a SIBLING of the destination (so it exists even
   before `git worktree add` creates the directory), right before calling `git worktree add`, and
   removes it only after its own `git ls-files` assertion passes. `--await` waits on that marker,
   bounded by `AGENT_TOOLING_AWAIT_CREATION_DEADLINE_SECONDS` (default 600) with the same
   heartbeat the dependency wait uses. As a backstop for a worktree this script did not create, it
   also waits on git's own transient `locked` file with an "initializing" reason, which recent git
   writes into a worktree's admin dir for the same duration.
2. Once the wait clears (or there was nothing to wait for), `--await` asserts `git ls-files` is
   non-empty itself, independent of whether a marker was ever involved. A worktree that reaches
   this state some other way (a killed process that never wrote or cleaned up a marker, an old git
   without the transient lock) is still caught.

The orchestrator-side half: do not launch a worker on the strength of `git worktree list` alone.
Wait for the `worktree-new.sh` call itself to exit.

## A fanned-out subagent starts its own dev server

If the repository checks in a launch configuration (`.claude/launch.json`), it is in every worktree, so it looks safe to reference by name from
anywhere. But `preview_start({name})` resolves that config against the **LAUNCHING session's** cwd,
not the calling subagent's. A fanned-out subagent that calls it by name from inside its own
dedicated worktree does not start a server there: it starts or attaches to a server rooted in the
**orchestrator's** worktree, talking to the orchestrator's database (a dev DB path that defaults to
`process.cwd()`-relative belongs to whichever process's cwd started the server).

The failure is silent and looks like success: the subagent gets a running server, hits it, sees
plausible responses, and reports its change verified, while it actually verified against a sibling
checkout's code and data.

**The fix is procedural.** It is a property of how the harness resolves a tool call's config, not
something repository code can detect. A fanned-out subagent starts its own dev server inside its
own assigned worktree (a plain backgrounded dev-server command) and attaches with
`preview_start({url: 'http://localhost:<port>'})`, never `preview_start({name})`. Put this in every
implementation-subagent prompt. It cannot become an automated assertion in a hermetic ritual smoke
test: the defect is in the harness's own resolution of a name-based call, which no test inside a
repository checkout can exercise.

## Removing worktrees: `worktree-rm.sh`

Why the script instead of `git worktree remove`:

- On Windows, `git worktree remove --force` **fails with "Filename too long"** (nested
  `node_modules` passes MAX_PATH) while still exiting 0, so the directory silently survives. The
  script detects that and falls back to `rm -rf` plus `git worktree prune`.
- **It refuses a glob.** The worktrees directory is shared by every concurrent session, and a
  `worktree-*` glob destroys other sessions' live worktrees.
- It refuses the primary checkout and any unregistered directory. It warns before deleting about
  uncommitted work, unpushed commits, **or a branch that is pushed but has not landed**.
- **Only remove worktrees you created, or whose branch has already merged.** Removal REFUSES a
  worktree with uncommitted changes and names them; `--force` overrides and discards them
  unrecoverably. Commits survive either way (the branch ref is left behind), so uncommitted work is
  the only thing at stake. An earlier version warned and deleted anyway, which destroyed another
  session's files: "heed the warning" is unactionable when the warning and the deletion print in the
  same non-interactive run.
- **Removal also REFUSES a worktree another live agent session is in**, naming the session;
  `--force-live-session` overrides, and `--stale` never nominates one. Each Claude Code session
  records where it is through `session-lock.mjs touch` (SessionStart, every shell tool call, after
  `EnterWorktree`, SubagentStop, SessionEnd) as one file per AGENT under a session-locks directory
  in the git common dir: the main thread and each subagent (`agent_id` in the hook payload) keep
  their own, so a bulk lead does not unpin its workers, and an agent that moves leaves no lock
  behind. A record is live while its `CLAUDE_PID` process runs and it is under 12h old (2h with no
  pid); a dead or expired one never blocks and is deleted when read. The caller's own session never
  blocks, so `land.sh` and an orchestrator still remove worktrees their session made. A check that
  could not run (the checker missing, a path that resolves to no checkout) REFUSES too: "could not
  look" is never "nobody is there", and removal is the one step nothing undoes. Codex sessions run
  no hooks and record nothing, and a desktop app's own worktree cleanup is outside the repository.
- `--stale` lists worktrees whose branch already **landed** and skips the current worktree. A run
  takes minutes, so SessionStart never runs it: a banner hook prints one line from a cached file in
  the git common dir and refreshes it in the background once a day. Removal re-checks everything,
  so a day-old list is safe to act on.

### The post-removal invariant needs entry-time existence

After removing its argument the script asserts that no OTHER worktree went missing, the
sibling-deletion failure. A check can observe that a registered path is absent; it cannot observe
*causation*, and asserting causation produces false accusations. The normal sequence behind one:

1. A PR merges and the head ref disappears (`delete_branch_on_merge`).
2. `--stale` nominates that branch's worktree and its directory is removed, leaving a dangling
   **registration** in `git worktree list`.
3. An unrelated session removes its own merged worktree. Its `git worktree prune` clears the
   leftover registration from step 2, which is what prune is for.
4. The invariant sees a registered-at-entry path that is absent at exit and calls it damage.

A registration vanishing is the *expected* outcome whenever its directory was already missing, so
the registration list alone can never separate the two cases. The distinguishing fact is **on-disk
existence captured at ENTRY**:

| At entry | At exit | Verdict |
|---|---|---|
| directory **present** | gone, and not the argument | this removal reached a stray path: loud, exit 2 |
| directory **already absent** | gone | a dangling registration got pruned: one informational line, exit 0 |

Pin both halves in tests. The loud half stubs a `git worktree remove` that genuinely deletes a
sibling, so deleting the detection, or widening it to swallow every absent path, turns that test
red rather than quietly buying the quiet half.

Why the accusation matters more than the noise: a tool that accuses its user of destroying a peer's
work on a routine correct run trains sessions straight back onto the broken bare command. Note also
that "the branch is 0 commits past main, so nothing could have been lost" is backwards reasoning:
0 commits ahead is precisely when uncommitted work would be unrecoverable, because no ref holds it.

The prune runs on **both** removal paths, not only the Windows `rm -rf` fallback: `git worktree
remove` clears its own argument's registration and nothing else, so a registration left dangling by
an earlier removal would survive it and read as newly missing on the next run.

### What `--stale` will and will not nominate

`--stale` nominates only on POSITIVE proof that the branch's work reached `origin/main`, and the
proof must survive the remote branch ref being deleted at merge:

| Signal | Effect |
|---|---|
| `upstream_state` returns `upstream` (ancestry, patch-id via `git cherry`, or a merged PR for the head) | eligible |
| `pushed-not-merged` / `unpushed` / `never-pushed` | never nominated |
| an OPEN PR exists for the branch (`gh pr list --head <br> --state open`) | vetoed, whatever the classification |
| no commits of its own | treated as UNSTARTED, needs a merged PR |

Both `gh` lookups are batched once per run and are best-effort: with `gh` missing or
`WORKTREE_RM_SKIP_GH=1`, the merged set only ever *withdraws* a nomination and the open set only
fails to *add* a veto, so going offline never turns a keep into a nominate.

**"Pushed" is not "landed".** If the classifier's fallback treats any branch in sync with its own
remote ref as `upstream`, every ordinary published feature branch with an open PR reads as merged,
under a banner saying removal is safe. The fallback must be conservative, and the open-PR test is a
deliberately redundant second signal that does not share a failure mode with the local-history
tests. Likewise a zero-own-commits branch must be treated as unstarted, never merged: those two are
indistinguishable from local refs once `main` moves past the point the worktree was cut from.

A landed branch means nothing another session still needs is only in that directory, which is why
`--stale`'s own output is a safe removal list even for entries someone else created. Every other
worktree stays off limits. This is a licence to remove the DIRECTORY, not the branch. Heed the
unpushed-work warning if it fires: merged branch plus live session is a real combination
(post-merge follow-up), and unpushed work there is still the only copy.

### A periodic sweep finishes what sessions leave behind

Removal only happens when a session runs `land.sh` to the end. Worse, when `worktree-rm.sh` cannot
delete a directory (another process's cwd is in it, usually the session that made it),
`git worktree remove` has already deregistered it: a husk that `worktree-rm.sh` refuses and
`--stale` never lists. A scheduled sweep closes both gaps. In dry-run mode it lists, and with
`--apply` it deletes: every `--stale` nomination through `worktree-rm.sh <path>` with all its checks
(never `--force`); the paths `worktree-rm.sh` recorded in a pending-delete file when a delete
failed; unregistered directories under the worktree roots, untouched for a day, with no live
session lock, that are empty, hold only build leftovers, or are a dead worktree link whose
remaining files are leftovers. A directory with real files and no live git link is listed and left
alone. A delete the OS refuses is not an error: the next run retries it.

## Sizing a wave and choosing the disk

**Measure, do not infer.** Machines differ in the opposite direction on what binds, so a limit
learned on one reads as universal in prose and is machine-killing on another. Two commands, once per
wave, not once per worker:

```powershell
Get-PhysicalDisk | Select DeviceId,MediaType,FriendlyName
Get-CimInstance Win32_OperatingSystem | Select-Object @{n='FreeGB';e={[math]::Round($_.FreePhysicalMemory/1MB,1)}}
```

- **Any `MediaType` of `HDD`:** the spindle is the budget. Worktree count there is bounded by I/O
  queue depth, never by free space. `node_modules` is hundreds of thousands of small files and every
  gate is random-read heavy, the worst case for a platter: one active worktree doing node work on a
  spindle is fine, three is pathological, and the whole machine (UI included) becomes unusable
  while an NVMe idles. Diagnose before blaming memory or agent count:

  ```powershell
  Get-Counter '\PhysicalDisk(*)\Current Disk Queue Length','\PhysicalDisk(*)\% Idle Time'
  ```

  A queue depth above about 2 per spindle is saturation. The failure is not loud: gate timeouts and
  exit-1-with-no-output results that are indistinguishable from a killed process, which is easily
  misread as an out-of-memory signature.
- **All `SSD`:** the disk is not the problem; size the wave by free RAM and by how many full builds
  are in flight.
- **Budget roughly one concurrent full test run per ~8 GB of FREE RAM.** Bulk workers run scoped
  gates with `--maxWorkers=2` so 3 to 5 of them fit where 3 to 5 full runs do not, so count the
  heavy gates in flight (especially the production build), not the workers.
- **N concurrent sessions is the normal mode and they cannot see each other's worker count.** Assume
  a peer session is spending the same budget beside you: two waves each honouring a cap of 3 still
  put six on one spindle.

### `AGENT_TOOLING_WORKTREE_ROOT`: choosing the disk for a whole wave

A bare slug used to expand one way only, beside the primary checkout, so a fan-out always landed on
the primary checkout's drive. The Claude Code worktree-location setting moves harness-created
SESSION worktrees and nothing else, so fan-out worktrees (the large ones that actually consume the
disk) ignored it. A near-full system drive kills a worker's build with ENOSPC and can corrupt a test
transform cache into bogus suite failures.

```sh
export AGENT_TOOLING_WORKTREE_ROOT=/d/Worktrees      # POSIX form, never D:/Worktrees
bash scripts/worktree-new.sh <slug> <branch>
```

- **Unset changes nothing.** The default is the primary's parent.
- **Not for a lead inside a harness-created worktree whose workers use `EnterWorktree`:** that tool
  refuses any path outside the repository's `.claude/worktrees/`, so such a lead keeps worker
  worktrees there. A separate root is for leads that do not use it.
- **A full path as the slug still wins**, per call. Backslash-separated paths are normalized and
  count as paths too.
- **The POSIX form is the supported one on Windows.** `/d/Worktrees/...` passes through Git Bash
  untouched; `D:/Worktrees/...` is the shape MSYS rewrites (any argument mixing a colon with
  slashes), so do not write it.
- **The parent directory is created on demand**, so a first use of a fresh root needs no `mkdir`.
- **Cross-drive worktrees work**, including `worktree-rm.sh` on both removal paths (`git worktree
  remove` and the Windows `rm -rf` plus prune fallback).
- **Pass `--await` the PATH, not the slug.** A shell without the variable resolves a bare slug
  somewhere else entirely, and `--await` would report on a directory nobody is installing into.
  The "Worktree ready" block prints the exact command.
- `--stale` enumerates from `git worktree list`, so a relocated root needs nothing from it.

## The creation mutex

Several races in `worktree-new.sh` share one cause: a `git worktree add` in flight mutates state
every other git command in the repository reads. The sharpest is the fetch:

```
fatal: bad object worktrees/<name>/HEAD
error: .../origin.git did not send all necessary objects
ERROR: could not fetch origin/main
```

Reproduced deterministically by pointing one worktree's `.git/worktrees/<name>/HEAD` at an OID that
does not resolve: `git fetch` then fails for the WHOLE repository, because its connectivity check
runs `rev-list --not --all` and `--all` enumerates every other worktree's HEAD. No git flag opts
out (`--negotiation-tip` and `fetch.negotiationAlgorithm=noop` both measured no difference).

Retries are only ever as deterministic as their budget. The script takes a `mkdir`-based mutex on
the shared git common dir around the two commands that collide, the fetch that READS every
sibling's HEAD and the add that WRITES ours, and releases it **before** the push. `mkdir` is
atomic on Windows and Linux alike; `flock` does not exist under MSYS. Everything expensive stays
parallel: the mutex covers a fraction of a second of local git per run and is long gone before the
dependency install, so a wave still installs concurrently. A lock whose owner died is broken after
`WORKTREE_NEW_LOCK_STALE_SECONDS` (300), and holding it too long makes a run proceed unlocked
rather than wedge: it is a throughput guard, never a correctness gate. Escape hatch:
`AGENT_TOOLING_WORKTREE_NO_LOCK=1`. The retries stay as belt and braces, because a human running a
bare `git worktree add` in the same repository holds no such lock.

One more note on classifying transient git errors: a `printf | grep -q` classifier is not exposed
to SIGPIPE under `pipefail`, because bash's `printf` builtin absorbs EPIPE. An EXTERNAL writer is:
`yes 'bad object' | head -c 5M | grep -q 'bad object'` exits 141, a false negative, which is why a
`git cherry | grep -c` guard (count, not quiet match) stays in `worktree-rm.sh`.

## Why `worktree-new.sh` exists at all

Each raw step it wraps has a failure mode that has bitten:

- **`git worktree add -q`.** Without `-q`, every creation dumps about 100 lines of
  `Updating files: N%` into the transcript.
- **Isolation check against the path you ASKED for**, not merely "is this a worktree".
- **Publishes the branch immediately** (see above). A rule you must remember is weaker than a script
  that does it.
- **A real dependency install, in the background**, never a symlinked `node_modules`, which breaks
  bundlers and fabricates unrelated test failures. Backgrounding lets a fan-out install in parallel
  instead of serialized. Always `--await` before a gate: gates against a half-installed tree fail
  like real breakage.
- **A bare `git worktree add` can hang forever when the shared config has `core.fsmonitor=true`:**
  the child `git reset --hard` waits on an fsmonitor daemon for the half-made worktree, leaving an
  empty directory and a `locked` file reading "initializing". `worktree-new.sh` and `worktree-rm.sh`
  run git with `core.fsmonitor=false` (an env override from a small sourced library), and
  `worktree-new.sh` also pins it in the new worktree's own config when `extensions.worktreeConfig`
  is already on. A hand-run add, or a git call that hangs in a worktree, takes the same override as
  a prefix: `GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=core.fsmonitor GIT_CONFIG_VALUE_0=false git ...`.

## Which hooks run is `core.hooksPath`, and it can be hijacked

Everything the staleness section below worries about presumes the repository's hooks run **at
all**. Git runs exactly one hooks directory: whatever `core.hooksPath` resolves to. A repository
that tracks its hooks (for example `.beads/hooks`) typically chains three separate things from
there: the beads shim (`bd hooks run <hook>`); `git lfs` pre-push, post-checkout, post-merge and
post-commit (without which a push of a new image uploads a pointer with no content); and the
repository's own guards (a dropped-files warning, a rebase-in-progress push block, a
`prepare-commit-msg` rebase bail-out). Point `core.hooksPath` anywhere else and **all three vanish
silently**. No error, no warning, and every affected guard is one whose whole job is to warn about
something invisible, so its absence looks exactly like "nothing was wrong".

An older `bd hooks install` can do this: it overwrites the repository's setting, and the value can
be present in both `.git/config` and the per-worktree `config.worktree` of every linked worktree
(`extensions.worktreeConfig` true). A newer bd writes its shims into whatever `core.hooksPath`
already points at and never writes the key itself, which lowers the recurrence risk without
removing it, since any machine can carry an older bd.

**Three traps, in the order they bite:**

- **`bd hooks list` cannot tell you.** It reports `installed` for all hooks while describing
  `.git/hooks`, exactly the directory the repository is supposed to be bypassing. A green
  `bd hooks list` is evidence about beads and about nothing else.
- **Do not grep the config file.** Git writes the key as `hooksPath` and reads it
  case-insensitively, so `grep hookspath .git/config` returns a clean false negative. Ask git.
- **`git config --local` is a write, not a repair.** It cannot see a per-worktree `config.worktree`
  override, and such an override **wins**. Re-running a setup script appears to fix nothing for that
  reason: it sets the right value in the scope that was already being overridden. A fix that only
  clears `.git/config` leaves every existing worktree broken.

**How to check, and how to fix:**

```bash
git config --show-origin --get-all core.hookspath   # every scope, with its file
git rev-parse --git-path hooks                      # what git will actually use
node scripts/repair-hookspath.mjs --check           # verdict; exit 1 on drift, writes nothing
node scripts/repair-hookspath.mjs                   # repair both scopes; silent when healthy
```

The repair clears every per-worktree override first (the scope that wins), then sets
`--local core.hookspath <tracked hooks dir>`, and is silent and non-writing on a healthy machine.
The desired value is deliberately the **relative** path: git resolves a relative `core.hooksPath`
against the top level of the working tree, so the relative form is correct in the primary checkout
and in every linked worktree at once, while an absolute path is right in at most one of them (so one
pointing at the correct directory today is still normalised). Test it against real git fixtures; a
mocked git only asserts someone's belief about scope precedence, which is the thing that was wrong.

Verify a chained hook really fires afterwards rather than trusting the config read:
`git push --dry-run` should show `git lfs pre-push` behaviour and the dropped-files check, and
`git commit` should exercise the beads `prepare-commit-msg` shim.

## Stale hooks

`.claude/settings.json` registers every hook by a RELATIVE path, resolved against the session's
cwd, which is its worktree, and a worktree is pinned to the commit it was created on. A session
whose worktree predates a hook fix keeps executing the OLD file forever, and **restarting Claude
Code resumes into the same worktree and changes nothing**, with nothing on screen to say so.

A SessionStart hook prints a `[hooks-stale]` banner naming the hook files that changed on
`origin/main` since this worktree's fork point. Resolving hook paths from the primary checkout
instead would change how every hook executes and merely relocate the staleness onto the primary,
which lags too. A session's own in-flight hook edits are never flagged (the comparison is
three-dot, against the merge base).

**It fixes the common case first**, inside the same process, so the banner describes the
post-refresh tree (SessionStart hooks run concurrently, so ordering the two inside one process is
the only guarantee). A LINKED worktree that is clean (`status --porcelain --untracked-files=no`
empty), on a branch, and an ANCESTOR of `origin/main` (zero commits of its own) is byte-for-byte
"origin/main as of earlier", so `git merge --ff-only origin/main` cannot lose anything. That is the
state of every fresh harness-created session worktree, which is cut from the primary's HEAD and
inherits its lag. The refresh:

- fetches first (15 s cap, `GIT_TERMINAL_PROMPT=0`, failure ignored) so the comparison is against
  the real `origin/main`;
- runs the merge with `core.hooksPath` pointed at an empty directory, because a post-merge hook
  that runs `bd hooks run post-merge` takes the machine-wide embedded Dolt lock and can block for
  minutes under another session's push burst;
- installs nothing itself when `package.json` or the lockfile changed in the range: it prints the
  `--await` reminder and leaves the install to the dependency hook, which `settings.json` runs right
  after it in the SAME shell command (staleness check, line-ending normalizer, dependency hook).
  That chain is load-bearing: Claude Code runs separate SessionStart hooks concurrently, and the
  normalizer's unlink-then-`checkout-index` racing the merge for `index.lock` can leave files
  deleted. Do not split them back into separate entries.

Anything else (dirty, own commits, detached, an upstream `@{upstream}` that holds commits this
checkout lacks, since moving the local ref would diverge from its remote, git refusing the
fast-forward because of an untracked file main now tracks) is reported as
`NOT fast-forwarded: <reason>` and falls through to the `[hooks-stale]` banner, which carries that
reason. A `.claude/settings.json` change in the range gets its own line: the harness read the old
file at startup, so a hook registered on main still does not run until the session restarts. The
primary checkout is never touched; `AGENT_TOOLING_NO_WORKTREE_REFRESH=1` pins a worktree on
purpose. Test it with a marker-writing `post-merge` hook that must NOT fire during the fast-forward.

**Act on the `[hooks-stale]` banner when it still appears.** It now means the refresh could NOT
run (the tree is dirty, has commits of its own, or is detached) and names why. Rebase the worktree
or start a fresh one: every guard the banner names is currently not protecting you.

The cost of NOT doing this: tooling friction already fixed on `main` gets filed again, by sessions
whose trees predate the fix, and a stale session's agreement is not corroboration. Before blaming a
script or hook, `git fetch origin` and run `git log --oneline origin/main -3 -- <file>`.

## Rebasing inside a worktree

**The safe form:**

```bash
git -c core.hooksPath="$(mktemp -d)" rebase origin/main
```

Not `git rebase --quiet origin/main`, and never piped into `tail`/`head`/`grep`. The same applies to
`git pull --rebase`.

A rebase in a linked worktree can stop after the FIRST pick with that pick's tracked changes
applied but **unstaged**, its new files **untracked**, no conflict markers, no commit created, and
the todo list still carrying the same pick. A `git push origin HEAD:refs/heads/<new>` in that state
pushes plain `origin/main`, because HEAD IS the rebase base until the sequencer commits, and the
branch looks empty. `git rebase --abort` then refuses with "untracked working tree files would be
overwritten by reset".

**Each of the three ingredients hides a different half of the failure:**

1. **`git rebase` runs `prepare-commit-msg` once per pick.** It does NOT run `pre-commit`, which is
   the intuition that makes this surprising. A rebase fires `pre-rebase`, `post-checkout`, then
   `prepare-commit-msg` plus `post-commit` per pick, then `post-rewrite`. If the repository's
   `prepare-commit-msg` runs `bd hooks run prepare-commit-msg`, that takes the machine-wide
   embedded-Dolt lock (N sessions serialize on it) with a long cap. A non-zero `bd` exit that is not
   a timeout (124) or an uninitialised DB (3) propagates, the sequencer's commit fails, and the
   rebase stops mid-pick with no conflict and no marker.
2. **`--quiet` suppresses the reason.** The hint about `git rebase --edit-todo` is all that
   survives; the hook's own output does not. *The hint IS the failure*: a rebase printing
   `--edit-todo` advice has stopped, whatever else it did or did not say.
3. **The pipeline masks the exit code.** `git rebase ... | tail` reports `tail`'s status. Without
   `pipefail` this is the same class as a gate piped into a filter, on a command that mutates the
   tree.

Two defences belong in the tracked hooks. The `prepare-commit-msg` shim returns 0 immediately when
a rebase is in progress, so the Dolt lock is out of the sequencer's path entirely (nothing is lost:
the commits being replayed already carry the messages beads gave them). And a block that runs FIRST
from `pre-push` **refuses** a push while `rebase-merge/` or `rebase-apply/` exists, explaining that
the push would publish the base commit rather than your work (escape hatch
`AGENT_TOOLING_ALLOW_REBASE_PUSH=1`). It fails open on a missing node or an erroring git, because a
pre-push hook that can make pushing impossible is worse than the bug.

Both resolve the state directory with `git rev-parse --git-path rebase-merge`, which is
**worktree-aware**: a linked worktree's git dir is `<primary>/.git/worktrees/<name>`, so a guard
that looked in the primary's `.git` would never fire for the sessions that actually hit this.
`GIT_REFLOG_ACTION` is NOT a usable signal: it is empty inside hooks during a rebase.

## Dependency installs in a worktree

The Claude Code harness creates `.claude/worktrees/<name>` itself and provisions nothing, so those
sessions used to hand-run an install before their first gate, and one that forgot got failures that
look like real breakage (the worktree resolves the PRIMARY's `node_modules` through npm's
lockfile-root heuristic and the bundler then refuses the dev server). A SessionStart hook detects a
linked worktree with no `node_modules`, or one stale against a rebased lockfile, and starts
`worktree-new.sh --install <path>` in the background: the same install block creation uses, so
`--await` works against a harness worktree unchanged. It never touches the primary checkout, never
duplicates an install already in flight, and never symlinks `node_modules`.

`worktree-new.sh --await <path>` fails LOUDLY (non-zero exit) rather than reporting success when it
finds no install running and `node_modules` is either missing or stale against the lockfile. It
also asserts Playwright's PINNED browsers when the tree has Playwright (they live outside the
worktree, so no `node_modules` check can see them) and names the missing revision plus the install
command rather than downloading hundreds of MB into every fan-out worktree.

### Judge the tree, never the exit code

A package manager can fail on a native compile that was never needed, leaving a fully usable tree,
and can also exit 0 over a broken one. One provisioning wave produces four end states, and the exit
code separates none of them:

| # | install exit | Tree | Verdict |
|---|---|---|---|
| 1 | 0 | normal package count, native binding present | clean |
| 2 | **nonzero** | everything unpacked, native binding present | **USABLE, gates run fine** |
| 3 | nonzero | no packages, or packages with no binding | genuinely broken |
| 4 | **0** | *more* directories than healthy, no test runner or compiler | broken, and it exits green |

State 2 is why a caller must never judge by the exit code alone: it throws away a working tree.
State 4 is why it must never judge by "node_modules is non-empty" either. `--await` verifies the
ARTEFACTS a gate reaches for (the core packages, plus a native binding that is either a shipped
`prebuilds/<platform>-<arch>.node` **or** a local `build/Release/*.node`), fails loudly naming
exactly what is missing, and demotes a noisy install log to a warning when the tree checks out. A
missing `build/` directory is evidence of nothing: a successful install of a prebuilt package has
no `build/` either.

When a native dependency ships prebuilt binaries but also a `binding.gyp` and no install script,
npm's implicit rule runs `node-gyp rebuild`, so a plain `npm ci` compiles it every time and fails on
a host with no C++ toolchain. The compile was never needed. The robust provisioning is
`npm ci --prefer-offline --ignore-scripts`, then an explicit `npm rebuild` over every
`hasInstallScript` package **derived from the lockfile, not hardcoded** (so a newly added native
dependency cannot go silently unbuilt in worktrees only), minus the one that ships prebuilds, then
the repository's own postinstall. Keep that sequence in ONE place (`worktree-new.sh --run-install`)
and have every other wrapper delegate to it, so it cannot be half-fixed. A repository-wide
`.npmrc` with `ignore-scripts=true` is the wrong fix: it silences those downloads for CI and the
primary checkout too, and that blast radius cannot be verified from a dev worktree. Concurrency is
at most an aggravator, not the cause: a clean serial install reproduces the failure exactly.

### `--await` exit codes

| code | meaning | what the caller does |
|---|---|---|
| `0` | dependencies are ready | run your gates |
| `1` | dependencies are NOT ready (or the checkout is incomplete) | run no gate; the message names what is missing and the fix |
| `3` | dependencies ready, Playwright's pinned browsers absent | run every gate except the e2e suite |

`--await` is mandatory before every gate with no carve-out, so when the browser case shared exit
`1` with a genuine dependency failure, a change that never touches e2e took a non-zero exit from a
required step for a reason with no bearing on whether its gates could run, and each unsupervised
worker had to decide on its own whether the ritual had just failed. Now `1` means one thing: no gate
may run. `3` stays non-zero, so a `set -e` caller still stops and an e2e task cannot sail past it,
but it is not a reason to stop. It narrows what the code MEANS without promoting it to ground
truth: **judge the TREE, never the exit code**, and the message is still the part to read.

### If you land in a broken worktree anyway

Only after `--await` has returned (never race a backgrounded install: two overlapping installs on
one tree produce end state 4 **while exiting 0**):

```bash
npm ci --ignore-scripts && npm rebuild <the lockfile's install-script packages>
```

then the repository's own postinstall. Never `npm cache clean`: other sessions on the machine read
that cache. If two installs really did overlap, `npm cache verify`, then remove `node_modules` and
reinstall cleanly.

## Resolving append-versus-append conflicts

Serialized work, such as an epic whose children all touch the same registry, types and checker
files, lands as append-versus-append conflicts in the same few files over and over. The advice that
gets passed between sessions is "keep both sides". That is right about **intent** and wrong as an
**instruction**.

**Keep-both-sides is a statement about not losing CONTENT. It is not a safe text operation.**

### Why concatenating breaks

Git places a conflict boundary by longest matching context, not by syntax. When the lines around
the change are identical on both sides, git hoists them **out** of the conflict as shared context,
which drags the boundary *inside* a construct. Each side is then a fragment, and concatenating two
fragments produces a file that parses as garbage.

The self-reinforcing part: **the more similar the rows, the worse it gets.** Two registry rows that
both set the same flag end with the same two lines:

```
    isSecret: true,
  },
```

so git has more identical trailing context to match on, and the boundary lands further inside the
object. A roster with many similar rows makes this **more** likely as it grows. That is a property
of the data, not of the merge.

### The check that makes it safe

Before concatenating, confirm **each side is independently well-formed**:

| shape | each side must own |
|---|---|
| a registry row | its opening `{` and its closing `},` |
| an import block | its own `import {` ... `} from '...';` |
| a JSDoc-led entry | its own `/**` ... `*/` |

Where a side is a fragment, supply the missing piece explicitly rather than relying on the shared
tail: close the preceding row yourself, then open the new one, and let the shared tail close *that*.

### Why you cannot rely on noticing

Real instances of this produced no conflict marker, no git warning and no error pointing at the
damage. What the boundary split, and what the error said:

| what the boundary split | what the error said |
|---|---|
| a JSDoc block, losing a closing `}` **and** an opening `/**` | a compiler `Expression expected` in **a different file** |
| mid-object, which would have **fused** two rows into one | (caught before running) |
| an import block, with the shared `import {` above and a dangling `} from './x';` | parse error |
| a table literal, with the shared `},` after | parse error |
| a JSDoc in a test file, with the shared `/**` above | `tsc` `Expression expected`, about ten lines away |

**The diff looks like a clean append in every one of these.** Reading it does not help. Run the
affected suites after resolving, not just a type-check of the changed file, which is what misses the
cross-file case.

The branch-mechanics hazards of the same serialized-PR setup are separate: merging a stacked PR
deletes the base branch and auto-closes its children, and a bead-close automation must not close on
a merge into a non-default base. Every PR branches from `origin/main` and targets the default
branch; when a slice depends on one that has not landed, wait for it to merge, then branch from the
updated `origin/main`.
