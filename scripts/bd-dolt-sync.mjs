#!/usr/bin/env node
/**
 * bd-dolt-sync.mjs - VERIFIED beads sync.
 *
 * ## The bugs this exists for
 *
 * **1. A pull that merges nothing and says it worked.** `bd dolt pull` can report
 * success and leave the branch exactly as diverged as it was, with no conflict to explain it.
 * Observed in an orchestrator session:
 *
 *   1. `bd update <id> --claim`  -> exit 0
 *   2. `bd dolt pull` -> exit 0 ; `bd dolt push` -> exit 1
 *   3. `bd dolt pull` -> exit 0 ; `bd dolt push` -> exit 1   (again)
 *   4. `dolt status` (CLI) -> "have DIVERGED, and have 2 and 1 different commits each",
 *      conflict table EMPTY
 *   5. `dolt pull` (CLI) -> exit 0, real merge commit, 0 conflicts
 *   6. `bd dolt push` -> exit 0. Synced.
 *
 * A known sibling is the CONFLICT case, where bd prints "Pull complete" over an unresolved
 * merge. That one is the NO-conflict case: the pull is a silent no-op.
 *
 * **2. A conflict abort DISCARDS this session's pending writes.** When bd's pull
 * hits a conflict it prints:
 *
 *   Error: merge origin/main: merge conflicts in issues require operator resolution;
 *          merge aborted and working set restored
 *
 * "working set restored" is the loss. A `bd update` that printed `✓ Updated issue` and reads
 * back correctly is **not yet a commit** - it is a working-set change, and the abort rolls the
 * working set back. Two batches of hygiene edits (14 mutations, then 5) vanished this way
 * with zero trace in `dolt log`, over a conflict that involved none of their beads:
 * two rows differing only in `updated_at`, the same close applied by a session and by a
 * CI close job 90 seconds apart. So this script COMMITS pending writes before it lets any
 * pull run, and refuses to pull when it cannot.
 *
 * **3. This helper's own false green.** It used to parse `dolt status`'s branch
 * line. That line is meaningless here: `.dolt/repo_state.json` has `branches.main.remote: ""`,
 * so dolt prints `Your branch is up to date with 'main'` - main compared against ITSELF. It
 * also ignored the exit status of its `dolt fetch`, so a transient
 * `cannot update manifest: database is read only` (routine - several clones share this one
 * embedded DB) produced `pull verified: up to date with origin/main` on a provably diverged DB.
 * Ground truth is now an explicit `dolt_log('origin/main..main')` / `('main..origin/main')`
 * rev-list count, and a failed fetch is reported as NOT verified.
 *
 * ## What this does
 *
 * Never trust bd's own report, and never trust a status line that compares a branch to itself;
 * ask the dolt CLI for counts ("Trust `dolt`, not bd's output"). Around each
 * operation: commit pending writes, fetch, count ahead/behind/conflicts/dirty, act, re-count.
 * If bd's pull left the branch diverged, run `dolt pull` from the embedded DB directory - which
 * merges the identical state cleanly - and re-check. `push` retries behind a verified pull with
 * bounded backoff, since a non-fast-forward rejection under concurrent sessions is
 * routine and self-healing - but a single retry was not: see PUSH_ATTEMPTS.
 *
 * Deliberately does NOT auto-resolve a real merge conflict: a real one requires resolution by
 * UNION (the other side's note routinely carries detail you need), which is a judgment call, so
 * an unmerged state stops with instructions rather than picking a side.
 *
 * ONE exception: the same bead closed twice - by an author session and by a
 * CI close job seconds apart. Every conflicting row is `closed` on BOTH sides and differs
 * only in close metadata (CLOSE_METADATA_COLUMNS), so there is no detail to union and no judgment
 * to make: keep origin's row (`dolt conflicts resolve --theirs issues`), commit, carry on. Anything
 * wider - another table, an open side, any other differing column, or a conflict that cannot be
 * read - refuses, and the refusal prints the recipe that actually works while the conflict stands
 * (`dolt add . && dolt commit` alone does not: it fails until the conflict is resolved).
 *
 * Usage:
 *   node scripts/bd-dolt-sync.mjs pull     # commit pending writes, pull, verify, CLI-merge if bd no-opped
 *   node scripts/bd-dolt-sync.mjs push     # push, verified-pull + bounded backoff retries
 *   node scripts/bd-dolt-sync.mjs status   # report only; exit 1 if not synced
 *
 * Exit 0 means the issue DB really is in the state the command claims.
 */
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The config loader is optional: a consumer's workflow may stage THIS file alone into a temp
// dir, where the sibling module is absent. Only the issue-prefix lookup below depends on it.
let CONFIG = null;
try {
  CONFIG = await import('./agent-tooling-config.mjs');
} catch {
  CONFIG = null;
}

/**
 * The only branch the beads DB ever uses. The ahead/behind ranges below need the branch name
 * as a literal, and `dolt_log()` will not take an expression - so rather than spend a second
 * round-trip resolving it, the query hardcodes this and returns `active_branch()` alongside so
 * a surprise branch is caught rather than silently measured against the wrong ref.
 */
export const DOLT_BRANCH = 'main';

/** How many times to retry a `dolt fetch` that fails on the shared-clone manifest lock. */
const FETCH_ATTEMPTS = 3;
const FETCH_BACKOFF_MS = [250, 750];

/**
 * Push retry ladder.
 *
 * A non-fast-forward rejection means another session pushed between our pull and our push -
 * routine under concurrent sessions, not exceptional. ONE retry was not enough: a CI close job
 * closed four beads on the runner's own clone, the push was rejected, and
 * then BOTH the bd pull and the dolt CLI pull inside that single retry failed against a DB a
 * concurrent session was mid-push on. The run went red, the runner was discarded, and the four
 * closes went with it - the beads stayed `in_progress` on DoltHub.
 *
 * Bounded on purpose, and deliberately in the tens of seconds rather than minutes: this runs on
 * a single-job-at-a-time self-hosted runner shared with PR auto-review, so a long ladder here
 * blocks every other job on that host. 4 attempts + [2s, 5s, 10s] of sleeping ≈ 17s of waiting
 * plus the three verified pulls in between - call it ~30s worst case.
 */
export const PUSH_ATTEMPTS = 4;
export const PUSH_BACKOFF_MS = [2000, 5000, 10000];

