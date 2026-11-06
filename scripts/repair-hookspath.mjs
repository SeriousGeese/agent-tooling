#!/usr/bin/env node
// Detect and repair `core.hooksPath` drift so the repo's CHAINED hooks actually run.
//
// Why this exists, and why setting the value was not enough:
//
// `.beads/hooks/*` are tracked files that chain three things git will not chain for you -
// the beads shim, `git lfs pre-push`/`post-checkout`/`post-merge`/`post-commit`, and this repo's own
// `scripts/hooks/*.mjs` guards (`warn-dropped-files`, `block-rebase-in-progress-push`, the
// prepare-commit-msg rebase bail-out). Git only runs whatever `core.hooksPath` resolves to.
// Point it at `.git/hooks` and every one of those goes silently missing: no error, no warning,
// and `bd hooks list` still cheerfully reports "installed", because it is describing the
// shims in `.git/hooks`, not the repo's chained hooks.
//
// Measured on the product owner's machine 2026-09-06: the value was an ABSOLUTE path to the
// primary checkout's own `.git/hooks`, present in BOTH `.git/config` AND the per-worktree
// `config.worktree` of all seven linked worktrees (`extensions.worktreeConfig` is true there).
// a setup script had been setting `--local core.hookspath .beads/hooks` since 2026-07-16 and
// re-running it fixed nothing visible, because `--local` does not touch a `--worktree`
// override and a `--worktree` override WINS. So a repair that only rewrites `.git/config` is
// the specific incomplete fix this exists to avoid.
//
// Two git details this leans on:
//   - git writes the key as `hooksPath` and reads it case-insensitively. NEVER grep the config
//     file for a lowercase `hookspath`; that returns a clean false negative. Ask git.
//   - a RELATIVE `core.hooksPath` is resolved against the top level of the working tree, so the
//     relative `.beads/hooks` is correct in the primary checkout AND in every linked worktree.
//     An absolute path is not portable the same way, a worktree that later moves takes its
//     absolute override with it, pointing nowhere, so drift detection still prefers and repairs
//     TOWARD the relative form.
//
// that preference must not become a FALSE POSITIVE. `--check` reported drift across
// 14 worktrees (12 belonging to other sessions) and claimed the chained hooks were NOT running,
// when the effective `pre-push` hook was byte-identical to the primary's `.beads/hooks/pre-push`
// and did chain `git lfs pre-push`, every one of those overrides was an ABSOLUTE path pointing
// at the primary checkout's `.beads/hooks`, which RESOLVES correctly and SERVES the right files.
// The bug was `sameHooksPath` alone: it compares the configured value to the literal string
// `.beads/hooks` with no path resolution at all, so ANY absolute value fails that comparison
// regardless of where it points. `hooksPathResolvesToDesired` below is the real check: resolve
// both sides to absolute paths first (`hooksPathResolvesToDesired`/`resolveHooksPathAbs`), and
// when a worktree's override points at a DIFFERENT directory than its own `.beads/hooks` (e.g.
// the primary's), fall back to comparing the actual hook FILES (`hooksDirsEquivalent`), if they
// are byte-identical, the hooks really are running and this is not reportable drift. A value
// pointing at an empty or genuinely different directory (`.git/hooks`) still fails both checks
// and is still reported and repaired, same as before.
//
// Usage:
//   node scripts/repair-hookspath.mjs            # repair; silent when already healthy
//   node scripts/repair-hookspath.mjs --check    # report only, exit 1 on drift
//   node scripts/repair-hookspath.mjs --verbose  # say "already correct" instead of nothing

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The one correct value. Relative on purpose, see the header. A consumer whose tracked hooks
 * live somewhere other than `.beads/hooks` sets AGENT_TOOLING_HOOKS_PATH (a path relative to the
 * top of the working tree).
 */
export const DESIRED_HOOKS_PATH = (process.env.AGENT_TOOLING_HOOKS_PATH || '').trim() || '.beads/hooks';

const CONFIG_KEY = 'core.hookspath';

function git(args, { cwd = process.cwd() } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    failedToSpawn: r.error != null,
  };
}

