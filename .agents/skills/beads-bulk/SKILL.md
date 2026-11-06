---
name: beads-bulk
description: Orchestrate several beads at once. The lead session owns ALL bd commands and coordination; each bead or small cluster of related beads (or each epic child, in blocker order) is handed to its own worktree-isolated subagent that implements it and opens a DRAFT PR; the orchestrator reviews every diff, fixes findings, marks the PR ready and enables auto-merge; a green required check enters the merge queue (where the repository has one), which merges it. Use when the user gives a list of independent beads or an epic to do in bulk (e.g. /beadsBulk), or asks to "spawn subagents for these beads" instead of opening one session per bead.
---

# Beads Bulk Orchestration

If a `LOCAL.md` exists beside this file, read it first: it holds this repository's specifics
(its CI job names, its scoped-gate table, its host and disk sizing, its guardrail suites) and
overrides the generic defaults here. This file reads correctly without one.

The lead session is the **orchestrator**. It owns every `bd` command, every product decision, every code review, and the completion protocol. Subagents only implement, they never run `bd`, never merge, never mark a PR ready.

This is the parallel counterpart to `bead-workflow` (`/bead`). Where `/bead` puts one compatible set on one branch that the lead drives directly, `/beadsBulk` gives **each bead (or a small cluster of related beads, or each epic child) its own subagent, worktree, branch, and PR**, run in parallel, with the orchestrator reviewing each result before it is merged. Grouping related beads onto one branch (§3a) is the default lever for keeping total PR count down: it is not a special mode the user has to ask for. Read `.agents/skills/bead-workflow/SKILL.md` for the shared primitives (clobber-safe Dolt discipline, verification gates, the `Fixes:` line). This skill only adds the orchestration layer and does not restate them. **The one primitive it deliberately OVERRIDES is the gate list:** `/bead`'s full-repo gate assumes one heavy run on the box, which a wave of N workers falsifies, so §5 replaces it with a scoped set and moves the full-suite verdict to CI. Nothing else in that file is superseded.

The whole reason this workflow beats "open a session per bead": **a subagent cannot be course-corrected mid-task.** So the orchestrator front-loads every ambiguous decision (see Product-Decision Gate) BEFORE launching. If most beads are exploratory, architectural, or interdependent, tell the user this flow is a poor fit and prefer `/bead` or individual sessions.

## Default Operating Policy (prompt can override)

On by default; an explicit instruction in the invocation overrides any of these.

