#!/usr/bin/env node
/**
 * bd-repo-guard.mjs - undo the repo churn `bd` makes while setting itself up.
 *
 * ## The bug this exists for
 *
 * `bd` rewrites tracked files that this repo deliberately owns, and - the half that hid for
 * longest - it also COMMITS them.
 *
 * **The dirty half.** `bd setup claude` / `bd setup gemini` append a managed beads
 * block to `CLAUDE.md` and `GEMINI.md`, which a repo may deliberately keep minimal to avoid drift, and rewrite
 * `.claude/settings.json`, dropping the PreCompact hook and re-escaping the file. a repo's setup script
 * can snapshot and restore those three around the bd steps.
 *
 * **The committed half.** `bd dolt remote remove|add` rewrites `.beads/config.yaml`
 * and commits it, unasked, onto whatever branch is checked out - `main` for the primary checkout
 * every contributor runs setup in. One setup run leaves a `bd: clear sync.remote` and a
 * `bd: update sync.remote` commit behind; a second run leaves four. Observed on a fresh clone.
 *
 * The rewrite moves the flat key `sync.remote: "https://…"` into a nested `sync:` block and
 * COMMENTS OUT the flat one, re-indents `backup.git-push` and `export.auto` from 2 spaces to 4,
 * and strips the blank lines between every documented section - leaving the file's own trailing
 * warning comment, which names the flat key and says "restore the DoltHub URL, do not commit the
 * auto-detected one", pointing at a key that is now commented out. The VALUE is
 * preserved, which is exactly why it goes unnoticed.
 *
 * Reverting is verified harmless: after `git reset --hard origin/main`, `bd dolt pull` succeeds
 * and bd does not re-dirty or re-commit the file. `bd dolt remote add` registers the remote with
 * the dolt CLI - that is the part that matters and it survives; the config rewrite is a side
 * effect, not a required migration.
 *
 * ## Why a commit is worse than a dirty file
 *
 * A setup script's end-of-run check reads `git status --porcelain`. A commit leaves the tree
 * CLEAN, so the check passes and says nothing. Meanwhile every agent session is told to verify
 * `git status` shows "up to date with origin" - which now fails for a reason unrelated to any
 * work the session did, on a file it never touched. A session that does not notice, and cuts a
 * branch from that local `main`, carries the churn into a PR.
 *
 * ## What this does
 *
 *   snapshot <dir>   before the bd steps: record HEAD, and copy every bd-owned file that is
 *                    currently CLEAN
 *   restore  <dir>   after them: reset HEAD back if - and only if - every commit bd added is
 *                    provably its own, then put the snapshotted contents back
 *
 * Two deliberate restraints:
 *
 * - **Only CLEAN files are snapshotted.** A file the contributor had already modified is left
 *   alone. Tidying up after bd must never discard their work.
 * - **The reset is `--mixed`, never `--hard`, and never runs on an unrecognised commit.** A
 *   `--hard` would destroy uncommitted work that has nothing to do with bd; `--mixed` moves the
 *   ref and touches no file content, so the restore loop below is what puts the file back and
 *   anything else bd happened to stage simply shows up as an ordinary modification. If ANY
 *   commit in the range is not bd-owned - wrong subject, or a file outside the bd surface - this
 *   resets nothing and warns instead. Refusing is always recoverable; a wrong reset is not.
 *
 * Usage:
 *   node scripts/bd-repo-guard.mjs snapshot <dir>
 *   node scripts/bd-repo-guard.mjs restore  <dir>
 */

import fs from 'node:fs';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnWithShellFallback } from './bd-dolt-sync.mjs';

/**
 * Tracked files `bd` is known to rewrite during setup. Repo-relative, forward slashes.
 *
 * `.beads/config.yaml` is the one bd COMMITS; the other three it merely dirties.
 */
export const BD_OWNED_FILES = [
  'CLAUDE.md',
  'GEMINI.md',
  '.claude/settings.json',
  '.beads/config.yaml',
];

/**
 * Commit subjects bd writes for the config rewrite, as a prefix test.
 *
 * Matched in ADDITION to the path check below, never instead of it: a subject is a string bd
 * controls and may reword, whereas "this commit touches only files bd owns" is the property that
 * actually makes a reset safe. Requiring both can only ever make this refuse MORE often, which is
 * the safe direction.
 */