/** Compare two configured hooksPath values. Windows paths differ only by case/separator. */
export function sameHooksPath(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const norm = (s) => {
    const t = s.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    return process.platform === 'win32' ? t.toLowerCase() : t;
  };
  return norm(a) === norm(b);
}

/**
 * Resolve a configured `core.hooksPath` VALUE, relative or absolute, to an absolute path,
 * against `baseDir` (the git root that a RELATIVE value would be interpreted from). An
 * already-absolute value passes through `path.resolve` unchanged except for normalisation.
 */
export function resolveHooksPathAbs(value, baseDir) {
  return path.resolve(baseDir, value);
}

function normalizeForCompare(p) {
  const norm = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? norm.toLowerCase() : norm;
}

/**
 * Are two hook files the same once line endings are ignored? A hook checked out on
 * Windows is CRLF in the primary checkout and LF in a script-created worktree, so a byte compare
 * called five text-identical hooks "different" and reported the chained hooks as not running.
 * Only `\r\n` -> `\n` is normalised (a trailing-newline difference is just EOL too); any other
 * content difference is still drift. A file containing a NUL byte is binary and stays byte-exact.
 */
export function hookFilesEquivalent(fileA, fileB) {
  const a = readFileSync(fileA);
  const b = readFileSync(fileB);
  if (a.equals(b)) return true;
  if (a.includes(0) || b.includes(0)) return false;
  const norm = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n').replace(/\n+$/, '');
  return norm(a) === norm(b);
}

/**
 * Do two hook directories contain the exact same set of files with identical content (modulo
 * line endings, see `hookFilesEquivalent`)?
 * Used as a fallback when a configured value does not textually/path-resolve to the LOCAL
 * worktree's own `.beads/hooks`, e.g. an absolute override pointing at the PRIMARY checkout's
 * `.beads/hooks` instead of the linked worktree's own tracked copy. If the files it
 * would actually run are identical to what `.beads/hooks` holds here, the chained hooks ARE
 * running correctly and this is not the drift `--check` exists to catch, even though the value
 * is not portable (see the header note on why a correct-but-absolute value is still repaired).
 * An empty or unreadable directory is never treated as equivalent to anything (a real absence of
 * hooks must never read as "fine").
 */
