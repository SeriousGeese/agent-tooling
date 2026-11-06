#!/usr/bin/env node
// Tests for `scripts/worktree-rm.sh`: the upstream classification (`--check-upstream`), the removal
// guards, the `--stale` report and the live-session refusal.
//
// Builds a throwaway repo with a bare "origin", then exercises the three
// classifications against real git history, including a SQUASH merge, the
// merge method an auto-merging bot uses and the case an ancestry-only check
// misses. The gh lookup is disabled (WORKTREE_RM_SKIP_GH=1) so these run offline
// and deterministically; the gh path is best-effort by design and only matters
// for multi-commit squashes.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, chmodSync, rmSync } from 'node:fs';
import { removeTempDir } from './test-support/cleanup.mjs';
import { copyTemplate, disposeTemplates } from './test-support/git-fixture-template.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCK_DIR_NAME } from './session-lock.mjs';
import { execFileSync, spawnSync } from 'node:child_process';

// Resolved from this file, not the cwd, so the suite runs from anywhere.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(HERE, 'worktree-rm.sh');

function fixtureEnv(source = process.env) {
  const env = { ...source };
  // Ambient GIT_CONFIG_COUNT/KEY_n/VALUE_n entries can override repo-local settings and make fixture
  // controls (especially the fsmonitor-on baseline) silently vacuous. Individual
  // tests that exercise caller-provided entries pass them explicitly to the script.
  for (const key of Object.keys(env)) {
    if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)) delete env[key];
  }
  return env;
}

