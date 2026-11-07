// Shared fixtures for the agent-ritual conformance smoke, and for a consumer-owned overlay
// test that adds steps only that consumer can run (see "The ritual set" in the README).
//
// Hermeticity is the hard constraint: every helper builds a throwaway git repo with a bare
// "origin" and a throwaway JSON beads "database" served by fixtures/bd-stub.cjs on a temp
// PATH dir. Nothing here ever touches a shared tracker remote or the real .beads workspace.
//
// Consumer values come from the consumer's agent-tooling.json (beadPrefix,
// worktreeNamePattern, claimHelper, envPrefix), read through the one loader. A step that
// needs a script from another set locates it on disk and SKIPS, naming the missing file,
// when it is absent: this file imports only base files, because a set is closed over base
// and itself.
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync, cpSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { tryLoadConfig } from '../agent-tooling-config.mjs';
import { removeTempDir } from '../test-support/cleanup.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url)); // scripts/ritual
export const REPO = path.resolve(HERE, '..', '..'); // repo root
export const scriptsDir = path.join(REPO, 'scripts');
export const hooksDir = path.join(scriptsDir, 'hooks');
export const fixturesDir = path.join(HERE, 'fixtures');
export const SETTINGS_FILE = '.claude/settings.json';

export const IS_WINDOWS = process.platform === 'win32';

function probe(cmd, args) {
  try {
    return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}
export const HAVE_BASH = probe('bash', ['-c', 'exit 0']);
export const HAVE_GIT = probe('git', ['--version']);
export const SKIP_BASH = HAVE_BASH && HAVE_GIT ? false : 'requires bash + git on PATH';

// ── consumer config ─────────────────────────────────────────────────────────
// A broken agent-tooling.json reads as the defaults here; the loader's own suite owns
// reporting it.
export const consumer = tryLoadConfig({ root: REPO }).config;
export const BEAD_PREFIX = consumer.beadPrefix ?? 'bd';

/** A bead id in the consumer's own prefix, e.g. beadId('ritual1') is `<prefix>-ritual1`. */
export const beadId = (suffix) => `${BEAD_PREFIX}-${suffix}`;

/** The consumer's hatch / environment-knob name for a guard: `<envPrefix><suffix>`. */
export const hatch = (suffix) => `${consumer.envPrefix}${suffix}`;

/** A literal string made safe to embed in a RegExp. */
export const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The directory name the consumer's worktreeNamePattern gives a slug in a fixture whose primary checkout is `repo`. */
export const worktreeName = (slug, repo = 'work') =>
  consumer.worktreeNamePattern.split('<slug>').join(slug).split('<repo>').join(repo);

// ── optional scripts from other sets ────────────────────────────────────────
export const hasFile = (rel) => existsSync(path.join(REPO, ...rel.split('/')));

/**
 * A node:test `skip` value: false when every named repo-relative file exists, else a reason
 * that names each missing file. A step keyed on a file runs exactly when the consumer has it.
 */
export function skipUnlessPresent(...rels) {
  const missing = rels.filter((r) => !hasFile(r));
  return missing.length ? `${missing.join(', ')} not present in this repository (its set is not installed)` : false;
}

/** The first truthy skip reason, or false. */
export const firstReason = (...reasons) => reasons.find(Boolean) || false;

/** Import a repo-relative module when it exists, else null. Dynamic on purpose: never a closure edge. */
export async function loadOptional(rel) {
  return hasFile(rel) ? import(pathToFileURL(path.join(REPO, ...rel.split('/'))).href) : null;
}

/** Read a repo-relative JSON file, or null when absent. */
export function readJsonOptional(rel) {
  if (!hasFile(rel)) return null;
  return JSON.parse(readFileSync(path.join(REPO, ...rel.split('/')), 'utf8'));
}

// ── fixtures & helpers ──────────────────────────────────────────────────────
export const GIT_ENV = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
};