export function hooksDirsEquivalent(dirA, dirB) {
  try {
    const listFiles = (d) =>
      readdirSync(d)
        .filter((f) => statSync(path.join(d, f)).isFile())
        .sort();
    const filesA = listFiles(dirA);
    const filesB = listFiles(dirB);
    if (filesA.length === 0) return false;
    if (filesA.length !== filesB.length || filesA.some((f, i) => f !== filesB[i])) return false;
    return filesA.every((f) => hookFilesEquivalent(path.join(dirA, f), path.join(dirB, f)));
  } catch (err) {
    if (err?.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Is this configured `core.hooksPath` VALUE effectively healthy from `baseDir`, the textual
 * `.beads/hooks` match `sameHooksPath` already covers, OR an absolute (or differently-spelled
 * relative) path that resolves to the same directory, OR one whose files are content-identical
 * to it? `sameHooksPath` alone flags every absolute override unconditionally, even
 * one that resolves to exactly the right directory or serves byte-identical hook files, which is
 * what produced a false "chained hooks are NOT running" report against 14 worktrees when the
 * effective pre-push hook was in fact byte-identical to the primary's and did chain `git lfs
 * pre-push`. Confirmed against the comparison logic before this fix: `sameHooksPath` never
 * resolves a path at all, so ANY absolute value fails the literal `.beads/hooks` string
 * comparison regardless of where it points.
 */
export function hooksPathResolvesToDesired(value, baseDir, desired = DESIRED_HOOKS_PATH) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (sameHooksPath(value, desired)) return true;
  const configuredAbs = resolveHooksPathAbs(value, baseDir);
  const desiredAbs = resolveHooksPathAbs(desired, baseDir);
  if (normalizeForCompare(configuredAbs) === normalizeForCompare(desiredAbs)) return true;
  return hooksDirsEquivalent(configuredAbs, desiredAbs);
}

/** Every worktree git knows about, minus ones whose directory is gone (prunable). */
export function parseWorktreeList(porcelain) {
  const paths = [];
  for (const line of porcelain.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) paths.push(line.slice('worktree '.length).trim());
  }
  return paths;
}

/** `--show-origin --get-all` output → [{ origin, value }]. Tab-separated; a value may contain spaces. */
export function parseShowOrigin(stdout) {
  const out = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const tab = line.indexOf('\t');
    if (tab === -1) continue;
    out.push({ origin: line.slice(0, tab), value: line.slice(tab + 1) });
  }
  return out;
}

/**
 * Read the full picture without changing anything.
 * `effective` is what git will actually use (last value wins across scopes).
 */
export function inspectHooksPath(cwd = process.cwd()) {
  const top = git(['rev-parse', '--show-toplevel'], { cwd });
  if (top.status !== 0) {
    throw new Error(`not a git repository: ${cwd}${top.stderr ? ` (${top.stderr})` : ''}`);
  }

  const effectiveRes = git(['config', '--get', CONFIG_KEY], { cwd });
  const effective = effectiveRes.status === 0 ? effectiveRes.stdout : null;

  const scopes = parseShowOrigin(git(['config', '--show-origin', '--get-all', CONFIG_KEY], { cwd }).stdout);

  const wtcRes = git(['config', '--get', 'extensions.worktreeConfig'], { cwd });
  const worktreeConfigEnabled = wtcRes.status === 0 && /^true$/i.test(wtcRes.stdout);

  const worktrees = parseWorktreeList(git(['worktree', 'list', '--porcelain'], { cwd }).stdout);
  const present = worktrees.filter((p) => existsSync(p));
  const missing = worktrees.filter((p) => !existsSync(p));

  // A `--worktree` override beats `--local`, so this is the scope that actually decides.
  const overrides = [];
  if (worktreeConfigEnabled) {
    for (const wt of present) {
      const r = git(['config', '--worktree', '--get-all', CONFIG_KEY], { cwd: wt });
      if (r.status !== 0) continue; // 1 = key absent in this scope
      for (const value of r.stdout.split(/\r?\n/).filter(Boolean)) overrides.push({ worktree: wt, value });
    }
  }

  const localRes = git(['config', '--local', '--get-all', CONFIG_KEY], { cwd });
  const local = localRes.status === 0 ? localRes.stdout.split(/\r?\n/).filter(Boolean) : [];

  const localHealthy = local.length === 1 && hooksPathResolvesToDesired(local[0], top.stdout);
  const badOverrides = overrides.filter((o) => !hooksPathResolvesToDesired(o.value, o.worktree));

  return {
    toplevel: top.stdout,
    effective,
    scopes,
    worktreeConfigEnabled,
    worktrees: present,
    missingWorktrees: missing,
    overrides,
    badOverrides,
    local,
    localHealthy,
    healthy: localHealthy && badOverrides.length === 0,
  };
}

/**
 * Repair both scopes. Returns the actions taken (empty array when already healthy).
 * Idempotent: a healthy repo is not written to at all.
 */
export function repairHooksPath({ cwd = process.cwd(), apply = true, log = () => {} } = {}) {
  const state = inspectHooksPath(cwd);
  const actions = [];

  if (state.healthy) return { state, actions, healthy: true };

  // 1) Per-worktree overrides FIRST. `--local` cannot see them and they win over it, so
  //    clearing `.git/config` alone leaves every existing worktree still broken.
  for (const o of state.badOverrides) {
    actions.push({ kind: 'unset-worktree-override', worktree: o.worktree, was: o.value });
    if (!apply) continue;
    const r = git(['config', '--worktree', '--unset-all', CONFIG_KEY], { cwd: o.worktree });
    // 5 = the key was already gone (another pass, or a duplicate entry we just cleared).
    if (r.status !== 0 && r.status !== 5) {
      throw new Error(`failed to clear the per-worktree core.hooksPath override in ${o.worktree}: ${r.stderr}`);
    }
  }

  // 2) Then the local scope, which every worktree inherits.
  if (!state.localHealthy) {
    actions.push({ kind: 'set-local', was: state.local.length ? state.local.join(', ') : '(unset)', to: DESIRED_HOOKS_PATH });
    if (apply) {
      if (state.local.length > 1) {
        const r = git(['config', '--local', '--unset-all', CONFIG_KEY], { cwd });
        if (r.status !== 0 && r.status !== 5) {
          throw new Error(`failed to clear the duplicate local core.hooksPath entries: ${r.stderr}`);
        }
      }
      const r = git(['config', '--local', CONFIG_KEY, DESIRED_HOOKS_PATH], { cwd });
      if (r.status !== 0) throw new Error(`failed to set core.hooksPath: ${r.stderr}`);
    }
  }

  if (apply) {
    for (const a of actions) {
      if (a.kind === 'set-local') {
        log(`  repaired .git/config: core.hooksPath ${a.was} -> ${a.to}`);
      } else {
        log(`  repaired per-worktree override in ${a.worktree} (was ${a.was}), now inherits ${DESIRED_HOOKS_PATH}`);
      }
    }
  }

  return { state, actions, healthy: false };
}

function main(argv) {
  const check = argv.includes('--check');
  const verbose = argv.includes('--verbose') || check;
  const cwd = process.cwd();

  let state;
  try {
    state = inspectHooksPath(cwd);
  } catch (err) {
    console.error(`WARNING: could not inspect core.hooksPath, ${err.message}`);
    return check ? 1 : 0;
  }

  if (state.healthy) {
    if (verbose) console.log(`✓ core.hooksPath is ${DESIRED_HOOKS_PATH} in every scope (${state.worktrees.length} worktree(s) checked).`);
    return 0;
  }

  console.log(`core.hooksPath drift detected, the repo's chained hooks in ${DESIRED_HOOKS_PATH} are NOT running.`);
  for (const s of state.scopes) console.log(`  ${s.origin}\t${s.value}`);
  if (state.badOverrides.length) {
    console.log(`  ${state.badOverrides.length} per-worktree override(s) (these WIN over .git/config):`);
    for (const o of state.badOverrides) console.log(`    ${o.worktree}`);
  }
  if (state.missingWorktrees.length) {
    console.log(`  (skipped ${state.missingWorktrees.length} worktree(s) whose directory is gone, run 'git worktree prune')`);
  }

  if (check) {
    console.log('Run: node scripts/repair-hookspath.mjs');
    return 1;
  }

  // Never THROW out of here. a setup script runs under `set -euo pipefail` and calls this script,
  // so a non-zero exit aborts first-time setup partway through, before `beads.role`, the
  // DoltHub remote and the issue sync, leaving a half-configured machine that is harder to
  // diagnose than the drift this repairs. A failing `git config` write is not hypothetical
  // here: concurrent sessions on this box hit Windows lock contention on the shared config
  // (that same failure shows up in a test). So warn loudly, name the repair command, and
  // let setup finish. `--check` still exits 1, which is what a CI or scripted caller wants.
  try {
    repairHooksPath({ cwd, apply: true, log: (m) => console.log(m) });
  } catch (err) {
    console.error(`WARNING: could not repair core.hooksPath, ${err.message}`);
    console.error(`  The repo's chained hooks in ${DESIRED_HOOKS_PATH} are still NOT running.`);
    console.error('  Re-run `node scripts/repair-hookspath.mjs` once nothing else is writing');
    console.error('  this repo\'s git config (another session mid-push, or a worktree being created).');
    return 0;
  }
  console.log('✓ core.hooksPath repaired. Verify a chained hook fires, e.g. `git push --dry-run`.');
  return 0;
}

/** True when this file is the script node was started on. Both sides go through realpath, so a symlinked or 8.3-short-named path still matches. */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

// Only run as a CLI, never on import (the tests import the helpers above).
if (isEntryPoint()) {
  process.exitCode = main(process.argv.slice(2));
}
