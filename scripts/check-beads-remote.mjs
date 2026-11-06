/**
 * check-beads-remote.mjs - fail if the beads sync remote has drifted off DoltHub.
 *
 * The issue database syncs with DoltHub, NOT with the GitHub git remote. bd does not reliably
 * respect that: `bd init` auto-detects the git origin and writes it into `.beads/config.yaml`,
 * and `bd dolt remote add` rewrites the file on every invocation, sometimes COMMITTING a
 * `git+ssh://...` URL unasked. The failure is quiet and expensive in both directions:
 *
 * - `bd bootstrap` clones from `sync.remote`, so a git URL there makes a new contributor's very
 *   first setup fail, or worse, appear to work against nothing.
 * - The dolt CLI remote is what `bd dolt push`/`pull` actually use. If THAT is missing, every
 *   push and pull is silently a NO-OP: bd exits 0 and publishes nothing.
 *
 * So this checks both, and treats a missing dolt CLI remote as fatal only when the embedded
 * database is actually present (a fresh clone that has not been bootstrapped yet has neither, and
 * should be told to bootstrap, not failed). The embedded database is found the way bd-dolt-sync.mjs
 * finds it (resolveDoltDir): under this checkout, else under the primary checkout that owns the git
 * common dir. A linked worktree has no embedded database of its own, so without that fallback the
 * dolt half would be skipped there and the check would still say OK.
 *
 * What "right" means is the consumer's call, in this order:
 *   1. `--expected <url>` on the command line, else
 *   2. the AGENT_TOOLING_BEADS_REMOTE environment variable, else
 *   3. no pinned URL: `sync.remote` must be present, must not be a git URL (`git+...`, `*.git`,
 *      a github.com URL), and the dolt CLI remote `origin` must equal it.
 *
 * Usage: node scripts/check-beads-remote.mjs [--expected <url>]   (exit 0 = fine, 1 = drift)
 */
import { spawnSync } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveDoltDir } from './bd-dolt-sync.mjs';

/** The environment variable that pins the expected remote (the sync rewrites the prefix). */
export const EXPECTED_REMOTE_ENV = 'AGENT_TOOLING_BEADS_REMOTE';

/** Is this URL a git remote rather than a DoltHub one? */
export function isGitRemote(url) {
  return /^git\+/.test(url) || /\.git$/.test(url) || /(^|[/@.])github\.com[:/]/.test(url);
}

/**
 * Pull `sync.remote` out of .beads/config.yaml.
 *
 * Hand-rolled rather than pulling in a YAML dependency: this must run as a standalone script
 * before a package install has necessarily happened. bd writes the key in TWO shapes and both are
 * live: a flat `sync.remote: "..."` (what a human writes) and the nested `sync:` / `remote: "..."`
 * block bd normalizes it into on `bd dolt remote add`. Commented-out lines are skipped so the
 * explanatory comment in config.yaml, which quotes the old git URL as the thing NOT to have, can
 * never be mistaken for the setting itself.
 */
