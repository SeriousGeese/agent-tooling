# agent-tooling

Shared agent process tooling for SeriousGeese repositories: the bead, ask, claim, worktree,
gate and session scripts, the process skills, and the generic halves of the agent docs.
Consumers do not depend on this repository at run time. Its files are **copied** into each
consumer at a pinned commit, at the same paths they have here, by
`scripts/agent-tooling-sync.mjs`.

## Two homes, one config

| Home | Holds | Sync | Record |
|---|---|---|---|
| [SeriousGeese/CICD `agent-hooks/`](https://github.com/SeriousGeese/CICD/blob/main/docs/AGENT-HOOKS.md) | Claude Code hooks: PreToolUse guards, SessionStart and worktree hooks, pre-push hooks, the config loader | `scripts/hooks/sync.mjs` | `scripts/hooks/CICD-HOOKS-SHA` |
| SeriousGeese/agent-tooling (here) | Process scripts, skills, shared docs, the node:test runner | `scripts/agent-tooling-sync.mjs` | `scripts/AGENT-TOOLING-SHA` |

- **A path has exactly one owner.** No consumer path is listed in both records. This sync
  refuses, before writing anything, a path the consumer's `CICD-HOOKS-SHA` records.
- **One config.** Both homes read the consumer's `agent-tooling.json` through one loader,
  `scripts/agent-tooling-config.mjs`, which is copied verbatim from CICD at the commit in
  `scripts/CICD-CONFIG-REF`. `tests/contract/config-loader-drift.node-test.mjs` fails when the
  copy drifts. The keys and their defaults are documented in CICD's
  [docs/AGENT-HOOKS.md](https://github.com/SeriousGeese/CICD/blob/main/docs/AGENT-HOOKS.md#config-agent-toolingjson).
- **One prefix.** Escape hatches and environment knobs are written here as `AGENT_TOOLING_*`
  and rewritten on the way in to the consumer's `envPrefix` (`AGENT_TOOLING_ALLOW_CLAIM_STEAL`
  becomes `ACME_ALLOW_CLAIM_STEAL`). CICD's hooks do the same with `AGENT_HOOKS_*`.

## Sets

`manifest.json` lists every vendored file. `base` ships to every consumer (this sync, the
config loader, the node:test runner, the actor id and test cleanup helpers, and the two small libraries the sets share: `lib/bd-cli.mjs`, the one synchronous `bd` caller (timeout, 64 MB maxBuffer, JSON row parser, assignee-mismatch close retry), and `lib/parse-flags.mjs`, the argv splitter). Everything else is in a named set, chosen with
`--set`:

| Set | Contents |
|---|---|
| `asks` | Routing a bead to a person for a decision: ask.mjs, the inbox banner. A malformed `agent-tooling.json` is reported (ask.mjs errors and exits non-zero, the banner prints one `[asks]` line and exits 0) instead of reading as an empty routing table; a missing one stays silent |
| `beads` | The Dolt-backed beads sync toolkit: verified pull/push (bd-dolt-sync), bd repo-churn guard, sync-remote drift check (finds the embedded database from a linked worktree via the git common dir), resilient-pull shell lib |
| `hygiene` | Epic hygiene, idea inbox, tooling-friction log, blocker-chain finder (`bead-chains.mjs`; its repo label is `--repo-label`, else `AGENT_TOOLING_REPO_LABEL`, else `repo:<origin basename>`, else the lower-cased `beadPrefix`; if none, every `repo:*` label counts as another repository) |
| `worktree` | claim.sh and its fresh-claim guard (claim-age), worktree creation with `--await`, the per-worktree dev server and port, safe removal with the `--stale` scan (worktree-rm), session locks, and land.sh. See [The worktree set](#the-worktree-set) |
| `gate` | gate.sh capture, fetch-main, PR queue state, PR metadata (and the gh-rate-limit helper they import; `parse-flags` is in base). Knobs: `AGENT_TOOLING_PR_WORKFLOW`, `AGENT_TOOLING_GATE_CHECK`, `pr-metadata --migrations-dir` |
| `session` | Session phase and tracker, hooksPath repair |
| `skills` | Process skills under `.agents/skills/`: `bead-workflow` (with its `agents/openai.yaml`), `beads-bulk`, `beads-hygiene`, `prompt-next-work`, `bead-chains`, `mvp-readiness`, `recurring-task`, `window-review`, `dependabot-handler`. (`ask-review` ships in `asks`, with the script it drives.) `bead-chains/SKILL.md` and `prompt-next-work/SKILL.md` run `scripts/bead-chains.mjs`, so they need the `hygiene` set installed alongside. Each may read a consumer-owned `LOCAL.md`, see Skill overlays |
| `docs` | The generic halves of the agent docs under `docs/agents/shared/`: `worktrees-and-claims.md`, `beads-sync.md`, `bead-filing.md`, `shell-guidelines.md`, `shell-windows.md` |
| `ritual` | The agent-ritual conformance smoke |

`all` is every set; `none` is `base` alone. A set may be empty until its files move here.

### The `docs` set

Five long agent docs are split into a generic half here and a consumer half there. The generic half
(`docs/agents/shared/worktrees-and-claims.md`: claim identity, worktree isolation failure modes,
`worktree-rm.sh` invariants, the `core.hooksPath` hijack, rebasing inside a worktree, append-versus-append
conflicts; `docs/agents/shared/beads-sync.md`: Dolt sync failure modes, recovery recipes, bd gotchas,
tracker mutation and PR wiring rules; `docs/agents/shared/bead-filing.md`: when to open a bead, the idea inbox, owning a pipeline red;
`docs/agents/shared/shell-guidelines.md`: rtk and grep traps, what the Bash tool does to a command, capturing a gate, jest path patterns,
poll rate limits; `docs/agents/shared/shell-windows.md`: PowerShell, MSYS path mangling and Windows verification traps) is vendored in place and must pass the neutral-text contract
(no consumer names, bead ids, people or hostnames). The consumer keeps its own incidents, bead ids and
measurements in its existing `docs/agents/<name>.md`, which links to the shared half. Environment
variables are written with the neutral `AGENT_TOOLING_` prefix, which sync rewrites. A consumer whose hooks print a fixed doc path (for example a Windows-shell pointer at `docs/agents/shell-windows.md`) keeps its own half at that path and links to `shared/shell-windows.md`.

## The worktree set

`worktree-new.sh`, `claim.sh`, `worktree-dev.sh`, `worktree-port.sh`, `worktree-rm.sh`, `session-lock.mjs` and `land.sh`, with their libs
(`lib/agent-config.sh`, `lib/git-no-fsmonitor.sh`, `lib/to-node-path.sh`). Consumer values come from
`agent-tooling.json`: `packageManager` (npm, pnpm, yarn or bun; see below), `worktreeRoot`, `worktreeNamePattern`
(`<repo>`, `<slug>`), `worktreeScripts` (the commands printed in hints) and `claimHelper`.

**Package managers.** npm is fully supported. pnpm, yarn (classic only: berry rejects
`--frozen-lockfile --ignore-scripts`) and bun install, with these gaps, and a one-line warning is
printed when one of them installs: dependencies whose install scripts were skipped are NOT rebuilt
(npm rebuilds the ones that need it), there is no lockfile-versus-installed version-drift check, and
staleness is the lockfile's mtime against the manager's record file (for bun that record is
`node_modules` itself, a directory mtime, so it is weak).

**Printed commands.** The `--install` fix commands and the `--await` hint name `worktree-new.sh` by
absolute path, so they work pasted from any directory, unless `worktreeScripts` overrides them.

**Runtime dependencies outside this set.** claim.sh needs `agent-actor-id.mjs` (base, always
present), `bd-dolt-sync.mjs` (the `beads` set) and the `bd` CLI. Without the beads set it refuses
before touching `bd`, naming the missing file and the set that ships it, so adopt
`--set beads,worktree` together. Likewise `claim-worktree-first.node-test.mjs` skips itself, with that
reason, when `bd-dolt-sync.mjs` is absent. If `claim-age.mjs` crashes (any exit other than its refusal code 3),
the claim proceeds and a stderr warning says the fresh-claim check did not run. The creation scripts need only git, bash and node; every config
read degrades to the defaults when `node` or the config module is absent.

**Removal, session locks and landing.** `worktree-rm.sh` removes one literal worktree path and refuses a
primary checkout, the caller's own cwd, a dirty tree and (through `session-lock.mjs`) a worktree another
live agent session is in; `--force-live-session` overrides the last. Its `--stale` mode lists removal
candidates and is the report a consumer's stale-worktree banner reads (point `worktreeScripts.stale` at
it): the `  MERGED  <path>  [<branch>]` lines, the `[worktree-stale] N of M` line and the `READ THIS FIRST`
marker are a parsed interface. `session-lock.mjs touch` is the hook entry that records which worktree each
session is in; wire it as in `reference/settings.json`. A removal that cannot finish records the path in
`<git common dir>/<prefix>-worktree-pending-delete.txt` (the consumer prefix, lowercased) for a consumer-owned sweep job to retry. Knobs:
`WORKTREE_RM_SKIP_GH=1` (offline: no `gh` lookups, which only ever removes nominations) and
`WORKTREE_RM_OPEN_PR_LIMIT` (default 1000).

`land.sh` waits for a PR to merge and for the close-beads run, checks every `Fixes:` bead is closed, then
removes the worktree and branch. The repo comes from the `origin` remote (override `REPO=owner/repo`);
bead ids use `beadPrefix` from `agent-tooling.json`. Knobs: `AGENT_TOOLING_CLOSE_BEADS_WORKFLOW`
(optional: the workflow file that closes beads, named in messages; default the phrase "the close-beads workflow"), `AGENT_TOOLING_SYNCED_TAG`
(default `beads-synced`), `AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS` (shared with the gate set, default 60),
`AGENT_TOOLING_PR_WATCH=0` (skip the optional per-machine watcher), and `LAND_POLL_SECONDS`,
`LAND_TIMEOUT_MINUTES`, `LAND_BACKOFF_MAX_SECONDS`.

**Runtime dependencies on other sets.** `land.sh` needs the `gate` set (`pr-queue-state.mjs`,
`lib/parse-flags.mjs`, `lib/gh-rate-limit.mjs`) and, unless `LAND_SYNC_CMD` is set or `--no-wait` is given, the
`beads` set (`bd-dolt-sync.mjs`). It checks for them before waiting on anything and names the missing file and
the set that ships it, so adopt `--set beads,gate,worktree` together. `land.node-test.mjs` skips, with that
reason, the cases that need the gate files; a parity test checks that land.sh's copy of the rate-limit pattern
equals `lib/gh-rate-limit.mjs`. `worktree-rm.sh` and `session-lock.mjs` need only this set.

**Consumer hint file.** Facts about a consumer's dependency tree live in the consumer-owned,
never-synced `scripts/worktree-new.hint.sh` (or the file named by `WORKTREE_NEW_HINT_FILE`):

| Variable | Meaning |
|---|---|
| `WORKTREE_NEW_NATIVE_PREBUILDS` | Packages that ship or compile a native binding. `--await` calls a tree incomplete (exit 1) when one has none, and the post-install rebuild skips them. Default: none |
| `WORKTREE_NEW_REQUIRED_PACKAGES` | Packages that must exist under `node_modules`. Default: every dependency and devDependency |
| `WORKTREE_NEW_BROWSER_CHECK` | `auto` (only when package.json declares Playwright), `1` or `0`. A missing browser is exit 3: deps are fine, only e2e is unavailable |
| `WORKTREE_NEW_BROWSERS` | Browsers to check and to print the install command for. Default: chromium |

`--await` exits 0 (ready), 1 (not ready), 3 (ready except the e2e browsers). Hatches:
`AGENT_TOOLING_WORKTREE_ROOT`, `AGENT_TOOLING_WORKTREE_NO_LOCK`,
`AGENT_TOOLING_ALLOW_CLAIM_STEAL`, `AGENT_TOOLING_CLAIM_COLLISION_HOURS` (default 4),
`AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR`, `AGENT_TOOLING_DEV_SERVER_PATTERN`.

### The `hygiene` set

Epic hygiene (`epic-hygiene.mjs`), the blocker-chain finder (`bead-chains.mjs`), the idea inbox (`idea-inbox.mjs`), the feature-idea recorder
(`record-feature-idea.sh`) and the tooling-friction log (`oddity.mjs`, `oddity-lib.mjs`,
`oddity-digest.mjs` and the two test stubs). The set is closed over `base`: its small bd, actor and
dolt-sync plumbing lives in `hygiene-bd-lib.mjs`, which uses the `asks` and `beads` sets' scripts
when they are installed beside it and falls back to `BEADS_ACTOR` and a bare `bd dolt pull|push`
when they are not. Verified sync is the beads set's job: without it hygiene runs a bare
`bd dolt pull|push` and prints a warning that the sync is NOT verified.

The friction log reads `beadPrefix` and `people` from `agent-tooling.json` and takes these
environment knobs (the prefix is rewritten on sync, so `AGENT_TOOLING_CHECKOUT` is `ACME_CHECKOUT`
in a consumer whose `envPrefix` is `ACME_`):

| Variable | Default | Meaning |
|---|---|---|
| `AGENT_TOOLING_CHECKOUT` | none | The checkout whose beads database holds every repo's friction entries |
| `AGENT_TOOLING_ODDITY_LABEL` | `tooling-oddity` | The label an entry carries |
| `AGENT_TOOLING_ODDITY_ARCHIVE` | `docs/agents/tooling-oddities-archive.md` | The archive of resolved entries |
| `AGENT_TOOLING_ODDITY_UPSTREAM` | `docs/agents/tooling-oddities-upstream.json` | The registry of workarounds tied to upstream issues |
| `AGENT_TOOLING_ODDITY_REPOS` | none | Repos the digest always lists, even at zero entries |
| `AGENT_TOOLING_ODDITY_SKIP_STALE_CHECK` | unset | `1` runs a CLI copy that is older than `origin/main` |

The per-issue verify recipes behind `oddity.mjs verify` (`scripts/oddity-verify/<issue>.mjs`) and
the tests that read a consumer's real archive, registry, inbox and workflow are consumer data and
stay in the consumer.

## Adopting

From the consumer's root, with any copy of the sync script (a first adoption can fetch it
from `https://raw.githubusercontent.com/SeriousGeese/agent-tooling/<sha>/scripts/agent-tooling-sync.mjs`):