const BD_COMMIT_SUBJECT = /^bd:\s/;

/** Is this repo-relative path part of the surface bd is allowed to have touched? */
export function isBdOwnedPath(p) {
  if (typeof p !== 'string' || p === '') return false;
  const norm = p.split(path.sep).join('/').replace(/^\.\//, '');
  if (BD_OWNED_FILES.includes(norm)) return true;
  // The whole .beads/ directory is bd's own state, not repo content an agent authored.
  return norm.startsWith('.beads/');
}

/**
 * Decide whether the commits bd added may be reset away.
 *
 * @param commits [{ sha, subject, files: string[] }] in any order, oldest-first by convention.
 * @returns { safe, reason, offenders } - `safe` only when there is at least one commit and
 *          EVERY one of them is recognisably bd's. An empty list is `safe: false` with reason
 *          `'no-commits'` so a caller cannot read "nothing to undo" as "undo succeeded".
 */
export function classifyChurnCommits(commits) {
  if (!Array.isArray(commits) || commits.length === 0) {
    return { safe: false, reason: 'no-commits', offenders: [] };
  }
  const offenders = [];
  for (const c of commits) {
    const badSubject = !BD_COMMIT_SUBJECT.test(c.subject ?? '');
    const badFiles = (c.files ?? []).filter((f) => !isBdOwnedPath(f));
    // A commit that touches NOTHING is not recognisably bd's either - an empty file list is
    // what a failed `git show --name-only` looks like, and treating that as "no foreign files"
    // would let a parse failure authorise the reset.
    const noFiles = (c.files ?? []).length === 0;
    if (badSubject || badFiles.length > 0 || noFiles) {
      offenders.push({
        sha: c.sha,
        subject: c.subject,
        reason: badSubject ? 'subject' : noFiles ? 'no-files' : 'files',
        files: badFiles,
      });
    }
  }
  if (offenders.length > 0) return { safe: false, reason: 'foreign-commits', offenders };
  return { safe: true, reason: null, offenders: [] };
}

export const DEFAULT_DEPS = {
  // Shared with bd-dolt-sync.mjs - see `spawnWithShellFallback` there. A private copy of
  // it once lacked the ETIMEDOUT carve-out (silent drift); sharing one picks that up for free.
  run: spawnWithShellFallback,
  log: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  exists: (p) => fs.existsSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  writeFile: (p, data) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  },
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
};

/** Current HEAD sha, or null when git cannot answer (no commits, not a repo). */
function headSha(deps) {
  const r = deps.run('git', ['rev-parse', 'HEAD']);
  const sha = r.status === 0 ? r.stdout.trim() : '';
  return sha || null;
}

/** Is this repo-relative path clean in BOTH the worktree and the index? */
function isClean(deps, file) {
  if (!deps.exists(file)) return false;
  const worktree = deps.run('git', ['diff', '--quiet', '--', file]);
  const index = deps.run('git', ['diff', '--cached', '--quiet', '--', file]);
  return worktree.status === 0 && index.status === 0;
}

/**
 * Record HEAD and the current contents of every bd-owned file that is clean right now.
 *
 * Writes `<dir>/HEAD` (may be the empty string when git has no HEAD yet), `<dir>/clean.txt`
 * (one repo-relative path per line) and `<dir>/files/<path>`.
 */
export function snapshot(dir, deps = DEFAULT_DEPS) {
  const head = headSha(deps);
  const clean = BD_OWNED_FILES.filter((f) => isClean(deps, f));
  deps.mkdir(dir);
  deps.writeFile(path.join(dir, 'HEAD'), head ?? '');
  deps.writeFile(path.join(dir, 'clean.txt'), clean.length ? `${clean.join('\n')}\n` : '');
  for (const f of clean) {
    deps.writeFile(path.join(dir, 'files', f), deps.readFile(f));
  }
  return { ok: true, head, clean };
}

/** Commits in `before..HEAD`, each with its subject and changed files. */
function commitsSince(deps, before) {
  const list = deps.run('git', ['rev-list', '--reverse', `${before}..HEAD`]);
  if (list.status !== 0) return null;
  const shas = list.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  const commits = [];
  for (const sha of shas) {
    const subj = deps.run('git', ['log', '-1', '--format=%s', sha]);
    // --name-only with --format= prints a leading blank line, hence the filter.
    const files = deps.run('git', ['show', '--name-only', '--format=', sha]);
    if (subj.status !== 0 || files.status !== 0) return null;
    commits.push({
      sha,
      subject: subj.stdout.trim(),
      files: files.stdout.split('\n').map((s) => s.trim()).filter(Boolean),
    });
  }
  return commits;
}