/**
 * Wall-clock cap on a SINGLE `bd dolt push`.
 *
 * bd runs dolt embedded, so one push holds the machine-wide storage lock for as long as it lives
 * and every other session's `bd` - reads included - blocks behind it with no output. One push wedged on the network half of the DoltHub push and held that lock for **67 minutes**,
 * accumulating 1 second of CPU: a claim script printed nothing for 11 minutes and died to its own
 * timeout, a second session's claim queued behind it, and a bare `bd show` from a third shell
 * hung too. The whole bead layer was down for over an hour and then cleared on its own.
 *
 * A cap does not make the push succeed; it makes ONE session fail loudly instead of taking every
 * session with it - the same trade as time-capping a `bd create` with `timeout 90`. Four
 * minutes is far above any healthy push here (seconds) and far below the hour that was paid.
 *
 * Read at CALL time, like `bdCli()`, so a caller or test can set it per case.
 */
export const DEFAULT_PUSH_TIMEOUT_MS = 240_000;
export const pushTimeoutMs = () => {
  const raw = Number(process.env.BD_DOLT_PUSH_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PUSH_TIMEOUT_MS;
};

const PENDING_COMMIT_MSG = '[bd-dolt-sync] commit pending bead writes before sync';

/**
 * The columns a double close may legitimately disagree on: when each side stamped
 * its own close, and what is derived from that. `content_hash` is derived from the row, so a
 * difference in it alone is a consequence of one of the others - any REAL content difference
 * (title, description, notes, assignee, ...) shows up in its own column and refuses.
 */
export const CLOSE_METADATA_COLUMNS = Object.freeze([
  'updated_at',
  'closed_at',
  'close_reason',
  'closed_by_session',
  'content_hash',
  'last_activity',
]);

/** The only table a conflict may be auto-resolved in. */
const AUTO_RESOLVE_TABLE = 'issues';

// Single-line SQL, like buildSyncQuery (cmd.exe truncates argv at a newline).
export const CONFLICT_SUMMARY_QUERY = 'select * from dolt_conflicts';
export const CONFLICT_ISSUES_QUERY = `select * from dolt_conflicts_${AUTO_RESOLVE_TABLE}`;

/** Parse a `dolt sql -r json` envelope into its rows; null when it is not one. */
export function parseJsonRows(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed?.rows) && parsed.rows.every((r) => r && typeof r === 'object')
      ? parsed.rows
      : null;
  } catch {
    return null;
  }
}

/**
 * Decide whether a standing merge conflict is a double close and nothing else.
 *
 * `summaryRows` are `dolt_conflicts` rows (`{ table, num_conflicts }`), `issueRows` are
 * `dolt_conflicts_issues` rows (`base_*`, `our_*`, `their_*`, `our_diff_type`,
 * `their_diff_type`; dolt OMITS a null column from its JSON, so a missing key reads as null).
 * Returns `{ resolvable: true, ids, columns }` or `{ resolvable: false, reason }`. Pure, and
 * fail-closed: anything it does not positively recognise is a refusal.
 */
export function classifyConflicts(summaryRows, issueRows) {
  if (!Array.isArray(summaryRows) || summaryRows.length === 0) {
    return { resolvable: false, reason: 'dolt_conflicts listed no conflicted table' };
  }
  const tables = summaryRows.map((r) => String(r.table ?? r.table_name ?? ''));
  const others = tables.filter((t) => t !== AUTO_RESOLVE_TABLE);
  if (others.length > 0) {
    return { resolvable: false, reason: `conflicts outside ${AUTO_RESOLVE_TABLE}: ${others.join(', ')}` };
  }
  const expected = Number(summaryRows[0].num_conflicts);
  if (!Array.isArray(issueRows) || issueRows.length === 0) {
    return { resolvable: false, reason: `dolt_conflicts_${AUTO_RESOLVE_TABLE} returned no rows` };
  }
  if (!Number.isFinite(expected) || expected !== issueRows.length) {
    return {
      resolvable: false,
      reason: `dolt_conflicts counts ${summaryRows[0].num_conflicts} conflict(s) but ${issueRows.length} row(s) were read`,
    };
  }

  const ids = [];
  const columns = new Set();
  for (const r of issueRows) {
    const ourId = r.our_id ?? null;
    const label = String(ourId ?? r.their_id ?? r.base_id ?? '?');
    if (r.our_diff_type !== 'modified' || r.their_diff_type !== 'modified') {
      return {
        resolvable: false,
        reason: `${label}: not modified on both sides (ours ${r.our_diff_type ?? '?'}, theirs ${r.their_diff_type ?? '?'})`,
      };
    }
    if (ourId === null || ourId !== (r.their_id ?? null)) {
      return { resolvable: false, reason: `${label}: the two sides name different rows` };
    }
    if (r.our_status !== 'closed' || r.their_status !== 'closed') {
      return {
        resolvable: false,
        reason: `${label}: not closed on both sides (ours ${r.our_status ?? 'null'}, theirs ${r.their_status ?? 'null'})`,
      };
    }
    const names = new Set();
    for (const key of Object.keys(r)) {
      const m = /^(our|their)_(.+)$/.exec(key);
      if (m && m[2] !== 'diff_type') names.add(m[2]);
    }
    for (const col of names) {
      const ours = r[`our_${col}`] ?? null;
      const theirs = r[`their_${col}`] ?? null;
      if (JSON.stringify(ours) === JSON.stringify(theirs)) continue;
      if (!CLOSE_METADATA_COLUMNS.includes(col)) {
        return { resolvable: false, reason: `${label}: the sides differ in "${col}", which is not close metadata` };
      }
      columns.add(col);
    }
    ids.push(ourId);
  }
  return { resolvable: true, ids, columns: [...columns].sort() };
}

/**
 * Read the standing conflict. Fail-closed: a query that errors or answers something unreadable
 * is a refusal with the reason, never a guess.
 */
