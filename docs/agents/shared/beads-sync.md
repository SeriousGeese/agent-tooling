Vendored from SeriousGeese/agent-tooling. A repository's own incidents and measurements live in its own docs, which link here.

# Beads and Dolt sync: troubleshooting and recovery

Rules live in the consuming repository's agent rulebook. This file is the reasoning behind them,
plus every recovery recipe. The worktree side of the same ritual is in
[worktrees-and-claims.md](worktrees-and-claims.md).

**Architecture in one line:** issues live in an embedded Dolt database under
`.beads/embeddeddolt/<name>`, and `bd dolt push` / `bd dolt pull` sync it with a **DoltHub** remote
wired up by the repository's setup script. Sync does **not** use the GitHub remote.

Scripts named here ship in the `beads` set: `bd-dolt-sync.mjs` (verified pull, push, status),
`bd-repo-guard.mjs` (a guard against bd churning repository files), `check-beads-remote.mjs`
(sync-remote drift check) and `lib/dolt-resilient-pull.sh` (a retrying pull for scripts).
`claim.sh` and `gate.sh` come from the `worktree` and `gate` sets. Environment variables carry the
consumer's prefix, written here as `AGENT_TOOLING_`.

## Contents

- [A host may run bd in server mode](#a-host-may-run-bd-in-server-mode)
- [Embedded bd serializes writes on one lock, and silence is not a signal](#embedded-bd-serializes-writes-on-one-lock-and-silence-is-not-a-signal)
- [Use the verified helper, not bare bd](#use-the-verified-helper-not-bare-bd)
- [Verify your remote with `dolt`, not `bd`](#verify-your-remote-with-dolt-not-bd)
- [Ground truth for sync state](#ground-truth-for-sync-state)
- [Orphan database: `no common ancestor`](#orphan-database-no-common-ancestor)
- [Merge conflicts: bd's output is least trustworthy here](#merge-conflicts-bds-output-is-least-trustworthy-here)
- [The abort discards your pending writes](#the-abort-discards-your-pending-writes)
- [A symlinked script path can skip the sync command entirely](#a-symlinked-script-path-can-skip-the-sync-command-entirely)
- [A pull can be a silent no-op on a diverged branch](#a-pull-can-be-a-silent-no-op-on-a-diverged-branch)
- [Why push comes BEFORE the second pull](#why-push-comes-before-the-second-pull)
- [Push and pull are gates: never pipe them](#push-and-pull-are-gates-never-pipe-them)
- [`bd ready` reflects your local database](#bd-ready-reflects-your-local-database)
- [Things that look like sync state but are not](#things-that-look-like-sync-state-but-are-not)
- [bd behaviours worth knowing (1.3.x)](#bd-behaviours-worth-knowing-13x)
- [bd facts the asks tooling depends on](#bd-facts-the-asks-tooling-depends-on)
- [`bd create --graph` reverses the `--blocks` wording, silently](#bd-create---graph-reverses-the---blocks-wording-silently)
- [Reading the id back from `bd create` in a script](#reading-the-id-back-from-bd-create-in-a-script)
- [Working rules for tracker mutations](#working-rules-for-tracker-mutations)
- [PR to bead wiring](#pr-to-bead-wiring)

## A host may run bd in server mode

A host can serve the same folder with a `dolt sql-server` (a systemd user unit, or a Scheduled Task
on Windows), so reads stop queuing behind syncs. Check which mode is live with `bd dolt show`:
`Mode: embedded`, or a server `Port` with `Server connection OK`. In server mode:

- **Every command and script is the same.** `bd dolt push`/`pull` and `bd-dolt-sync.mjs` work
  unchanged. The dolt CLI run in the embedded folder routes through the server.
- **`connection refused` from every bd call means the server is down.** Check the unit
  (`systemctl --user status <unit>`, or `Get-ScheduledTask` / `Get-ScheduledTaskInfo` on Windows,
  where `Running` is healthy, `Ready` with nothing on the port means it stopped, and
  `0xC000013A` as `LastTaskResult` is a console close or Ctrl+C). Never start a server by hand with
  `bd dolt start`, never kill a `dolt` process, and never edit `.beads/metadata.json`. A person owns
  the unit, and restarting it needs their OK. A launcher that restarts a crashed dolt and exits
  nonzero when cut short lets the task's restart-on-failure fire; a task registered before that
  lacks the setting until the installer is re-run.
- **`dangling chunk reference: aborting push` with nothing after the colon is NOT corruption.** It
  is bd's 30s pre-push fsck timing out because bd can see the store. The cause is a misconfigured
  `dolt_data_dir`, which must be the empty dir. Run the server-mode status script and report it. Do
  not "recover" the store.
- **A hang on every bd call, with the server up,** means something opened the store embedded.
  `.beads/metadata.json` must say `"dolt_mode": "server"` on that host.

## Embedded bd serializes writes on one lock, and silence is not a signal

In embedded mode (`Dolt engine: embedded (in-process, no server)`) there is no daemon arbitrating
concurrent access. Every `bd` invocation on the machine opens the same on-disk Dolt store
in-process, and a write from one session holds the storage lock until it finishes. A second
session's `bd` call that needs the same lock simply waits, and **bd prints nothing while it
waits**: no "waiting for lock", no progress, nothing to distinguish contention from a hang. A burst
of claims followed by a push in one session can leave another session's foreground `bd create`
silent for minutes. It has not hung; it completes.

**Why this matters more than the wait itself:** the natural response to an eight-minute silent
command is to kill it. Killing a `bd` or `claim.sh` call mid-`git worktree add` is exactly how you
get a worktree with a valid HEAD and branch but an EMPTY index (see
[worktrees-and-claims.md](worktrees-and-claims.md#failure-mode-3-a-valid-worktree-with-an-empty-index)).
Contention produced the silence, and the silence produced the kill.

**The fix:** treat a silent multi-minute `bd` write during another session's burst as expected
contention, not evidence of a deadlock. Time-cap writes instead of watching the clock yourself, so a
genuine stall fails LOUDLY instead of ambiguously:

```bash
timeout 90 bd create ...
timeout 90 bd note <id> "..."
```

A `timeout` exit (124) after 90s with no other session actively writing is a real signal worth
investigating; the same silence during a known concurrent burst is not. Running N concurrent agent
sessions against one machine is the normal operating mode, so every session shares the one
embedded lock. A script must also wrap a time-capped `bd create` knowing the row may exist anyway
(see [Reading the id back](#reading-the-id-back-from-bd-create-in-a-script)).

### Wedged versus contended: the exit condition

"Silence is expected" is correct and is also **indistinguishable from the failure**. A single
`bd dolt push` can WEDGE and hold the storage lock for over an hour: `claim.sh` produces no output
until it dies to its own timeout, a second session's claim queues behind it, and a plain `bd show`
from a third shell hangs the same way. The whole fleet's bead layer is down. The only error anyone
sees, from a shell that has already timed out, is `the database is locked by another dolt process`.

**Wedged and contended are told apart by CPU time against wall time, not by how long you have
waited.** An ordinary contended `bd` accumulates CPU as it works; a wedged push has about a second
of CPU in an hour, sleeping in a futex wait with many threads, stuck almost certainly on the
network half of the DoltHub push.

```bash
# Linux: compare TIME (CPU) against ELAPSED (wall clock)
ps -o pid,etimes,time,stat,wchan:20 -p <pid>
```

```powershell
# Windows: CPU is TOTAL PROCESSOR SECONDS; compare it against now minus StartTime
Get-Process -Id <pid> | Select-Object Id,CPU,StartTime
```

That is one recipe per platform, not a universal one: `ps -o wchan` and `/proc/<pid>/stat` do not
exist on Windows. On Linux, a CPU sample over 5s of `/proc/<pid>/stat` fields 14/15 confirms a
reading either way. Seconds of CPU against an hour of wall clock, in `S`/`Sl` state, is WEDGED.
CPU climbing with wall clock is CONTENTION: wait it out.

**The safe workaround, once you have established it is wedged:**

1. Kill **only your own** queued `claim.sh`. This is safe when it is blocked on a `bd show`, which
   is a READ, with no mutation in flight and no worktree created yet.
2. Create the worktree directly with `bash scripts/worktree-new.sh <slug> <branch>`. That is pure
   git and touches no Dolt, so it runs while the lock is held.
3. Re-run the bead half later, from inside that worktree:
   `bash scripts/claim.sh <id> --claim-only`. This split is exactly what `--claim-only` is for.

**Do NOT kill another session's `bd` process.** Kill only processes you started, and a push killed
mid-write risks the local Dolt database, a far worse outcome than an hour of waiting.
`bd-dolt-sync.mjs` time-caps its own `bd dolt push` (`BD_DOLT_PUSH_TIMEOUT_MS`, below) so an
indefinite fleet-wide stall becomes one loud failure for one session.

## Use the verified helper, not bare bd

```bash
node scripts/bd-dolt-sync.mjs pull     # bd pull, then dolt-CLI merge if bd no-opped
node scripts/bd-dolt-sync.mjs push     # push; on rejection, verified pull + one retry
node scripts/bd-dolt-sync.mjs status   # report only; exit 1 unless genuinely synced
```

It asks the dolt CLI for ground truth rather than trusting bd's own report, and `claim.sh` routes
both its sync steps through it: claiming on a stale DB is exactly how two sessions end up working
the same bead. It deliberately does **not** auto-resolve a real conflict (resolution is by UNION, a
judgment call, with one narrow exception below), and when the dolt CLI is missing it reports "NOT
verified" rather than a false green. Test it against verbatim `dolt sql -r json` fixtures. If dolt
changes that envelope, update the parser, not the fixtures.

Implementation facts worth not re-deriving:

- **Ground truth is a rev-list count, not a status line.** `.dolt/repo_state.json` can have
  `branches.main.remote: ""`, so `dolt status` prints `Your branch is up to date with 'main'`: main
  compared against **itself**, which is true on a wildly diverged DB. The helper counts
  `dolt_log('origin/main..main')` and `dolt_log('main..origin/main')` explicitly.
- **A failed `dolt fetch` is NOT verified.** Several clones share one embedded DB, so a transient
  `cannot update manifest: database is read only` from a concurrent bd process is routine. The
  helper retries, and if it still fails it says NOT verified instead of printing `pull verified`
  over a stale `origin/main`.
- **The push is time-capped.** Each `bd dolt push` attempt gets `BD_DOLT_PUSH_TIMEOUT_MS` (default
  240000) of wall clock and is killed at it. A wedged push holds the machine-wide embedded lock for
  as long as it lives, so an uncapped one takes every session's `bd` down with it. The cap converts
  a fleet-wide outage into one loud failure for the session that caused it. The timeout is never
  retried: the retry ladder exists for a non-fast-forward rejection, which is a race, and re-running
  a push that wedged just re-takes the lock. Raise the variable for a genuinely slow link; do not
  remove the cap.

## Verify your remote with `dolt`, not `bd`

Some bd versions report `Remotes: (none)` in `bd dolt show` even when the remote is present and
working, and `bd dolt remote add` can report success without changing that line. Newer versions
list it correctly, but the authoritative check is still the dolt CLI:

```bash
cd .beads/embeddeddolt/<name> && dolt remote -v
# expect: origin <the DoltHub remote URL>
```

If *that* prints nothing, the remote really is missing and **every `bd dolt push`/`pull` is silently
a no-op**. Two distinct causes produce identical output:

1. **The dolt CLI is missing, or has no credential.** Check this **first**: `dolt version` and
   `dolt creds ls`. The remote lives in the dolt CLI's config, so with no CLI there is nowhere for
   it to live: `bd dolt remote add` prints success and the remote still does not persist. Auth comes
   from the credential `dolt login` writes to `~/.dolt/creds`; without it `bd dolt pull` fails with
   a misleading `Error 1105: ... PermissionDenied` that reads like a URL problem. **The setup script
   cannot fix either; re-running it only reproduces the same abort.** Fix: install dolt
   (`winget install DoltHub.Dolt`; macOS `brew install dolt`), run `dolt login`, *then* re-run the
   setup script (which should guard for this).
2. **The setup script aborted mid-script.** If it sets `beads.role` before adding the remote, an
   abort between them leaves exactly that state. Fix: re-run it, then re-check.

`check-beads-remote.mjs` is the scripted version of the remote check, and detects the sync remote
drifting from the configured one.

## Ground truth for sync state

```bash
cd .beads/embeddeddolt/<name> && dolt fetch && dolt status
```

`diverged ... N and M different commits` is the **normal** shared-repository state: `bd dolt pull`
merges it, it does not overwrite.

## Orphan database: `no common ancestor`

A database that was `bd init`'d locally instead of cloned has a history unrelated to DoltHub's and
cannot merge. Recover with bd's own path: rename `.beads/embeddeddolt` aside (**never delete**; it
may hold issues that exist nowhere else) and run `bd bootstrap` to re-clone. Two traps in bd's own
error text: its `rm -rf .beads/dolt` can name a path the repository does not use (the real one is
`.beads/embeddeddolt`), and **never take its `bd dolt push --force` option**, which overwrites the
shared DB with your unsynced local one.

**Export first** (`bd export -o backup.jsonl`), then diff the export against the re-cloned DB:
local-only issues are the whole reason the orphan existed, and `bd import` can re-add them after a
`bd show <id>` collision check. Never `bd dolt push` from an unverified DB.

The same pair also transfers issues between machines: `bd export`, a git branch, the
`bd show <id>` collision check, then `bd import -i <file>` round-trips notes, close reasons,
external refs, and parent/blocks edges intact.

`bd bootstrap` clones from `sync.remote` in `.beads/config.yaml`, **not** from the dolt CLI remote.
Keep that key pointed at DoltHub. bd can auto-detect the *git* origin and overwrite it, which makes
bootstrap fail with `dolt clone git+https://github.com/...: Error 1007: can't create database
<name>; database exists`: two faults at once, since bootstrap also needs `.beads/embeddeddolt`
renamed aside first. To bypass bd's remote resolution entirely, clone by hand, which produces the
identical layout:
`cd .beads/embeddeddolt && dolt clone <DoltHub remote URL> <name>`.

## Merge conflicts: bd's output is least trustworthy here

Two sessions hitting the same conflicting edit can see *different* behaviour:

- One gets a clean failure: `merge conflicts in issues require operator resolution; merge aborted
  and working set restored`.
- The other gets **`Pull complete`** on a merge that was never resolved. `bd dolt push` then
  refuses repeatedly with *"behind its remote counterpart"*, and only the dolt CLI reveals
  `CONFLICT (content): Merge conflict in issues`.

**The tell is a `bd dolt push` that keeps reporting "behind its remote counterpart" after a pull
that appeared to succeed.** Ground truth, from `.beads/embeddeddolt/<name>`:

```bash
dolt status
dolt sql -r csv -q "select base_id, our_id, their_id from dolt_conflicts_issues"
```

Resolve by **union, never by taking one side wholesale**. The `notes` column is append-only in
spirit, and the other side's note routinely contains detail you need, sometimes the very evidence
that fixes the bug. `dolt conflicts resolve --ours issues` keeps only your row, so re-add the other
side's note afterwards with `bd note`, then `dolt commit` the merge and push.

**Resolve before you commit.** While a conflict stands, `dolt add . && dolt commit` fails, so the
order is always: inspect (`dolt sql -q "select * from dolt_conflicts"`, then the
`dolt_conflicts_<table>` rows), `dolt conflicts resolve --ours|--theirs <table>` (plus any union
edit), and only then `dolt add . && dolt commit`. `bd-dolt-sync.mjs` prints exactly this recipe when
it refuses.

### The double close resolves itself

A bead closed by hand seconds after close automation closed it from a PR's `Fixes:` line leaves two
rows that are `closed` on both sides and differ only in `closed_at`, `close_reason` and
`updated_at`, yet the push stops on an unresolved conflict and prints an add-and-commit recipe that
cannot work while the conflict stands. There is nothing to union in that shape, so
`bd-dolt-sync.mjs` resolves it on its own: when **every** conflict is in `issues`, **every**
conflicting row is `closed` on both sides, and the sides differ only in `CLOSE_METADATA_COLUMNS`
(`updated_at`, `closed_at`, `close_reason`, `closed_by_session`, `content_hash`, `last_activity`),
it runs `dolt conflicts resolve --theirs issues`, commits, names each resolved id
(`auto-resolved <id>`), and continues the verified sync. Anything wider (another table, an open
side, a differing title, notes or any other column, a conflict it cannot read) refuses with the
recipe above.

**Prevention: do not race the close automation.** After a merge, wait for the close run to finish
(it closes every bead named on a `Fixes:` line) and check with `bd show <id> --json` after a
`bd dolt pull`. Close by hand only an id that run lists as unknown, held or without a `Fixes:`
line, or one it never reached.

## The abort discards your pending writes

`bd update` writes into dolt's *working set*; a working-set change is not a commit. When a later
`bd dolt pull` hits a conflict, bd aborts with `merge aborted and working set restored`, and that
restore **discards every pending mutation**: no trace in `dolt log`, and the beads read back at
their pre-edit values. This happens even over a conflict involving none of the pending beads.
Everything pushed within seconds of being written survives; everything held for a batched push at
the end is lost. So **push in SMALL batches.**

`bd-dolt-sync.mjs` commits pending writes before it lets a pull run (and refuses to pull when it
cannot), but that protects only mutations made through the helper's own sync. A bare `bd dolt pull`
still eats them.

**A concurrent writer can make the pending commit empty.** Another session may commit the shared
tables after the helper detects them but before its own commit runs. A failed commit therefore
triggers a fresh verified state read. The helper proceeds only when that read confirms `main`, no
pending writes, and no conflicts, and it reuses those counts for the sync preamble. An
empty-commit message alone is never enough. Dirty, unreadable, wrong-branch, or unverified state
still refuses the pull, and normal post-sync verification remains required. The shared preamble
also refuses both sync verbs when the active branch is missing or differs from `main`, including the
fresh read after it commits pending writes.

## A symlinked script path can skip the sync command entirely

When a host's `/home` resolves to another path through a symlink, Node loads a module through its
real path, but an absolute CLI argument can still name the alias. Comparing those URLs without
resolving the CLI path makes `bd-dolt-sync.mjs` return zero without executing either pull or push.
A `claim.sh` that used a logical script directory then claims locally and publishes the Git branch
while silently skipping both Dolt operations, and a later PR registration correctly refuses the
absent remote claim.

The scripts therefore derive their script directory with `cd -P`, and the sync CLI compares the
real path of its entry argument. Test both through a directory alias: the claim test requires an
actual pull before the claim and an actual push after it, while the CLI test requires argument
validation to run. When recovering from an older checkout, invoke the helper through the canonical
directory, run verified pull and push, then inspect the claim after pulling again. An empty
successful subprocess is not evidence that anything was synchronized.

## A pull can be a silent no-op on a diverged branch

No conflict at all, exit codes bare (bd 1.2.2):

```
bd update <id> --claim   -> EXIT 0        (one local commit)
bd dolt pull -> EXIT 0 ;  bd dolt push -> EXIT 1
bd dolt pull -> EXIT 0 ;  bd dolt push -> EXIT 1     # again, unchanged
dolt status  (CLI)       -> "have DIVERGED, and have 2 and 1 different commits each"
                            dolt_conflicts_issues: 0 rows
dolt pull    (CLI)       -> EXIT 0, real merge commit, 0 conflicts
bd dolt push             -> EXIT 0. Synced.
```

Because divergence is the NORMAL state under several continuously pushing sessions, a session
following the documented recipe can loop on push rejections indefinitely while every pull claims
success. Do not read a repeated rejection as "already synced", and never reach for `--force`.

Open question: whether this is a bd bug, a race with the embedded dolt sql-server (bd pulls through
the server, the CLI pulls against the files), or a fetch-but-no-merge path in bd. Reproduce by
running `bd dolt pull` then immediately `dolt status` on a known-diverged DB; if status still says
diverged, bd did not merge.

## Why push comes BEFORE the second pull

The order used to be `pull, mutate, pull, push`, and across that second pull the titles and
descriptions of several beads silently reverted. **The pull is where the loss becomes VISIBLE; it
is not where the loss happens.** Traced in the Dolt history, the destructive write was an ordinary
non-merge `bd update` from a CONCURRENT session that rewrote a whole text column, replacing
`issues.notes` outright with a shorter value and none of the old text carried over. Checked in the
other direction, the pull merges themselves were innocent: `dolt_diff` across a pull-merge and its
local parent showed zero changed `description` cells.

Two consequences, and they are the whole fix:

1. **Push while your commit is still the only edit in flight.** bd auto-commits every mutation
   locally, so an unpushed edit is a commit nobody else can see; pushing first puts it on the
   remote, where a genuine collision surfaces as a real conflict instead of being quietly
   superseded. (The original reason for a pull before the push still stands, because
   `bd dolt push` has no fast-forward protection, which is why the pull moves AFTER the push rather
   than away.)
2. **Append notes, never replace them.** `bd update --notes` REPLACES the entire notes column;
   `bd note <id>` and `bd update --append-notes` append. Whole-column replacement is the exact
   shape of every loss observed.

Verify with `bd show <id> --json` on the field you edited, not the `Updated issue` line, which
prints on a write a concurrent session is about to overwrite. Cross-check that notes did not get
SHORTER.

## Push and pull are gates: never pipe them

Their exit status is the *only* proof the issue DB reached DoltHub; bd's text is already documented
as untrustworthy. `bd dolt push 2>&1 | tail -1` reports the filter's exit, so a rejected push reads
as success. A masked-gate guard refuses the piped form. For quiet output, capture the exit:
`bd dolt push > /dev/null 2>&1; echo EXIT:$?`. Prefer
`node scripts/bd-dolt-sync.mjs pull|push|status`, run bare.

**A non-fast-forward rejection means another session pushed between your pull and your push.** It
is not "already synced". Pull and retry. Under several concurrent sessions this is routine.

## `bd ready` reflects your local database

It excludes `in_progress`, blocked and deferred issues, but only as of your last `bd dolt pull`. A
session can see a bead it was just told is claimed because its local DB is stale. Pull immediately
before `bd ready`, verify each candidate with `bd show <id> --json` (`assignee` plus `started_at`),
and treat `claim.sh`'s claim-age check as the backstop, not the first line. Prefer `bd ready -n 100`
when auditing so stale-open work is easier to spot.

## Things that look like sync state but are not

Several artifacts look like sync state and are not. They can compose into a convincing false
"replication is broken" story that ends in a bogus P0 and an instruction to stop claiming work,
when ground truth is a routine pull that then works first try. Check the mechanism with the dolt
CLI before raising an alarm. Typical decoys:

- `refs/dolt/data` on the git remote: a legacy git-blob path, switched off via
  `backup.git-push: false`. Its local and remote refs are unrelated orphan histories, and nothing
  reads them.
- `.beads/issues.jsonl` and `.beads/export-state.json`: JSONL export, switched off via
  `export.auto: false`. Its timestamp is not a sync date.
- `.beads/embeddeddolt.local-diverged.*`: old quarantine directories.

See the upstream sync concepts doc, `docs/SYNC_CONCEPTS.md` in the beads repository.

## bd behaviours worth knowing (1.3.x)

Each item was probed in an isolated `bd init` workspace; re-verify before building on one.

- **`bd search` includes closed beads, and `--limit` drops matches status-blind.** Good for a
  dedupe, wrong for finding live work: add `--status open,in_progress`, or use
  `bd list --title-contains`. It still searches titles and ids, never notes; `--desc-contains` adds
  the description.
- **A dated defer wakes on any `bd ready` read**, committed as `bd: wake N expired defer(s)`. A
  defer with no date stays deferred. `--defer` and `bd create --defer` set status `deferred`.
- **`--status` takes a comma list on `bd list` and `bd search`** (`--status open,in_progress`).
- **`bd update --status done` is an error.** `done` is not a built-in status; use `bd close`.
- **`bd show <id> --as-of origin/main` reads the remote's copy** after a `dolt fetch`, without the
  `dolt sql ... AS OF` recipe.
- **`--if-assignee` and `--if-status` make an update conditional.** A mismatch writes nothing and
  exits 13, so a script can release a claim without racing the holder.
- **`bd unclaim` refuses anyone but the holder, and a session's actor is not your git name.** Pass
  `--actor "$(node scripts/agent-actor-id.mjs)"`, or park with `bd update <id> --status open -a ""`.
  Both clear the lease.
- **Claims carry a 5-minute lease and nothing heartbeats it, so never run `bd reclaim`.** An
  expired lease changes nothing by itself: a second actor's `--claim` is still refused. But
  `bd reclaim` clears the assignee on every expired lease, which is every claim older than a few
  minutes. Stale claims stay a human-judged `bd update`, and the claim-age guard is unchanged.
- **`bd sync` is not adopted.** Keep using `bd-dolt-sync.mjs`, which verifies against the remote and
  resolves conflicts the way this file describes.
- **Migration safety:** bd refuses to auto-migrate a remote-backed database and names the
  designated-migrator path, instead of silently forking the schema across clones. `bd doctor`
  schema-drift detection is unavailable in embedded mode; verify a migration with
  `cd .beads/embeddeddolt/<name> && dolt sql -q "select max(version) from schema_migrations"` plus
  `bd stats` counts reconciled against a pre-migration `bd export --all`.
- **Untruncated piped output:** `bd list | grep` needs no ceremony.
- **`bd metrics`** shows a usage-metrics prompt on first run; `bd metrics off` opts out. Opt out
  unattended runners.
- **Still true on 1.3.x:** the `bd create --graph` orientation below, `bd create --json` printing
  one object, and `bd doctor` offering only `artifacts`, `conventions` and `pollution` in embedded
  mode.

## bd facts the asks tooling depends on

Re-verify before changing the query. `bd list --label X --all --json -n 0` returns `metadata` on
every row in well under a second, so the whole inbox is **one** bd call and closed rows are dropped
in code rather than enumerating `--status`. `bd query --json` includes `metadata` as of 1.3.2.
`bd show --json` includes `notes` when a bead has any, but notes are the human audit trail, never
read back programmatically. `--set-metadata` **merges** (it does not replace the whole blob), and
bd **coerces numeric-looking values**, so `a=1` reads back as the JSON number `1`.

## `bd create --graph` reverses the `--blocks` wording, silently

Filing many findings in one `bd create --graph <plan.json>` can produce **reversed** blocking
edges: every finding ends up blocking the partition gate instead of being blocked BY it, so all of
them land in `bd ready` the instant they are created, the exact outcome the gate exists to prevent.

A plan that declares, for each finding,

```json
{ "from_key": "part", "to_key": "m-fog", "type": "blocks" }
```

reads in English as *"part blocks m-fog"* and matches the CLI form `bd dep part --blocks m-fog`.
The graph importer does **not** use that orientation. Its `from`/`to` are *issue* / *depends_on*,
the same orientation as `bd dep add <issue> <dep>`, so that line creates *part depends on m-fog*:
the exact inverse of the identically worded CLI command.

The trap is that `blocks` names the edge TYPE in both places while the field pair around it flips:

| form | orientation |
|---|---|
| `bd dep A --blocks B` | A blocks B |
| `bd dep add A B` | A depends on B |
| graph plan `{from_key: A, to_key: B, type: "blocks"}` | **A depends on B** |
| `bd dep add --file NDJSON {from: A, to: B}` | **A depends on B** |

So the two bulk/file paths agree with `dep add` and disagree with the `--blocks` flag. A plan
authored from the documented `bd dep <blocker> --blocks <blocked>` recipe is reversed by
construction. **Author the edge as *the blocked bead depends on the blocker***:
`{"from_key": "<blocked>", "to_key": "<blocker>", "type": "blocks"}`. Never transliterate the
`--blocks` CLI form into a plan or an NDJSON file.

### Verify with `bd ready`, not with `bd show`

Nothing reports the reversal. The dry run prints its issue and edge counts and validates the graph
without complaint: a reversed edge is still a well-formed edge, and the cycle checker has nothing to
object to because the reverse orientation is also acyclic. `bd show <finding>` then renders
`BLOCKS <-`, which at a glance looks like the gate is present and doing its job; you have to
already know that `BLOCKS <-` means *this bead is the blocker* to read it as wrong.

The unambiguous check is behavioural, and it is one call:

```bash
bd ready -n 500 --json    # none of the gated ids may appear
```

Reproduced in an isolated workspace with both orientations in one plan, `gate` to `find1` and
`find2` to `gate`:

```
$ bd ready
o TT-8h7 * P0 Finding one          # find1: the --blocks-shaped edge left it UNGATED

$ bd show TT-8h7 | grep -A1 BLOCKS       # find1
BLOCKS
  <- o TT-y5k: Partition gate            # find1 is the BLOCKER, backwards

$ bd show TT-7lt | grep -A1 'DEPENDS ON' # find2
DEPENDS ON
  -> o TT-y5k: Partition gate            # correct, and absent from bd ready
```

### An unknown field in a plan is dropped with a warning, not an error

Two more ways the same call fails quietly:

- **The node list is `nodes`, not `issues`.** A plan keyed `issues` warns
  `graph plan plan has unknown field(s): [issues] (silently dropped ...)` and then fails with
  `invalid graph plan: plan has no nodes`. That one at least exits non-zero.
- **A node's type field is `type`, not `issue_type`**, and `issue_type` is the name bd's own
  `--json` export and `bd show --json` use, so it is the one you reach for. It is dropped with a
  warning and every bead is created as the default `task`. A plan filing 42 **bugs** files 42
  **tasks**, exit 0, no error:

  | node field | result |
  |---|---|
  | `"type": "bug"` | `issue_type=bug`, correct, no warning |
  | `"issue_type": "bug"` | warning, `issue_type=task` |
  | `"kind": "bug"` | warning, `issue_type=task` |

  The warnings go to **stderr** and scroll past above a green `Created N issues`, so a script that
  captures stdout alone never sees them. Read stderr, or check one created bead's `issue_type`
  before trusting the batch.

### Recovery from a reversed batch

`bd dep remove <gate> <finding>` for each reversed edge, then re-add correctly. The bulk add path
is much faster than N individual calls and takes the same orientation as `dep add`:

```bash
# NDJSON, one line per edge: the FINDING depends on the GATE
{"from":"<finding-id>","to":"<gate-id>","type":"blocks"}
bd dep add --file deps.ndjson
```

`bd dep remove` has no `--file` form, so the removals are a loop. Wrap them in a script rather than
N tool calls, since each one takes the machine-wide Dolt lock
([above](#embedded-bd-serializes-writes-on-one-lock-and-silence-is-not-a-signal)). Under N
concurrent sessions an ungated window is luck, not a margin: a peer running `bd ready` in that
window sees the whole batch as available work, so sweep for claims made during it.

## Reading the id back from `bd create` in a script

- **`bd create` DOES support `--json`**, and it prints one object whose `id` field is the new bead.
  Parse that field. Do not scrape `Created issue: <id>` out of the human output.
- **Parse by FIELD, never by a regex over the payload.** bd emits the object's keys sorted, so
  `description` comes out BEFORE `id`: a first-match `grep '"id":'` or `/<prefix>-[a-z0-9]+/`
  returns whatever id-shaped string the DESCRIPTION happened to mention. A batch script that did
  exactly that ran `bd dep add` against ids lifted from prose fragments.
- **Keep stderr out of the captured stdout.** `2>&1` folds bd's validation warnings into the text
  you are about to parse as JSON. Redirect stderr to its own file and echo it afterwards.
- **`--silent` prints the id even when a validation warning fires.** It writes the id to stdout and
  the `missing required sections for <type>` warning to stderr, as it should. So an empty stdout
  from `--silent` is **not** explained by the warning path. Without `--silent`, stdout ends with a
  tip line, so a `.pop()` on the output is only correct while `--silent` is passed.
- **A non-zero exit means the state is UNKNOWN, not "not created".** bd runs dolt embedded, so
  every session serializes writes on one lock with no feedback while blocked. A
  `timeout 120 bd create` that fires AFTER the row is committed exits 124 with nothing on stdout
  while the bead exists, which is the real explanation for an "empty id, bead present" report.
  Check the exit code, and on any failure LOOK before retrying; a blind retry is how a duplicate
  gets filed.
- **The required-sections check is a case-insensitive SUBSTRING match on the section name**, not a
  check for the section. It ignores the `##` markup entirely, so a body that merely mentions the
  words passes. Measured against `--type epic`, whose required section is `## Success Criteria`:

  | body | verdict |
  |---|---|
  | `## Success Criteria` | no warning (correct) |
  | `success criteria` | no warning, no heading at all |
  | `SUCCESS CRITERIA` | no warning, case-insensitive |
  | `the success criteria are unclear` | no warning, prose SAYING the section is missing |
  | `successcriteria` | **warns**, so it is a substring test, not fuzzy |

  A thoughtful body routinely mentions those words in passing, so the check goes quiet on exactly
  the bodies it least needs to police. Read its silence as "the words appear somewhere", never as
  "structured correctly". It is advisory (`warn`) and nothing depends on its verdict. `--body-file`
  and `-d` behave identically here; a probe that varies two things at once (the flag and the body
  text) cannot attribute the result to either.

## Working rules for tracker mutations

These are the rules the sections above justify.

- **Use `bd` for all task tracking.** No ad hoc TODO lists. `bd remember` holds persistent
  knowledge.
- **Search before `bd create`.** Run `bd search "<keyword>"` on one or two key terms from the title
  first.
- **`human-required` means no agent can finish this bead; never select one autonomously.** Its
  acceptance criteria need a real rig, an external console, a human identity, a signature or a
  judgement call. Two queries, and both matter:

  ```bash
  bd ready --exclude-label human-required   # the agent-available queue; autonomous selection uses THIS
  bd ready --label human-required           # the human's queue
  ```

  **It is a LABEL, and the bead stays `open` and in `bd ready` on purpose.** Deferring or blocking
  it would hide it from the person who is supposed to do it, so the beads are deliberately visible
  and the exclusion lives at the query instead. Bare `bd ready` is therefore not a list of
  agent-available work, and every autonomous selection path owes it the flag. An id the USER names
  explicitly overrides this (that is them deciding), but say the bead is human-required rather than
  silently attempting it. This is a **selection-time** rule, which is the whole point: a label is
  invisible until a bead is opened, and by then a subagent has been launched at work it will stall
  on. A constraint recorded anywhere other than the selection surface does not exist for the
  purpose of choosing work.

  Tag one with `bd tag <id> human-required` the moment you conclude a bead needs a person,
  including one you were about to hand back. It is distinct from `ask-<person>`, which routes a bead
  to a NAMED human for a DECISION: an ask is answered, a `human-required` bead is done. A bead can
  carry both. It is also distinct from `bd human <id>`, bd's own decision-escalation inbox, whose
  `respond` CLOSES the bead, the wrong lifecycle for a task. **Labels are inherited by
  `bd create --parent`** (opt out with `--no-inherit-labels`), so a child of a `human-required`
  epic is tagged whether or not you passed `-l`; verify with `bd show`.
- **A bulk `bd create --graph` / `bd dep add --file` edge is written BLOCKED-first,** the opposite
  way round from `bd dep <blocker> --blocks <blocked>`. Write
  `{"from_key": "<blocked>", "to_key": "<blocker>"}`, verify behaviourally with
  `bd ready -n 500 --json`, and use `type`, not `issue_type`, for a node's type.
- **`bd` is a planning layer, not the record of what shipped.** `origin/main` plus merged PRs are
  authoritative. Before starting a bead from `bd ready`, audit recent merges and verify the concrete
  files, routes and tests it names. Do not re-implement work just because a bead is open.
- **Audit against `origin/main` before FILING a bug about tooling, too.** Your worktree runs the
  scripts and hook files it was cut with, so a fix that merged hours ago is still absent here and
  the old bug still reproduces, with entirely real output. Read the stale-hooks banner and run
  `git log --oneline origin/main -3 -- <the file you are about to blame>` after `git fetch origin`.
  **A peer session agreeing with you is not corroboration**; under N concurrent sessions it is
  probably stale too.
- **Every bead mutation uses this order:** `bd dolt pull`, mutation(s), **`bd dolt push`**,
  `bd dolt pull`, then **verify the edited field** with `bd show <id> --json`. Push BEFORE the
  second pull, and never trust the `Updated issue` line as proof.
- **Push in SMALL batches.** A pull that hits a conflict aborts and discards every pending mutation.
- **Append, never replace.** Use `bd note <id>` or `--append-notes`; cross-check that notes did not
  get shorter.
- **`bd dolt push`/`pull` are gates; run them bare, never piped.**
- **Prefer the verified helper:** `node scripts/bd-dolt-sync.mjs pull|push|status`.
- **Every `bd` write on a machine serializes on one lock with no feedback while blocked.** Silence
  is not a hang. Time-cap writes: `timeout 90 bd create ...`.
- **After any `git pull` on `main` or any relevant PR merge, reconcile the touched beads** with
  evidence. When auditing use `bd ready -n 100`. If a bead looks stale-open, append an audit note
  with the evidence found in `main` before closing or retargeting it.

## PR to bead wiring

- **Every bead-derived PR body includes a `Fixes: <id>[, <id>]` line** naming exactly the bead(s)
  that PR completes. The close automation parses ONLY body lines starting with
  `Fixes:`/`Closes:`/`Resolves:`/`Bead:` (with any `(epic ...)` parenthetical stripped), never body
  prose and **never the PR title** (title parsing closes partially advanced beads). A PR that only
  partially advances a bead references it in prose ("Part of <id>"); epic mentions likewise belong
  in prose.
- Close automation that runs on `pull_request: closed` needs auto-merge enabled with a real token
  (the author's own, or a dedicated automerge token): a `GITHUB_TOKEN` merge never fires that event.
  Unknown or already-closed ids are skipped; real failures fail the job loudly.
- **An `unknown` id and a lost close are opposite outcomes; do not conflate them.** An unknown id
  means the bead was never found: it may just be a typo, so the run stays GREEN, retries once behind
  an extra `bd dolt pull` (a bead created shortly before its PR merges can lose the propagation
  race), and lists the id under `UNKNOWN:` and in the job's step summary for a hand check. A close
  the run BELIEVED it made and did not is a lost write and always fails the job: the automation
  re-reads each bead after the push and holds the "beads synced" marker on a failed bead so the next
  batch re-does the PR. `Closed` plus `push verified` in a green log is not proof; a run can print
  both while every committed row still says `in_progress`.
- **The third failure mode is a MISSING `Fixes:` line, and it is quieter than either.** A PR merged
  with its bead ids in bold prose only: the close run logs "nothing to close" and succeeds, and any
  sweep that delegates the same parse inherits the same blind spot, while the beads sit
  `in_progress` against merged code, named nowhere. So the close run also reads the merged PR's
  **branch name** (a convention requires it to end in the bead id) and lists any still-open bead it
  names that no anchor line names, under `NO-FIXES-LINE:`. It never closes from a branch name and
  never fails the run: a "Part of" slice PR is legitimately branched off the bead it only advances,
  so the listing is a question for you, not a verdict.
- **A PR metadata check makes the same test BEFORE merge, and fails the gate.** When the branch ends
  in a bead id that no anchor body line names, and the body has no `Part of <id>` for it, the check
  is red; `gh pr edit --body-file` fixes it and the job re-runs on the edit. The runner has no `bd`,
  so it keys on the branch id alone: a follow-up PR for an already-closed bead says `Part of`.
  Branches with no trailing bead id (dependabot, `claude/*`) are untouched.
- **A bead can refuse its own auto-close: write the hold in its NOTES.** Use the explicit
  `[hold-close]`, or the natural phrasings `do not close ... until`, `don't close ... until`,
  `keep ... open until`. Nothing else reads a bead's notes at close time, so "keep this open until
  X" is otherwise simply overwritten by the merge. The PR still merges; only the bead close is
  deferred, the run stays green, and the bead is listed under `HELD:`. It then sits in `bd ready`
  like any other open work. The guard should also run in dry-run mode, deliberately: a dry run is
  the preview of the real path, and any sweep that delegates to the same script would otherwise
  undo a merge-path-only hold. **It does NOT cover a manual `bd close`.** If you close by hand,
  read the notes first.
- **The `do-not-merge` / `hold` / `blocked` label** (case-insensitive) keeps the auto-merge arming
  job from arming the merge, and you do not arm it by hand on a labelled PR. Add it with
  `gh pr create --label do-not-merge` or `gh pr edit <n> --add-label do-not-merge`, and remove it
  once the reason is gone.
- **A reviewer's minor findings can become beads nightly,** one low-priority bead per finding left
  open on a merged head, while a blocking finding (security, data loss, a leak to a restricted
  audience, a common-path crash) is a REQUEST_CHANGES review, fixed before the merge or dismissed
  by a maintainer with a reason.

### Stacked PRs are unsupported

**Every PR branches from `origin/main` and targets the default branch. Never open a PR based on
another PR's branch.** Merging a PR deletes its head branch (when the repository sets
`delete_branch_on_merge`), and GitHub responds to a deleted base by **closing** every PR that
targeted it; it does **not** retarget them. The close is unrecoverable in place: GitHub refuses both
`gh pr edit --base` and `gh pr reopen` afterwards, so the only remedy is a new PR, losing the review
thread. A `do-not-merge` label does **not** help: it keeps auto-merge off the *child*, not the
*parent's* merge deleting the base underneath it.

When ordering genuinely matters, wait: let the sibling merge, then branch from the updated
`origin/main`. There is no `Depends-on:` body line, and auto-merge lands a PR the moment its gate is
green. The default branch's ruleset is the only guard, and a PR whose base is not the default
branch is simply not covered by it, so the branch rule above is yours to keep.

Two related protections: the close automation refuses to close **any** bead for a PR merged into a
non-default base (otherwise a bead reads "shipped" while its code sits on a feature branch), and
branch maintenance will not delete a stale branch that is an open PR's base.
