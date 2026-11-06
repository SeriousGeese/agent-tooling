Vendored from SeriousGeese/agent-tooling. A repository's own incidents and measurements live in its own docs, which link here.

# Shell guidelines: the deep dive

Rules live in the consuming repository's agent rulebook. This file is the evidence behind them: the
mechanisms, the traps and the fixes that did not work. It applies on every host. Windows, Git Bash,
MSYS and PowerShell material lives in [shell-windows.md](shell-windows.md). The bead-filing rules
are in [bead-filing.md](bead-filing.md).

Scripts named here: `gate.sh`, `fetch-main.mjs`, `pr-queue-state.mjs` and `lib/gh-rate-limit.mjs`
ship in the `gate` set; `land.sh` in the `worktree` set; `test-preflight.mjs` in base. The guard
hooks named here (`block-masked-gates`, `block-pr-body-heredoc`, `block-bash-double-backslash`,
`block-prose-backtick-substitution`, `block-npx-unlisted`) are the agent hooks a repository vendors
separately. Hatch variables carry the repository's env prefix (`envPrefix` in `agent-tooling.json`).

"RTK" below is a token-compressing output wrapper that a Claude Code hook can put in front of shell
commands (`git status` becomes `rtk git status`). Everything about it applies only where it is
installed.

## Keep rtk away from `git` and `grep`

Put this in rtk's user config (`rtk config` prints the path; on Windows it is
`%APPDATA%\rtk\config.toml`):

```toml
[hooks]
exclude_commands = ["grep", "rg", "git"]
```

The `grep`/`rg`/`git` rewrites are a small share of rtk's savings, and they carry the two failures
below: capped or wrong grep results, and a harness that refuses every `rtk git ...` in a
worktree-isolated session (it cannot prove where the wrapped git runs). Lint, jest and `read` are
where rtk earns its keep, and those stay rewritten. The hazards below still apply to an explicit
`rtk grep` and on any machine without the exclusion. Confirm with `rtk rewrite 'git status'`: empty
output means it is excluded.

## rtk-wrapped grep: false zeroes, the 200-line cap, and git config keys

**Do not cluster grep's short flags: write `-r -l -n`, never `-rln`.** On `rtk` **below 0.43**, a
cluster of three or more short flags containing an output-SHAPE flag (`-l`, `-L`, `-c`, `-o`, `-q`,
`-b`, `-Z`) is not recognised as shape-changing, so rtk applies its `file:line:text` summariser to
output that has a different shape and prints **`0 matches in 0 files`**. Verified against
`rtk proxy grep` and `git grep`:

| form | result |
|---|---|
| `-r -l -n`, `-rl -n`, `-r -i -c` (separated) | correct |
| `-rl`, `-rn`, `-ri`, `-rc`, `-rni`, `-rin` | correct |
| `-rln`, `-rli`, `-rlni`, `-rlc`, `-ric`, `-rci`, `-rnl`, `-rnc`, `-rlH` | **`0 matches in 0 files`** |

The root cause was upstream and is fixed from 0.43: before it, the format-flag check matched whole
tokens (`matches!(arg, "-c" | "-l" | ...)`), so a cluster never matched; a per-letter scan replaced
it. **Check `rtk --version` before trusting a clustered-flag grep on any machine.**

The habit that survives the fix: **a zero-match result is the dangerous half.** An implausibly LARGE
count reads as an anomaly and gets re-run; zero reads as a clean answer and gets acted on. It can
close a bead as already-fixed, or record code as deleted. Confirm any empty grep/rg with `git grep`
(never wrapped) or `rtk proxy grep` before concluding code is absent.

**That habit is the general rule, not a list of known trigger shapes.** A single `-c` (not
clustered) with single quotes and parentheses inside the pattern, passed through the wrapper on a
version well past the clustered-flag fix, returned **0** for a line the Grep tool found at once.
None of the enumerated shapes fit. Treat "a list of known triggers" as the defect in the framing:
an agent whose pattern matches none of them has no reason to think the zero-is-dangerous rule
applies, and that is exactly backwards. **Any zero from an rtk-wrapped grep is unconfirmed, full
stop.** Re-run it through `git grep`, `rtk proxy grep`, or the Grep tool before trusting it,
whether or not the pattern looks like a known trigger. Check `rtk --version` and record it when you
file a new instance, so the next reader knows whether the wrapper or the pattern is the suspect.

