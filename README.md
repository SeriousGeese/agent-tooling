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
config loader and the node:test runner). Everything else is in a named set, chosen with
`--set`:

| Set | Contents |
|---|---|
| `asks` | Routing a bead to a person for a decision: ask.mjs, the inbox banner, the actor id |
| `beads` | The Dolt-backed beads sync toolkit: verified pull/push (bd-dolt-sync), bd repo-churn guard, sync-remote drift check, resilient-pull shell lib |
| `hygiene` | Epic hygiene, idea inbox, tooling-friction log |
| `worktree` | claim.sh, worktree creation, removal, landing and session locks |
| `gate` | gate.sh capture, fetch-main, PR queue state, PR metadata (and the parse-flags and gh-rate-limit helpers they import). Knobs: `AGENT_TOOLING_PR_WORKFLOW`, `AGENT_TOOLING_GATE_CHECK`, `pr-metadata --migrations-dir` |
| `session` | Session phase and tracker, hooksPath repair |
| `skills` | Process skills under `.agents/skills/`: `bead-workflow` (with its `agents/openai.yaml`), `beads-bulk`, `beads-hygiene`, `prompt-next-work`, `bead-chains`, `mvp-readiness`, `recurring-task`, `window-review`, `dependabot-handler`. (`ask-review` ships in `asks`, with the script it drives.) Each may read a consumer-owned `LOCAL.md`, see Skill overlays |
| `docs` | The generic halves of the agent docs under `docs/agents/shared/`: `worktrees-and-claims.md`, `beads-sync.md` |
| `ritual` | The agent-ritual conformance smoke |

`all` is every set; `none` is `base` alone. A set may be empty until its files move here.

### The `docs` set

Two long agent docs are split into a generic half here and a consumer half there. The generic half
(`docs/agents/shared/worktrees-and-claims.md`: claim identity, worktree isolation failure modes,
`worktree-rm.sh` invariants, the `core.hooksPath` hijack, rebasing inside a worktree, append-versus-append
conflicts; `docs/agents/shared/beads-sync.md`: Dolt sync failure modes, recovery recipes, bd gotchas,
tracker mutation and PR wiring rules) is vendored in place and must pass the neutral-text contract
(no consumer names, bead ids, people or hostnames). The consumer keeps its own incidents, bead ids and
measurements in its existing `docs/agents/<name>.md`, which links to the shared half. Environment
variables are written with the neutral `AGENT_TOOLING_` prefix, which sync rewrites.

### The `hygiene` set

Epic hygiene (`epic-hygiene.mjs`), the idea inbox (`idea-inbox.mjs`), the feature-idea recorder
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