/**
 * Put the tree back the way `snapshot` found it.
 *
 * Order matters: the HEAD reset runs FIRST, because `--mixed` leaves the rewritten content in
 * the working tree, and the file restore below is what actually returns that content to its
 * committed state.
 *
 * The two halves are independent on purpose. When the reset is refused, the file restore still
 * runs - which for a file bd had COMMITTED leaves it reading as modified against the new HEAD.
 * That is the intended outcome, not an oversight: the contributor gets a loud warning about the
 * unrecognised commit AND a dirty file, both pointing at the same thing needing review, instead
 * of bd's rewrite sitting silently in the history. It only arises when something else committed
 * during setup, which is already anomalous.
 */
export function restore(dir, deps = DEFAULT_DEPS) {
  const headFile = path.join(dir, 'HEAD');
  if (!deps.exists(headFile)) {
    deps.warn(`[bd-repo-guard] no snapshot at ${dir} - nothing to restore.`);
    return { ok: false, reason: 'no-snapshot', reset: false, reverted: [] };
  }
  const before = deps.readFile(headFile).trim();
  const now = headSha(deps);

  let reset = false;
  if (before && now && before !== now) {
    const commits = commitsSince(deps, before);
    const verdict = commits === null
      ? { safe: false, reason: 'unreadable-history', offenders: [] }
      : classifyChurnCommits(commits);
    if (verdict.safe) {
      const r = deps.run('git', ['reset', '--mixed', before]);
      if (r.status === 0) {
        reset = true;
        deps.log(
          `  reset HEAD back to ${before.slice(0, 8)} - bd committed ${commits.length} ` +
          `change(s) to its own files unasked`,
        );
      } else {
        deps.warn(`[bd-repo-guard] git reset --mixed ${before} failed: ${r.stderr.trim()}`);
      }
    } else {
      // Refusing is the safe outcome and must be LOUD: the commits are real and still there.
      deps.warn('');
      deps.warn(`WARNING: HEAD moved during setup (${before.slice(0, 8)} -> ${now.slice(0, 8)}) and`);
      deps.warn('  the new commits are NOT all bd\'s own, so setup did not reset them:');
      for (const o of verdict.offenders) {
        deps.warn(`    ${String(o.sha).slice(0, 8)} ${o.subject} [${o.reason}${o.files.length ? `: ${o.files.join(', ')}` : ''}]`);
      }
      deps.warn('  Review them by hand before pushing.');
      deps.warn('');
    }
  }

  const listFile = path.join(dir, 'clean.txt');
  const clean = deps.exists(listFile)
    ? deps.readFile(listFile).split('\n').map((s) => s.trim()).filter(Boolean)
    : [];
  const reverted = [];
  for (const f of clean) {
    const saved = path.join(dir, 'files', f);
    if (!deps.exists(saved)) continue;
    const want = deps.readFile(saved);
    const have = deps.exists(f) ? deps.readFile(f) : null;
    if (have === want) continue;
    deps.writeFile(f, want);
    reverted.push(f);
    deps.log(`  reverted ${f} - bd rewrote it; repo guidance lives in its agent docs`);
  }
  return { ok: true, reason: null, reset, reverted };
}

export function main(argv, deps = DEFAULT_DEPS) {
  const cmd = argv[0];
  const dir = argv[1];
  if ((cmd === 'snapshot' || cmd === 'restore') && dir) {
    // Never fail setup over this - the guard is a tidy-up, not a prerequisite. A crash here
    // must not cost the contributor the steps that come after it in the setup script.
    try {
      if (cmd === 'snapshot') snapshot(dir, deps);
      else restore(dir, deps);
    } catch (err) {
      deps.warn(`[bd-repo-guard] ${cmd} failed: ${err?.message ?? err}`);
    }
    return 0;
  }
  deps.warn('Usage: node scripts/bd-repo-guard.mjs <snapshot|restore> <dir>');
  return 2;
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