```bash
node agent-tooling-sync.mjs --into . --ref <40-hex agent-tooling commit> --set asks,worktree
```

This writes `base` plus the named sets at their paths, with LF endings, and records the ref,
prefix, sets and files in `scripts/AGENT-TOOLING-SHA`. After that the consumer runs its own
vendored copy, `node scripts/agent-tooling-sync.mjs ...`. Without `--set`, a re-sync keeps the
recorded sets; naming a smaller selection deletes the files that dropped out. A branch or tag
is refused as `--ref`: it can move.

Sync never replaces a file it did not write. Every target must be absent, already the new
bytes, or still exactly what the recorded ref wrote (under the recorded prefix); otherwise the
whole sync stops before writing anything and lists each such path. That covers a consumer
file at a path the manifest claims and a vendored file edited in place. When the consumer is
**moving its own scripts into agent-tooling**, so that the vendored copy should replace its
file, re-run with `--adopt` (library: `sync({ ..., adopt: true })`); each adopted path is
printed to stderr. A target that is a symlink, a directory or anything else but a regular
file is refused outright, `--adopt` or not. All checks and reads happen first; then the files
are written (each through a temp file renamed over its path, so a hard link is replaced,
never written through), then the record, then the stale deletes.

A stale file (one the last sync wrote that the new selection drops) is deleted only when it is
still byte-for-byte what the recorded ref wrote. One that was edited, or that cannot be
confirmed because the recorded ref (or its manifest) can no longer be read, is kept with a
message on stderr. It is also dropped from the new record, so no later sync revisits it:
delete it by hand if it is no longer wanted.