function inspectConflicts(deps, doltDir) {
  const summary = deps.run('dolt', ['sql', '-r', 'json', '-q', CONFLICT_SUMMARY_QUERY], { cwd: doltDir });
  if (summary.status !== 0) {
    const why = (summary.stderr || summary.stdout || '').trim().split('\n')[0];
    return { resolvable: false, reason: `could not read dolt_conflicts${why ? ` (${why})` : ''}` };
  }
  const summaryRows = parseJsonRows(summary.stdout);
  if (!summaryRows) return { resolvable: false, reason: 'dolt_conflicts answered something unreadable' };
  const tables = summaryRows.map((r) => String(r.table ?? r.table_name ?? ''));
  if (tables.some((t) => t !== AUTO_RESOLVE_TABLE)) {
    return { ...classifyConflicts(summaryRows, []), tables };
  }
  const issues = deps.run('dolt', ['sql', '-r', 'json', '-q', CONFLICT_ISSUES_QUERY], { cwd: doltDir });
  if (issues.status !== 0) {
    const why = (issues.stderr || issues.stdout || '').trim().split('\n')[0];
    return { resolvable: false, tables, reason: `could not read dolt_conflicts_${AUTO_RESOLVE_TABLE}${why ? ` (${why})` : ''}` };
  }
  const issueRows = parseJsonRows(issues.stdout);
  if (!issueRows) {
    return { resolvable: false, tables, reason: `dolt_conflicts_${AUTO_RESOLVE_TABLE} answered something unreadable` };
  }
  return { ...classifyConflicts(summaryRows, issueRows), tables };
}

/**
 * The refusal for a conflict this script will not resolve: the recipe that WORKS while the
 * conflict stands. The old advice (`dolt add . && dolt commit`) fails until the conflict is
 * resolved, which is what sent two sessions in circles.
 */
function warnConflictRecipe(deps, doltDir, reason, tables = []) {
  const known = tables.filter(Boolean);
  deps.warn('[bd-dolt-sync] MERGE CONFLICT in the issue DB - resolve by UNION, not by side.');
  if (reason) deps.warn(`[bd-dolt-sync] Not auto-resolved: ${reason}.`);
  deps.warn('[bd-dolt-sync] Inspect the conflict first:');
  deps.warn(`[bd-dolt-sync]   cd ${doltDir}`);
  deps.warn(`[bd-dolt-sync]   dolt sql -q "${CONFLICT_SUMMARY_QUERY}"`);
  const inspect = known.length > 0 ? known : [AUTO_RESOLVE_TABLE];
  for (const t of inspect) {
    deps.warn(
      t === AUTO_RESOLVE_TABLE
        ? '[bd-dolt-sync]   dolt sql -q "select our_id, our_status, their_status, our_updated_at, their_updated_at from dolt_conflicts_issues"'
        : `[bd-dolt-sync]   dolt sql -q "select * from dolt_conflicts_${t}"`,
    );
  }
  deps.warn('[bd-dolt-sync] Then resolve each conflicted table - keep one side whole:');
  const table = known.length === 1 ? known[0] : '<table>';
  deps.warn(`[bd-dolt-sync]   dolt conflicts resolve --theirs ${table}   # keep origin's row`);
  deps.warn(`[bd-dolt-sync]   dolt conflicts resolve --ours ${table}     # keep the local row`);
  deps.warn('[bd-dolt-sync] (For a UNION: resolve --ours, then UPDATE the row with the other side\'s detail.)');
  deps.warn('[bd-dolt-sync] Only once dolt_conflicts is empty:  dolt add . && dolt commit -m "resolve beads merge conflict"');
  deps.warn('[bd-dolt-sync] Then re-run:  node scripts/bd-dolt-sync.mjs push');
  deps.warn("[bd-dolt-sync] See the repository's agent docs on beads merge conflicts.");
}

/**
 * A standing conflict: resolve it when it is a double close, refuse otherwise.
 * Returns `{ ok, ids? }`; on `ok` the caller must re-read the state before trusting anything.
 */
function settleConflict(deps, doltDir) {
  const inspected = inspectConflicts(deps, doltDir);
  if (!inspected.resolvable) {
    warnConflictRecipe(deps, doltDir, inspected.reason, inspected.tables);
    return { ok: false };
  }
  const { ids, columns } = inspected;
  deps.log(
    `[bd-dolt-sync] Merge conflict is a double close only: closed on BOTH sides, differing only in ` +
      `${columns.length ? columns.join(', ') : 'nothing'} - keeping origin's row (--theirs ${AUTO_RESOLVE_TABLE}).`,
  );
  for (const id of ids) deps.log(`[bd-dolt-sync]   auto-resolved ${id}`);

  const steps = [
    ['conflicts', 'resolve', '--theirs', AUTO_RESOLVE_TABLE],
    ['add', '.'],
    ['commit', '-m', `[bd-dolt-sync] auto-resolve double close of ${ids.join(', ')} with --theirs`],
  ];
  for (const args of steps) {
    const r = deps.run('dolt', args, { cwd: doltDir });
    if (r.status !== 0) {
      const why = (r.stderr || r.stdout || '').trim().split('\n')[0];
      deps.warn(`[bd-dolt-sync] dolt ${args.slice(0, 2).join(' ')} FAILED (exit ${r.status})${why ? `: ${why}` : ''}.`);
      warnConflictRecipe(deps, doltDir, 'the automatic resolution failed part-way', [AUTO_RESOLVE_TABLE]);
      return { ok: false };
    }
  }
  return { ok: true, ids };
}

/**
 * Settle a conflict shown by `read`, then re-read. Returns `{ ok, read }`; `ok: false` means the
 * conflict stands (the recipe has been printed) or the state after resolving is not trustworthy.
 */
function settleAndReread(deps, doltDir) {
  const settled = settleConflict(deps, doltDir);
  if (!settled.ok) return { ok: false, read: null };
  const read = readSyncState(deps, doltDir);
  if (!read.state || read.reason === 'unexpected-branch' || read.state.unmerged) {
    deps.warn(
      `[bd-dolt-sync] State after the automatic resolution is not clean` +
        `${read.state ? '' : ` (${explainReason(read.reason, read.detail)})`} - stopping rather than guessing.`,
    );
    return { ok: false, read };
  }
  return { ok: true, read };
}

/**
 * The one query that is ground truth for "are we synced".
 *
 * `ahead`/`behind` are real rev-list counts against `origin/<branch>`, NOT a reading of
 * `dolt status`'s branch line - that line compares main against itself while
 * `branches.main.remote` is empty. `dirty_tables` is what a conflict abort would
 * roll back; `conflicts` is an unresolved merge.
 */