const ENV = {
  ...fixtureEnv(),
  WORKTREE_RM_SKIP_GH: '1',
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@t',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

test('fixture Git environment drops inherited fsmonitor=false overrides', () => {
  const env = fixtureEnv({
    ...process.env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.fsmonitor',
    GIT_CONFIG_VALUE_0: 'false',
  });
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(Object.keys(env).some((key) => /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(key)), false);
});

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function check(wt, scriptPath = script) {
  return execFileSync('bash', [scriptPath, '--check-upstream', wt], { encoding: 'utf8', env: ENV }).trim();
}

// origin (bare) + work clone on main with one commit pushed.
// Every fixture root is recorded and removed once the file's tests finish, so a test that
// fails (or forgets its own finally) cannot leak a bare origin plus clone into tmpdir().
// Per-test removeTempDir calls stay; removal of a gone dir is a no-op.
const fixtureRoots = new Set();
after(() => {
  for (const r of fixtureRoots) removeTempDir(r, 'worktree-rm.node-test');
  fixtureRoots.clear();
  disposeTemplates((dir) => removeTempDir(dir, 'worktree-rm.node-test'));
});
// Built once per file and copied per test: seven git processes per test became a file
// copy. git-fixture-template.mjs rewrites the absolute paths git records, so each copy is the same
// repo a fresh build would be.
function buildBase(root) {
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  git(root, 'init', '--bare', '-q', '-b', 'main', origin);
  git(root, 'clone', '-q', origin, work);
  git(work, 'checkout', '-q', '-b', 'main');
  writeFileSync(path.join(work, 'a.txt'), 'base\n');
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', '-u', 'origin', 'main');
}
function paths(root) {
  return { root, origin: path.join(root, 'origin.git'), work: path.join(root, 'work') };
}
function fixture() {
  const root = copyTemplate('wtrm-base', buildBase, 'wtrm-');
  fixtureRoots.add(root);
  return paths(root);
}
function commitOn(work, branch, file, content, msg) {
  git(work, 'checkout', '-q', branch);
  writeFileSync(path.join(work, file), content);
  git(work, 'add', '.');
  git(work, 'commit', '-q', '-m', msg);
}

test('a SQUASH-merged single-commit branch is classified upstream even after its remote ref is deleted', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/x');
    commitOn(f.work, 'feat/x', 'x.txt', 'x\n', 'feat: x');
    git(f.work, 'push', '-q', '-u', 'origin', 'feat/x');
    // Squash-merge on main, push, delete the remote branch, exactly what the bot does.
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '--squash', '-q', 'feat/x');
    git(f.work, 'commit', '-q', '-m', 'feat: x (#1)');
    git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'push', '-q', 'origin', '--delete', 'feat/x');
    git(f.work, 'fetch', '-q', '--prune');
    git(f.work, 'checkout', '-q', 'feat/x');
    // Sanity: the case an ancestry-only check misses, not an ancestor, and no origin/feat/x.
    assert.throws(() => git(f.work, 'merge-base', '--is-ancestor', 'feat/x', 'origin/main'));
    assert.throws(() => git(f.work, 'rev-parse', '--verify', 'origin/feat/x'));
    assert.equal(check(f.work), 'upstream');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('a merge-commit merge is still classified upstream (ancestry path)', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/y');
    commitOn(f.work, 'feat/y', 'y.txt', 'y\n', 'feat: y');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '--no-ff', '-q', '-m', 'merge y', 'feat/y');
    git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'checkout', '-q', 'feat/y');
    assert.equal(check(f.work), 'upstream');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('MUTATION GUARD: a local-only commit is still classified never-pushed', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/z');
    commitOn(f.work, 'feat/z', 'z.txt', 'z\n', 'feat: z: never pushed');
    assert.equal(check(f.work), 'never-pushed');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('a pushed branch with a newer local commit is classified unpushed', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/w');
    commitOn(f.work, 'feat/w', 'w1.txt', '1\n', 'feat: w1');
    git(f.work, 'push', '-q', '-u', 'origin', 'feat/w');
    commitOn(f.work, 'feat/w', 'w2.txt', '2\n', 'feat: w2: local only');
    assert.equal(check(f.work), 'unpushed');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── Removal guards ──────────────────────────────────────────────
// A fixture primary with two linked worktrees, so a removal can be run FROM one
// and the other can be checked afterwards.
function fixtureWithWorktrees() {
  const root = copyTemplate('wtrm-worktrees', (r) => {
    buildBase(r);
    const { work } = paths(r);
    git(work, 'worktree', 'add', '-q', path.join(r, 'wt-a'), '-b', 'feat/a');
    git(work, 'worktree', 'add', '-q', path.join(r, 'wt-b'), '-b', 'feat/b');
  }, 'wtrm-');
  fixtureRoots.add(root);
  return { ...paths(root), wtA: path.join(root, 'wt-a'), wtB: path.join(root, 'wt-b') };
}
function runRm(cwd, target, env = ENV) {
  try {
    const out = execFileSync('bash', [script, target], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

// on Windows, `git worktree remove` can leave a deep node_modules behind and MSYS
// `rm -rf` cannot delete it either. Under `set -e` the failing rm ended the script there, with
// the worktree already deregistered and its directory still on disk. Stubbed here: `git worktree
// remove` fails, `rm` refuses the target (and only the target), and `powershell.exe` deletes it
// and leaves a marker, so the test proves the fallback ran rather than that rm happened to work.
function longPathStubs(root, victimName) {
  const dir = path.join(root, 'longpath-stubs');
  mkdirSync(dir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const marker = path.join(root, 'powershell-ran');
  const stub = (name, lines) => {
    const bin = path.join(dir, name);
    writeFileSync(bin, ['#!/usr/bin/env bash', ...lines].join('\n') + '\n');
    chmodSync(bin, 0o755);
  };
  stub('git', [
    'for a in "$@"; do [ "$a" = "remove" ] && exit 1; done',
    `exec ${realGit} "$@"`,
  ]);
  stub('rm', [
    `for a in "$@"; do case "$a" in */${victimName}|*${victimName}) echo "rm: cannot remove '$a': File too large" >&2; exit 1 ;; esac; done`,
    'exec /bin/rm "$@"',
  ]);
  // The real cygpath where there is one (Git Bash: node needs the Windows form), else the path as given.
  const realCygpath = execFileSync('sh', ['-c', 'command -v cygpath || true'], { encoding: 'utf8' }).trim();
  stub('cygpath', [realCygpath ? `exec ${realCygpath} "$@"` : 'printf "%s\\n" "${@: -1}"']);
  stub('powershell.exe', [
    'node -e \'const fs = require("node:fs"); fs.rmSync(process.env.WORKTREE_RM_WIN_TARGET, { recursive: true, force: true }); fs.writeFileSync(process.env.LONGPATH_STUB_MARKER, "ran")\'',
  ]);
  return { env: { ...ENV, PATH: dir + path.delimiter + process.env.PATH, LONGPATH_STUB_MARKER: marker }, marker };
}

test('a target neither git nor rm can delete is removed through PowerShell, and the run finishes', () => {
  const f = fixtureWithWorktrees();
  try {
    const { env, marker } = longPathStubs(f.root, 'wt-a');
    const r = runRm(f.work, f.wtA, env);
    assert.equal(r.status, 0, `${r.out}\n${r.err}`);
    assert.ok(existsSync(marker), `the PowerShell fallback never ran:\n${r.out}`);
    assert.ok(!existsSync(f.wtA), 'the target is gone');
    assert.ok(existsSync(f.wtB), 'the sibling survives');
    assert.doesNotMatch(git(f.work, 'worktree', 'list', '--porcelain'), /wt-a\b/, 'and its registration is pruned');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('refuses to remove the worktree it is running FROM', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRm(f.wtA, f.wtA);
    assert.equal(r.status, 1);
    assert.match(r.err, /running from INSIDE it/);
    assert.ok(existsSync(f.wtA), 'the target must be untouched after a refusal');
    assert.ok(existsSync(f.wtB), 'the sibling must be untouched after a refusal');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('refuses when cwd is a SUBDIRECTORY of the target', () => {
  const f = fixtureWithWorktrees();
  try {
    const sub = path.join(f.wtA, 'deep');
    mkdirSync(sub);
    const r = runRm(sub, f.wtA);
    assert.equal(r.status, 1);
    assert.match(r.err, /running from INSIDE it/);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('removing one worktree from the primary leaves every sibling on disk and registered', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRm(f.work, f.wtA);
    assert.equal(r.status, 0, r.err);
    assert.ok(!existsSync(f.wtA), 'the target is gone');
    assert.ok(existsSync(f.wtB), 'the SIBLING survives: the sibling-deletion invariant');
    const listed = git(f.work, 'worktree', 'list', '--porcelain');
    assert.match(listed, /wt-b/);
    assert.doesNotMatch(listed, /wt-a\b/);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('removal from INSIDE a sibling worktree is allowed and leaves that sibling intact', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRm(f.wtB, f.wtA); // standing in B, removing A
    assert.equal(r.status, 0, r.err);
    assert.ok(!existsSync(f.wtA));
    assert.ok(existsSync(f.wtB), 'the cwd worktree must not be touched');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── a stale registration is not a sibling deletion ────────────────
// The post-removal invariant used to diff "registered at entry" against "present on
// disk at exit", which reports a registration that was ALREADY dangling as damage this
// run caused, with an incident bead named and a demand that the operator report their
// invocation. The trigger is routine: a PR merges, the head ref is deleted, `--stale`
// nominates that worktree, its directory goes, and the leftover registration lingers
// until the next prune, which is any later removal by any session on any drive.
//
// The fix is that on-disk existence is captured at ENTRY, so the two cases are told
// apart by a fact the registration list cannot carry: a path already absent when the
// script started was not absented by the script.
//
// Both halves are pinned below. The quiet half alone would pass a "detection deleted"
// mutation, so the loud half stubs a genuinely destructive `git worktree remove` and
// asserts the error still fires.

// A registration whose directory no longer exists, the way a previous removal leaves
// one behind. `rmSync` rather than `worktree remove` on purpose: the point is a
// dangling REGISTRATION, so git must not be told the worktree is gone.
function danglingRegistration(f, name = 'wt-gone') {
  const wt = path.join(f.root, name);
  git(f.work, 'worktree', 'add', '-q', wt, '-b', `feat/${name}`);
  rmSync(wt, { recursive: true, force: true });
  return wt;
}

test('a stale registration whose directory was ALREADY gone is pruned quietly, not reported as damage', () => {
  const f = fixtureWithWorktrees();
  try {
    const gone = danglingRegistration(f);

    // Preconditions, or the test proves nothing: the registration must still be
    // listed while its directory is already absent. That pair IS the false trigger.
    assert.ok(!existsSync(gone), 'fixture did not actually remove the directory');
    assert.match(git(f.work, 'worktree', 'list', '--porcelain'), /wt-gone/,
      'fixture did not leave a dangling registration: the false trigger is absent');

    const r = runRm(f.work, f.wtA);
    assert.equal(r.status, 0, `a routine removal exited non-zero:\n${r.out}\n${r.err}`);
    assert.ok(!existsSync(f.wtA), 'the target is gone');
    assert.ok(existsSync(f.wtB), 'the live sibling survives');

    const all = `${r.out}\n${r.err}`;
    assert.doesNotMatch(all, /ERROR/, `a correct run printed an ERROR:\n${all}`);
    assert.doesNotMatch(all, /sibling-deletion failure/, `a correct run blamed the sibling-deletion incident:\n${all}`);
    assert.doesNotMatch(all, /report the exact invocation/i,
      `a correct run asked the operator to file a report:\n${all}`);

    // ...and it says what it did, rather than staying silent about a pruned entry.
    assert.match(r.out, /also pruned 1 stale registration\(s\) whose directories were already gone/,
      `no informational line for the pruned registration:\n${r.out}`);
    assert.match(r.out, /wt-gone/, 'the informational line must name the pruned path');

    // The prune really happened, otherwise the message is a claim, not a report.
    assert.doesNotMatch(git(f.work, 'worktree', 'list', '--porcelain'), /wt-gone/,
      'the stale registration survived the removal');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The other half. Deleting the detection outright, or widening it to swallow every
// absent path, makes THIS test fail, which is what keeps the quiet path above from
// being achieved by simply not looking.
//
// A real cross-path removal cannot be produced with the real git, so `worktree remove`
// is stubbed to also delete a sibling. PATH is built with Node's `path.delimiter` and
// `process.env.PATH`, never a shell-level `export`.
function destructiveGitStub(root, victim) {
  const dir = path.join(root, 'gitstub-destructive');
  mkdirSync(dir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'git');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      '# Reproduces sibling-deletion: a `worktree remove` that reaches a path other than its',
      '# argument. Only that subcommand is intercepted; everything else is the real git,',
      '# and the removal itself is still performed so the script follows its normal path.',
      '# `--stub-probe` lets the test prove THIS file is the git on PATH by behaviour',
      '# (the real git rejects the flag), not by comparing path strings across forms.',
      'if [ "$1" = "--stub-probe" ]; then echo DESTRUCTIVE_GIT_STUB; exit 0; fi',
      'for a in "$@"; do',
      '  if [ "$a" = "remove" ]; then',
      `    rm -rf -- "${victim}"`,
      '    break',
      '  fi',
      'done',
      `exec ${realGit} "$@"`,
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return { ...ENV, PATH: dir + path.delimiter + process.env.PATH };
}

test('a genuine cross-path removal: a sibling PRESENT at entry and gone at exit: is still loud', () => {
  const f = fixtureWithWorktrees();
  try {
    const env = destructiveGitStub(f.root, f.wtB);

    // Preconditions: the victim is on disk at entry (that is the whole difference from
    // the case above), and the stub is genuinely the git the script will run.
    //
    // Proven by BEHAVIOUR, not by comparing the resolved path to the one Node built.
    // That comparison was red on every Windows checkout: Git Bash's `command -v` answers in POSIX form and maps %TEMP% to
    // `/tmp`, so `/tmp/wtrm-x/gitstub-destructive/git` never equals
    // `C:\Users\…\Temp\wtrm-x\gitstub-destructive\git` even though it IS the stub.
    // A PATH stub can be "broken" several ways that present identically, a cross-form
    // string comparison among them. Asking the
    // git on PATH for the stub's marker cannot be fooled by path form, and still fails
    // RED when the stub is absent, the real git rejects the flag with a nonzero exit.
    assert.ok(existsSync(f.wtB), 'the victim must exist at entry or this is the other case');
    const probe = spawnSync('bash', ['-c', 'git --stub-probe'], { env, encoding: 'utf8' });
    assert.equal(probe.status, 0, `the stub is not on PATH: the test would prove nothing:\n${probe.stderr}`);
    assert.equal(probe.stdout.trim(), 'DESTRUCTIVE_GIT_STUB',
      'the git on PATH is not the destructive stub: the test would prove nothing');

    let r;
    try {
      const out = execFileSync('bash', [script, f.wtA], { cwd: f.work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      r = { status: 0, out, err: '' };
    } catch (e) {
      r = { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
    }

    assert.ok(!existsSync(f.wtB), 'the stub did not actually destroy the sibling');
    assert.equal(r.status, 2, `a cross-path removal did not fail loudly:\n${r.out}\n${r.err}`);
    assert.match(r.err, /a worktree OTHER than the argument is now missing from disk/);
    assert.match(r.err, /wt-b/, 'the error must name the path it lost');
    assert.match(r.err, /sibling-deletion failure/, 'the error must still name the failure it is');
    assert.match(r.err, /report the exact invocation/i, 'a real cross-path removal IS report-worthy');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// Both shapes at once: the run must fail on the sibling it destroyed and must NOT
// fold the pre-existing dangling registration into the same accusation.
test('a cross-path removal reports ONLY the path it actually lost, not the already-dangling one', () => {
  const f = fixtureWithWorktrees();
  try {
    const gone = danglingRegistration(f);
    assert.ok(!existsSync(gone));
    const env = destructiveGitStub(f.root, f.wtB);

    let r;
    try {
      const out = execFileSync('bash', [script, f.wtA], { cwd: f.work, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
      r = { status: 0, out, err: '' };
    } catch (e) {
      r = { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
    }

    assert.equal(r.status, 2, `the real failure was swallowed:\n${r.out}\n${r.err}`);
    assert.match(r.err, /wt-b/, 'the destroyed sibling must be named');
    assert.doesNotMatch(r.err, /wt-gone/,
      `the already-dangling registration was reported as damage:\n${r.err}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── a CONCURRENT removal is not a sibling deletion ────────────────
// Two `worktree-rm.sh` runs at once is the normal mode here: post-merge cleanup is what
// several sessions do at the same moment without coordinating, and each removal is
// ~0.7 GB of node_modules, so the overlap is wide. A peer removing ITS OWN argument
// leaves a sibling present at entry and absent at exit, the exact evidence the
// sibling-deletion invariant accuses on, so a correct run printed the loudest message this
// script has, ending "Please report the exact invocation".
//
// Two facts separate the cases, and neither is plausibility:
//   * WHEN it vanished, before this run's first destructive command, or across it.
//   * whether its REGISTRATION was still standing when the delete finished. Nothing
//     this run does deregisters a sibling (`worktree remove` clears its argument only,
//     `rm -rf` clears nothing), so an already-cleared registration means another
//     process removed it deliberately.
//
// A peer is simulated by stubbing `git worktree remove` to ALSO run a real
// `worktree remove --force` on the victim, deregistering it, which is what a peer's
// removal (or its prune) does and what this run cannot do to a sibling. Contrast
// `destructiveGitStub` above, which only `rm -rf`s the victim and must stay loud.
function concurrentPeerGitStub(root, victim) {
  const dir = path.join(root, 'gitstub-peer');
  mkdirSync(dir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'git');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      '# A peer worktree-rm.sh removing its OWN argument mid-run: the directory goes AND',
      '# the registration goes with it. Fired from `worktree remove` purely to land inside',
      '# this run; everything else is the real git.',
      'if [ "$1" = "--stub-probe" ]; then echo PEER_GIT_STUB; exit 0; fi',
      'for a in "$@"; do',
      '  if [ "$a" = "remove" ]; then',
      `    ${realGit} worktree remove --force "${victim}" >/dev/null 2>&1 || rm -rf -- "${victim}"`,
      '    break',
      '  fi',
      'done',
      `exec ${realGit} "$@"`,
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return { ...ENV, PATH: dir + path.delimiter + process.env.PATH };
}

// A peer whose removal lands EARLIER, while this run is still classifying the branch,
// before it has deleted anything. Injected through the `gh` lookup in `upstream_state`,
// which is the one outbound call in that window; the point is only that the sibling goes
// before the first destructive command, so this run demonstrably did not do it.
function ghStubThatRemoves(root, victim) {
  const dir = path.join(root, 'ghstub-removes');
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'gh');
  writeFileSync(
    bin,
    ['#!/usr/bin/env bash', `rm -rf -- "${victim}"`, 'echo 0', 'exit 0'].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return { ...ENV, WORKTREE_RM_SKIP_GH: '0', PATH: dir + path.delimiter + process.env.PATH };
}

function runRmEnv(cwd, target, env) {
  try {
    const out = execFileSync('bash', [script, target], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

test('a sibling removed by a CONCURRENT process is not reported as a sibling deletion', () => {
  const f = fixtureWithWorktrees();
  try {
    const env = concurrentPeerGitStub(f.root, f.wtB);

    // Preconditions. The victim is on disk at entry, that is what made this
    // indistinguishable from sibling-deletion, and the stub really is the git on PATH,
    // proven by behaviour rather than by comparing path strings across MSYS forms.
    assert.ok(existsSync(f.wtB), 'the victim must exist at entry or this proves nothing');
    const probe = spawnSync('bash', ['-c', 'git --stub-probe'], { env, encoding: 'utf8' });
    assert.equal(probe.stdout.trim(), 'PEER_GIT_STUB', 'the git on PATH is not the peer stub');

    const r = runRmEnv(f.work, f.wtA, env);

    assert.ok(!existsSync(f.wtB), 'the peer did not actually remove the sibling: no false trigger');
    assert.equal(r.status, 0, `a concurrent peer removal failed the run:\n${r.out}\n${r.err}`);
    assert.doesNotMatch(`${r.out}\n${r.err}`, /sibling-deletion failure/, 'a concurrent removal was blamed on this run');
    assert.doesNotMatch(r.err, /ERROR/, `a correct run printed an ERROR:\n${r.err}`);

    // Quiet is not the same as silent: it must still say the sibling went, and name
    // concurrent cleanup as the cause rather than demanding an incident report.
    assert.match(r.out, /this run did not remove them/, `no note for the concurrently-removed path:\n${r.out}`);
    assert.match(r.out, /wt-b/, 'the note must name the path');
    assert.match(r.out, /Concurrent cleanup is routine/, 'the note must name the likely cause');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('a sibling that vanished BEFORE this run deleted anything is not attributed to it', () => {
  const f = fixtureWithWorktrees();
  try {
    // wtA needs a commit of its own, or `upstream_state` short-circuits before the gh
    // lookup and the peer never fires. Assert the injection point instead of assuming it.
    writeFileSync(path.join(f.wtA, 'own.txt'), 'own work\n');
    git(f.wtA, 'add', '.');
    git(f.wtA, 'commit', '-q', '-m', 'own commit');
    assert.equal(git(f.work, 'rev-list', '--count', 'origin/main..feat/a'), '1');

    const env = ghStubThatRemoves(f.root, f.wtB);
    const r = runRmEnv(f.work, f.wtA, env);

    assert.ok(!existsSync(f.wtB), 'the peer stub never fired: the window is not covered');
    assert.equal(r.status, 0, `a pre-delete concurrent removal failed the run:\n${r.out}\n${r.err}`);
    assert.doesNotMatch(`${r.out}\n${r.err}`, /sibling-deletion failure/, 'a pre-delete removal was blamed on this run');
    assert.match(r.out, /this run did not remove them/, `no note for the path that vanished first:\n${r.out}`);
    assert.match(r.out, /wt-b/);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── ────────────────────────────────────────────────────────────────
// "pushed and in sync with origin/<branch>" is NOT "landed on origin/main". The
// fallback used to print `upstream` for exactly this shape, so every ordinary
// published feature branch with an open PR read as merged; on 2026-09-02 that
// nominated four live branches for deletion. This test
// previously asserted the buggy answer, which is why the defect survived a rewrite of
// the surrounding logic, it is inverted here deliberately.
test('a pushed, in-sync branch with its own unmerged commits is pushed-not-merged, NOT upstream', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/v');
    commitOn(f.work, 'feat/v', 'v.txt', 'v\n', 'feat: v');
    git(f.work, 'push', '-q', '-u', 'origin', 'feat/v');

    // Preconditions: genuinely published, genuinely in sync, genuinely not landed.
    assert.equal(git(f.work, 'rev-parse', 'feat/v'), git(f.work, 'rev-parse', 'origin/feat/v'));
    assert.throws(() => git(f.work, 'merge-base', '--is-ancestor', 'feat/v', 'origin/main'));
    assert.match(git(f.work, 'cherry', 'origin/main', 'feat/v'), /^\+ /);

    assert.equal(check(f.work), 'pushed-not-merged');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── The `grep -c` SIGPIPE guard ──────────────────────────────────
// `upstream_state` COUNTS `git cherry`'s '+' lines with `grep -c` instead of testing
// them with `grep -q`, and the comment above that line says why: `grep -q` leaves on
// the first match, git dies of SIGPIPE, `set -o pipefail` reports 141, and the `!` in
// front of the pipeline flips that failure into `upstream`, the one classification
// that tells a caller the directory is safe to delete.
//
// Nothing tested that. Rewriting the count back into the `! … | grep -q '^+'` form kept
// every other case in this file green (23/23, verified 2026-09-03), so the guard was
// one "simplification" away from silently restoring the original blast radius.
//
// The race is invisible on a small fixture, git finishes writing before grep leaves,
// which is exactly why it fires on a machine with many worktrees and not on a laptop -
// so `git cherry` is STUBBED to emit far more than a pipe buffer. That makes the broken
// pipe deterministic instead of load-dependent. Everything else forwards to the real
// git by absolute path, so nothing but the size of that one stream changes.
//
// PATH is built with Node's `path.delimiter` and never a shell-level `export`, for the
// MSYS reason spelled out on `ghStub` below.
function gitStub(root) {
  const dir = path.join(root, 'gitstub');
  mkdirSync(dir, { recursive: true });
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const bin = path.join(dir, 'git');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      '# Intercept `cherry` only; every other subcommand is the real git.',
      'for a in "$@"; do',
      '  if [ "$a" = "cherry" ]; then',
      '    # `exec` matters: the STUB ITSELF must die of SIGPIPE, the way git does.',
      '    # A forked child would die while this shell went on to exit 0, and the',
      '    # failure the test exists to reproduce would never reach the caller.',
      "    exec awk 'BEGIN { for (i = 0; i < 200000; i++) print \"+ 0000000000000000000000000000000000000000\" }'",
      '  fi',
      'done',
      `exec ${realGit} "$@"`,
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return { ...ENV, PATH: dir + path.delimiter + process.env.PATH };
}

test('a reader that leaves the `git cherry` pipe early does NOT yield upstream: the grep -c SIGPIPE guard', () => {
  const f = fixture();
  try {
    git(f.work, 'checkout', '-q', '-b', 'feat/sigpipe');
    commitOn(f.work, 'feat/sigpipe', 's.txt', 's\n', 'feat: s');
    git(f.work, 'push', '-q', '-u', 'origin', 'feat/sigpipe');
    const env = gitStub(f.root);

    // The stub must actually BE the git the script runs, and must actually emit more
    // than a pipe buffer. Without both, this test passes having proven nothing, the
    // failure mode of every PATH-stub test.
    const emitted = execFileSync('bash', ['-c', 'git cherry origin/main feat/sigpipe | wc -l'], {
      cwd: f.work, env, encoding: 'utf8',
    });
    assert.equal(Number(emitted.trim()), 200000);

    // The branch is pushed and in sync, and its commit is not on main. The only way to
    // read `upstream` here is by mistaking a broken pipe for "nothing is ahead".
    const state = execFileSync('bash', [script, '--check-upstream', f.work], { encoding: 'utf8', env }).trim();
    assert.equal(state, 'pushed-not-merged');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── ────────────────────────────────────────────────────────────────
// Two defects that composed into unrecoverable data loss on 2026-09-01: `--stale`
// nominated five in-flight worker worktrees as MERGED, and removal printed its
// uncommitted-changes warning and then deleted anyway.

function runRmArgs(cwd, ...args) {
  try {
    const out = execFileSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}
function runStale(cwd) {
  return runRmArgs(cwd, '--stale');
}

test('--stale does NOT nominate a branch with no commits of its own, even once main has moved past it', () => {
  const f = fixture();
  // A worktree provisioned from origin/main as it stood at that moment.
  const fresh = path.join(f.root, 'wt-fresh');
  git(f.work, 'worktree', 'add', '-q', fresh, '-b', 'feat/fresh');
  // main then advances, the condition that defeated the old tip===origin/main guard.
  // `--stale` fetches main before deciding, so on a repo merging all day this is the
  // normal state, not an edge case.
  commitOn(f.work, 'main', 'b.txt', 'more\n', 'second');
  git(f.work, 'push', '-q', 'origin', 'main');

  // Precondition: the OLD ancestry-only test would say "merged" here. If this ever
  // stops holding the test below is vacuous, so assert it rather than assume it.
  const isAncestor = (() => {
    try { git(f.work, 'merge-base', '--is-ancestor', 'feat/fresh', 'origin/main'); return true; }
    catch { return false; }
  })();
  assert.equal(isAncestor, true, 'fixture no longer reproduces the ancestry false-positive');

  const r = runStale(f.work);
  assert.equal(r.status, 0);
  assert.ok(!r.out.includes('feat/fresh'), `--stale nominated an unstarted branch:\n${r.out}`);
});

test('--stale DOES nominate a squash-merged branch: the case ancestry alone always missed', () => {
  const f = fixture();
  const done = path.join(f.root, 'wt-done');
  git(f.work, 'worktree', 'add', '-q', done, '-b', 'feat/done');
  writeFileSync(path.join(done, 'landed.txt'), 'landed\n');
  git(done, 'add', '.');
  git(done, 'commit', '-q', '-m', 'the work');
  // Squash-merge the way an auto-merging bot does: same content, different SHA, so the
  // branch is NOT an ancestor of main afterwards.
  git(f.work, 'checkout', '-q', 'main');
  git(f.work, 'merge', '-q', '--squash', 'feat/done');
  git(f.work, 'commit', '-q', '-m', 'squashed the work');
  git(f.work, 'push', '-q', 'origin', 'main');

  const isAncestor = (() => {
    try { git(f.work, 'merge-base', '--is-ancestor', 'feat/done', 'origin/main'); return true; }
    catch { return false; }
  })();
  assert.equal(isAncestor, false, 'fixture did not actually squash: test would prove nothing');

  const r = runStale(f.work);
  assert.equal(r.status, 0);
  assert.ok(r.out.includes('feat/done'), `--stale missed a squash-merged branch:\n${r.out}`);
});

test('removal REFUSES a worktree with uncommitted changes, and leaves every file on disk', () => {
  const f = fixtureWithWorktrees();
  const wip = path.join(f.wtA, 'wip.txt');
  writeFileSync(wip, 'precious uncommitted work\n');

  const r = runRm(f.work, f.wtA);
  assert.notEqual(r.status, 0, 'removal should have failed');
  assert.match(r.err, /refusing to remove/i);
  assert.match(r.err, /not recoverable/i);
  assert.match(r.err, /--force/, 'the refusal must name the escape hatch');
  assert.match(r.out, /wip\.txt/, 'the refusal must name the dirty files');
  assert.ok(existsSync(wip), 'the uncommitted file was destroyed by a refused removal');
  assert.ok(existsSync(f.wtA), 'the worktree directory was removed despite the refusal');
});

test('removal refuses on a TRACKED modification too, not just an untracked file', () => {
  const f = fixtureWithWorktrees();
  writeFileSync(path.join(f.wtA, 'a.txt'), 'locally modified\n');

  const r = runRm(f.work, f.wtA);
  assert.notEqual(r.status, 0);
  assert.match(r.err, /refusing to remove/i);
  assert.ok(existsSync(f.wtA));
});

test('--force removes a dirty worktree, and works before or after the path', () => {
  for (const order of [['--force', 'TARGET'], ['TARGET', '--force']]) {
    const f = fixtureWithWorktrees();
    writeFileSync(path.join(f.wtA, 'wip.txt'), 'discard me\n');
    const args = order.map((a) => (a === 'TARGET' ? f.wtA : a));

    const r = runRmArgs(f.work, ...args);
    assert.equal(r.status, 0, `--force removal failed for ${order.join(' ')}:\n${r.err}`);
    assert.ok(!existsSync(f.wtA), `--force did not remove the worktree for ${order.join(' ')}`);
    assert.ok(existsSync(f.wtB), 'a sibling worktree was collateral damage');
  }
});

test('a CLEAN worktree still removes without --force: the common path stays one command', () => {
  const f = fixtureWithWorktrees();
  const r = runRm(f.work, f.wtA);
  assert.equal(r.status, 0, `clean removal regressed:\n${r.err}`);
  assert.ok(!existsSync(f.wtA));
});

test('--force does NOT bypass the other guards (glob, primary, inside-cwd)', () => {
  const f = fixtureWithWorktrees();
  const glob = runRmArgs(f.work, path.join(f.root, 'wt-*'), '--force');
  assert.notEqual(glob.status, 0);
  assert.match(glob.err, /refusing a glob/i);

  const primary = runRmArgs(f.work, f.work, '--force');
  assert.notEqual(primary.status, 0);
  assert.match(primary.err, /PRIMARY checkout/i);

  const inside = runRmArgs(f.wtA, f.wtA, '--force');
  assert.notEqual(inside.status, 0);
  assert.match(inside.err, /running from INSIDE it/i);
  assert.ok(existsSync(f.wtA), '--force deleted the cwd it was told to refuse');
});

// ── `--stale` must nominate only on POSITIVE proof of landing ─────
// The classifier bug above reached `--stale` directly (it accepts `upstream` and
// nothing else), so the same branch shape was printed under a banner saying its work
// had LANDED and that removal was safe. These cases pin both halves: the fail-open
// default is gone, and the independent open-PR backstop vetoes a nomination whatever
// the classifier decides.
//
// `gh` is stubbed rather than skipped for the cases that need it. The stub directory
// is prepended with Node's `path.delimiter` and `process.env.PATH`, NEVER via a
// shell-level `export PATH=…`, which MSYS rewrites on Windows and which then fails
// SILENTLY UPWARD: the stub is simply not on PATH and the test passes having proven
// nothing.
function ghStub(root, { open = [], merged = [] } = {}) {
  const dir = path.join(root, 'ghstub');
  mkdirSync(dir, { recursive: true });
  const bin = path.join(dir, 'gh');
  writeFileSync(
    bin,
    [
      '#!/usr/bin/env bash',
      'state=""; head=""; json=""; prev=""',
      'for a in "$@"; do',
      '  case "$prev" in',
      '    --state) state="$a" ;;',
      '    --head) head="$a" ;;',
      '    --json) json="$a" ;;',
      '  esac',
      '  prev="$a"',
      'done',
      'if [ "$state" = "open" ]; then list="${GH_STUB_OPEN:-}"; else list="${GH_STUB_MERGED:-}"; fi',
      'if [ -n "$head" ]; then',
      '  n=0',
      '  while IFS= read -r l; do [ "$l" = "$head" ] && n=$((n + 1)); done <<< "$list"',
      '  if [ "$json" = "number" ]; then echo "$n"; else [ "$n" -gt 0 ] && echo "$head"; fi',
      '  exit 0',
      'fi',
      '[ -n "$list" ] && printf \'%s\\n\' "$list"',
      'exit 0',
    ].join('\n') + '\n',
  );
  chmodSync(bin, 0o755);
  return {
    ...ENV,
    WORKTREE_RM_SKIP_GH: '0',
    PATH: dir + path.delimiter + process.env.PATH,
    GH_STUB_OPEN: open.join('\n'),
    GH_STUB_MERGED: merged.join('\n'),
  };
}
function runStaleEnv(cwd, env) {
  try {
    const out = execFileSync('bash', [script, '--stale'], { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

// The exact bug: published, in sync with its own remote ref, has commits of its own,
// nothing merged. Offline (no gh at all), so the ONLY thing keeping it off the list is
// the classifier refusing to call a pushed branch landed.
test('--stale does NOT nominate a pushed, in-sync branch whose work has not landed', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-inflight');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/inflight');
    writeFileSync(path.join(wt, 'inflight.txt'), 'in flight\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'work in progress');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/inflight');

    // Precondition: this is the branch shape that used to classify `upstream`.
    assert.equal(git(f.work, 'rev-list', '--count', 'origin/main..feat/inflight'), '1');
    assert.equal(check(wt), 'pushed-not-merged');

    const r = runStale(f.work);
    assert.equal(r.status, 0, r.err);
    assert.ok(!r.out.includes('feat/inflight'), `--stale nominated an unmerged branch:\n${r.out}`);
    assert.ok(!r.out.includes('MERGED'), `--stale claimed something LANDED:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The veto cannot be read, so it must not be assumed absent: a failed lookup used to look like
// "no open PRs", and this landed-looking branch could have one.
test('--stale nominates nothing and exits non-zero when the open PRs cannot be read', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-unknown');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/unknown');
    writeFileSync(path.join(wt, 'landed.txt'), 'landed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'the work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--squash', 'feat/unknown');
    git(f.work, 'commit', '-q', '-m', 'squashed the work');
    git(f.work, 'push', '-q', 'origin', 'main');
    assert.ok(runStale(f.work).out.includes('feat/unknown'), 'fixture must classify as landed');

    const env = ghStub(f.root);
    writeFileSync(path.join(f.root, 'ghstub', 'gh'), '#!/usr/bin/env bash\nexit 1\n');
    const r = runStaleEnv(f.work, env);
    assert.equal(r.status, 1, r.err);
    assert.ok(!r.out.includes('feat/unknown'), `nominated with the veto unknown:\n${r.out}`);
    assert.match(r.err, /could not read every open PR/);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// gh truncates at --limit without saying so, so a full page may be hiding this branch's PR.
test('--stale nominates nothing when the open-PR list reaches its limit', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-truncated');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/truncated');
    writeFileSync(path.join(wt, 'landed.txt'), 'landed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'the work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--squash', 'feat/truncated');
    git(f.work, 'commit', '-q', '-m', 'squashed the work');
    git(f.work, 'push', '-q', 'origin', 'main');

    const env = { ...ghStub(f.root, { open: ['other/a', 'other/b'] }), WORKTREE_RM_OPEN_PR_LIMIT: '2' };
    const truncated = runStaleEnv(f.work, env);
    assert.equal(truncated.status, 1, truncated.err);
    assert.ok(!truncated.out.includes('feat/truncated'), `nominated from a truncated list:\n${truncated.out}`);

    // One under the limit is a complete list, so the fixture does nominate.
    const complete = runStaleEnv(f.work, { ...env, WORKTREE_RM_OPEN_PR_LIMIT: '3' });
    assert.equal(complete.status, 0, complete.err);
    assert.ok(complete.out.includes('feat/truncated'), `fixture must classify as landed:\n${complete.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The independent backstop. This branch IS genuinely squash-merged, so every landing
// test says `upstream`, and it is still not nominated, because a PR is open on it.
test('--stale never nominates a branch with an OPEN PR, even when it classifies upstream', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-openpr');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/openpr');
    writeFileSync(path.join(wt, 'landed.txt'), 'landed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'the work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--squash', 'feat/openpr');
    git(f.work, 'commit', '-q', '-m', 'squashed the work');
    git(f.work, 'push', '-q', 'origin', 'main');

    // Without the backstop this WOULD be nominated, assert that, or the test is vacuous.
    const offline = runStale(f.work);
    assert.ok(offline.out.includes('feat/openpr'), `fixture does not classify as landed:\n${offline.out}`);

    const r = runStaleEnv(f.work, ghStub(f.root, { open: ['feat/openpr'] }));
    assert.equal(r.status, 0, r.err);
    assert.ok(!r.out.includes('feat/openpr'), `--stale nominated a branch with an OPEN PR:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// Do not over-correct into uselessness: a real squash merge with no open PR still lists.
test('--stale STILL nominates a squash-merged branch when gh is live and reports no open PR', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-squashed');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/squashed');
    writeFileSync(path.join(wt, 'landed.txt'), 'landed\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'the work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--squash', 'feat/squashed');
    git(f.work, 'commit', '-q', '-m', 'squashed the work');
    git(f.work, 'push', '-q', 'origin', 'main');

    const env = ghStub(f.root, { open: ['some/other-branch'], merged: ['feat/squashed'] });
    const r = runStaleEnv(f.work, env);
    assert.equal(r.status, 0, r.err);
    assert.ok(r.out.includes('feat/squashed'), `--stale stopped nominating genuinely merged work:\n${r.out}`);
    assert.match(r.out, /MERGED/);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// Fast-forward / merge-commit landing leaves the branch with ZERO commits of its own,
// which is indistinguishable from an unstarted worktree, so it needs the
// positive merged-PR evidence, and with that evidence it must still be nominated.
test('--stale nominates a merge-commit-merged branch on merged-PR evidence', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-ff');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/ff');
    writeFileSync(path.join(wt, 'ff.txt'), 'ff\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'ff work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '--no-ff', '-q', '-m', 'merge ff', 'feat/ff');
    git(f.work, 'push', '-q', 'origin', 'main');
    assert.equal(git(f.work, 'rev-list', '--count', 'origin/main..feat/ff'), '0', 'fixture must leave zero own commits');

    const r = runStaleEnv(f.work, ghStub(f.root, { merged: ['feat/ff'] }));
    assert.equal(r.status, 0, r.err);
    assert.ok(r.out.includes('feat/ff'), `--stale missed a merge-commit-merged branch:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The zero-own-commits rule must not regress now that gh is consulted twice: a freshly-provisioned
// worktree has no commits, no merged PR and no open PR, and stays KEEP.
test('--stale still keeps a zero-own-commits fresh worktree when gh is live', () => {
  const f = fixture();
  try {
    const fresh = path.join(f.root, 'wt-fresh2');
    git(f.work, 'worktree', 'add', '-q', fresh, '-b', 'feat/fresh2');
    commitOn(f.work, 'main', 'b.txt', 'more\n', 'second');
    git(f.work, 'push', '-q', 'origin', 'main');

    const r = runStaleEnv(f.work, ghStub(f.root, { open: [], merged: [] }));
    assert.equal(r.status, 0, r.err);
    assert.ok(!r.out.includes('feat/fresh2'), `--stale nominated an unstarted branch:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The removal path consumes the same classifier. A new state must not fall silently
// through its `case` into "nothing to lose", removal still works, but it must SAY the
// branch has not landed.
test('removal of a pushed-not-merged worktree still succeeds, and warns that it has NOT landed', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-warn');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/warn');
    writeFileSync(path.join(wt, 'w.txt'), 'w\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'work');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/warn');
    assert.equal(check(wt), 'pushed-not-merged');

    const r = runRm(f.work, wt);
    assert.equal(r.status, 0, `removal regressed for a new classification:\n${r.err}`);
    assert.ok(!existsSync(wt), 'the worktree was not removed');
    assert.match(r.out, /has NOT landed/i, 'removal fell through the case into silence');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// A dirty pushed-not-merged worktree is the shape the whole bug endangers: an agent
// mid-review-loop with an open PR. The uncommitted-changes refusal must still fire.
test('removal STILL refuses a dirty pushed-not-merged worktree, and --force still overrides', () => {
  const f = fixture();
  try {
    const wt = path.join(f.root, 'wt-dirty-pnm');
    git(f.work, 'worktree', 'add', '-q', wt, '-b', 'feat/dirty-pnm');
    writeFileSync(path.join(wt, 'w.txt'), 'w\n');
    git(wt, 'add', '.');
    git(wt, 'commit', '-q', '-m', 'work');
    git(wt, 'push', '-q', '-u', 'origin', 'feat/dirty-pnm');
    writeFileSync(path.join(wt, 'wip.txt'), 'precious\n');

    const refused = runRm(f.work, wt);
    assert.notEqual(refused.status, 0, 'a dirty worktree was removed without --force');
    assert.match(refused.err, /not recoverable/i);
    assert.ok(existsSync(path.join(wt, 'wip.txt')));

    const forced = runRmArgs(f.work, wt, '--force');
    assert.equal(forced.status, 0, `--force regressed:\n${forced.err}`);
    assert.ok(!existsSync(wt));
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── a STALE copy of this script must say so, in the output that gets acted on ──
// The SessionStart banner refreshes `--stale` from the session's own checkout, so a
// worktree emits it from the copy it was cut with, forever, restarting Claude Code does
// not pick up fixes. Every past defect here over-nominated LIVE worktrees as
// MERGED, so a stale copy fails in the destructive direction while sounding certain.
//
// `[hooks-stale]` already warns about this and names the file; on 2026-09-03 an agent read
// it, quoted it back, and filed a bug anyway against a fallthrough fixed 13 hours
// earlier, then a peer session "corroborated" it with 30 of 36 worktrees nominated, being
// stale itself. So the caveat has to travel WITH the nominations and lead them, which is
// what the ordering assertion below pins.
//
// The fixture puts a copy of the real script inside its own repo so the script's staleness
// is a property of a throwaway checkout, never of the machine running the suite.
function selfStaleFixture({ advanceOrigin = true, nominate = true } = {}) {
  const f = fixture();
  const scripts = path.join(f.work, 'scripts');
  mkdirSync(scripts, { recursive: true });
  const local = path.join(scripts, 'worktree-rm.sh');
  copyFileSync(script, local);
  chmodSync(local, 0o755);
  // The script sources its sibling lib; a lone copy would die before it ran.
  mkdirSync(path.join(scripts, 'lib'), { recursive: true });
  copyFileSync(
    path.join(HERE, 'lib', 'git-no-fsmonitor.sh'),
    path.join(scripts, 'lib', 'git-no-fsmonitor.sh'),
  );
  // ...and its session-lock checker.
  copyFileSync(path.join(HERE, 'session-lock.mjs'), path.join(scripts, 'session-lock.mjs'));
  git(f.work, 'add', '.');
  git(f.work, 'commit', '-q', '-m', 'vendor worktree-rm.sh');
  git(f.work, 'push', '-q', 'origin', 'main');

  if (nominate) {
    // A genuinely squash-merged branch, so there is something legitimate to nominate and
    // the caveat is measured against real output rather than an empty list.
    const done = path.join(f.root, 'wt-landed');
    git(f.work, 'worktree', 'add', '-q', done, '-b', 'feat/landed');
    writeFileSync(path.join(done, 'landed.txt'), 'landed\n');
    git(done, 'add', '.');
    git(done, 'commit', '-q', '-m', 'the work');
    git(f.work, 'checkout', '-q', 'main');
    git(f.work, 'merge', '-q', '--squash', 'feat/landed');
    git(f.work, 'commit', '-q', '-m', 'squashed the work');
    git(f.work, 'push', '-q', 'origin', 'main');
  } else {
    // Provisioned-but-unstarted: zero commits of its own, so the zero-own-commits rule keeps it off the list.
    git(f.work, 'worktree', 'add', '-q', path.join(f.root, 'wt-fresh'), '-b', 'feat/unstarted');
  }

  if (advanceOrigin) {
    // Somebody else lands a change TO THIS SCRIPT on main. `work` never pulls it, which is
    // exactly the state a worktree is permanently in after a fix merges.
    const other = path.join(f.root, 'other');
    git(f.root, 'clone', '-q', f.origin, other);
    writeFileSync(path.join(other, 'scripts', 'worktree-rm.sh'), `${readFileSync(local, 'utf8')}\n# upstream fix\n`);
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'fix(worktrees): a fix this checkout does not have');
    git(other, 'push', '-q', 'origin', 'main');
    // `--stale` fetches for itself, but the precondition assertion below reads the ref
    // BEFORE the script runs, without this it would measure the pre-push state.
    git(f.work, 'fetch', '-q', 'origin', 'main');
  }
  return { ...f, local };
}
// NOT runRmArgs/runStale: those run the REPO's script, whose staleness is a property of
// the machine. These cases turn on the staleness of the copy being EXECUTED, so the
// fixture's own vendored copy has to be the one invoked.
function runLocalStale(f) {
  try {
    const out = execFileSync('bash', [f.local, '--stale'], { cwd: f.work, encoding: 'utf8', env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

test('--stale warns FIRST when the running copy of the script is behind origin/main', () => {
  const f = selfStaleFixture();
  try {
    // Precondition: the fixture really is in the failing state. Without this the assertions
    // below could pass on a fixture that never went stale.
    assert.ok(
      git(f.work, 'diff', '--name-only', 'HEAD...origin/main', '--', 'scripts/worktree-rm.sh'),
      'fixture is not actually stale: the test would prove nothing',
    );

    const r = runLocalStale(f);
    assert.equal(r.status, 0);
    assert.match(r.out, /STALE copy/, `no staleness caveat on a stale script:\n${r.out}`);
    assert.match(r.out, /restarting Claude Code does NOT pick up fixes/, 'the caveat must name why restarting does not help');
    assert.match(r.out, /Do NOT remove anything below/, 'the caveat must say what not to do');
    assert.ok(r.out.includes('feat/landed'), `the nomination itself was lost:\n${r.out}`);

    // The whole point of leading: a caveat printed AFTER the confident claim is one the
    // reader has already scrolled past. It has to lead.
    assert.ok(
      r.out.indexOf('READ THIS FIRST') < r.out.indexOf('MERGED'),
      `the caveat came after the nominations it qualifies:\n${r.out}`,
    );
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--stale does NOT cry stale when the running copy is current', () => {
  const f = selfStaleFixture({ advanceOrigin: false });
  try {
    const r = runLocalStale(f);
    assert.equal(r.status, 0);
    assert.ok(r.out.includes('feat/landed'), `the nomination regressed:\n${r.out}`);
    assert.ok(!r.out.includes('STALE copy'), `cried stale on a current checkout:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--stale stays SILENT on a stale script that nominates nothing', () => {
  // The caveat qualifies a claim. With no claim there is nothing to qualify, and a banner on
  // every session start of every stale worktree is how a warning gets trained out of a reader
  // (the failure the caveat exists to prevent, not a fix for it).
  const f = selfStaleFixture({ nominate: false });
  try {
    const r = runLocalStale(f);
    assert.equal(r.status, 0);
    assert.equal(r.out.trim(), '', `spoke up with nothing to nominate:\n${r.out}`);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── the arg loop used to silently DROP any argument it did not
// recognise, and silently take the FIRST bare word as the target no matter what
// followed it. `<path> --dry-run` and `<path> --help` both took the old
// `*) [ -z "$TARGET" ] && TARGET="$1"` catch-all straight into the removal branch
// and deleted a live worktree tonight. Every case below asserts BOTH halves: the
// exit code AND that the fixture worktree is still on disk afterward, an exit
// code alone would not have caught the original bug, since the old code exited 0
// too (it just deleted something on the way).
test('an unknown flag BEFORE the path exits 2 and removes nothing', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, '--dry-run-typo', f.wtA);
    assert.equal(r.status, 2, `did not fail closed:\n${r.out}\n${r.err}`);
    assert.match(r.err, /unrecognised option/i);
    assert.match(r.err, /--dry-run-typo/);
    assert.ok(existsSync(f.wtA), 'the worktree was removed despite the unknown flag');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('an unknown flag AFTER the path exits 2 and removes nothing, the exact reported bug', () => {
  const f = fixtureWithWorktrees();
  try {
    // This is the literal shape that removed a reviewer's worktree: the old code took
    // wtA as TARGET and silently dropped --some-other-flag, then proceeded to delete it.
    const r = runRmArgs(f.work, f.wtA, '--some-other-flag');
    assert.equal(r.status, 2, `did not fail closed:\n${r.out}\n${r.err}`);
    assert.match(r.err, /unrecognised option/i);
    assert.ok(existsSync(f.wtA), 'the worktree was removed despite the unknown trailing flag');
    assert.ok(existsSync(f.wtB), 'the sibling was also untouched');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--help exits 0, prints usage on stdout, and removes nothing', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, '--help');
    assert.equal(r.status, 0, `--help did not exit 0:\n${r.out}\n${r.err}`);
    assert.match(r.out, /Usage:/);
    assert.match(r.out, /--dry-run/);
    assert.equal(r.err, '', `--help wrote to stderr:\n${r.err}`);
    assert.ok(existsSync(f.wtA), 'a bare --help removed a worktree');
    assert.ok(existsSync(f.wtB));
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('`<path> --help` exits 0, removes nothing (the exact second reported bug shape)', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, f.wtA, '--help');
    assert.equal(r.status, 0, `<path> --help did not exit 0:\n${r.out}\n${r.err}`);
    assert.match(r.out, /Usage:/);
    assert.ok(existsSync(f.wtA), '<path> --help removed the worktree it was told to just describe');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--dry-run exits 0, names the target, and removes nothing on a CLEAN worktree', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, f.wtA, '--dry-run');
    assert.equal(r.status, 0, `--dry-run failed:\n${r.out}\n${r.err}`);
    assert.match(r.out, /DRY RUN/);
    assert.match(r.out, /feat\/a/, 'the dry-run output must name the branch it would remove');
    assert.ok(existsSync(f.wtA), '--dry-run actually removed the worktree');
    const listed = git(f.work, 'worktree', 'list', '--porcelain');
    assert.match(listed, /wt-a/, '--dry-run deregistered the worktree');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--dry-run works with the flag before the path too', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, '--dry-run', f.wtA);
    assert.equal(r.status, 0, `--dry-run failed:\n${r.out}\n${r.err}`);
    assert.match(r.out, /DRY RUN/);
    assert.ok(existsSync(f.wtA));
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--dry-run still runs the glob / primary-checkout / inside-cwd / not-a-worktree guards', () => {
  const f = fixtureWithWorktrees();
  try {
    const glob = runRmArgs(f.work, path.join(f.root, 'wt-*'), '--dry-run');
    assert.notEqual(glob.status, 0);
    assert.match(glob.err, /refusing a glob/i);

    const primary = runRmArgs(f.work, f.work, '--dry-run');
    assert.notEqual(primary.status, 0);
    assert.match(primary.err, /PRIMARY checkout/i);

    const inside = runRmArgs(f.wtA, f.wtA, '--dry-run');
    assert.notEqual(inside.status, 0);
    assert.match(inside.err, /running from INSIDE it/i);

    const notReg = path.join(f.root, 'not-a-worktree');
    mkdirSync(notReg);
    const notWt = runRmArgs(f.work, notReg, '--dry-run');
    assert.notEqual(notWt.status, 0);
    assert.match(notWt.err, /not a registered git worktree/i);

    assert.ok(existsSync(f.wtA), 'a guard failure under --dry-run should never remove anything anyway');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--dry-run STILL refuses a dirty worktree without --force, exactly like a real run', () => {
  const f = fixtureWithWorktrees();
  try {
    writeFileSync(path.join(f.wtA, 'wip.txt'), 'precious uncommitted work\n');
    const r = runRmArgs(f.work, f.wtA, '--dry-run');
    assert.notEqual(r.status, 0, 'a dirty --dry-run target must still be refused without --force');
    assert.match(r.err, /not recoverable/i);
    assert.ok(existsSync(f.wtA));
    assert.ok(existsSync(path.join(f.wtA, 'wip.txt')));
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--dry-run --force on a dirty worktree says it WOULD discard, and removes nothing', () => {
  const f = fixtureWithWorktrees();
  try {
    writeFileSync(path.join(f.wtA, 'wip.txt'), 'precious uncommitted work\n');
    const r = runRmArgs(f.work, f.wtA, '--dry-run', '--force');
    assert.equal(r.status, 0, `--dry-run --force failed:\n${r.out}\n${r.err}`);
    assert.match(r.out, /would discard/i);
    assert.match(r.out, /DRY RUN/);
    assert.ok(existsSync(f.wtA), '--dry-run --force actually removed the worktree');
    assert.ok(existsSync(path.join(f.wtA, 'wip.txt')), '--dry-run --force discarded uncommitted work');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('a second positional argument exits 2 and removes nothing', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, f.wtA, f.wtB);
    assert.equal(r.status, 2, `did not fail closed on a second positional:\n${r.out}\n${r.err}`);
    assert.match(r.err, /unexpected extra argument/i);
    assert.ok(existsSync(f.wtA), 'the first positional was removed despite the extra argument');
    assert.ok(existsSync(f.wtB), 'the second positional was removed despite never being a valid target');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// `--force` and `--stale` behaviour must be unchanged by this fix. `--force` (both
// orderings, and combined with the other guards) is already pinned above by
// "--force removes a dirty worktree, and works before or after the path" and
// "--force does NOT bypass the other guards"; `--stale` by the whole open-PR veto /
// zero-own-commits / stale-copy block above. This is a direct A/B against the exact old
// silent-drop shape, so a future edit that reopens it fails immediately rather
// than waiting to be noticed on a reviewer's tree again.
test('MUTATION GUARD: an unrecognised trailing argument is never silently absorbed into a successful removal', () => {
  const f = fixtureWithWorktrees();
  try {
    const r = runRmArgs(f.work, f.wtA, '--totally-made-up-flag');
    assert.notEqual(r.status, 0, 'an unrecognised flag must not read as success');
    assert.ok(existsSync(f.wtA), 'the target must survive an unrecognised trailing flag');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// worktree-rm.sh runs `git status` inside the target and `git worktree remove`,
// the same fsmonitor-daemon waits that hang worktree-new.sh's checkout. It must run its git
// with core.fsmonitor off. A hook-based fsmonitor that logs each call stands in for the
// daemon: it is consulted by the same code path whenever the setting is on.
test('worktree-rm runs its git with core.fsmonitor off, even when the shared config turns it on', () => {
  const f = fixtureWithWorktrees();
  try {
    const log = path.join(f.root, 'fsmonitor-hook.log');
    const hook = path.join(f.root, 'fsmonitor-hook.sh');
    const bashPath = (p) => p.replace(/\\/g, '/');
    writeFileSync(hook, `#!/bin/sh\necho called >> "${bashPath(log)}"\nprintf '\\0'\n`, { mode: 0o755 });
    git(f.work, 'config', 'core.fsmonitor', bashPath(hook));
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').length : 0);

    // Control: a plain `git status` inside a linked worktree consults the hook. Without
    // this the zero below could be a git that never calls it.
    git(f.wtA, 'status', '--porcelain');
    assert.ok(calls() > 0, 'fixture is vacuous: git status never consulted fsmonitor');
    rmSync(log);

    // Preserve a realistic inherited caller override through the script invocation;
    // fixture setup above deliberately runs with a clean Git config environment so
    // the fsmonitor-on control remains observable.
    const callerEnv = {
      ...ENV,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.fsmonitor',
      GIT_CONFIG_VALUE_0: 'false',
    };
    const r = runRm(f.work, f.wtA, callerEnv);
    assert.equal(r.status, 0, r.err);
    assert.ok(!existsSync(f.wtA), 'the target is gone');
    assert.equal(calls(), 0, 'worktree-rm.sh ran git with fsmonitor enabled; its status/remove can hang');
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// ── a worktree a live session is in is not removed out from under it ──────
// A session-lock record (scripts/session-lock.mjs) in the fixture's common git dir. The pid is
// this test process's own, so it is alive; the caller's session id comes from ENV.
function pinSession(f, worktree, { sessionId = 'peer-session', pid = process.pid, touchedAt = Date.now() } = {}) {
  const dir = path.join(f.work, '.git', LOCK_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${sessionId}.json`), JSON.stringify({ sessionId, pid, worktree, touchedAt }));
}
const LIVE_ENV = { ...ENV, CLAUDE_CODE_SESSION_ID: 'the-caller' };
function runRmLive(cwd, ...args) {
  try {
    const out = execFileSync('bash', [script, ...args], { cwd, encoding: 'utf8', env: LIVE_ENV, stdio: ['ignore', 'pipe', 'pipe'] });
    return { status: 0, out, err: '' };
  } catch (e) {
    return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
  }
}

test('removal REFUSES a worktree another live session is in, naming the session, and leaves it intact', () => {
  const f = fixtureWithWorktrees();
  pinSession(f, f.wtA);
  const r = runRmLive(f.work, f.wtA);
  assert.equal(r.status, 1);
  assert.match(r.err, /a live agent session is working in it/);
  assert.match(r.err, new RegExp(`session peer-session \\(pid ${process.pid},`));
  assert.match(r.err, /--force-live-session/);
  assert.ok(existsSync(path.join(f.wtA, 'a.txt')), 'the live session keeps its checkout');
  assert.equal(runRmLive(f.work, f.wtA, '--dry-run').status, 1, '--dry-run reports the same refusal');
  assert.equal(runRmLive(f.work, f.wtA, '--force').status, 1, '--force is for uncommitted changes, not live sessions');
  assert.equal(runRmLive(f.work, f.wtB).status, 0, 'a sibling nobody is in still removes');
});

test('the refusal holds with MSYS_NO_PATHCONV=1, which hands node the /c/... path verbatim (review on this PR)', () => {
  const f = fixtureWithWorktrees();
  pinSession(f, f.wtA);
  let r;
  try {
    execFileSync('bash', [script, f.wtA], { cwd: f.work, encoding: 'utf8', env: { ...LIVE_ENV, MSYS_NO_PATHCONV: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    r = { status: 0, err: '' };
  } catch (e) {
    r = { status: e.status, err: String(e.stderr ?? '') };
  }
  assert.equal(r.status, 1, `removed a live session's worktree:\n${r.err}`);
  assert.match(r.err, /a live agent session is working in it/);
  assert.ok(existsSync(path.join(f.wtA, 'a.txt')));
});

test('a check that cannot RUN refuses too, never "nobody is there"; --force-live-session overrides', () => {
  const f = fixtureWithWorktrees();
  // A copy of the script with its lib but WITHOUT session-lock.mjs beside it: node cannot load
  // the checker, the shape both fail-open paths the review found reduced to.
  const bare = path.join(f.root, 'bare-scripts');
  mkdirSync(path.join(bare, 'lib'), { recursive: true });
  copyFileSync(script, path.join(bare, 'worktree-rm.sh'));
  copyFileSync(path.join(HERE, 'lib', 'git-no-fsmonitor.sh'), path.join(bare, 'lib', 'git-no-fsmonitor.sh'));
  const run = (...args) => {
    try {
      return { status: 0, out: execFileSync('bash', [path.join(bare, 'worktree-rm.sh'), ...args], { cwd: f.work, encoding: 'utf8', env: LIVE_ENV, stdio: ['ignore', 'pipe', 'pipe'] }), err: '' };
    } catch (e) {
      return { status: e.status, out: String(e.stdout ?? ''), err: String(e.stderr ?? '') };
    }
  };
  const r = run(f.wtA);
  assert.equal(r.status, 1, r.out);
  assert.match(r.err, /could not check whether a live agent session is in it/);
  assert.ok(existsSync(path.join(f.wtA, 'a.txt')));
  const forced = run(f.wtA, '--force-live-session');
  assert.equal(forced.status, 0, forced.err);
  assert.ok(!existsSync(f.wtA));
});

test('--force-live-session removes it anyway, and says so', () => {
  const f = fixtureWithWorktrees();
  pinSession(f, f.wtA);
  const r = runRmLive(f.work, f.wtA, '--force-live-session');
  assert.equal(r.status, 0, r.err);
  assert.match(r.out, /--force-live-session given/);
  assert.ok(!existsSync(f.wtA));
});

test("the caller's own session never blocks it: land.sh removes the worktree its session made", () => {
  const f = fixtureWithWorktrees();
  pinSession(f, f.wtA, { sessionId: 'the-caller' });
  const r = runRmLive(f.work, f.wtA);
  assert.equal(r.status, 0, r.err);
  assert.ok(!existsSync(f.wtA));
});

test('a stale lock does not block: a dead pid, or a record past the 12h cap', () => {
  for (const stale of [{ pid: 2 ** 30 }, { touchedAt: Date.now() - 13 * 3_600_000 }]) {
    const f = fixtureWithWorktrees();
    pinSession(f, f.wtA, stale);
    const r = runRmLive(f.work, f.wtA);
    assert.equal(r.status, 0, `${JSON.stringify(stale)} blocked:\n${r.err}`);
    assert.ok(!existsSync(f.wtA));
  }
});

test('--stale never nominates a worktree a live session is in, even once its branch has landed', () => {
  const f = fixture();
  const done = path.join(f.root, 'wt-done');
  git(f.work, 'worktree', 'add', '-q', done, '-b', 'feat/done');
  writeFileSync(path.join(done, 'landed.txt'), 'landed\n');
  git(done, 'add', '.');
  git(done, 'commit', '-q', '-m', 'the work');
  git(f.work, 'checkout', '-q', 'main');
  git(f.work, 'merge', '-q', '--squash', 'feat/done');
  git(f.work, 'commit', '-q', '-m', 'squashed the work');
  git(f.work, 'push', '-q', 'origin', 'main');
  assert.ok(runRmLive(f.work, '--stale').out.includes('feat/done'), 'control: the landed branch is nominated while nobody is in it');
  pinSession(f, done);
  const r = runRmLive(f.work, '--stale');
  assert.equal(r.status, 0);
  assert.ok(!r.out.includes('feat/done'), `a live session's worktree was nominated:\n${r.out}`);
});

// ── the `--stale` report is parsed by other tools, so its shape is pinned ─────────────────────────
// A consumer's session-start banner counts the `  MERGED  ` lines and a sweep job reads the path and
// branch out of them; both read the `[worktree-stale] N of M` line and the READ THIS FIRST marker.
// The prose around them may be reworded, those parts may not move. One squash-merged branch in a
// current checkout: the whole output, line for line.
test('--stale output on a fixture is exactly the pinned shape: one MERGED line, then the fixed footer', () => {
  const f = selfStaleFixture({ advanceOrigin: false });
  try {
    const porcelain = git(f.work, 'worktree', 'list', '--porcelain').split('\n');
    const at = porcelain.indexOf('branch refs/heads/feat/landed');
    assert.ok(at > 0, `fixture lost its landed worktree:\n${porcelain.join('\n')}`);
    const landedPath = porcelain[at - 2].replace(/^worktree /, '');
    const r = runLocalStale(f);
    assert.equal(r.status, 0, r.err);
    assert.equal(r.err, '');
    assert.equal(r.out, [
      `  MERGED  ${landedPath}  [feat/landed]`,
      '[worktree-stale] 1 of 2 worktrees are on branches whose work has LANDED.',
      '[worktree-stale] Each keeps ~0.7 GB of node_modules. Remove one with:',
      '[worktree-stale]   bash scripts/worktree-rm.sh <path>',
      '[worktree-stale] Nomination needs positive evidence the branch did work that landed',
      '[worktree-stale] (a merged PR, or its own commits already upstream). Merely being pushed',
      '[worktree-stale] and in sync with origin/<branch> is NOT landing and is never listed,',
      '[worktree-stale] nor is any branch with an OPEN PR. A branch with no commits',
      "[worktree-stale] of its own is treated as UNSTARTED, never merged, so another session's",
      '[worktree-stale] freshly-provisioned worktree is not listed here.',
      '[worktree-stale] Anything NOT listed, only remove if you created it. Removal REFUSES a',
      '[worktree-stale] worktree with uncommitted changes; --force overrides and is unrecoverable.',
      '',
    ].join('\n'));
    // The banner's count regex, as a consumer writes it.
    assert.equal((r.out.match(/^ {2}MERGED {2}/gm) ?? []).length, 1);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

test('--stale with a stale copy of the script still leads with READ THIS FIRST and keeps the same MERGED lines', () => {
  const f = selfStaleFixture();
  try {
    const r = runLocalStale(f);
    assert.equal(r.status, 0, r.err);
    const lines = r.out.split('\n');
    assert.match(lines[0], /^\[worktree-stale\] .* READ THIS FIRST/);
    assert.equal(lines.filter((l) => /^ {2}MERGED {2}\S.*\[feat\/landed\]$/.test(l)).length, 1, r.out);
    assert.match(r.out, /^\[worktree-stale\] 1 of 2 worktrees are on branches whose work has LANDED\.$/m);
  } finally {
    removeTempDir(f.root, 'worktree-rm.node-test');
  }
});

// The pending-delete file a consumer sweep job reads is named from the neutral-prefix token, so a
// synced consumer keeps the file name its own sweep already reads. A hardcoded literal would orphan it.
test('worktree-rm.sh derives its pending-delete file name from the prefix token', () => {
  const src = readFileSync(script, 'utf8');
  assert.match(src, /AGENT_TOOLING_WORKTREE_PENDING_DELETE/);
  assert.doesNotMatch(src, /[a-z]-worktree-pending-delete|\bworktree-pending-delete\.txt/);
  const name = execFileSync('bash', ['-c', "printf %s AGENT_TOOLING_WORKTREE_PENDING_DELETE | tr 'A-Z_' 'a-z-'"], { encoding: 'utf8' });
  assert.equal(name, 'agent-tooling-worktree-pending-delete');
});