A case-only rename in the manifest (`Tool.mjs` to `tool.mjs`) never deletes the old-case
path, because on a case-insensitive filesystem (Windows, macOS) the two names are one file. On
a case-sensitive filesystem that leaves the old-case file in place beside the new one; delete
it by hand. This is by design: the alternative deletes the only copy on the hosts where the
names collide.

Then:

1. Write `agent-tooling.json` at the root with the consumer's values (the hatch prefix, bead
   prefix, people, worktree naming). Every key is optional.
2. Wire the hooks: [reference/settings.json](reference/settings.json) for Claude Code,
   [reference/pre-push](reference/pre-push) for git.
3. Add the drift check to CI as a step in an existing job:
   `node scripts/agent-tooling-sync.mjs --into . --check`.

### Consumer-owned overlays

Some advice belongs to one consumer only. A skill here may reference a `LOCAL.md` beside its
`SKILL.md`; the consumer writes that file and sync never reads, writes or checks it. It is the
same idea as CICD's `<guard>.hint.txt`.

### Skill overlays

The skills are prose, so the generic text keeps every rule and its reasoning and drops only what
is one repository's: its test and gate commands, its CI job names, its feature-toggle policy,
its people, bead ids, hostnames and host sizing, and any script that is not vendored from here.
Each vendored `SKILL.md` says near the top: "If a `LOCAL.md` exists beside this file, read it
first: it holds this repository's specifics and overrides the generic defaults here." The skill
reads correctly with no `LOCAL.md`; with one, the overlay wins.