export function buildSyncQuery(branch = DOLT_BRANCH) {
  // Joined with SPACES, never newlines: this string travels as ONE argv
  // element, and the win32 spawn path can route through cmd.exe, which terminates the
  // command line at the first embedded newline - dolt then received just `select`,
  // whose parse error ("syntax error at position 7 near 'select'") broke pull AND
  // push on every Windows dev box while Linux CI stayed green.
  return [
    'select',
    `(select count(*) from dolt_log('origin/${branch}..${branch}')) as ahead,`,
    `(select count(*) from dolt_log('${branch}..origin/${branch}')) as behind,`,
    '(select count(*) from dolt_conflicts) as conflicts,',
    "(select coalesce(group_concat(table_name separator '|'), '') from dolt_status) as dirty_tables,",
    'active_branch() as branch',
  ].join(' ');
}

/**
 * Parse `dolt sql -r json` output for the query above. Returns null when the output is not the
 * single row we asked for - an unreadable answer must never be mistaken for a clean one.
 */
export function parseSyncJson(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const row = Array.isArray(parsed?.rows) ? parsed.rows[0] : null;
  if (!row || typeof row !== 'object') return null;

  const ahead = Number(row.ahead);
  const behind = Number(row.behind);
  const conflicts = Number(row.conflicts);
  if (![ahead, behind, conflicts].every(Number.isFinite)) return null;

  // group_concat with a '|' separator, so a table name can never be mistaken for a delimiter
  // the way it would with the default comma inside CSV output.
  const dirtyTables = String(row.dirty_tables ?? '')
    .split('|')
    .map((t) => t.trim())
    .filter(Boolean);

  return {
    branch: String(row.branch ?? ''),
    ahead,
    behind,
    conflicts,
    dirtyTables,
    diverged: ahead > 0 && behind > 0,
    unmerged: conflicts > 0,
    dirty: dirtyTables.length > 0,
    // "Synced" means nothing local is unpublished - committed OR merely written - and nothing
    // remote is unmerged.
    synced: ahead === 0 && behind === 0 && conflicts === 0 && dirtyTables.length === 0,
  };
}

/**
 * The database directory name under `.beads/embeddeddolt/`.
 *
 * ASSUMPTION: that name equals the configured `beadPrefix` (bd derives the database name from
 * the issue prefix at init). If a repository's database was named otherwise, the lookup does not
 * fail loudly: it resolves a directory that does not exist, and the run reports "sync NOT
 * verified". Set `beadPrefix` in agent-tooling.json to the real directory name to fix that.
 *
 * Best effort: the consumer's configured `beadPrefix` when the config loader is present, else
 * null, in which case resolveDoltDir looks for the single real database directory (one holding
 * a `.dolt` directory) under embeddeddolt/. A config file that fails to load is reported once
 * on stderr, because it otherwise surfaces only as "could not locate the DB".
 */
let configErrorReported = false;
function configuredDbName() {
  const loaded = CONFIG?.tryLoadConfig?.();
  if (loaded?.error && !configErrorReported) {
    configErrorReported = true;
    console.warn(`[bd-dolt-sync] agent-tooling.json could not be loaded (${loaded.error}); not using its beadPrefix.`);
  }
  return loaded?.config?.beadPrefix ?? null;
}

/**
 * Locate the embedded dolt database directory.
 *
 * It lives in the BEADS WORKSPACE, which is the primary checkout - a linked worktree has no
 * `.beads/embeddeddolt` of its own, so walking up from cwd is not enough. Fall back to the git
 * common dir's parent, which resolves to the primary checkout from inside any worktree.
 *
 * `dbName` is the directory under `embeddeddolt/`; when it is not known the single
 * subdirectory found there is used (`readdir` is a seam for tests). More than one candidate
 * is never guessed between: it resolves to nothing, and the caller says it could not verify.
 */
export function resolveDoltDir({ cwd, exists, gitCommonDir, dbName = configuredDbName(), readdir }) {
  const roots = [];
  let dir = cwd;
  for (;;) {
    roots.push(dir);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (gitCommonDir) roots.push(path.dirname(gitCommonDir));
  const candidates = roots.flatMap((root) => embeddedDbCandidates(root, { exists, dbName, readdir }));
  return candidates.find(exists) ?? null;
}

/**
 * The embedded database directory a workspace root would hold: `<root>/.beads/embeddeddolt/<db>`.
 * Returns [] when `dbName` is unknown and the directory does not hold exactly one database.
 *
 * Without a name, only a REAL database directory counts: not dot-prefixed, and holding a
 * `.dolt` directory. In server mode `dolt sql-server` runs in embeddeddolt/ itself and creates
 * `.dolt/` and `.doltcfg/` beside the database, which must not read as extra databases.
 */
export function embeddedDbCandidates(root, { exists, dbName = configuredDbName(), readdir } = {}) {
  const base = path.join(root, '.beads', 'embeddeddolt');
  if (dbName) return [path.join(base, dbName)];
  if (!exists(base)) return [];
  const list = readdir ?? ((p) => fs.readdirSync(p, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name));
  let names;
  try {
    names = list(base);
  } catch {
    return [];
  }
  const real = names.filter((n) => !n.startsWith('.') && exists(path.join(base, n, '.dolt')));
  return real.length === 1 ? [path.join(base, real[0])] : [];
}

/*
 * LIVES IN THIS FILE ON PURPOSE, not under scripts/lib/: a consumer's CI workflow may stage
 * bd-dolt-sync.mjs ALONE into a temp dir (`git show origin/main:scripts/bd-dolt-sync.mjs`), so a
 * static relative import from here to a sibling module would crash that workflow while every
 * in-place run stays green. (The config loader is therefore imported dynamically and is optional.) bd-repo-guard.mjs and any sibling script import it FROM
 * here instead - this file is the one that must stay self-contained.
 */
/**
 * spawnWithShellFallback(cmd, args, opts).
 *
 * Extracted from independent copies of the same "spawn without a shell first, retry through a
 * shell only on ENOENT/EINVAL" pattern, so every script that spawns bd or dolt shares one.
 *
 * ## Why the retry exists at all
 *
 * Windows cannot exec a `.cmd`/`.bat` shim (or an extensionless shebang script) without a
 * shell, and both `bd` and `dolt` are commonly installed as shims there - so a shell-less
 * spawn fails with exit 1 that reads exactly like "the remote rejected us". Every command this
 * module's callers run is a fixed literal with fixed literal arguments, so there is no
 * interpolation for a shell to mangle.
 *
 * No shell FIRST, everywhere: a real executable (dolt, git, node) gets its argv
 * verbatim - cmd.exe truncates at embedded newlines and has its own quoting rules. The shell is
 * only a win32 FALLBACK for commands that are .cmd shims (bd via winget/npm), which CreateProcess
 * cannot start directly. That failure arrives on TWO channels and both must route to the
 * fallback: a bare name that libuv's PATH search misses returns ENOENT in `r.error`, but an
 * EXPLICIT `.cmd`/`.bat` path (e.g. BD_CLI pointing at the shim `where bd` prints) makes Node's
 * BatBadBut mitigation (CVE-2024-27980, Node ≥18.20.1) refuse it with EINVAL - which Node 22
 * and 24 on windows-latest RETURN in `r.error` (measured on windows-latest) but which a
 * spawn can also THROW, so both the catch and the `r.error` check below stay.
 *
 * ## The ETIMEDOUT carve-out
 *
 * A `timeout` expiry also arrives as `r.error` (ETIMEDOUT), and it must NOT route to the win32
 * shell fallback: that fallback exists for a command that never STARTED, and re-running a
 * command that just wedged behind a wall-clock cap (e.g. `bd dolt push`) would
 * re-take whatever lock it was holding for another full cap. bd-repo-guard.mjs's own copy of
 * this pattern was MISSING this carve-out - silent drift from bd-dolt-sync.mjs's copy, since
 * nothing here passes a `timeout` option today, but the next caller that does would otherwise
 * retry a wedged command through the shell instead of reporting `timedOut`.
 */

const NEEDS_SHELL = process.platform === 'win32';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {import('node:child_process').SpawnSyncOptions} [opts]
 * @returns {{ status: number, stdout: string, stderr: string, timedOut?: true }}
 */
export function spawnWithShellFallback(cmd, args, opts = {}) {
  let r;
  try {
    r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  } catch (err) {
    if (!NEEDS_SHELL) throw err;
    r = { error: err };
  }
  // Reported as `timedOut` so the caller can say what happened rather than printing a bare
  // non-zero exit code.
  const timedOut = r.error?.code === 'ETIMEDOUT' || (opts.timeout && r.signal != null && !r.status);
  if (r.error && NEEDS_SHELL && !timedOut) {
    r = spawnSync(cmd, args, { encoding: 'utf8', shell: true, ...opts });
  }
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? '',
    stderr: r.stderr ?? '',
    ...(timedOut ? { timedOut: true } : {}),
  };
}