**The opposite hazard: an rtk-wrapped grep STOPS at 200 lines, and a pipeline's `grep` stage is
wrapped too.** The hook rewrites every `grep` segment, not only a leading one:
`git diff -U0 origin/main...HEAD | grep -E 'x'` runs as `git diff ... | rtk grep -E 'x'`, and
`rtk grep` defaults to `--max 200`. Past 200 matches it prints the first 200 plus
`[rtk] output capped at 200 results`, and nothing else. Two consequences:

- A **count taken downstream is wrong**: `... | grep -E '<pattern>' | wc -l` printed 201 (200 lines
  plus the marker) where plain grep printed 4425. `grep -c` is not affected, because the count is
  computed by grep itself before the cap.
- A pattern that **matches every line** (an empty alternation branch such as `'a|'` or `(a|)`, the
  jest trap below in regex form) returns what looks like the raw, unfiltered input, capped with that
  marker. A worker reads that as "grep was ignored"; the grep ran, the pattern selected everything.

For a list or count you will act on, use `grep -c`, the Grep tool, `rtk proxy grep`, or let git
filter (`git diff -G<regex>`, `rtk proxy git grep`). Treat the `output capped` marker as
"incomplete", never as the end of the result.

**A `git grep` typed into the Bash tool is rtk-wrapped too, and has returned a PARTIAL list.** A
wrapped `git grep -n -F '<literal>'` returned 2 of 5 real hits in one call and 0 of 3 in another,
far under the 200 cap, while `rtk proxy git grep` with the same arguments and the Grep tool both
found them all. A short non-zero list is worse than a zero, because it reads as confirmed and an
auditor cites the count. So "use `git grep`" means `rtk proxy git grep` (or `git grep` from a
script, where nothing rewrites it); the bare form in the Bash tool is the wrapped one. Record
`rtk --version` with the literal if you see it.

**An rtk-wrapped `git fetch` can read as success when it did nothing.** rtk's filtered fetch output
drops git's ref-update lines and its error text, so a quiet `git fetch origin main` can leave
`origin/main` stale: a migration-number check reads an old journal and a merge-main step misses
commits. Every worktree shares ONE `.git`, so sibling sessions' fetches also contend for the same
ref lock (`cannot lock ref 'refs/remotes/origin/main'`). `node scripts/fetch-main.mjs [branch]`
runs git directly, prints its output, retries a ref-lock failure with backoff, and checks
`origin/<branch>` against `git ls-remote` (refetching once if the branch just moved). Exit 0 prints
the verified sha, anything else exits 1.

**Never grep a git config FILE for a key by its lowercase documented name.** Git writes a camelCased
key (`hooksPath`, `autoSetupRemote`, `defaultBranch`, `untrackedCache`, `worktreeConfig`,
`fileMode`) into `.git/config` / `config.worktree` verbatim, while accepting and reporting every key
case-insensitively everywhere else (`git config --get`, `--show-origin`, docs prose). A
`grep -h "hookspath"` over worktree configs returns nothing even when every one has it set, because
the file spells it `hooksPath`. Ask git instead: `git config --show-origin --get-all <key>`, which
also names which scope each value came from. Or `grep -i` if you must read the file directly.
General form, and it recurs with other tools: **a key a tool treats case-insensitively is not safe
to match case-sensitively on disk.**

## What the Bash tool does to a command: heredocs, backslashes, backticks

**Never build a large prose payload with a shell heredoc. The failing class is SIZE, not `gh pr`.**
A heredoc-bearing command in the ~9 KB range dies intermittently with
`unexpected EOF while looking for matching '`. Correct quoting does not save it, plain ASCII does
not save it, and it hits a bare `cat >> file` append exactly like a PR body. rtk is exonerated (the
failing command passes through its hook unmodified), so the mangling is in the harness-to-bash
handoff itself. Write the content to a file with the Write tool and consume the FILE
(`--body-file <path>`, `cat <path> >> <target>`). The `block-pr-body-heredoc` guard enforces both
rules: any `gh pr create` / `gh pr edit` heredoc (hatch `AGENT_TOOLING_ALLOW_PR_BODY_HEREDOC=1`),
and any command over ~4 KB carrying a heredoc (hatch `AGENT_TOOLING_ALLOW_LARGE_HEREDOC=1`).