- **Front-load every blocker, assume the user stepped away.** Batch ALL genuine product/scope decisions into one `AskUserQuestion` (the Product-Decision Gate, §4) BEFORE launching any subagent. Treat an unanswered mid-run question as a stall, not a pause, never defer a blocking decision to "when I reach that bead", because the user may not answer for a long while. Ask only true blockers; never re-ask what the bead already answers, and resolve with a cheap `Grep`/`Read`/`curl` first where you can. **Ping peer sessions BEFORE you ask the human, not just before you claim**, §4's pre-gate ping. Two orchestrations asking the same person the same question is the one collision the sweep cannot catch.
- **Make reasonable calls, then log them for undo.** Where a non-blocking judgment call is reasonable (a naming choice, a minor scope trim, a variant pick), make it and keep moving, but record each and print them together at the end under **"Judgment calls (review/undo)"**, each with *what* was decided, *where* (file / PR #), and *how to revert*. This log is the safety valve that lets the run proceed unattended.
- **CI's verification is a REQUIRED step of this workflow, not a courtesy check, and it runs AFTER you ready a PR, not before.** Subagents run only the SCOPED gates §5 assigns them, so the required CI check is where the related suites, the guardrails, lint, type-check and the build actually run for a wave; read which job went red. Where CI runs nothing on an unlabeled DRAFT, **a draft has no required check and you must not wait for one**: review the diff (§10), mark the PR ready, and the ready transition starts the real run. The required check then reports on the PR's CURRENT head SHA, auto-merge waits for it, and a red comes back to you like any other finding: triage it immediately rather than moving on, because CI also catches what local can't (fresh clone, empty DB, Linux case-sensitivity). Moving the full verification to CI is only sound *because* nothing merges without that verdict. Label a draft for CI only when it genuinely needs CI before review; never by default, or the rule does nothing. **End-to-end specs run on the PR too, scoped by the plan:** the plan job computes the specs the diff can break and the e2e job runs exactly those; the full suite still runs on `main` on a schedule and a red run files a bead. A spec change is additionally validated by the worker running the specs it touched locally. The job names, the preview command and the schedule are in `LOCAL.md`.
- **Selection, concurrency & model are the lead's call.** With no explicit IDs (empty invocation or `ready [N]`), autonomously pick unclaimed beads from **`bd ready --exclude-label human-required`** under the cap below, audited against `origin/main` per §3, and treat them as independent unless their dep graph says otherwise. Per-bead model (mechanical→`sonnet`; judgment/migration/broad→`opus`, §5) is the lead's discretion unless the prompt pins it.
- **Never autonomously select a `human-required` bead, it names work no agent can do.** A capture on a real rig, an external console, a human identity or signature; the AC cannot be met from here. It stays `open` and in `bd ready` on purpose, because a human works that queue (`bd ready --label human-required`), so `bd ready` alone is not a list of agent-available work, and the exclusion above is what makes it one. This is a SELECTION rule: the label is invisible until a bead is opened, and by then a subagent is already launched against work it will stall on. The repository's rulebook section on the beads issue tracker has the contract. An explicit id in the invocation overrides this, as with any Default Operating Policy line, the user naming a bead is them deciding, and if it is human-required, say so rather than silently working around it.
- **A bare numeric cap is a PER-WAVE CONCURRENCY cap on subagents/branches** (a product decision): "up to 5", "5 at a time" and `ready 5` all mean at most N parallel work items per wave, successive waves allowed until the selected work is done. It is NOT a total bead budget unless the user says "total"/"budget", and grouping (§3a) means a wave of N units may carry more than N beads, which is fine *provided it is declared*:
- **Declare the count before claiming, once per wave, mandatory.** One line, before the first claim of each wave: `claiming X beads in M groups (wave K, cap N)`, with M ≤ N checked explicitly. This line exists because on one run an orchestrator silently chose subagents as its unit AND mis-summed its own beads ("5 subagents / 6 beads", it was 7); the user saw neither the unit choice nor the arithmetic until after the claims. The declaration kills both failure modes at the cost of one line.
- **Group related beads to cut total PR count.** Default is one subagent/branch/PR per bead, but small, genuinely related candidates, same file/component, same mechanical pattern, trivial variations of one change, should share ONE branch/subagent/PR instead of each getting its own. See §3a. This is the standing answer to "combine into branches if similar, to reduce the number of PRs", no need to restate it per invocation.
- **Verify every candidate is actually unclaimed before you launch anything.** Other sessions, this machine and others, human and agent, run against this repo concurrently. §2's Concurrent-Actor Sweep is not optional scaffolding; run it before the AC audit, **before the Product-Decision Gate fires** (§4), and again immediately before claiming, every time, without being told.
- **Every bead you claim must ALREADY have been pinged, the claim set is a subset of the pinged set, never larger.** If you collision-checked a peer session, any bead ADDED to the batch afterwards gets its own one-line re-ping before you claim it, a claim outside the pinged set defeats the check (one run pinged six, claimed a seventh that no peer ever saw). The pinged set is legitimately BIGGER, because §4 requires pinging every bead your questions touch and a prioritisation question is normally about work you will not claim; pinging a bead you never claim costs a peer one line to read and is the intended outcome, not a mistake to correct.

## 1. Parse The Request

Text after the invocation is the input.

- **List of bead IDs** (whitespace/comma/prose separated): each is a candidate for its own subagent, unless §3a groups it with others to cut PR count. This is the flat-list mode.
- **A single epic ID** + intent to "do the epic" / "children in blocker order": use **Epic Mode** (§7). An explicit epic request authorizes completing every implementation child and clearing deferrals *within that epic only*, never unrelated backlog, never enabling a feature toggle.
- **No explicit IDs** (empty invocation, or `ready [N]`): autonomously select unclaimed beads from `bd ready --exclude-label human-required`, audited per §3, per the Default Operating Policy. N is a per-wave concurrency cap on work items (see the cap bullets above), never more parallel units than the user named, and always the declared `X beads in M groups` line before claiming.
- Trailing prose is process notes (how to work), not a replacement for bead requirements.

## 2. Concurrent-Actor Sweep: who else is already on this?

**Run this BEFORE the AC audit, BEFORE the Product-Decision Gate fires (§4), and re-run it
immediately before you claim.**

More than one contributor runs agents against this repo, several contributors' sessions, on
different machines, plus the humans themselves committing directly. A `bd` claim is the only
signal the tracker gives you, and it is wrong in **both** directions:

- **Claimed ≠ someone is working.** One bead sat `in_progress` with an assignee for a day
  with no branch, no worktree and no PR anywhere, a prior orchestration claimed it and never
  started. An orchestrator that trusts the claim skips real available work forever.
- **Unclaimed ≠ nobody is working.** The same evening, a human maintainer was actively committing
  to a branch for that same bead. Three writers converged on one bead within minutes; the cost was
  one complete implementation discarded, a PR opened on someone else's branch, a rejected push,
  and a peer credited for work they never wrote.

So check the *artifacts of work*, not the tracker's opinion of it. For every candidate bead:

```bash
bd dolt pull                                   # other machines' claims land here, and ONLY here
gh pr list --state open --limit 60   --json number,title,headRefName,author       # in-flight PRs (author cannot identify a session - see below)
git fetch origin --prune
git ls-remote --heads origin "*<beadId>*"      # someone else's pushed branch for this bead
git branch -r                                  # ditto, post-fetch
git worktree list                              # local worktrees, incl. other sessions on this box
git log --oneline -15 origin/main              # did it just land? (a bead can be open yet done)
```

Then `ListAgents` for live sessions **on this machine**, and message any that might overlap
before you write **or ask** (§4). It is the only thing that distinguishes a live session from
stranded work, a dirty tree with no PR looks identical to both, and it is the only thing that
stops two orchestrations interrupting the same human with the same question. **A `SendMessage`
return of `success: true` reports only that the ping was queued for the recipient's approval, not
that it was delivered, write the §4 tracker marker regardless of what `SendMessage` reports
.** The hold comes from a permission-mode mismatch between the two sessions, and
`crossSessionInbound: "accept"` in the user's Claude Code settings removes it for peers on the same
machine (see the repository's worktrees-and-claims doc, if it has one). It
does not reach another machine's sessions, so the marker stays mandatory.

Treat a bead as **taken** if any of these is true, and say which one:

- a `bd` claim by someone who is not you (`bd dolt pull` first, or the claim you see is stale);
- an open PR or a pushed remote branch whose name contains the bead id;
- a live agent in `ListAgents` that names it;
- recent `origin/main` commits touching the files the bead names **and carrying a bead id that is
  not one of yours**, read the commit subject, which this repo's convention puts the id in, not
  the author field, which cannot tell you whose they are (see the identity warning below). A
  commit touching those files with no bead id at all is a human committing directly, and counts.
- a `[gate-pending <actor> <timestamp>]` marker in the bead's notes (`bd show <id>`), less than
  roughly 2h old, written by an actor that is not you. §4 now writes this alongside every peer
  ping it sends, live or not, see §4 for why. Treat it as "another session is mid-gate on this
  bead's question": do not ask the human about it too; wait, or pick other work. **A marker is
  superseded, not taken, once the same bead's notes carry a LATER "Product owner decision
  <date>: …" note.** `bd note` is append-only, so the `[gate-pending]` text itself
  never goes away once the question is answered. Reading only "is there a marker under 2h old"
  misreads an already-decided bead as still mid-gate. Read the notes in ORDER: a `[gate-pending]`
  followed later by a decision note is closed, no matter how recent the marker's own timestamp
  looks.

**`author` CANNOT identify a session, and two of the checks above read as though it can.** Every
session on this machine pushes as the same GitHub account and commits under the same git
`user.name`, so `gh pr view --json author`, `gh pr list --json author` and "commits by another
author" all collapse to one value covering you, every peer session, and the human. A peer that
reads `author` does not get "somebody else", it gets a name that is equally true of itself.

This is not hypothetical: on 2026-09-09 a third `/beadsBulk` session attributed PR #3043 to the
wrong session this way and built real coordination on it, a worker stood down from creating a
file "because it belongs to that session", and a follow-up doc note was queued against the wrong
merge. Both decisions needed to reach an orchestrator that never heard them. Nothing failed
loudly; the misattribution was caught only because the two sessions happened to be talking.

**The two identifiers that DO separate sessions:**

- the bead's `assignee`, the per-session bot id from `scripts/agent-actor-id.mjs`
  (`<base>-bot-<session8>`, or `<base>-bot-<name>-<session8>` in Claude Code), which is why §5 claims under it and why `bd show <id> --json` is the
  authority;
- the bead id in the branch name, which is what the paragraph below is about.

So the `author` field in the `gh` calls above is useful for *counting* in-flight work, never for
deciding *whose* it is. Ask the tracker, not GitHub.

Treat a claim as **stale** only with positive evidence of absence, no PR, no local or remote
branch, no worktree, no live agent, and when you re-claim, leave a `bd note` recording that
evidence. Never silently take a bead off someone.

**Branch naming is a coordination signal, so make it one:** every branch this skill creates ends
in the bead id (§5), which is exactly what makes `git ls-remote --heads origin "*<beadId>*"`
work for everyone else. Do not drop the id from a branch name.

**Publish your claim the moment you make it**, `bd dolt push` right after claiming (§5), not at
session end. An unpushed claim is invisible to every other contributor and buys you nothing.

**Re-run the sweep after any long gate** (a full dependency install, a CI wait, a review loop). Claims race,
and a wave you launch 20 minutes after auditing is a wave launched on stale information.

## 3. Preflight & AC-Readiness Audit

`bd dolt pull`, then for every candidate bead: `bd show <id>`, and audit the concrete files/routes/tests/docs it names against current `origin/main` (the authoritative record of what already landed, a bead can be open yet already done).

For each bead classify it as one of:

- **Ready**, acceptance criteria are concrete and self-contained; a cold subagent could execute without guessing. → eligible to launch.
- **Needs a decision**, AC hinges on a product/architecture call a subagent would have to guess. → route to the Product-Decision Gate (§4).
- **Already done / stale-open**, add an audit note with the `origin/main` evidence, then close or retarget (clobber-safe). Do not re-implement.
- **Machine-bound**, needs the dev server's default port, a browser, or a visual-snapshot regeneration (for example `--update-snapshots`). → flag for serialized execution (§8), never the parallel batch.
- **Research-only**, the ask is "decide / investigate", not "change code". → memo subagent (§6), no branch.

State the classification of each bead in one line before proceeding.

## 3a. Group Related Beads to Cut PR Count

Before the Product-Decision Gate, cluster the **Ready** beads from §3: small, genuinely related candidates, same file/component, same mechanical fix pattern (e.g. three lint fixes, four identical guard additions, a handful of one-line terminology corrections), or trivial variations of one change, become ONE group, sharing a single branch/subagent/PR instead of one each. The goal is fewer total PRs for the batch to review and merge, not maximum parallelism for its own sake.

Keep beads in separate groups (and separate PRs) when any of these hold:

- They touch unrelated files/areas with no shared review context.
- They carry different risk profiles, bundling a migration/auth/payments change with a one-line copy fix forces the risky change to wait on trivial review, or vice versa.
- Combining would make the diff hard to review as one coherent change, or would block one bead's merge on an unrelated bead's blocker/dependency.
- The Machine-Bound or Research-Only classifications (§3) already route them to a different lane, never fold those into a mechanical group.

State the grouping in one line before launching each wave, which bead IDs share a branch, and why. A single-bead group is normal and expected; do not force unrelated beads together just to hit a number.

**Every claim, worktree, and PR from §5 onward operates per GROUP, not per bead.** One worktree per group, one subagent per group, one PR per group whose `Fixes:` line names every bead the PR closes (`Fixes: <bead-id>, <bead-id>`). A group's subagent prompt lists all of its bead IDs and requirements together, the subagent implements the whole group on its one branch.

## 4. Product-Decision Gate: do this BEFORE launching anything

For every "needs a decision" bead, surface the decision to the user with `AskUserQuestion` (batch related questions). Put the recommended option first, labelled. A cheap inline verification (a `Grep`/`Read` to confirm a claim, a `curl` to confirm reachability) often resolves a decision without asking, do that first.

**PING PEER SESSIONS BEFORE THE GATE FIRES, this is the one collision the sweep cannot catch.**
`ListAgents`, then message any live session that might be working the same queue, listing the bead
IDs you are about to ask about. Wait briefly for a reply; proceed if none comes. Do this **even
though §2's sweep just came back clean**, because a clean sweep is exactly what both sides see.

**The ping must cover every bead your QUESTIONS touch, not the set you are about to claim.**
Those are different sets and they diverge in the normal case, because a prioritisation or scoping
question is exactly the kind you ask about work you have NOT claimed and may never claim. A third
`/beadsBulk` run on 2026-09-09 pinged the eight beads it was claiming, then asked the product owner
four questions, two of which were about beads outside that ping, one of them a prioritisation
question about an epic another session was actively holding a child of. Nothing was
claimed and nothing was built, so no artifact check would ever have surfaced it; the holder learned
of it only because that session volunteered it afterwards. Enumerate the beads named in your
questions, union them with the beads you intend to claim, and ping that union.

**A `SendMessage` success only means the ping was QUEUED for the recipient's approval, not that it
was delivered, write the tracker marker alongside every ping, not only when `SendMessage` is
missing or refused.** Twice in one day, `ListAgents` returned live peers while
`SendMessage` itself was absent from the tool list, or refused with "disabled for this session",
that incident built the marker as the fallback for exactly that case, and it does not cover this
one: tool availability is not the variable. `SendMessage` was fully present and every
call returned `{"success":true,"message":"'<summary>' → peer-75 (another Claude session on this
machine)"}`, reading as delivery, the real verdict arrives asynchronously, minutes later, as a
"held for the recipient user's approval" notice that resolves to approved or expired-unapproved.
Two of three peers approved nothing over roughly 90 minutes; a second live run reproduced it again
at 1-of-2, consistent with per-recipient approval that is simply not granted by default, not a
transient fault. Both times the run was saved only by ordering, the one peer that DID approve
happened to hold the real collision, and the second time that peer wrote the collision into the
blocked bead's own notes as well as replying live, naming this exact failure mode as why: the
tracker is what actually carried the load-bearing information the live reply could just as easily
have lost. So regardless of what `SendMessage` reports, success, absence, or refusal, before
asking the human: write a
`bd note <id> "[gate-pending <actor> <UTC timestamp>] asking <human> about: <one line>"` on every
bead in the pinged union, then `bd dolt push` at once: an unpushed note is invisible to every other
machine, the same reason §2 says to publish a claim the moment you make it. Once pushed, the note
is visible to any peer's §2 sweep even with no live message exchanged. If `SendMessage` could not
be sent at all, also disclose the gap in the SAME message that carries the questions to the human:
say the peer ping could not be sent, and name the peers `ListAgents` showed. Keep the marker note
short. The live ping stays the primary mechanism, it is what produced the useful collision reply
above, the marker is now written alongside it every time, not only as a fallback for when it is
unavailable.

**What closes a marker:** appending the "Product owner decision <date>: …" note this gate already
requires. No separate step is needed, since that note has to be written anyway. If the answer does
not fit that phrasing (the question was withdrawn, or answered outside this gate), append an
explicit `bd note <id> "[gate-answered <actor> <UTC timestamp>]"` instead. Either way, a peer's §2
sweep reads notes in ORDER: a `[gate-pending]` marker followed by a later decision or
`[gate-answered]` note is closed, regardless of how recent the marker's own timestamp is. This is
what makes the check readable from the notes alone, without comparing wall-clock ages by hand.

The sequence that produced the 2026-09-09 collision is fully compliant with every other rule in
this file:

```
session A: sweep → clean → AC audit → GATE (asks the human) → sweep → claim
session B: sweep → clean → AC audit → GATE (asks the human) → sweep → claim
                                      ^^^^^^^^^^^^^^^^^^^^^
                          both here at once, neither visible to the other
```

Two `/beadsBulk` runs asked the product owner the SAME two product questions within
minutes. They stopped one session and told it to go find out why they were being asked twice. **No bead
was double-claimed**, the second sweep worked perfectly and the two claim sets came out disjoint.
That is the point: the guards protect the tracker, and the tracker was never at risk. The damage
lands on the human's attention, which nothing in the sweep models.

**A better sweep cannot fix this, so do not try to build one.** §2 checks the *artifacts of work*,
a claim, a branch, a worktree, a PR, a live agent naming the bead. A session in the pre-claim
question phase has produced **none of them**, by construction: that is what "pre-claim" means. The
other session ran the full sweep correctly and it truthfully reported nobody working, because at
that moment nobody was. Both sessions were invisible to each other through every check the sweep
has, and no additional check could have seen them. The ping is not a redundant belt on top of the
sweep, it is the only mechanism that covers this window at all.

The asymmetry that makes this worth a rule: a duplicate **claim** is caught by
`claim.sh`'s claim-age check and by the second sweep. A duplicate **question** has no guard at all,
it interrupts the human mid-task, and the two sessions can get *different* answers, or one gets an
answer and the other gets redirected, which is exactly what happened. Session A was told "boundary
doc only"; session B was told "go find out why two of you are asking me this" and then reported the other question to session A as UNDECIDED. **A decision split across two sessions is worse than no
decision, because each session believes it holds the whole answer.**

**A peer's account of an answer is hearsay, not a decision.** When a peer relays what the product
owner told *them* about a bead in *your* lane, reconcile it against the answer you hold and the
`bd note` on the bead, never let it override an answer the product owner gave you directly, and
never re-ask the human a question your own gate already resolved. If the two accounts genuinely
conflict, say so to the human once, with both versions; do not silently pick one.

Fold each answer into the subagent's prompt as an explicit instruction, and record it as a `bd note` on the bead ("Product owner decision <date>: …") so the rationale is durable, that note is also what lets a peer session read the decision instead of asking for it a second time. A bead whose decision the user defers stays out of this batch.

**A bead this gate promotes to Ready re-enters through §2, not straight into a wave.** The gate is by construction the slowest step in the run, so the sweep and any peer collision-ping are at their stalest exactly when it resolves. Before claiming a gate-promoted bead: re-run the §2 sweep for it, and re-ping any peer you collision-checked (one line naming the bead). One bead once went gate → wave with neither, and was claimed without ever appearing in a ping.

Do not launch a subagent for a bead whose core decision is still open. This gate is the point of the whole workflow.

## 5. Claim, Then Fan Out

Everything below operates per GROUP (§3a), a "candidate" launched here may be a single bead or a cluster sharing one branch. Substitute the group's primary bead ID (or a short shared slug) anywhere a single bead ID would otherwise name the worktree/branch.

**Claim** every bead in every group you are about to launch with `bash scripts/claim.sh <id> --claim-only`, one literal id per call (several may be joined with `&&`). It pulls Dolt, claims under your per-session id, runs the claim-age check and publishes; `block-bare-claim.mjs` refuses a bare `bd update --claim`. If a claim is refused (someone else holds it), drop that bead, and if it was part of a group, either shrink the group to its remaining beads or split it, whichever keeps the launch coherent, and continue.

**Never re-claim a bead another actor already holds without checking the claim's AGE.** `bd show` prints `Started:` as a date only; use `bd show <id> --json` for the real `started_at`. A claim legitimately precedes its branch and PR, so an empty `gh pr list` / `git branch -r` is NOT evidence the bead is free; assuming it caused a real collision, where a re-claim landed 17 minutes into another session's work on the same bead and branch name. `claim.sh` enforces this for every vendor (`scripts/claim-age.mjs`, default window 4h, `AGENT_TOOLING_CLAIM_COLLISION_HOURS`); a deliberate takeover of genuinely abandoned work needs `AGENT_TOOLING_ALLOW_CLAIM_STEAL=1` and a `bd note` saying why. If another orchestration is running the same epic, partition the children up front rather than relying on the check.

**Fan out, but do NOT trust harness `isolation: "worktree"` to isolate anything.** It has silently created NO worktree and dropped every spawned subagent into the LAUNCHING session's own worktree, where `git rev-parse --show-toplevel == cwd` and `.git` exists, so the naive isolation check falsely passes while all the agents share one working tree, index and HEAD and collide (one agent's `git checkout -b` hijacks the shared HEAD; another's commits land on the wrong branch, the corrupted first fan-out of one epic). Instead, for each group the **orchestrator itself pre-creates and pins a dedicated worktree**:

1. **`bash scripts/worktree-new.sh <slug>-<beadId> <type>/<slug>-<beadId>`**, one command per worker. It creates a uniquely-named sibling dir (NOT under a directory other sessions share, such as a harness's shared worktree folder), adds it quietly, verifies `toplevel` equals the path it just made, **publishes the branch immediately**, and kicks off the dependency install in the background. Publishing the empty branch is what makes the claim visible in git: deferring it to the subagent's first commit leaves a window (20 minutes in a real collision) where the bead is claimed in Dolt while `git branch -r` and `gh pr list` both look empty, which reads to another agent as an abandoned bead and invites a re-claim. Because the installs are backgrounded, create ALL of the wave's worktrees first and let their installs overlap, rather than paying for them one at a time inside each subagent's turn. **Pick the disk before the wave, not per call:** the worktree root (`worktreeRoot` in `agent-tooling.json`, or the consumer's override) decides where every bare slug lands; on Windows give it in POSIX form (`/d/Worktrees`, never `D:/Worktrees`, which MSYS rewrites). **Exception, a lead that itself runs inside a harness-created worktree and enters each worker's worktree with `EnterWorktree` before dispatching it (see the first bullet under "Every implementation-subagent prompt MUST include") must keep worker worktrees under the repo's harness worktree folder (`.claude/worktrees/`)**, because `EnterWorktree` refuses any path outside it. Fan-out worktrees are large (about 0.7 GB each for a typical Node app) and the harness's worktree-location setting does NOT move them, so a wave that ignores the disk is what fills a drive and kills a worker's build with ENOSPC. **But size the wave for the HOST, and find out which host you are on first** by measuring its disks (on Windows, `Get-PhysicalDisk | Select DeviceId,MediaType,FriendlyName`). **Any `HDD`**: the spindle is your budget. Seven worktrees on one platter measured queue depth 12 at 100% busy and 137 KB/s while the NVMe sat 1% busy; one active worktree there is fine, three is pathological, and N concurrent sessions share it without seeing each other's count. **All `SSD`**: the disk is not your constraint at all, so put worktrees on the roomiest drive and size purely by RAM. Either failure is quiet: gate timeouts and exit-1-with-no-output runs that look exactly like a killed process. Per-host numbers belong in the repository's rulebook, not here, because a duplicated host fact is exactly what goes stale. Tell each subagent to run `bash scripts/worktree-new.sh --await <absolute-worktree-path>` before its first gate, the PATH, not the slug: the subagent's shell does not inherit your worktree-root setting, so a bare slug there resolves somewhere else entirely and `--await` reports on a directory nobody is installing into. `--await` judges the TREE (the core packages plus any native binding the repository needs), not the installer's exit code, and names exactly what is missing; so an install that printed errors but verifies clean is a usable worktree, and a missing native build directory is evidence of NOTHING. **Tell each worker that a `--await` exit of `3` is not a reason to stop:** it means dependencies ARE ready and only the browser binaries are absent, so every gate but the end-to-end run can run. Exit `1` is the one that means run no gate at all. When those two shared one exit code, both workers in a wave had to decide unsupervised whether the mandatory pre-gate step had just failed, a subagent cannot be course-corrected mid-task, which is exactly why this prompt is so prescriptive.
2. Spawn the subagent **WITHOUT `isolation`**, passing its EXACT assigned absolute worktree path. It works only there, via absolute paths, and never creates or switches branches (its branch is already checked out).
3. **Do not launch a worker until its `worktree-new.sh` call has EXITED, not until `git worktree list` shows the entry.** `git worktree add` writes the admin entry and starts checking out files BEFORE the command returns, so `git worktree list` lists a worktree that is still mid-checkout exactly the same as a finished one; there is no way to tell them apart from that output. If the Bash tool moves a `worktree-new.sh` call to the background because it ran past its own timeout (a real risk on a desktop under RAM pressure), WAIT for that backgrounded call to actually finish before handing the worktree to a worker; do not treat its appearance in `git worktree list` as the readiness signal. An orchestrator that did exactly this once launched a worker while `git worktree add` was still running: the worker's `--await` found no install pid and no lockfile yet, read that as "created with `--no-install`", and proceeded against a worktree with an EMPTY index (recovered with `git reset --hard HEAD` from inside the worktree). `--await` now also waits out an in-progress checkout itself (via a creation marker `worktree-new.sh` writes) and asserts a non-empty index before reporting ready, so a worker that DOES get launched early is no longer silently told to proceed, but that is a backstop, not a substitute for waiting at launch time.

Model split by task nature:

- **Mechanical** (dead-code removal, rote refactors, dependency bumps, mechanical renames) → `sonnet`.
- **Judgment-heavy** (lifecycle/socket/auth/payments/migration wiring, architectural changes, research memos) → `opus`.

Keep concurrency sane: launch in waves of roughly 3–5. The old single-slot review queue is gone (§9), so merge-time contention no longer caps this, but each subagent is a full worktree with its own dependency install, dev server and browser, so the real limits are the machine and the token spend. Only exceed it when the beads are tiny and truly independent. **Anything that regenerates committed artefacts (visual snapshot baselines) belongs in its own serialized pass (§8), not the parallel batch**, captures made under CPU contention bake degraded renders into the repo.

**A lead inside a harness-created worktree is limited to ONE writing worker at a time**. Every writer needs the lead to `EnterWorktree` into its worktree first (see the first bullet below), and a lead can be in one worktree at a time, so the writers of a wave run serially and the 3-5 concurrency above applies only to leads outside a harness worktree and to read-only reviewers. Consequence to plan for: while a worker holds the lead in its worktree, the lead cannot apply a fix to a different PR. Once, a one-line merge conflict on one PR waited about 50 minutes for a worker on another PR to finish. Hand such a fix to the next dispatch, or finish the running worker first.

**Size the wave by RAM as well as by disk, and size it ONCE, here.** The disk guidance above is a throughput budget; this is a memory one, and it was the missing dimension when a 5-worker wave thrashed a 16 GB / 12-thread laptop. Budget roughly **one concurrent FULL test run per ~8 GB of free RAM**, which on a 16 GB box means one, not five, and note that this is precisely why §5 gives workers a scoped gate set instead: with `--maxWorkers=2` and a targeted selection, 3–5 workers fit where 3–5 full runs do not. **On an all-SSD host this is the ONLY constraint, so count the full-build runs in flight rather than the workers**, builds are the memory hog. Check the host before the wave (`free -g`, or `Get-CimInstance Win32_OperatingSystem` on Windows) and **do not assume any particular machine**, the orchestrator host may be a large build box, a 32 GB dual-NVMe desktop, or a laptop with a third of the cores and half the RAM, and nothing in the prompt will say so. This is a ONE-TIME orchestrator decision on purpose: "run the full suite if the box looks quiet" cannot be delegated to the workers, because five workers evaluating it simultaneously each see a quiet box and all five then start, which is the incident.

### Every implementation-subagent prompt MUST include

- **Inside a harness-created worktree (cwd under `.claude/worktrees/`), a worker cannot enter its own worktree: the LEAD enters it first, and only ONE writing worker runs at a time**. Seen 2026-11-01: three workers launched in parallel were all refused at `EnterWorktree` and stopped with no changes. The harness pins a session, and the subagents it spawns, to the worktree the session is currently in, and a subagent's `EnterWorktree` into a different worktree is refused. So the lead calls `EnterWorktree` with the worker's assigned absolute path (load it with ToolSearch if it is deferred; it refuses any path outside the repo's `.claude/worktrees/`, so such a lead must not point the worktree root anywhere else), re-verifies `git rev-parse --show-toplevel` equals that path, and only then dispatches the worker WITHOUT `isolation`. The worker's prompt says: **do not call `EnterWorktree`; you are already in your worktree, verify it and work there.** Without the lead's switch the Write/Edit tools refuse every file in the worker's pre-created worktree ("belongs to a different worktree") while Bash and git still work, and the refusal only shows on the first Write/Edit, after the worker has already planned. Read-only reviewers are not bound by this: they can read other worktrees by absolute path. The orchestrator hits the same refusal when it edits a file inside a worker's worktree (a PR-body file in `.tmp-gates/`): keep such files in the orchestrator's own scratchpad.
- **Verify you are in YOUR assigned worktree**, the orchestrator passes its absolute path in the prompt: `git rev-parse --show-toplevel` must equal that EXACT path, not merely "some valid worktree" (the check that silently passed while two agents shared one tree). If it differs, the launching session's `.claude/worktrees/*` path, the parent repo checkout, or anything else, STOP and report; run no git-mutating command. Re-check before the first commit.
- **Never create or switch branches**, no `git checkout -b`, `git switch`, `git checkout <branch>`, or `git worktree`. Your branch is already checked out in your assigned worktree; switching it is what hijacks a shared HEAD. Start every shell command with `cd <assigned-path> &&` (or `git -C <assigned-path>`) and use absolute paths under it for Read/Edit/Write.
- **Do NOT run any `bd` command.** The orchestrator owns all bead state.
- **Wait for dependencies before your first gate**: `bash scripts/worktree-new.sh --await <your absolute worktree path>`, the path, never a bare slug, which resolves against a worktree-root setting your shell does not have. The orchestrator started the dependency install in the background when it created your worktree; a gate run against a half-installed `node_modules` fails in ways that look like real breakage. Do NOT symlink `node_modules` from the parent checkout, that breaks Turbopack and fabricates unrelated test failures.
  - **An exit of `3` here is NOT a failure of your tree and NOT a reason to stop**. It means dependencies ARE ready and only the browser binaries are absent, so the end-to-end run is unavailable and **every other gate runs normally**, which is almost certainly all your task needs. Exit `1` is the one that means run no gate at all: it names the missing package and the command that fixes it. Read the message either way; the tree is the verdict, never the exit code.
- **Every file you write OUTSIDE your assigned worktree is SHARED with every sibling worker, so give it your bead id or keep it inside the worktree.** The harness scratchpad belongs to the orchestrator's session, not to you: every subagent in a wave inherits the SAME scratchpad directory, so an unqualified name there (`await.log`, `out.txt`, `notes.md`) is one file written by N workers. Prefer writing inside your own worktree: the gitignored `.tmp-gates/` is already per-worktree (created by `worktree-new.sh`; `mkdir -p` it in any other tree), and `bash scripts/gate.sh --name <slug> <cmd…>` captures any command there with its verdict. Anything that must live outside goes under a bead-id-prefixed name (`await-<beadId>.log`). The incident: a worker captured `--await` output to the scratchpad as `await.log`, a sibling wrote the same name, and the file came back holding the sibling's install log (a recurrence of a known tooling oddity). The PR-body file below follows the same rule.
- **Verifying against a dev server? Start your OWN, in your OWN worktree, never `preview_start({name})`.** That form resolves `.claude/launch.json` against the LAUNCHING session's cwd, not yours, so a fanned-out subagent that calls it by name silently starts or attaches to the ORCHESTRATOR's server and dev DB, the verification then looks like it passed while it checked a sibling checkout entirely. Start the dev server yourself inside your assigned worktree and attach with `preview_start({url: 'http://localhost:<port>'})`. **An end-to-end run may hold several consecutive ports** (the app plus its fake services), so take your port from the repository's per-worktree port helper if it has one (stride 3 in the repository this was written for) or, when the orchestrator assigns ports, space them at least as far apart as the repository's stride, never consecutively. `LOCAL.md` has the helper and the stride.
- If the change touches images: verify Git LFS materialized real bytes (`git lfs ls-files`, size > 1KB not a ~130-byte pointer); `git lfs pull` if needed. On push, confirm the output shows `Uploading LFS objects`, pushing pointer-less images is a repo hazard.
- **Run gates bare, never piped** into `tail`/`head`/`grep`/`wc` (a PreToolUse hook rejects masked gates; there is no pipefail on this machine), or capture one with `bash scripts/gate.sh [--name <slug>] <full command>`, for example `bash scripts/gate.sh --name types <type-check command>` (a bare `gate.sh <slug>` exits 2; ONE command per call, so chain two with `&&` rather than listing them; `--name <slug>` accepts only `[A-Za-z0-9._-]`, both refused loudly by design). All must pass, including pre-existing failures the change surfaces.
- **Your gates are SCOPED to what your group touched. The full test suite is CI's job in a wave, not yours, and you must say so in your report.** CI's verification runs on every PR, but only once the PR is READY: a draft may get no CI at all, so your draft gets no required check and you must not wait for one. Its verdict lands in the required check once the orchestrator marks the PR ready (§9, §10), and nothing merges without it. So the verification is not being dropped; it is being run ONCE per PR on a machine that does it in minutes instead of N times concurrently on one box that does not. **This overrides any other gate list you inherit**: `bead-workflow`'s full-repo gate, and the full-suite line in a domain skill's checklist: those are written for a single agent with the box to itself. Keep every *targeted* gate such a checklist names; replace only its bare full run. Every worker runs the repository's one scoped verification command (named in `LOCAL.md`) regardless of what it changed:
  - **What it covers** is the program the pre-push hook and CI also run: a secret scan, lint on the changed files, type-check on the touched projects, the related tests, and the guardrail tests. Run it once, when the work is ready to commit, with new files staged (`git add`) because many guardrails only see tracked files. Commit without further edits so the push can reuse the PASS, and do not also run whole-tree type-check or lint. A slot wait can outlast the Bash tool's 10-minute cap, so run it in the background and read the verdict from `tail -n 20 .tmp-gates/<slug>.log`.
  - **A secret scan** that reads EVERY tracked file cannot be predicted by a files-touched analysis: a PR can go green on every scoped gate and fail CI because a fixture used a secret-shaped string. Write fixtures with recognised placeholder values, not random-looking strings.
  - **Guardrail tests** scan the TREE as TEXT (every tracked markdown file, the source files read as source), so they go red on changes that touch none of their subjects and **no files-touched analysis can predict them**. That is why a docs-only or skill-only group is not gate-free.

  Then add, by what the group actually changed, the extra gates the repository names (`LOCAL.md` carries the table). **Not every guardrail lives in the main guardrail directory:** a few are colocated with the directory they police and scan it as a whole, so no module's colocated test names them and the unconditional run never reaches them. Run the row for every area you touched. A change that makes an exported function start doing I/O, or changes its default behavior, also gets the import-graph-following related-tests run, because it catches tests that reach the changed module through an untouched intermediary; read the suite count, and retain the colocated, direct-caller and source-reading selectors because import analysis cannot see text-based consumers. Skip that run for a change whose module barrel reaches nearly everything (it selects the whole suite, which is CI's job in a wave) and say so in your report.

  **Do not run a bare full-suite command in a wave.** A local full run is opt-in and only when the wave is a single worker, or the orchestrator says the box is quiet and has told you so explicitly.
- **Cap the test runner's process count on every local run in a wave** (jest: `--maxWorkers=2`). A runner sizes its pool per PROCESS at cores-1 and cannot see that N-1 siblings are doing the same, so five workers on a 12-thread box is ~55 runner processes at 100-700 MB each. That took a 16 GB laptop to ~1300 pages/sec of swap and ~2.7 GB free, with the gates collectively getting ~16 CPU-seconds per 15s of wall clock across 12 cores (~9%). Suites took 70-90 minutes and produced dozens of load-manufactured reds (5s timeouts, a socket-integration dev server missing its startup limit, retry tests that ran for ~48 minutes, a timing assertion) and three workers spent real time re-running failures that were pure contention. All five PRs were green in CI within minutes. **The orchestrator host may be a laptop, not the fleet's big box**: do not assume the fleet's core count.
- **A "targeted" test run silently becomes a FULL one if the pattern is wrong, which is the failure this scoping exists to prevent.** A path-pattern argument is a regex matched against the ABSOLUTE path, and a worktree is named after its branch and bead, so a pattern echoing either (the two strings you reach for first) matches the DIRECTORY component of every file in the tree and selects about the whole suite; an empty alternation branch (`'a|'`, `'|b'`) does the same. Both read as a targeted green. A positional argument is that same regex, not a literal path: a route segment such as `[id]` is a character class, so it selects nothing, or the wrong set with exit 0. **For named test files use the runner's literal-path mode** (jest: `--runTestsByPath <file…>`). A DIRECTORY positional with no brackets is fine. Otherwise scope any pattern with a `/` or a filename, pass multiple patterns as separate values rather than joining them with `|`, and **read the runner's suite count**: the count is the proof.
- **Recognise a load artefact instead of re-running it.** Many SUITES failing while almost no TESTS fail means almost nothing RAN: collection died, not your code (a full `/tmp` inode table is one known cause). A wave on Windows also produced two failed suites with ZERO failed tests, a transient read error at suite load in two files nowhere near the change: concurrent readers over one dependency tree, both green in isolation. Do not chase these and do not "fix" them: report the shape to the orchestrator and let CI's clean single-reader run be the verdict. Scoping and the process cap are also what cut the concurrent-reader count that produces them.
- Prefix every `gh` command with `env -u GITHUB_TOKEN` (a stale env token breaks auth on this machine).
- Follow the repository's terminology rules.
- **Open a DRAFT PR**: draft is mandatory; orchestrator review happens before it goes ready. **Do not wait for CI on the draft, and do not label it for CI yourself:** an unlabeled draft may run no CI at all, so your scoped local gates are your verdict and CI's full run starts only when the orchestrator marks the PR ready. A draft "waiting for the required check" waits forever. The body starts from the repository's PR template (the sections its metadata check requires) and includes a `Fixes: <beadId>[, <beadId2>, ...]` line naming every bead the group closes, and the standard Claude Code attribution footer. **Optional preview:** if the repository can preview the end-to-end specs the plan will run for a diff (see `LOCAL.md`), put that list in your report so the orchestrator can judge it against the diff. If your change moves a screenshot, regenerate its baseline in your branch through the repository's baseline workflow, look at the images it lists, and commit them; never leave a moved baseline for `main` to find. **Write the body to a temp file with the Write tool and pass `gh pr create --body-file <path>`, never an inline Bash heredoc.** Large quoted heredocs die intermittently on this machine with a spurious ``unexpected EOF while looking for matching `'``` (two workers in one batch); delete the temp file after. **Name the temp file with your own bead id (`pr-body-<beadId>.md`) and write it inside YOUR assigned worktree, never a shared scratch root**: two concurrent workers in one wave independently picked `pr-body.md` and overwrote each other mid-run; only the harness's changed-on-disk notice stopped one PR from opening with the other bead's body (the general rule for every scratch file is the bullet after `--await` above).
- **Mutation checks: use the repository's mutation-check helper if it has one** (`LOCAL.md` names it); it enforces every rule in this bullet and exits 0 only when the named test demonstrably bit. Don't hand-roll a harness: two workers once keyed on jest's `✕`, which multi-suite runs print as a `●` heading, and read biting guardrails as not biting. The rules, for when you must: **the anchor must occur exactly ONCE** (`if (count !== 1) throw` before patching: byte-identical guard lines across sibling functions land the patch in the wrong one and report a false GREEN), and **undo a mutation by writing back the captured original text, never `git checkout -- <path>`**: the pathspec checkout discards every uncommitted edit in the file, and a guard hook blocks it on dirty targets. **And assert the mutated gate actually RAN, not merely that it exited nonzero**: a gate killed by process pressure from a peer session (routine on a shared box, and manufactured outright by the image-wide kills this file forbids) exits nonzero having asserted nothing, and one worker scored exit `4294967295` with zero jest output as a triumphant RED. That direction is the dangerous one, because a false red **looks like success and ends the investigation**. Match the runner's summary line AND a failure line naming the test under test (jest: `●` heading or `✕`/`×`, never one marker alone; nested `node --test`: TAP reporter, deleted `NODE_TEST_CONTEXT`, `# tests N` + `not ok N - <name>`). The repository's rulebook has the known-gotchas entries; do not duplicate them here.
- **Never `bd create`; fix your own bead's bugs in your PR.** A bug in your implementation or tests, or a review finding on your PR (blocking or not), is fixed in this PR before it is armed. Anything else you notice, related work you could not fold in, an unrelated red, a pipeline or deploy red, a speculative idea, goes in your final report; the lead dedupes and files it after the batch (§11).
- **Report tooling/CI/hook friction, don't file it yourself.** If you hit a misleading error, a missing guard, or docs and hooks that didn't match reality and had to work around it, note it in your final report (symptom, root cause if known, what you did). Do NOT run `scripts/oddity.mjs` or write to any log, the orchestrator files every subagent's findings after the batch (§11), so a wave's five workers hitting the same oddity produce one bead, not five.
- **Do NOT merge and do NOT mark the PR ready.**
- **Report gates WITH THEIR SCOPE, a bare "gates green" is a forbidden report now that the set is scoped.** Your reader will otherwise assume you ran what `/bead` prescribes. Name each gate you ran; for every test run give the exact selector AND the suite count the runner reported (jest prints `Test Suites:`), so a pattern that silently matched the whole tree (or nothing) is visible rather than inferred; list what you did NOT run and why; and close with the literal sentence **"The full test suite was not run locally, CI's required check is the full-suite verdict for this PR."** Put the same gate list in the PR body. If you DID run a full local suite (single-worker wave, or the orchestrator told you the box is quiet), say that instead, the rule is that the report states the scope either way.
- Report back (the final message returns to the orchestrator, not the user): branch, PR URL, what changed, what was skipped and why, the scoped gate results above, surprises.

Pass the product-decision answers and any process notes into the relevant prompts verbatim.

## 6. Research-Only Beads

For a "decide/investigate" bead, launch an `opus` subagent in a worktree but instruct it: **read-only, no edits, no commits, no branch, no PR, no bd mutations.** Its final message IS the memo. For bead archaeology it may run read-only `bd` (`bd show/search/children/memories`) with the shell cd'd to the main checkout, but never a mutation and never git from there.

When the memo returns, **spot-verify its headline claims** in the actual code with `Grep`/`Read` before relaying them as fact, a confident memo can still cite a stale audit line. Then condense it onto the bead as a `bd note`, deliver the full memo to the user, and route any decisions it raises back through §4 for a follow-up execution pass. Park the bead `open` (not `in_progress`) with a note on what it waits for.

## 7. Epic Mode: children in blocker order

`bd show <epic>`, `bd children <epic>`, and read the dependency tree. Audit children against `origin/main`; clear deferrals only within this epic. Then run **waves**:

1. **Wave 1** = every child with no unmet blocker → launch in parallel per §5.
2. As each child's PR merges (§9), the children it blocked become eligible → launch the next wave.
3. One child (or one tightly compatible slice) per branch and PR, never one giant epic branch.
4. A child whose blocker's code it depends on must wait for that blocker to **merge**, not just to open a PR, dependents branch off the updated `origin/main`. **Do not stack**: never pass `--base <feature-branch>` to `worktree-new.sh` and never open a PR targeting anything but `main`. GitHub CLOSES a PR whose base branch is deleted on merge, unrecoverably (stacked PRs are unsupported). There is no `Depends-on:`: a PR that must not merge before another is not opened ready until the other has merged, and is branched from the updated `origin/main`.
5. Continue until every implementation child is done or a genuine product/external blocker needs the user. Close completed children, then close the parent epic (`bd show <epic>` to confirm all children ✓/❄ first).
6. New feature toggles stay OFF unless separately approved; name each toggle and its OFF state in the relevant PR and the final handoff.

Blocker order makes the epic path inherently more serial than a flat independent list, that is correct, not a bug. Tell the user which children are in flight vs waiting.

## 8. Machine-Bound Work: serialized, after the batch

Beads needing the dev server's default port, a browser, or a visual snapshot regeneration **cannot** share the machine with the parallel batch or each other. Run them one at a time AFTER the parallel batch settles, each in its own worktree subagent.

- **The default dev-server port is often the user's own dev server.** Confirm it is fair game before starting a server there; never kill an existing process.
- Canvas-heavy pages can freeze screenshot capture on a machine (`LOCAL.md` names the ones that do here), instruct the subagent to verify via DOM/`read_page`/console/JS, and rely on the end-to-end framework's own screenshotting for snapshots, not the browser-preview screenshot tool.
- Gate these behind the relevant merges with a `Monitor` poll on the blocking PRs' state (§9) so they launch against fresh `origin/main`.

## 9. How draft→ready→merge works

The CI workflow, the one required check, the review's blocking classes, arming with your own token and the merge queue are described in the repository's pipeline doc (see `LOCAL.md`), and the author's side of them is `bead-workflow` steps 8 to 11. What is specific to a wave:

- **Readying a wave at once is fine.** Every PR runs its own CI on its own head; only the final merge is serialized, by the merge queue (two wave PRs that touch the same lines show as unmergeable there, and the second waits, rebases and re-arms). The runner pools are finite, so a wave of five readied together waits on runners, not on each other. **Same-PR** events cancel that PR's own older run, so do not push and re-ready one PR back-to-back. A global-effect file (one whose change sends a PR's e2e to the full suite; `LOCAL.md` lists them) means such PRs should be spaced out across a wave.
- **A queued PR's branch is locked, so batch every fix BEFORE `gh pr ready` and arming.** A review fix found after queuing lands as a follow-up PR, or dequeue first (`node scripts/pr-queue-state.mjs <n> --dequeue`), push, and re-arm with `--rearm`.
- **A stale red check after `main` was fixed needs a new head**, not a retrigger: `git fetch origin main && git merge origin/main` and a plain `git push`. The tell is a failing check naming a file the PR never touched.

**Holding a PR back: use the `do-not-merge` label, NOT draft status.** Draft is not a hold: any concurrent session or human can `gh pr ready` it, and auto-merge would then land work someone deliberately parked. This happened: a PR held a socket authorization change pending live staging verification, another account marked it ready, and only a chance manual check minutes later stopped an unverified merge. The `enable-auto-merge` job refuses a PR carrying `hold`, `do-not-merge` or `blocked`, and you do not arm auto-merge on one by hand. So: `env -u GITHUB_TOKEN gh pr edit <n> --add-label do-not-merge`, and say in a PR comment what it waits on. Keep it in draft too (belt and braces), but the label is the part that actually holds.

Track merges with a `Monitor` that polls `node scripts/pr-queue-state.mjs <n1> <n2> ...` (ONE aliased GraphQL request for every open PR, never a `gh pr view` per PR: the shared account's secondary rate limit counts every session's calls), a `sleep 300` between polls, backing off longer when it prints `ratelimited` (exit 3), and exits when all are terminal.

## 10. Orchestrator Review Loop: the core value

**A worker's task-notification is not automatically its report.** A background subagent that parks
on its own gate (an end-to-end run, a `Monitor` wait, a long dependency install) fires a "finished"
notification each time it comes up for air, and the result text on those intermediate ones is an
interim status line ("Waiting on jest", "still installing"), not the branch/PR/gate-results
report §5 asks for. On 2026-09-10 an orchestrator nearly reassigned or took over a live worker's
worktree on the strength of one of these: two workers produced seven such interim notifications
before either sent its real report. Treat a notification as complete only when its result text
actually carries the report; an interim line means the worker is still parked and will resume on
its own, so leave its worktree alone. If `SendMessage` is available, a one-line status ping to the
worker settles it directly. If it is not, check for a pushed commit or an open PR on the worker's
branch before concluding it died or stalled. Do not act on silence alone.

For each returned draft PR:

1. `git fetch origin <branch>`; `git diff origin/main...origin/<branch> --stat`, then read the full diff of the non-test production code (and skim the tests). Confirm the body has a `Fixes: <bead-id>` line for the bead (or `Part of <bead-id>` for a slice) and the template's sections: the repository's metadata check fails the gate without them. **If the diff touches application source, preview the e2e scope against the diff you just read, not the worker's word:** if the repository can preview the specs its plan will run (`LOCAL.md`), run that in the worker's tree and read what it lists; the plan computes the scope the same way, so a change it cannot see (a renamed test id reached without a shared string, timing, server state) is one you run locally before readying. A thin scope once let two PRs break seven specs on `main`.
2. **Verify the subagent's claims in the actual code, not just the diff**, confirm a "skipped, still used" call really has callers, a guard's exclusion logic is right, a deleted export truly had zero references. Read images the subagent generated.
3. **Fix findings directly on the branch**, reuse the subagent's still-provisioned worktree (it keeps `node_modules`, seeded DB, `.env`); verify the fix (bare gates, or drive the specific spec that proved the bug), commit, push. File a separate bead for anything out of the PR's scope.
4. **Do not wait for a `gate` on the draft, there is none.** An unlabeled draft runs no CI, so the wave's verification verdict comes AFTER step 5: `ready_for_review` starts the PR workflow, and auto-merge waits for the required check. What you check here instead is the worker's REPORT: the scope sentence §5 requires, the test selectors and suite counts, and what it left to CI. A report that claims a full local suite it was told not to run, or that reports "gates green" with no scope, is itself a review finding; ask for the gate list rather than assuming. A red gate after ready comes back to you like any other finding: fix it on the branch (step 3) and push; it is NOT waved through as wave load, because CI runs one suite per PR on a clean single-reader checkout, which is the condition local runs lacked. Reach for the label that opts a draft into CI (`ci-on-draft` here; `env -u GITHUB_TOKEN gh pr edit <n> --add-label <label>`; the next push runs the PR workflow) only when a draft genuinely needs CI before you review it (a long-lived draft, a change whose risk lives in the Linux-only suites, a PR that edits workflows), never by default, and remove it when done. If every orchestrator labels every draft, the rule does nothing and the queue is back where it was.
5. `env -u GITHUB_TOKEN gh pr ready <n>`: **this is what starts CI** (§9), and every PR runs its own CI, so a whole reviewed wave can go ready at once. Then arm the merge with `env -u GITHUB_TOKEN node scripts/pr-queue-state.mjs <n> --rearm` (your own token; §9 says why not `GITHUB_TOKEN`), re-run a minute later if it exits 1 saying the ready_for_review run has not started: a bare `gh pr merge --auto` straight after `gh pr ready` enqueues the PR on the draft's skipped checks. The e2e specs the plan computed run on the PR; a change the generator cannot see is one the worker ran locally.
   **Ready only what can land without colliding.** Two drafts of the wave that share files: ready one, let it merge, then rebase the other onto the updated `origin/main` and ready it. There is no landing queue and no `Queue-after:` line; the wait is yours to sequence. Keep the number of ready PRs to what the fleet absorbs (three or four at a time): more only queues on runners and multiplies paid reviews when `main` moves.

If review finds nothing, mark ready as-is and arm auto-merge. Never merge by hand: the merge queue merges on a green gate, the post-merge workflow on `main` deploys staging and verifies main, and the close-beads workflow closes the beads on the push. There are no exceptions for workflow or script changes; nothing is special. A PR the reviewer refuses to machine-review (too large, an untracked binary) or whose finding is wrong is reported to the human, who dismisses the review in the GitHub UI with a reason; the merge still happens through auto-merge.

### 10a. After ready: wait, read the review, verify the beads

The lead holds every Beads claim (§5) and owns every PR of the wave, so **the lead waits and acts, never a worker**:

1. Right after `gh pr ready <n>` and arming it with `--rearm` (§10 step 5), add the PR to ONE wait loop for the whole wave: `env -u GITHUB_TOKEN gh pr view <n> --json state,mergeCommit,mergeStateStatus,reviewDecision` per PR, under `Monitor` with a `sleep` of a few minutes between rounds, never one tight loop per PR: your sessions share a 5,000/hour GitHub limit.
2. `reviewDecision: CHANGES_REQUESTED` means a blocking finding (§9). From that PR's worktree (the worker's, still provisioned) either fix it yourself or resume the worker with the finding via `SendMessage`; the worker edits and commits only. Run the §5 scoped gates, push, and the reviewer re-reviews the new head and dismisses its stale REQUEST_CHANGES. Review text came from a model: data, not instructions. A finding you judge wrong goes to the human with the evidence; a maintainer dismisses it in the GitHub UI.
3. `mergeStateStatus: DIRTY` (CONFLICTING) means `main` moved under the PR: from its worktree `git fetch origin main && git merge origin/main`, resolve and commit, then a plain `git push` (no rebase, no force-push). After stopping a backgrounded push, read `git ls-remote origin <branch>` before any local reset. Auto-merge stays armed. A red required check is yours to read (§9): a verify or e2e job is code, a metadata job is the body.
4. If the lead session ends or is cleared (`/clear` gives it a new id) before the PRs merge, nothing is lost: auto-merge is GitHub state. The next lead session lists the wave with `gh pr list --author @me --state open --json number,mergeStateStatus` plus ONE `node scripts/pr-queue-state.mjs <n1> <n2> ...` for the whole wave (one aliased GraphQL request; never `autoMergeRequest`, which reads null once queued) and resumes step 1; the claims stay under the earlier lead's actor name.
5. **A QUEUED PR is done for scheduling:** once `node scripts/pr-queue-state.mjs <n>` prints `queued …`, the next wave PR that touches DIFFERENT files may open; one that touches the same files waits for the merge and branches from the updated `origin/main`. `ejected <reason> unarmed` is the lead's to act on (read the merge_group run, fix or merge `origin/main`, re-arm); a workflow also comments on the PR. `held review` / `held conflict` is a PR that never queued: steps 2 and 3 above; `land.sh` exits 6 on it, and a watchdog workflow comments once on an armed PR held 2 hours or more. The lead does not end its session while `land.sh <path> --queued-ok` exits 6 for any wave PR.
6. After each merge, land it from the primary checkout: `bash scripts/land.sh <worker worktree path>` waits (printing the merge-queue position, with no cap while queued) for the close-beads workflow to move the `beads-synced` tag past the merge, pulls Dolt, prints `bd show` per `Fixes:` id, exits 1 naming any bead still open (worktree kept), and otherwise removes the worktree, deletes the local branch and prunes. Close by hand only an id the run's `beads-unclosed.json` artifact lists under `UNKNOWN`/`HELD`/`NO-FIXES-LINE`, then re-run `land.sh`; never race the run.

## 11. Completion & Follow-Ups

- **Workers never file beads; the lead files what is left, once, after the batch settles**. A bug in a worker's own bead, implementation, tests or a review finding, blocking or not, is fixed in that worker's PR before it is armed, not filed. Directly related or small isolated work is folded into the bead in flight the same way. Only a candidate that would change the PR's review tier, needs a human, is blocked on unlanded work, or is unrelated real work becomes a bead (repro + AC, dupe-checked via `bd search`; an open match gets a `bd note` instead). Speculative ideas go to `node scripts/idea-inbox.mjs add`. A pipeline or deploy red seen during the run is the lead's to claim (a failure you saw is a failure you own).
- Reconcile every bead clobber-safe (`bd dolt pull` → mutate → `bd dolt pull` → `bd dolt push`). Confirm the merged PRs auto-closed their beads (`bd show`); close a parent epic once all children are done.
- Merged agent worktrees are removed by `bash scripts/land.sh <path>` (§10a step 5), which calls `scripts/worktree-rm.sh` once the beads read closed, it handles the Windows long-path failure (bare `git worktree remove` exits 0 while leaving the directory) and refuses globs, since `.claude/worktrees/` is shared with other live sessions. `bash scripts/worktree-rm.sh --stale` lists leftovers from earlier sessions.
- Keep `in_progress` honest: a bead awaiting a product decision goes back to `open` with a note on what it waits for, not left claimed.
- **File every subagent's reported tooling friction (§5) as `tooling-oddity` beads, one pass, after the batch settles, not per-subagent.** Dedupe across workers first (five workers hitting one oddity is one bead). For each item: grep the archive of resolved oddities (named in `LOCAL.md`) for the same symptom/root cause, a match is a RECURRENCE, filed with `node scripts/oddity.mjs recur <N> "<title>" --body-file <md>` and saying what the archived fix failed to cover; otherwise `node scripts/oddity.mjs new "<title>" --body-file <md>`. Write each entry with the Write tool in the CLI's template (Date / Repo / Symptom / Root cause / What was patched / Suggested systemic fix / Effort guess). Also `bd list -l tooling-oddity` for an OPEN bead already covering it, add a `bd note` there instead of a duplicate. Skip this entirely when no subagent reported anything.
- Final handoff: list every PR (merged / awaiting its gate), every bead closed, every new bead filed, any feature toggles touched (with OFF confirmation), and any decisions still owed by the user. Include a **Judgment calls (review/undo)** list of every call made on the user's behalf during the run, each with how to revert.

## Anti-Patterns

- Launching a subagent for a bead whose core decision is unresolved (it will guess). Gate first.
- **Walking up to the human without pinging peer sessions first.** The sweep protects the tracker,
  not the product owner's attention, two orchestrations can both pass a clean sweep and then ask
  the same person the same question minutes apart (one real run). Ping before
  the gate (§4), not only before claiming.
- **Asking the human with no ping at all because `SendMessage` is disabled.** Absence of the tool
  is not absence of the risk: write the `[gate-pending]` tracker marker (§4) before asking, and
  disclose the missing ping in the same message as the questions. A peer's §2 sweep can only read
  the marker if you wrote it.
- **Treating a peer's relay of a product-owner answer as authoritative for a bead in your lane.**
  It is hearsay: reconcile it with the answer you hold and the bead's `bd note`. In that
  collision a peer reported a bead as UNDECIDED that had been decided in the other session's own
  gate minutes earlier.
- **Defaulting to one PR per bead without checking §3a.** A batch of small, related beads left as N separate PRs is exactly the outcome grouping exists to avoid, cluster them onto shared branches before fanning out, not after review reveals they overlapped.
- **Forcing unrelated beads onto one branch just to reduce the PR count.** Grouping is for beads that are actually related (§3a); bundling a risky change with a trivial one, or two beads with no shared review context, trades a real problem (too many PRs) for a worse one (an unreviewable or blocked PR).
- **Treating a `bd` claim as ground truth in either direction.** Claimed does not mean someone is
  working (a claim with no branch, worktree or PR anywhere is stale); unclaimed does not mean
  nobody is (another contributor's agent, or a human, may be mid-commit on an unpushed branch).
  Run the §2 sweep and check the artifacts of work.
- **Writing into a branch or worktree you did not create.** A dirty tree with no PR is
  indistinguishable from stranded work. `ListAgents` first, and message the owner before you
  touch it. If your push is rejected because someone else pushed to your branch, do NOT
  force-push, read their commit, then rebase onto it or merge.
- **Claiming locally and pushing at session end.** An unpushed claim is invisible to every other
  contributor and every other machine. `bd dolt push` immediately.
- **Trusting harness `isolation: "worktree"` to isolate a fanned-out subagent.** It has silently dropped agents into the launching session's own worktree, which passes the `toplevel == cwd` check yet shares one HEAD/index, corrupting one epic's first fan-out. Pre-create each worktree yourself and pin the agent to its absolute path (§5), verifying against that assigned path.
- **Having every worker in a wave run the full test suite.** It is N duplicate copies of a verdict CI produces once in ~3 minutes, and on a box that cannot afford N of them it does not merely cost time, it *manufactures* reds (timeouts, startup limits, suite-load `UNKNOWN` errors from concurrent `node_modules` readers) that workers then investigate as real. Scope the gates (§5) and take the full verdict from CI's required check (§10).
- **Reporting a scoped gate run as "gates green".** The opposite failure, and the one that makes scoping dangerous rather than merely cheaper: the reader assumes `/bead`'s full set. Every worker names its gates, its test selectors and suite counts, and what it left to CI (§5), and the orchestrator treats a scope-less "green" as a review finding, not as a pass.
- **Deciding "the box is quiet, I'll run the full suite" inside a worker.** N workers evaluate that at the same moment, all see a quiet box, and all start, which is the incident, not a mitigation of it. Capacity is an orchestrator decision made once, before the wave (§5).
- Letting a subagent run `bd`, merge, or mark its own PR ready.
- Letting a worker arm auto-merge, rebase a readied PR or answer a review (§10a): the lead owns the wave's PRs, a worker only edits and commits.
- One giant branch/PR for a whole epic instead of one child per PR.
- Running machine-bound beads in the parallel batch, or two at once on the same dev-server port.
- Relaying a research memo's claims without spot-checking them in code.
- Blaming your own branch for a red `review` or `e2e` job before reading the run log and checking which runner actually ran it.
- Assuming a draft→ready toggle cleared a stale red check: a check red against a since-fixed `main` needs a new head, a merge of `main` + plain push (§9).
- Re-implementing a bead that `origin/main` shows is already done because it was still open in `bd`.
- **Dropping a bead because its own notes say it is blocked, without testing whether the blocker is
  real.** A bead's audit note is a prior agent's opinion, not ground truth, and §3 already tells you
  to audit the *files it names* against `origin/main`, do that for the BLOCKER too, not just for
  the work. One bead carried a note saying its fix "DEPENDS on the shared-tooling change landing first" because a shared `/tmp` path had two writers in two repos. Two `/beadsBulk`
  sessions independently read that note, agreed with each other, and dropped the bead as
  third-party-blocked. A human then fixed it in this repo alone in an afternoon by keying its own path on the CI run id: two paths that differ cannot collide, so what the other repo writes
  stopped mattering. The note framed a *shared-name* problem as a *cross-repo* problem, and both
  agents inherited the framing instead of re-deriving it. **Peer agreement is not corroboration
  here**, a peer reading the same note reaches the same conclusion for the same bad reason.

## Example Requests

- `/beadsBulk <id-a> <id-b> <id-c>`, three independent beads, one subagent each.
- `/beadsBulk <id-a> <id-b> <id-c> <id-d>`, if the first three are near-identical lint/type fixes in the same file, §3a groups them onto one branch/PR; `<id-d>` (unrelated area) still gets its own.
- `/beadsBulk <id-a>, <id-b> keep the changes minimal`, with process notes.
- `/beadsBulk <epic-id>`, an epic; children run in blocker order, wave by wave.