- **Where it lives:** `.agents/skills/<skill>/LOCAL.md`, next to the `SKILL.md` it adjusts.
  Write it as a list of overrides keyed to the skill's own step or section numbers (the verify
  command for step 6, the toggle policy for the epic rule, the host table for the wave-sizing
  section), and name the consumer freely: the neutrality check does not run on it.
- **Sync never touches it.** It is not in `manifest.json` and a re-sync leaves it alone.
  `tests/contract/skills.node-test.mjs` fails if a manifest entry is a `LOCAL.md`, if a vendored
  `SKILL.md` lacks `name` and `description` frontmatter, or if one mentions `LOCAL.md` without
  introducing it as optional.
- **Config placeholders** cover what is a value rather than prose: hatch names are written
  `AGENT_TOOLING_*` (rewritten to the consumer's prefix on the way in), bead ids as `<bead-id>`,
  and the worktree root and people come from `agent-tooling.json`.

## Changing a file

1. Change it **here**, with its `.node-test.mjs`, never in a consumer's vendored copy (the
   consumer's `--check` fails on an in-place edit).
2. Keep it neutral: no consumer name, people or hostname; consumer values come from
   `agent-tooling.json`. `tests/contract/manifest.node-test.mjs` fails otherwise.
3. A new file goes in `manifest.json`, in `base` or one set, together with everything it
   imports. The contract test fails if the manifest and the tree disagree, if a `.mjs` imports
   a package or a non-vendored file, or if a set is not closed under its imports.
4. After it merges, each consumer re-syncs to the merge commit; the consumer's diff is the
   change plus the ref line.

## Tests

Plain node, no package.json, so the suites run in a consumer that has no package manager at
all:

```bash
node scripts/run-node-tests.mjs agent-tooling "scripts/**/*.node-test.mjs" "tests/**/*.node-test.mjs"
```

CI runs the same command on Linux and Windows.