**The Bash tool collapses every `\\` in a command to `\` before bash sees it, and ONLY that.**
`\$`, `\"`, `` \` `` and `\n` survive, so this is not shell quoting. It is not rtk (the hook returns
the command unmodified), not MSYS/libuv (a bash.exe spawned from Node receives `\\` intact), and
not a heredoc thing (a single-quoted `echo` collapses too). The Write, Edit and PowerShell tools all
preserve `\\` byte-for-byte. So a `sed`/`grep`/`printf`/JSON payload written with `\\` executes as a
DIFFERENT string and reports success: a probe turned `case *\\*)` into `*\*)` and answered a
different question with a plausible path. Never author backslash-bearing content in a Bash-tool
command: write it with the Write tool and run or consume the FILE, or use the Grep tool (or
`git grep` / `rtk proxy grep` when the harness has no Grep tool) for regex searches. The
`block-bash-double-backslash` guard blocks any Bash command containing `\\` (hatch
`AGENT_TOOLING_ALLOW_DOUBLE_BACKSLASH=1` for a deliberately pre-doubled command).

**That guard also covers the Monitor tool.** The Monitor tool's `command` field runs through the
same collapsing handoff as the Bash tool. This was measured by feeding both tools the identical
`printf` probe with doubled backslashes, a backslash-dollar, a backslash-quote, a backslash-backtick
and a backslash-n: Monitor returned the SAME collapse table as Bash (two backslashes become one, four
become two, everything else untouched). So a collapsed `jq`/regex filter inside a Monitor watch loop
is exactly as real a risk as a one-shot Bash failure, and arguably worse: the watch keeps running
and silently matches nothing, which looks identical to "nothing has happened yet" for the whole
duration. A guard's tool-name check has to name Monitor as well as Bash, or widening the settings
matcher alone is not enough. `block-prose-backtick-substitution` has the identical fix, for the same
reason: command substitution is a property of the shell, and Monitor is confirmed to be a real one.
`block-pr-body-heredoc` and the PowerShell branch of `block-masked-gates` are deliberately NOT
extended to Monitor: their failure modes were not independently measured against that channel, and
covering an unmeasured channel risks a false refusal for no benefit.

**Never put a backtick in a PROSE argument: it is command substitution, and it eats the word.** A
backtick inside a double-quoted (or unquoted) bash word runs what it wraps and substitutes the
output. That is ordinary, correct bash; what makes it bite is the payload. Beads and PR bodies are
**markdown**, where the backtick is the most common punctuation mark there is (every `file.ts:123`,
every identifier, every flag name wants one), so the house style actively encourages the character
that silently rewrites the text. `bd create ... -d "... its own \`mod\` variable."` stores
*"... its own  variable."*: bash ran `mod`, it failed, and its empty stdout went in. bd reported
success, and the only signal was one stray `bash: line 1: mod: command not found` above a green
`Created issue`. **A failing command is the LUCKY case.** A backticked word that IS a command
(`date`, `pwd`, `time`, `true`) injects its OUTPUT mid-sentence with no diagnostic at all. The
damage is durable and authoritative: a bead description is what the next session implements from,
and a sentence missing one word still parses, so it survives review. Unlike the two rules above this
is not harness mangling; it is plain shell semantics reaching a place where the argument is prose.
Fix it by making the text literal: single-quote the argument, backslash-escape each backtick inside
double quotes, or (best for anything long) write it with the Write tool and pass the file
(`--body-file <path>`, which `gh` and `bd` both accept). For substitution you actually want, `$(...)`
is unambiguous and unaffected. The `block-prose-backtick-substitution` guard blocks a live backtick
in a `bd`/`gh` segment and leaves every other command alone (hatch
`AGENT_TOOLING_ALLOW_PROSE_BACKTICK=1`). It cannot see `gh` / `bd` calls made by a SCRIPT rather
than typed at the tool, so a script that builds prose arguments still owes the same care.