export const DEFAULT_DEPS = {
  // The no-shell-first / win32-shell-fallback dance is shared with
  // bd-repo-guard.mjs and epic-hygiene.mjs - `spawnWithShellFallback` above.
  run: spawnWithShellFallback,
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  exists: (p) => fs.existsSync(p),
  cwd: () => process.cwd(),
  // Synchronous on purpose - the whole module is spawnSync-shaped so callers can treat it as
  // one blocking gate.
  sleep: (ms) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  },
};

function findDoltDir(deps) {
  const gitCommon = deps.run('git', ['rev-parse', '--git-common-dir']);
  const gitCommonDir =
    gitCommon.status === 0 && gitCommon.stdout.trim()
      ? path.resolve(deps.cwd(), gitCommon.stdout.trim())
      : null;
  // `deps.dbName` is a seam: tests name their fixture database, so the result never depends
  // on the config of whatever repository the suite happens to run in.
  return resolveDoltDir({ cwd: deps.cwd(), exists: deps.exists, gitCommonDir, dbName: deps.dbName });
}

/**
 * `dolt fetch`, retried past the transient shared-clone lock.
 *
 * Five clones share this one embedded DB, so `cannot update manifest: database is read only`
 * from a concurrent bd process is routine rather than exceptional. It is also NOT ignorable:
 * without a successful fetch, `origin/main` is stale and every "behind" count below is a lie
 *.
 */
function doltFetch(deps, doltDir) {
  let last = { status: 1, stdout: '', stderr: '' };
  for (let attempt = 0; attempt < FETCH_ATTEMPTS; attempt += 1) {
    last = deps.run('dolt', ['fetch'], { cwd: doltDir });
    if (last.status === 0) return { ok: true, attempts: attempt + 1, result: last };
    const backoff = FETCH_BACKOFF_MS[attempt];
    if (backoff !== undefined) deps.sleep?.(backoff);
  }
  return { ok: false, attempts: FETCH_ATTEMPTS, result: last };
}

/**
 * Fetch, then read the ground-truth counts.
 *
 * Returns `{ state, reason }`. `reason` is null only when the answer is trustworthy; anything
 * else means the caller must NOT print a verified line, even when `state` is populated (a
 * failed fetch still tells the truth about local dirt and conflicts, but not about `behind`).
 */
function readSyncState(deps, doltDir) {
  const fetched = doltFetch(deps, doltDir);

  const q = deps.run('dolt', ['sql', '-r', 'json', '-q', buildSyncQuery()], { cwd: doltDir });
  if (q.status !== 0) {
    return { state: null, reason: 'query-failed', detail: (q.stderr || q.stdout || '').trim() };
  }
  const state = parseSyncJson(q.stdout);
  if (!state) {
    return { state: null, reason: 'unreadable', detail: String(q.stdout).slice(0, 200) };
  }
  if (state.branch !== DOLT_BRANCH) {
    return { state, reason: 'unexpected-branch', detail: state.branch };
  }
  if (!fetched.ok) {
    return {
      state,
      reason: 'fetch-failed',
      detail: (fetched.result.stderr || fetched.result.stdout || '').trim(),
    };
  }
  return { state, reason: null };
}

/** Human-readable "why this is not verified", for the one warning that says so. */
function explainReason(reason, detail) {
  switch (reason) {
    case 'fetch-failed':
      return `dolt fetch FAILED${detail ? ` (${detail})` : ''} - origin/${DOLT_BRANCH} is stale, so "behind" cannot be trusted`;
    case 'query-failed':
      return `the dolt ground-truth query failed${detail ? ` (${detail})` : ''}`;
    case 'unreadable':
      return 'the dolt ground-truth query returned something unreadable';
    case 'unexpected-branch':
      return `the issue DB is on branch "${detail}", not ${DOLT_BRANCH}`;
    default:
      return 'sync could not be verified';
  }
}

