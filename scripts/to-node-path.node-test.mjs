// Regression coverage: claim.sh derives SCRIPT_DIR via
// `cd ... && pwd`, which under Git Bash yields a POSIX-style path
// (/c/git/...). On a host where MSYS's automatic argument conversion is off
// (e.g. MSYS_NO_PATHCONV=1), that path reaches native `node` unmodified and
// resolves as C:\c\git\... instead of C:\git\..., so claim.sh fails before it
// can sync, claim, or create a worktree.
//
// scripts/lib/to-node-path.sh exports `to_node_path`, which converts a path
// for use as a `node` argument only (never for bash/git subcommands, which
// must keep the POSIX form).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const LIB_DIR = path.join(SCRIPTS_DIR, 'lib');
const LIB = path.join(LIB_DIR, 'to-node-path.sh');

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
const SKIP = !has('bash') || !has('node') ? 'requires bash and node on PATH' : false;

/** POSIX-style form of `dir`, as `cd "$dir" && pwd` produces under Git Bash. */
function posixForm(dir) {
  return spawnSync('bash', ['-c', 'cd "$1" && pwd', '_', dir], { encoding: 'utf8' }).stdout.trim();
}

test(
  'node run against the raw POSIX SCRIPT_DIR fails when automatic MSYS path conversion is disabled',
  { skip: SKIP || (process.platform !== 'win32' && 'MSYS path-conversion behaviour is Windows-only') },
  () => {
    const posixDir = posixForm(LIB_DIR);
    const r = spawnSync(
      'bash',
      ['-c', 'node "$1/to-node-path-probe.mjs"', '_', posixDir],
      { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
    );
    assert.notEqual(r.status, 0, `expected the raw POSIX path to fail node module resolution:\n${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /Cannot find module/);
  },
);

test('to_node_path produces a path node can resolve, even with automatic MSYS conversion disabled', { skip: SKIP }, () => {
  const posixDir = posixForm(LIB_DIR);
  const r = spawnSync(
    'bash',
    ['-c', `source "${LIB}"; np="$(to_node_path "$1")"; node "$np/to-node-path-probe.mjs"`, '_', posixDir],
    { encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } },
  );
  assert.equal(r.status, 0, `to_node_path did not produce a resolvable node path:\n${r.stdout}${r.stderr}`);
  assert.equal(r.stdout.trim(), 'OK');
});

test('to_node_path falls back to the input unchanged when cygpath is unavailable', { skip: SKIP }, () => {
  const r = spawnSync(
    'bash',
    ['-c', `source "${LIB}"; to_node_path "/some/posix/path"`],
    { encoding: 'utf8', env: { ...process.env, PATH: '/usr/bin:/bin' } },
  );
  const hasCygpath = spawnSync('cygpath', ['--version'], { encoding: 'utf8' }).status === 0;
  if (hasCygpath) return; // covered by the resolution test above on hosts that have it
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.equal(r.stdout.trim(), '/some/posix/path');
});