export function parseSyncRemote(yaml) {
  const lines = String(yaml ?? '').split(/\r?\n/);
  let inSyncBlock = false;
  for (const line of lines) {
    if (/^\s*#/.test(line) || !line.trim()) continue;

    const flat = line.match(/^\s*sync\.remote\s*:\s*(.+?)\s*$/);
    if (flat) return unquote(flat[1]);

    if (/^sync\s*:\s*$/.test(line)) {
      inSyncBlock = true;
      continue;
    }
    if (inSyncBlock) {
      const nested = line.match(/^\s+remote\s*:\s*(.+?)\s*$/);
      if (nested) return unquote(nested[1]);
      if (/^\S/.test(line)) inSyncBlock = false;
    }
  }
  return null;
}

function unquote(v) {
  const s = String(v).trim();
  const m = s.match(/^"(.*)"$/) || s.match(/^'(.*)'$/);
  return m ? m[1] : s;
}

/** Parse `dolt remote -v` output into a { name: url } map. */
export function parseDoltRemotes(text) {
  const out = {};
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = line.trim().match(/^(\S+)\s+(\S+)/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

export const DEFAULT_DEPS = {
  read: (p) => fs.readFileSync(p, 'utf8'),
  exists: (p) => fs.existsSync(p),
  run: (cmd, args, opts) => {
    // shell:true on win32 only: dolt is commonly a .cmd shim there. See bd-dolt-sync.mjs.
    let r;
    try {
      r = spawnSync(cmd, args, {
        encoding: 'utf8',
        ...(process.platform === 'win32' ? { shell: true } : {}),
        ...opts,
      });
    } catch {
      return { status: 1, stdout: '', stderr: '' };
    }
    return { status: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  },
  log: (...a) => console.log(...a),
  error: (...a) => console.error(...a),
};

/**
 * @param {string} repoRoot
 * @param {typeof DEFAULT_DEPS & { expected?: string|null, dbName?: string|null, readdir?: (p: string) => string[], gitCommonDir?: string|null }} [deps]
 *   `expected` pins the remote (see the header); `dbName`/`readdir` are seams for the embedded
 *   database directory lookup; `gitCommonDir` is the absolute git common dir (the primary
 *   checkout's `.git`), which locates the embedded database from a linked worktree.
 */
export function check(repoRoot, deps = DEFAULT_DEPS) {
  const configPath = path.join(repoRoot, '.beads', 'config.yaml');
  const problems = [];
  const expected = deps.expected ?? null;

  if (!deps.exists(configPath)) {
    deps.error('ERROR: .beads/config.yaml is missing.');
    return 1;
  }

  const configured = parseSyncRemote(deps.read(configPath));
  if (expected) {
    if (configured !== expected) {
      problems.push(
        `.beads/config.yaml sync.remote is ${configured ? `"${configured}"` : 'MISSING'}, expected "${expected}".`,
      );
    }
  } else if (!configured) {
    problems.push('.beads/config.yaml sync.remote is MISSING.');
  } else if (isGitRemote(configured)) {
    problems.push(`.beads/config.yaml sync.remote is "${configured}", which is a git remote, not a DoltHub one.`);
  }
  if (configured && isGitRemote(configured)) {
    problems.push(
      '  This is bd auto-detecting the GitHub git origin. Issues sync with DoltHub, not GitHub.',
    );
    problems.push('  Restore the DoltHub URL - do NOT commit the auto-detected one.');
  }

  // The dolt CLI remote is what push/pull actually use; without it they are silent no-ops. Only
  // meaningful once the embedded DB exists, so a pre-bootstrap clone is not failed for it.
  const gitCommonDir = deps.gitCommonDir ?? null;
  const doltDir = resolveDoltDir({
    cwd: repoRoot,
    exists: deps.exists,
    gitCommonDir,
    dbName: deps.dbName,
    readdir: deps.readdir,
  });
  const embeddedRoot = [repoRoot, ...(gitCommonDir ? [path.dirname(gitCommonDir)] : [])]
    .map((root) => path.join(root, '.beads', 'embeddeddolt'))
    .find((p) => deps.exists(p));
  if (!doltDir && embeddedRoot) {
    // Not fatal (a pre-bootstrap clone has no database), but never silent: the check that
    // catches a missing dolt CLI remote did not run.
    deps.error(`WARNING: ${embeddedRoot} exists but no database directory could be resolved, so the dolt CLI remote check was SKIPPED.`);
    deps.error('  Set "beadPrefix" in agent-tooling.json to the database directory name (or leave exactly one database there).');
  }
  if (doltDir) {
    const r = deps.run('dolt', ['remote', '-v'], { cwd: doltDir });
    if (r.status !== 0) {
      problems.push('Could not run `dolt remote -v` in the embedded DB - is the dolt CLI installed?');
    } else {
      const origin = parseDoltRemotes(r.stdout).origin;
      const want = expected ?? configured;
      if (!origin || (want && origin !== want)) {
        problems.push(
          `dolt CLI remote "origin" is ${origin ? `"${origin}"` : 'MISSING'}${want ? `, expected "${want}"` : ''}.`,
        );
        problems.push('  Every `bd dolt push`/`pull` is a silent NO-OP while this is wrong.');
      }
    }
  }

  if (problems.length) {
    deps.error('Beads remote check FAILED:');
    for (const p of problems) deps.error(`  ${p}`);
    deps.error('');
    deps.error('Fix with:');
    const url = expected ?? '<the DoltHub URL>';
    deps.error(`  bd dolt remote remove origin; bd dolt remote add origin "${url}"`);
    deps.error('  and restore the sync.remote line in .beads/config.yaml.');
    return 1;
  }

  deps.log(`Beads remote OK${expected ? `: ${expected}` : ''}`);
  return 0;
}

/** `--expected <url>` / `--expected=<url>`, else the environment variable, else null. */
export function expectedFromArgs(argv, env = process.env) {
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--expected' && argv[i + 1]) return argv[i + 1];
    if (argv[i].startsWith('--expected=')) return argv[i].slice('--expected='.length) || null;
  }
  return env[EXPECTED_REMOTE_ENV] || null;
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

/** The absolute git common dir of `repoRoot` (the primary checkout's `.git` from a linked worktree), or null. */
export function gitCommonDirOf(repoRoot, run = DEFAULT_DEPS.run) {
  const r = run('git', ['rev-parse', '--git-common-dir'], { cwd: repoRoot });
  return r.status === 0 && r.stdout.trim() ? path.resolve(repoRoot, r.stdout.trim()) : null;
}

if (isEntryPoint()) {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.exitCode = check(repoRoot, {
    ...DEFAULT_DEPS,
    gitCommonDir: gitCommonDirOf(repoRoot),
    expected: expectedFromArgs(process.argv.slice(2)),
  });
}