/**
 * Make this session's pending bead writes durable BEFORE anything can abort a merge.
 *
 * A working-set change is not a commit, and bd's conflict abort "restores the working set" -
 * which discards it. Returns `{ ok, committed, read? }`; `ok: false` means the caller
 * must refuse to pull rather than risk the rollback.
 */
function commitPendingWrites(deps, doltDir, tables) {
  deps.warn(
    `[bd-dolt-sync] UNCOMMITTED bead writes in: ${tables.join(', ')} - committing them first.`,
  );
  deps.warn(
    '[bd-dolt-sync] A pull that hits a conflict "restores the working set", which would discard them.',
  );
  const add = deps.run('dolt', ['add', '.'], { cwd: doltDir });
  if (add.status === 0) {
    const commit = deps.run('dolt', ['commit', '-m', PENDING_COMMIT_MSG], { cwd: doltDir });
    if (commit.status === 0) {
      deps.log('[bd-dolt-sync] Pending writes committed - safe from a conflict abort.');
      return { ok: true, committed: true };
    }
    deps.warn(`[bd-dolt-sync] dolt commit FAILED (exit ${commit.status}).`);
    const why = (commit.stderr || commit.stdout || '').trim();
    if (why) deps.warn(`[bd-dolt-sync]   ${why.split('\n')[0]}`);
    // Another writer may have committed between our dirty-state read and this commit
    //. The CLI's failure alone cannot distinguish that race from real pending
    // writes. Require fresh ground truth, including the branch and conflict checks;
    // never treat an "empty commit" message itself as permission to pull.
    const read = readSyncState(deps, doltDir);
    if (read.reason === null && read.state?.branch === DOLT_BRANCH &&
        !read.state.dirty && !read.state.unmerged) {
      deps.log('[bd-dolt-sync] Fresh state has no pending writes or conflicts - continuing without another commit.');
      return { ok: true, committed: false, read };
    }
    if (read.state?.unmerged) {
      // A conflict appeared under us: a plain add+commit cannot clear it.
      deps.warn('[bd-dolt-sync] REFUSING to pull - the issue DB holds an unresolved merge conflict.');
      warnConflictRecipe(deps, doltDir, null);
      return { ok: false, committed: false };
    }
  } else {
    deps.warn(`[bd-dolt-sync] dolt add FAILED (exit ${add.status}).`);
  }
  deps.warn('[bd-dolt-sync] REFUSING to pull - these uncommitted writes would be at risk:');
  for (const t of tables) deps.warn(`[bd-dolt-sync]   ${t}`);
  deps.warn(`[bd-dolt-sync] Commit them by hand first:  cd ${doltDir} && dolt add . && dolt commit -m "..."`);
  return { ok: false, committed: false };
}

/**
 * The bd binary to spawn. Honours $BD_CLI so callers that stub bd (a close script that
 * threads it everywhere, a conformance smoke's fixture) reach the stub through THIS script
 * too. Learned the hard way: a caller invoked this script, this script spawned bare `bd`, and
 * the smoke's temp dir had a real bd with no workspace - a fake "push rejected" followed by a fake pull failure.
 * Read at CALL time, not import time, so tests can set the env per case.
 */
export const bdCli = () => process.env.BD_CLI || 'bd';

/**
 * Shared preamble for both verbs: locate the DB and get this session's writes committed.
 *
 * Returns `{ doltDir, read, blocked }`. `doltDir: null` means we cannot verify anything and,
 * more importantly, cannot protect pending writes - the caller says so out loud and carries on
 * rather than hard-failing every environment without the dolt CLI.
 */
function prepareLocalWrites(deps) {
  const doltDir = findDoltDir(deps);
  if (!doltDir) {
    deps.warn('[bd-dolt-sync] Could not locate the embedded dolt DB under .beads/embeddeddolt - sync NOT verified.');
    deps.warn('[bd-dolt-sync] Pending bead writes cannot be protected from a conflict abort.');
    return { doltDir: null, read: null, blocked: false };
  }

  let read = readSyncState(deps, doltDir);
  if (!read.state) {
    deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - sync NOT verified. See the repo's agent docs.`);
    deps.warn('[bd-dolt-sync] Pending bead writes cannot be protected from a conflict abort.');
    return { doltDir, read, blocked: false };
  }
  if (read.reason === 'unexpected-branch') {
    deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - refusing to sync.`);
    return { doltDir, read, blocked: true };
  }

  // A conflict left standing by an earlier merge. Committing "pending writes" over
  // it fails, and pulling over it cannot help - settle it first, or stop with the recipe.
  if (read.state.unmerged) {
    const settled = settleAndReread(deps, doltDir);
    if (!settled.ok) return { doltDir, read: settled.read ?? read, blocked: true };
    read = settled.read;
  }

  if (read.state.dirty) {
    const committed = commitPendingWrites(deps, doltDir, read.state.dirtyTables);
    if (!committed.ok) return { doltDir, read, blocked: true };
    // Reuse the race recovery's fresh proof, or refresh counts after our own commit.
    const refreshed = committed.read ?? readSyncState(deps, doltDir);
    if (refreshed.reason === 'unexpected-branch') {
      deps.warn(`[bd-dolt-sync] ${explainReason(refreshed.reason, refreshed.detail)} - refusing to sync.`);
      return { doltDir, read: refreshed, blocked: true };
    }
    return { doltDir, read: refreshed, blocked: false };
  }

  return { doltDir, read, blocked: false };
}

/**
 * `bd dolt pull`, then VERIFY it actually merged; fall back to the dolt CLI when it did not.
 * Returns { ok, verified, state }.
 */
export function syncPull(deps = DEFAULT_DEPS) {
  const prepared = prepareLocalWrites(deps);
  if (prepared.blocked) {
    return { ok: false, verified: prepared.read?.reason === null, state: prepared.read?.state ?? null };
  }

  const pull = deps.run(bdCli(), ['dolt', 'pull']);
  if (pull.status !== 0) {
    deps.warn(`[bd-dolt-sync] bd dolt pull FAILED (exit ${pull.status}).`);
  }

  const { doltDir } = prepared;
  if (!doltDir) return { ok: pull.status === 0, verified: false, state: null };

  let read = readSyncState(deps, doltDir);
  if (!read.state) {
    deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - sync NOT verified. See the repo's agent docs.`);
    return { ok: pull.status === 0, verified: false, state: null };
  }

  let state = read.state;

  if (state.unmerged) {
    const settled = settleAndReread(deps, doltDir);
    if (!settled.ok) return { ok: false, verified: read.reason === null, state: settled.read?.state ?? state };
    read = settled.read;
    state = read.state;
  }

  if (state.diverged) {
    // The silent no-op: bd reported success and merged nothing. The CLI merges it cleanly.
    deps.log(
      `[bd-dolt-sync] bd dolt pull left the branch DIVERGED (${state.ahead} local / ${state.behind} remote)` +
        ' - merging with the dolt CLI instead.',
    );
    const cliPull = deps.run('dolt', ['pull'], { cwd: doltDir });
    if (cliPull.status !== 0) {
      deps.warn(`[bd-dolt-sync] dolt pull FAILED (exit ${cliPull.status}).`);
    }
    read = readSyncState(deps, doltDir);
    state = read.state ?? state;
    // Routed through a bd sql-server, the CLI merge EXITS NON-ZERO on a conflict yet
    // still leaves it standing; embedded, it exits 0. Either way the standing conflict decides.
    if (cliPull.status !== 0 && !read.state?.unmerged) {
      return { ok: false, verified: read.reason === null, state };
    }
    if (read.state?.unmerged) {
      // The CLI merge leaves a conflict STANDING (bd's own pull aborts instead) - the shape
      // a double close produces.
      const settled = settleAndReread(deps, doltDir);
      if (!settled.ok) return { ok: false, verified: read.reason === null, state: settled.read?.state ?? state };
      read = settled.read;
      state = read.state;
    }
    if (state.diverged || state.unmerged) {
      deps.warn('[bd-dolt-sync] Still not merged after a CLI pull - stopping rather than guessing.');
      return { ok: false, verified: read.reason === null, state };
    }
  }

  // Only ever claim "verified" when the fetch behind these numbers actually succeeded - the
  // whole point of this helper is to be ground truth, so a false green here is the most
  // expensive kind.
  if (read.reason !== null) {
    deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - sync NOT verified. See the repo's agent docs.`);
    return { ok: pull.status === 0, verified: false, state };
  }

  // Say what was verified. Two sessions reported that a healthy pull "looks like a
  // no-op until you run status" - and silent success is precisely what let the silent no-op
  // hide for a day. The happy path should be as explicit as the sad ones.
  deps.log(
    state.ahead > 0
      ? `[bd-dolt-sync] pull verified: in sync with origin, ${state.ahead} local commit(s) still to publish.`
      : `[bd-dolt-sync] pull verified: up to date with origin/${DOLT_BRANCH}.`,
  );
  return { ok: true, verified: true, state };
}