**`--no-verify` takes no value, and never `rm` a `-F` message file in the same command as the
`git commit` that consumes it.** `--no-verify=false` is a git syntax error, not a way to say "run
hooks"; omitting the flag is how you say that. Chaining
`git add ... ; git commit -F <file> --no-verify=false ; rm <file>` hits exactly that error AFTER
`git add` has already staged everything, and rtk's compressed rendering of a `;`-chained command
prints each stage's summary inline, so the earlier `ok N files changed` sits directly above the
later failure and reads as a landed commit. Because the message file was deleted in the same line,
the message is gone too, caught only by checking `git log` before pushing. A worker reaching for an
explicit spelling of "run hooks" has none to reach for; omitting the flag is the only one. Sequence it instead:
write the message file, `git commit -F <file>` bare, confirm with `git log -1`, THEN `rm <file>` in
a separate command.

**A bare `git add` through the rtk hook prints the same `ok N files changed` shape.** It is a
STAGING summary, not a commit summary, and nothing was committed. Same trap as the paragraph above:
the compressed line reads like a landed commit sitting above wherever the actual commit happens.
Confirm a commit with `git log -1`, never with the `add` output.

## Tree-wide searches

**Tree-wide searches use the dedicated Grep/Glob tools, never shell `grep -r` or bare `find`.** When
the harness has no Grep tool, use `git grep` (never rtk-wrapped, and it honours the ignore rules) or
`rtk proxy grep` with an explicit path, and `git ls-files` or `rtk proxy find` in place of Glob.
`grep -r` walks every entry under `node_modules/` even with `--include` (that flag filters which
files MATCH, not which directories are TRAVERSED) and can blow the Bash tool's 120s timeout, while
ripgrep honors ignore files and returns instantly. A `find` needing compound predicates (`-not`,
`-exec`) is rejected by `rtk find`, and its "use `find` directly" advice loops because the hook
rewrites `find` back to `rtk find`. Use the Glob tool or `rtk proxy find`. Corollary: never chain a
file write ahead of a long search in one command. A timeout kills both halves, including the write
that "already ran".

## Processes, exit codes and capturing a gate

**Never kill processes by image name (`taskkill /IM node.exe`, `pkill -f node`).** N concurrent
agent sessions on one machine is the normal mode, and an image-wide kill takes out other sessions'
dev servers, installs and test runs with no attribution and no warning. Clear only load YOU
created: track the PIDs of processes you started and kill exactly those.

**For live progress from a long Jest gate, use `rtk proxy npm test -- <jest args...>` inside
`gate.sh`.** Plain `rtk npm test` can buffer Jest's output until the run ends, so the gate log holds
only its header for the whole run and a watcher cannot tell a slow suite from a hang. `rtk proxy`
streams the raw output and still keeps the exit-status verdict.

**`[RTK:PASSTHROUGH] jest parser: All parsing tiers failed` plus a nonzero exit can be a FALSE
red.** rtk (up to 0.45.0) synthesized `EXIT:1` for gate commands that actually exited 0 when its
jest-output parser gave up. Before filing a bug against the code being gated, re-run the identical
command via `rtk proxy <cmd>` and trust that exit code.

**A `npm run lint` FAILURE can put the offending rule and line only inside a ~1 MB rtk tee log, too
large for the agent harness's own tool-result cap.** Same family as the jest-parser false-red
above: rtk's compressed summary is fine when lint PASSES, and it is exactly when lint FAILS (the one
time the detail matters) that the only pointer left is a tee log too big to open. Re-run ESLint
directly on the one file the compressed summary DID name:

```bash
npx --no-install eslint <file>
```

`--no-install` is load-bearing, not decoration: a bare `npx eslint` is exactly the unpinned-download
shape the `block-npx-unlisted` guard exists to stop, and ESLint is a declared dependency, so
`--no-install` both works and stays inside the guard's intent.