export function git(cwd, ...args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** A path resolved the way git and a hook's realpath see it (macOS /var, Windows 8.3 RUNNER~1 names). */
export const real = (p) => realpathSync.native(p);

export function mkRoot(tag) {
  return real(mkdtempSync(path.join(tmpdir(), `ritual-${tag}-`)));
}

/**
 * A bare origin plus a work clone on `main` with one pushed commit. `userName` sets the
 * clone's LOCAL git identity so agent-actor-id.mjs derives a deterministic actor base.
 * `withConfig` commits an agent-tooling.json carrying the consumer's naming (bead prefix,
 * worktree name pattern, claim helper) with the worktree root pinned inside the sandbox.
 */
export function repoFixture(tag, { userName, withConfig = false } = {}) {
  const root = mkRoot(tag);
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-q', '-b', 'main', origin);
  // Every fixture push lands here. receive.unpackLimit defaults to 100, so a tiny push always
  // takes the UNPACK path, which explodes the pack into loose objects; on Windows that means
  // unlinking and replacing a just-written object under a temp dir that Defender or the
  // indexer can hold open ("unable to unlink ... Invalid argument", seen once, 13/13 on an
  // immediate retry). A limit of 1 keeps every real push (commit + tree + blob) packed, which
  // removes the code path rather than papering over a flake with a retry.
  git(origin, 'config', 'receive.unpackLimit', '1');
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  if (userName) {
    git(work, 'config', 'user.name', userName);
    git(work, 'config', 'user.email', 'ritual@example.test');
  }
  writeFileSync(path.join(work, 'README'), 'base\n');
  if (withConfig) {
    const cfg = { worktreeRoot: '..', worktreeNamePattern: consumer.worktreeNamePattern, claimHelper: consumer.claimHelper };
    if (consumer.beadPrefix) cfg.beadPrefix = consumer.beadPrefix;
    writeFileSync(path.join(work, 'agent-tooling.json'), `${JSON.stringify(cfg, null, 2)}\n`);
  }
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return { root, origin, work };
}

/**
 * Copy the committed stubs to extensionless `bd` / `gh` on a temp PATH dir. On Windows a
 * `.cmd` sibling is written too: bd-dolt-sync.mjs spawns bd from NODE, which cannot run an
 * extensionless shebang file there, and honours BD_CLI (see withBin).
 */
export function makeBinDir(root) {
  const binDir = path.join(root, 'bin');
  mkdirSync(binDir, { recursive: true });
  for (const [src, name] of [
    ['bd-stub.cjs', 'bd'],
    ['gh-stub.cjs', 'gh'],
  ]) {
    const dst = path.join(binDir, name);
    cpSync(path.join(fixturesDir, src), dst);
    chmodSync(dst, 0o755);
    if (IS_WINDOWS) writeFileSync(`${dst}.cmd`, `@echo off\r\nnode "%~dp0${name}" %*\r\n`);
  }
  return binDir;
}

/** process.env with `binDir` first on PATH, BD_CLI aimed at its stub, and no inherited worktree root. */
export function withBin(binDir, extra = {}) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const env = {
    ...process.env,
    [key]: `${binDir}${path.delimiter}${process.env[key] ?? ''}`,
    BD_CLI: path.join(binDir, IS_WINDOWS ? 'bd.cmd' : 'bd'),
  };
  // A host worktree root would put the fixture worktrees in the REAL shared worktree directory,
  // where they outlive the sandbox.
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'AGENT_TOOLING_WORKTREE_ROOT') delete env[k];
  return { ...env, ...extra };
}

/** Convert a Windows path to the msys mount form bash can exec (C:\x becomes /c/x). */
export function toBashPath(p) {
  if (!IS_WINDOWS) return p;
  const fwd = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  return m ? `/${m[1].toLowerCase()}/${m[2]}` : fwd;
}

/** Drive a PreToolUse hook exactly as the harness does: JSON on stdin, read the exit code + stderr back. */
export function runHook(hookFile, command, { cwd, env, toolName } = {}) {
  return spawnSync(process.execPath, [path.join(hooksDir, hookFile)], {
    input: JSON.stringify(toolName ? { tool_name: toolName, tool_input: { command } } : { tool_input: { command } }),
    encoding: 'utf8',
    cwd,
    env: env ?? process.env,
  });
}

/** Everything spawnSync knows, so a command that failed to start says what failed. */
export function spawnDiag(r) {
  return `stderr=${JSON.stringify(r.stderr)} stdout=${JSON.stringify(r.stdout)} signal=${r.signal} error=${r.error?.message ?? 'none'}`;
}

export function cleanup(root) {
  removeTempDir(root, 'agent-ritual-smoke.node-test');
}