/**
 * `bd dolt push`, retried behind a verified pull with bounded backoff.
 *
 * A non-fast-forward rejection means another session pushed between your pull and your push -
 * routine under concurrency, and the whole reason a retry is right here rather than an error
 * (the repo's agent rules). Each attempt does the full verified-pull dance before pushing again.
 *
 * Two things this deliberately does NOT do:
 *
 * - **It does not abandon the ladder on the first failed pull.** A pull that fails here is
 *   almost always the SAME contention that rejected the push (a concurrent session mid-push,
 *   or the shared-clone manifest lock), so giving up on it turns a transient race into lost
 *   closes - exactly what happened on run 33194890814. Back off and try the whole thing again.
 * - **It does not retry a non-race failure.** An unresolved merge conflict is a data-level
 *   state that no amount of retrying can clear; it needs resolution by UNION. Stop
 *   immediately and say so, rather than hammering the remote three more times for nothing.
 *
 * Never `--force`: that overwrites the shared DB with the local one, the one action the agent rules
 * forbid outright.
 */
export function syncPush(deps = DEFAULT_DEPS) {
  // Uncommitted writes push NOTHING while `bd dolt push` still exits 0 - the same false green
  // in the other direction, so commit them first.
  const prepared = prepareLocalWrites(deps);
  if (prepared.blocked) {
    return { ok: false, retried: false, attempts: 0, ...(prepared.read?.state?.unmerged ? { unmerged: true } : {}) };
  }

  for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
    const timeout = pushTimeoutMs();
    const push = deps.run(bdCli(), ['dolt', 'push'], { timeout });
    if (push.timedOut) {
      // A wedged push, not a rejected one. Say which, and say what it cost -
      // the failure people actually hit is every OTHER session's `bd` hanging behind the
      // lock this push was holding, with nothing on screen to explain it.
      deps.warn(
        `[bd-dolt-sync] bd dolt push was KILLED after ${timeout}ms - it did not reject, it WEDGED` +
          '. One such push once held the machine-wide embedded-dolt lock for 67 minutes,' +
          ' blocking every session\'s bd, reads included.',
      );
      deps.warn('[bd-dolt-sync] NOT retried: a retry just re-takes that lock. Check, in order:');
      deps.warn('[bd-dolt-sync]   1. that nothing is still holding it - a bd/dolt process with seconds');
      deps.warn('[bd-dolt-sync]      of CPU against minutes of wall clock is wedged, not busy;');
      deps.warn('[bd-dolt-sync]      Linux: ps -o pid,etimes,time,stat,wchan:20 -p <pid>');
      deps.warn('[bd-dolt-sync]      Windows: Get-Process -Id <pid> | Select-Object Id,CPU,StartTime');
      deps.warn('[bd-dolt-sync]   2. reachability of DoltHub - the wedge was on the network half;');
      deps.warn('[bd-dolt-sync]   3. then re-run: node scripts/bd-dolt-sync.mjs push');
      deps.warn('[bd-dolt-sync] Server mode (a bd sql-server): killing bd did NOT stop the push -');
      deps.warn('[bd-dolt-sync]   the server may still be running it. Wait, then run status before pushing again.');
      deps.warn(`[bd-dolt-sync] Raise BD_DOLT_PUSH_TIMEOUT_MS (now ${timeout}) for a genuinely slow link.`);
      deps.warn('[bd-dolt-sync] Do NOT kill another session\'s bd - a push killed mid-write risks the local DB.');
      return { ok: false, retried: attempt > 1, attempts: attempt, timedOut: true };
    }
    if (push.status === 0) {
      // deps.run CAPTURES bd's own "Push complete", so without this the command prints
      // nothing at all on success - same silent-success genre.
      //
      // And without the retry variant, the last line on screen is the retry-pull's "N local
      // commit(s) still to publish" - a SUCCESSFUL retry that reads like a failure. A session
      // ran `dolt status` three times to confirm syncs that had in fact succeeded.
      deps.log(
        attempt === 1
          ? '[bd-dolt-sync] push verified: published.'
          : `[bd-dolt-sync] push verified: published after retry (attempt ${attempt}/${PUSH_ATTEMPTS}).`,
      );
      return { ok: true, retried: attempt > 1, attempts: attempt };
    }

    if (attempt === PUSH_ATTEMPTS) break;

    deps.log(
      `[bd-dolt-sync] bd dolt push rejected (attempt ${attempt}/${PUSH_ATTEMPTS})` +
        ' - another session pushed first. Pulling, then retrying.',
    );
    const pulled = syncPull(deps);
    if (!pulled.ok) {
      if (pulled.state?.unmerged) {
        deps.warn(
          '[bd-dolt-sync] Push blocked by an UNRESOLVED merge conflict, not by a race' +
            ' - retrying cannot clear it, so stopping here.',
        );
        return { ok: false, retried: attempt > 1, attempts: attempt, unmerged: true };
      }
      deps.warn(
        `[bd-dolt-sync] The pull before retry ${attempt + 1}/${PUSH_ATTEMPTS} FAILED` +
          ' - usually the same concurrent push that rejected us. Backing off and retrying anyway.',
      );
    }

    const backoff = PUSH_BACKOFF_MS[attempt - 1] ?? PUSH_BACKOFF_MS[PUSH_BACKOFF_MS.length - 1];
    deps.log(`[bd-dolt-sync] waiting ${backoff}ms before push attempt ${attempt + 1}/${PUSH_ATTEMPTS}.`);
    deps.sleep?.(backoff);
  }

  deps.warn(
    `[bd-dolt-sync] Push STILL rejected after ${PUSH_ATTEMPTS} attempts behind verified pulls.` +
      ' Do NOT --force - inspect:',
  );
  deps.warn(`[bd-dolt-sync]   cd ${path.relative(deps.cwd(), prepared.doltDir) || prepared.doltDir} && dolt status && dolt log --oneline -5`);
  return { ok: false, retried: true, attempts: PUSH_ATTEMPTS };
}