**A BACKGROUNDED command's reported exit code is untrustworthy in BOTH directions. Read the runner's
own summary line, never the status.** The false-RED half: a healthy backgrounded server whose
captured log reads empty and whose task reports nonzero. The false-GREEN half is the one that
bites: a backgrounded `npm test` that finished with **3 failing suites** was reported to the agent
as exit `0`, with nothing in the transcript contradicting it. Half a rule is worse than none here,
because "the backgrounded exit code lies low" actively licenses trusting a `0`. So: run gates in the
FOREGROUND, where the status is the shell's own, whenever they fit under the 10-minute cap (the
next paragraph covers the ones that do not), and either way judge from the runner's summary in the
OUTPUT: jest's `Tests:` / `Test Suites:` lines, `# fail 0` from `node --test --test-reporter=tap`,
`EXIT:` from `gate.sh`. A status is a claim about a process, not about what it asserted.

**A foreground command stops at the Bash tool's 10-minute cap (600000 ms), and a full local verify
routinely runs longer than that.** The harness then moves the command to the background (older
builds killed it): the agent loses the inline verdict, and any `grep` or `echo` chained after it
never ran in the foreground. A span that LOOKS like a slow `rm -rf .next`, a slow `git commit` or a
slow gate is often a compound command whose long gate tail ran past the cap; check which step was
actually slow before blaming it. Under 3+ concurrent sessions, per-step times queue behind each
other's verifies, so a whole run can take 12 to 16 minutes. So:

- Start the full local verify, a full `npm test`, or any chain that ends in one, with the Bash
  tool's `run_in_background` and wrap it in `gate.sh`: `bash scripts/gate.sh --name verify <the
  verify command>`. Wait for the completion notice, then read `tail -n 20 .tmp-gates/verify.log`;
  the verdict line is in the log. Never trust the task's exit status alone (the paragraph above).
- Do not chain a fast step in front of a long gate (`git commit -q ... && <long verify>`). The
  commit's own result is then reported only after the gate.
- A call with a smaller `timeout` parameter is cut off at that value instead of the cap.

**Capture a gate with `bash scripts/gate.sh [--name <slug>] <full command>`, not a hand-rolled
redirect.** The obvious form is wrong twice over:

```bash
npm test > .tmp-gates/out.txt 2>&1; echo "EXIT:$?"   # DO NOT
```

A fresh worktree has **no `.tmp-gates/`**, so bash rejects the redirect *before the gate runs* and
its `No such file or directory` reads like the gate exploding. And the `echo` goes to the
**terminal, not into the redirect**, so the captured file a later reader opens has no verdict in it
at all. `gate.sh` creates the directory, streams the output so the harness's output watchdog keeps
seeing progress (a silent capture can get the run killed), writes `=== GATE VERDICT: ... EXIT:n ===`
into the log **and** to stdout, and exits with the gate's own status. `.tmp-gates/` is gitignored;
delete it when you are done. Hand-rolling it anyway means `mkdir -p .tmp-gates` first and putting
the verdict inside the file.

`gate.sh` runs one command per invocation, followed by that command's arguments. It does not accept
a list of npm script names: `bash scripts/gate.sh lint type-check` is not a request to run both.
Run each script explicitly so each gets its own log and verdict, for example
`bash scripts/gate.sh --name lint npm run lint && bash scripts/gate.sh --name type-check npm run type-check`.
The wrapper prints this guidance when it recognizes a list of bare npm script names. Its
`--name <slug>` takes 1 to 60 characters from `[A-Za-z0-9._-]`, starting with a letter or digit
(deliberate: the slug becomes a log file name); anything else is refused with exit 2, so pick a plain
slug rather than a path or a phrase.

**Do not pipe `gate.sh` itself into a filter. That is a masked gate too, and it is refused.** The
wrapper does not launder the pipe: `bash scripts/gate.sh npm test | tail -30` still reports
`tail`'s exit status, and `| head` is worse still because it drops the `=== GATE VERDICT: ... EXIT:n
===` line entirely. A stage beginning `bash` matches no runner name, so a masked-gate guard must
strip `[bash|sh] [<dir>/]gate.sh` the way it strips `timeout`/`env`/`rtk`, and judge the argument.
Then the wrapper is covered in every invocation shape, a bare `gate.sh` run still passes untouched,
and `set -o pipefail;` remains the hatch. There is no need for the pipe anyway: that is what the log
file is for.

**A guard that strips the wrapper's NAME and stops reopens the hole through the wrapper's own
flags.** `bash scripts/gate.sh --name probe npm run lint | tail -0` was ALLOWED while the same
command without `--name` was refused: the guard read the command word as `--name`, decided the stage
was no gate, and let the pipeline report `tail`'s status. The flag is the documented way to name a
captured run's log, i.e. what a fan-out wave reaches for (many gates in one worktree), so the guard
went quiet for the workflow that needs it most, in the silent direction. A wrapper's own options
must be consumed along with its name, so **no `gate.sh` flag, present or future, changes whether the
guard sees the gate.** Nothing else moves: a bare run, a non-gate argument, `--help` and the
`pipefail` hatch all behave exactly as before.

**On a large suite the LOG FILE is the readable artefact, not the stream.** Streaming is deliberate
(it keeps the output watchdog fed), but a big suite's output runs to a couple of hundred KB, and the
agent harness caps its own tool-result size independently of anything `gate.sh` does. So the
STREAMED copy is cut off mid-run: before `=== GATE VERDICT: ... EXIT:n ===`, before the runner
summary printed beside it, and before the `captured:` line that would have named the log. A gate
whose output simply STOPS is therefore the expected shape of a big run, **not** the gate exploding
and not a hang. Do not re-run it and do not start diagnosing it. Read the log instead:

```bash
tail -n 20 .tmp-gates/npm-test.log        # verdict + summary are the last lines
```

`<name>` is the `--name` slug when you passed one, otherwise the command slugified (`npm test`
becomes `npm-test`, `npm run lint` becomes `npm-run-lint`).

## Jest path patterns and inode exhaustion

**A jest path pattern is a REGEX, so it can match EVERYTHING as silently as it can match nothing.**
The zero-match half is loud (`[id]` is a character class, and jest says `No tests found, exiting
with code 1`). The inverse is silent: an **empty alternation branch** matches every path. A pattern
`'name'` selects one suite and `'name|other'` selects two, but `'name|'`, `'|b'` and `'(a|)'` each
select ALL of them, so the run executes the whole suite, passes, exits 0, and reads as a targeted
green. A trailing `|` is easy to grow when a pattern is joined from a list or edited down. Passing
several patterns as separate values (`--testPathPatterns a b`) cannot grow an empty branch and is the
safer form.

**A positional argument is the same regex, not a literal path.** To run named test files, and
always when a path has a bracketed route segment such as `[id]`, use `--runTestsByPath <file...>`.

**The same silent everything-selected outcome arrives from a second, likelier cause: the pattern is
matched against the ABSOLUTE path, and worktrees are named after their branch.** When the worktree
directory is named from the branch slug and the bead id, a pattern echoing either (the two strings
you reach for FIRST when narrowing a run) matches the DIRECTORY component of every file in the
tree. A bead id that appears in no test path anywhere selects every suite for exactly this reason.
Scope the pattern to something that cannot appear in a directory above the repository root: include
a `/`, or name the file (`'route.test'`).

**Both causes can be made to announce themselves.** A jest preflight (`test-preflight.mjs`, in base,
with its test) warns for any pattern whose regex matches the root directory's own path, which is true
of a directory-name match and of an empty alternation branch alike. It should never fail the run:
over-running is the safe direction, and a fix that traded it for under-running would be worse than
the bug. Read the `Test Suites:` count anyway. The warning covers the patterns that select
EVERYTHING, not every way a pattern can select the wrong thing.

**`npm test` on a box that is out of INODES reports a huge number of failing suites in your own
code, and `df -h` agrees there is plenty of space.** The tell is the shape: hundreds of SUITES
failing while only a handful of TESTS do means almost nothing RAN. A temp directory with a handful
of free inodes and tens of GB free leaves Jest unable to write its transform cache, so suites die at
COLLECTION time with an ordinary-looking `Test suite failed to run` and a caret under an import
line, which reads as a module-resolution bug in whatever file it names. Check `df -i`. The fix is
to clear the regenerable caches (the Jest transform cache and the Node compile cache) when no peer
test process is running. Both grow monotonically across every session on the box, so the session
that hits the wall is not the one that filled it. The base `test-preflight.mjs` refuses to start a run
when the temp directory has fewer than 20000 free inodes (`MIN_FREE_INODES`), printing the diagnosis
(`df -i`) plus the remedy. The escape hatch is `AGENT_TOOLING_SKIP_INODE_PREFLIGHT=1`.

## One request per poll tick

**The failure.** REST calls from a shared GitHub account start failing with
`HTTP 403: API rate limit exceeded` while `gh api rate_limit` shows the core quota nearly full. That
is GitHub's **secondary** limit. It counts bursts, concurrency and content-changing requests per
minute, across EVERY session and workflow using the account at once, and it does not appear in
`rate_limit`'s numbers. A script that reads the 403 as a failure ends its wait in a refusal. The
trigger can be a burst of back-to-back writes (for example a package-cleanup run issuing thousands of
DELETEs) on top of several sessions each polling `gh pr view`, `gh pr checks` and
`pr-queue-state.mjs` per PR, every 60 seconds. The first reading, "the core quota is spent, find the
heavy user", is wrong: count requests per tick and how many pollers run at once, not quota.

**Tell the two limits apart.** `gh api rate_limit` is free and does not count against either limit.
A 403 or 429 while `resources.core.remaining` is healthy is the secondary limit. A 403 with core at
0 is the primary limit, which resets at `resources.core.reset`.

**The rules, in order of how much they save:**

1. **One poll tick is ONE request.** If a loop makes two calls per tick, find the one call that
   answers both. `land.sh` waits with `pr-queue-state.mjs`, which already answers `merged <sha>` and
   `closed`, and `compare/<merge>...<synced tag>` takes the tag by name, so a separate sha lookup is
   not needed.
2. **Several PRs are one GraphQL query with aliases**, never one call per PR:
   `node scripts/pr-queue-state.mjs 101 102 103` sends `p101: pullRequest(number:101){...} p102: ...`
   and prints a line per PR with its verdict and the head commit's `statusCheckRollup`. `--json`
   prints an array. An unknown PR reads as `missing` instead of failing the read. (`gh api graphql`
   exits 1 on a partial error, so the script reads the body itself.)
3. **List endpoints over per-item loops.** One `gh run list --json ... -L N` instead of N calls to
   `gh run view`. One `bd show a b c` instead of three calls.
4. **Poll remote state every 5 minutes or slower, and stop when the condition is met.** CI, the
   merge queue and the close-beads tag all move on a scale of minutes, so a 60-second poll mostly
   re-reads the same answer. `land.sh` defaults to `LAND_POLL_SECONDS=300`. Finding a just-dispatched
   run still polls every 15 seconds: it is a handful of calls, and usually none, because gh prints
   the run URL.
5. **A 403 with core quota left means back off, never retry at once.** A retry adds to the burst
   that every other session on the account is also paying for. `lib/gh-rate-limit.mjs` recognises
   gh's wording for both limits (`rate limit`, `RATE_LIMITED`, `abuse detection`, `HTTP 429`) and
   computes the back-off: max(poll, 60s), doubled for each consecutive limited poll, capped at 30
   minutes. `land.sh` (which carries a bash copy of the pattern, held in step by a parity test) and
   `pr-queue-state.mjs` (stdout `ratelimited`, exit 3) back off this way. None of them treats a
   limited poll as a failure or as "no state". The floor is `AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS`
   (default 60).

**ETags are not a free poll.** A 304 to `If-None-Match` is free against the primary limit. Nothing
GitHub publishes says it is free against the secondary limit, and the only way to find out is to
burst the shared account until it trips, which stalls every other session on it. Do not count on
304s until someone can measure it without that cost (a separate account, say).

**A per-machine watcher is the next step if pollers still add up.** Without one, N `land.sh` runs on
one machine are N requests per tick. One leader holding a registry of watched PRs, reading them all
in one aliased GraphQL query and writing a state file that readers consult first, makes it one
request per tick per repository whatever N is. It must be opt-in, must change nothing when it is not
running (readers fall back to their own direct call when there is no live leader, the state is past
its freshness, or a PR was not covered), must back off on a limited read so readers back off too,
and must be stopped by PID or service, never by process name.
