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
| `beads` | The Dolt-backed beads sync toolkit |
| `hygiene` | Epic hygiene, idea inbox, tooling-friction log |
| `worktree` | claim.sh, worktree creation, removal, landing and session locks |
| `gate` | gate.sh capture, fetch-main, PR queue state, PR metadata (and the parse-flags and gh-rate-limit helpers they import). Knobs: `AGENT_TOOLING_PR_WORKFLOW`, `AGENT_TOOLING_GATE_CHECK`, `pr-metadata --migrations-dir` |
| `session` | Session phase and tracker, hooksPath repair |
| `skills` | Process skills under `.agents/skills/` |
| `docs` | The generic halves of the agent docs under `docs/agents/shared/` |
| `ritual` | The agent-ritual conformance smoke |

`all` is every set; `none` is `base` alone. A set may be empty until its files move here.

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