/**
 * Read the local issue count. Returns null when the answer cannot be read - an unreadable
 * count must never be treated as "empty", because "empty" is what authorises a hard reset.
 */
export function parseIssueCount(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const row = Array.isArray(parsed?.rows) ? parsed.rows[0] : null;
  if (!row || typeof row !== 'object') return null;
  const n = Number(row.c);
  return Number.isFinite(n) ? n : null;
}

/**
 * Fresh-clone recovery: adopt `origin/<branch>` wholesale, discarding the local dolt history.
 *
 * `bd init` seeds an empty database with its own commits, which share no root with the DoltHub
 * history. `bd dolt pull` can then never fast-forward and the CLI-merge fallback in syncPull()
 * cannot help either - the clone is stuck at 0 issues with no tracker.
 *
 * The reset is only safe because the local side is provably empty, so this REFUSES unless the
 * local issue count reads exactly 0. A non-zero count, or a count that cannot be read at all,
 * means somebody's writes are at stake and the caller must resolve it by hand.
 */
export function adoptRemote(deps = DEFAULT_DEPS) {
  const doltDir = findDoltDir(deps);
  if (!doltDir) {
    deps.warn('[bd-dolt-sync] No embedded dolt DB found - nothing to adopt.');
    return { ok: false, adopted: false };
  }

  const counted = deps.run('dolt', ['sql', '-r', 'json', '-q', 'select count(*) as c from issues'], {
    cwd: doltDir,
  });
  const local = counted.status === 0 ? parseIssueCount(counted.stdout) : null;
  if (local === null) {
    deps.warn('[bd-dolt-sync] Could not read the local issue count - refusing to reset. Resolve by hand.');
    return { ok: false, adopted: false };
  }
  if (local > 0) {
    deps.warn(
      `[bd-dolt-sync] Local DB holds ${local} issue(s) - refusing to discard them.` +
        ' adopt is only for a fresh clone whose local history is empty.',
    );
    return { ok: false, adopted: false };
  }

  const fetched = doltFetch(deps, doltDir);
  if (!fetched.ok) {
    deps.warn(
      `[bd-dolt-sync] dolt fetch failed after ${fetched.attempts} attempt(s) - cannot adopt the remote.`,
    );
    return { ok: false, adopted: false };
  }

  const reset = deps.run('dolt', ['reset', '--hard', `origin/${DOLT_BRANCH}`], { cwd: doltDir });
  if (reset.status !== 0) {
    deps.warn(`[bd-dolt-sync] dolt reset --hard origin/${DOLT_BRANCH} FAILED (exit ${reset.status}).`);
    return { ok: false, adopted: false };
  }

  const read = readSyncState(deps, doltDir);
  if (!read.state || read.reason !== null) {
    deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - adopt NOT verified.`);
    return { ok: false, adopted: true };
  }
  if (!read.state.synced) {
    deps.warn(`[bd-dolt-sync] Still not synced after adopt: ${JSON.stringify(read.state)}`);
    return { ok: false, adopted: true };
  }
  deps.log(`[bd-dolt-sync] adopted origin/${DOLT_BRANCH} (local history was empty).`);
  return { ok: true, adopted: true };
}

export function main(argv, deps = DEFAULT_DEPS) {
  const cmd = argv[0] ?? 'status';
  if (cmd === 'pull') return syncPull(deps).ok ? 0 : 1;
  if (cmd === 'push') return syncPush(deps).ok ? 0 : 1;
  if (cmd === 'adopt') return adoptRemote(deps).ok ? 0 : 1;
  if (cmd === 'status') {
    const doltDir = findDoltDir(deps);
    if (!doltDir) {
      deps.warn('[bd-dolt-sync] No embedded dolt DB found.');
      return 1;
    }
    const read = readSyncState(deps, doltDir);
    if (!read.state || read.reason !== null) {
      deps.warn(`[bd-dolt-sync] ${explainReason(read.reason, read.detail)} - NOT verified.`);
      return 1;
    }
    deps.log(`[bd-dolt-sync] ${JSON.stringify(read.state)}`);
    return read.state.synced ? 0 : 1;
  }
  deps.warn('Usage: node scripts/bd-dolt-sync.mjs <pull|push|status|adopt>');
  return 2;
}

// Node resolves the loaded module's symlinks; resolve the CLI path the same way.
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
