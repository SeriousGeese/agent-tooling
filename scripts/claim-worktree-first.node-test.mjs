// Behavioural coverage for scripts/claim.sh.
//
// The bug this pins: claim.sh used to finish with `git checkout -b "$BRANCH"`, which,
// given its own on-main precondition, could only ever run in the SHARED primary
// checkout, and left that checkout sitting on a feature branch. A multi-agent repository forbids
// exactly that (never switch branches in the main checkout), and any concurrent session using
// the shared checkout inherits the wrong HEAD.
//
// A source-text assertion would not have caught it (the old script's text was perfectly
// reasonable), so this runs the real script against a throwaway repo with a local bare
// "origin" and a stubbed `bd`, then asserts on the resulting git state.
//
// Runs under `npm run test:scripts` (node --test). Skips itself if `bash` or `git` is
// unavailable rather than failing, the assertions are about shell behaviour, not about
// every machine having a POSIX shell.
//
// The claim() cases run on Windows too (they were once skipped there).
// claim.sh's dolt sync step shells out to `node scripts/bd-dolt-sync.mjs pull/push`, which
// spawns `bd` via Node's spawnSync rather than bash. On Windows that spawn does not resolve
// directory-first the way bash and cmd.exe do: it only tries `.com`/`.exe` along the whole
// PATH, so a real `bd.exe` installed anywhere on PATH (winget, say) silently won over the
// stub's `bd.cmd` in the FIRST directory, ran against a sandbox with no beads workspace, and
// failed ("bd dolt pull FAILED (exit 1)"). So the PATH is no longer what reaches the stub on
// the Node side: every claim passes `BD_CLI`, which bd-dolt-sync.mjs honours, set to the
// stub's absolute path, `bd.cmd` on Windows, which its shell fallback runs through cmd.exe.
// bash still finds the extensionless `bd` stub on PATH for claim.sh's own `bd` calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTempDir } from './test-support/cleanup.mjs';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WINDOWS = process.platform === 'win32';

const has = (cmd) => spawnSync(cmd, ['--version'], { encoding: 'utf8' }).status === 0;
// claim.sh syncs through bd-dolt-sync.mjs, which belongs to the beads set: a consumer that
// vendored the worktree set alone has nothing for these tests to run against.
const SKIP = !has('bash') || !has('git')
  ? 'requires bash and git on PATH'
  : !fs.existsSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'bd-dolt-sync.mjs'))
    ? 'scripts/bd-dolt-sync.mjs is absent: claim.sh needs the beads set (adopt --set beads,worktree)'
    : false;
let tmp, origin, checkout, stubBin;

// What claim.sh runs against: itself, the worktree half, the 4h check, and (from the base and
// beads sets) the actor id, the verified sync and the config loader every script reads.
const CLAIM_SCRIPTS = ['claim.sh', 'claim-age.mjs', 'worktree-new.sh', 'agent-actor-id.mjs', 'bd-dolt-sync.mjs', 'agent-tooling-config.mjs'];
const CLAIM_LIBS = ['to-node-path.sh', 'git-no-fsmonitor.sh', 'agent-config.sh'];

/** The stub bd-dolt-sync.mjs must spawn from `dir`: Node cannot run the extensionless one on Windows. */
const bdCliIn = (dir) => path.join(dir, IS_WINDOWS ? 'bd.cmd' : 'bd');

/**
 * process.env with `dir` first on PATH and BD_CLI aimed at its stub. Prepends to whichever
 * spelling of the key Windows already uses (`Path` under PowerShell), never a second one.
 */
function stubbedEnv(dir) {
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  const env = { ...process.env, [key]: `${dir}${path.delimiter}${process.env[key] ?? ''}`, BD_CLI: bdCliIn(dir) };
  // A host AGENT_TOOLING_WORKTREE_ROOT would put the fixture worktrees in the REAL shared worktree dir,
  // where they outlive the sandbox and collide with the next run's (as the worktree-new-*.node-test files do).
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'AGENT_TOOLING_WORKTREE_ROOT') delete env[k];
  return env;
}

/** Run a command in `cwd`, asserting it succeeded. */
function run(cmd, args, cwd, extraEnv = {}) {
  const r = spawnSync(cmd, args, {
    cwd, encoding: 'utf8', env: { ...process.env, ...extraEnv },
  });
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (${r.status})\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

const git = (args, cwd) => run('git', args, cwd).stdout.trim();

before(() => {
  if (SKIP) return;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claim-sh-'));
  origin = path.join(tmp, 'origin.git');
  checkout = path.join(tmp, 'checkout');
  stubBin = path.join(tmp, 'bin');

  run('git', ['init', '--bare', '-b', 'main', origin], tmp);
  run('git', ['init', '-b', 'main', checkout], tmp);
  git(['config', 'user.email', 'claim-test@example.com'], checkout);
  git(['config', 'user.name', 'Claim Test'], checkout);
  git(['remote', 'add', 'origin', origin], checkout);

  // Only the scripts under test, claim.sh delegates to worktree-new.sh for the worktree and
  // to bd-dolt-sync.mjs for its two sync steps.
  fs.mkdirSync(path.join(checkout, 'scripts'));
  fs.mkdirSync(path.join(checkout, 'scripts', 'lib'));
  for (const f of CLAIM_SCRIPTS) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, f), path.join(checkout, 'scripts', f));
  }
  for (const f of CLAIM_LIBS) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, 'lib', f), path.join(checkout, 'scripts', 'lib', f));
  }
  fs.writeFileSync(path.join(checkout, 'README.md'), 'sandbox\n');
  git(['add', '.'], checkout);
  git(['commit', '-m', 'seed'], checkout);
  git(['push', '-u', 'origin', 'main'], checkout);

  // `bd` is the beads CLI; the script's Dolt calls are irrelevant here.
  //
  // Two stubs, not one. claim.sh invokes `bd` from bash, where the shebang script is enough,
  // but it now routes its sync through scripts/bd-dolt-sync.mjs, which spawns `bd` from NODE,
  // and on Windows that goes through cmd.exe and cannot run an extensionless shebang file. A
  // .cmd sibling is what makes the stub reachable from both callers.
  fs.mkdirSync(stubBin);
  fs.writeFileSync(path.join(stubBin, 'bd'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(stubBin, 'bd.cmd'), '@echo off\r\nexit /b 0\r\n');
  }
});

after(() => {
  // `tmp` holds a bare origin, a real checkout and up to four LIVE git worktrees,
  // and claim.sh shells out to bd/dolt underneath. A lingering handle here EPERMs
  // on Windows; that is lock contention, not a code failure, so it is reported
  // rather than thrown out of the root `after` hook.
  removeTempDir(tmp, 'claim-worktree-first.node-test');
});

/**
 * Invoke claim.sh from the sandbox checkout with `bd` stubbed out. The default actor
 * carries a -bot-<8> session suffix: claim.sh refuses a shared one.
 */
function claim(args, extraEnv = {}, bin = stubBin) {
  return spawnSync('bash', ['scripts/claim.sh', ...args], {
    cwd: checkout,
    encoding: 'utf8',
    env: {
      ...stubbedEnv(bin),
      GITHUB_TOKEN: '',
      BEADS_ACTOR: 'claim-test-bot-0000feed',
      BEADS_ACTOR_BASE: '',
      AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR: '',
      ...extraEnv,
    },
  });
}

/** An env with NO session identity of any vendor, the Codex-on-Windows shape. */
const NO_SESSION = { BEADS_ACTOR: '', CLAUDE_CODE_SESSION_ID: '', CODEX_THREAD_ID: '' };

/** A bash `bd` that records every invocation, so "nothing was claimed" is observable. */
function recordingBin(tag) {
  const dir = path.join(tmp, `bin-${tag}`);
  const log = path.join(dir, 'bd-calls.log');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'bd'), `#!/usr/bin/env bash\necho "$*" >> "${log.replace(/\\/g, '/')}"\nexit 0\n`, { mode: 0o755 });
  if (process.platform === 'win32') {
    // Redirection FIRST: `echo %* >> log` would record a trailing space on every line.
    fs.writeFileSync(path.join(dir, 'bd.cmd'), `@echo off\r\n>>"${log}" echo %*\r\nexit /b 0\r\n`);
  }
  return { dir, log };
}

// Refusals run BEFORE the dolt sync, so (like the --in-place refusal below)
// they run on Windows too: no bd-via-Node spawn is reached.
test('refuses to claim with no session id and no BEADS_ACTOR, before any pull, sync or bd call', { skip: SKIP }, () => {
  const { dir, log } = recordingBin('nosession');
  const r = claim(['bd-test7', 'fix/no-session', '--no-install'], NO_SESSION, dir);
  assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to claim bd-test7 under a shared actor identity/);
  assert.match(r.stderr, /"claim-test" is NOT session-distinct/);
  assert.match(r.stderr, /CODEX_THREAD_ID/);
  assert.doesNotMatch(r.stdout, /Claiming as:|Syncing issues|Pulling latest main/);
  assert.ok(!fs.existsSync(log), `bd must never run; it was called with:\n${fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : ''}`);
  assert.ok(!fs.existsSync(path.join(tmp, 'checkout-no-session')), 'no worktree was created');
});

test('refuses an explicit BEADS_ACTOR that is a shared name, the same way the hook judges it', { skip: SKIP }, () => {
  const { dir, log } = recordingBin('sharedactor');
  const r = claim(['bd-test8', '--claim-only'], { ...NO_SESSION, BEADS_ACTOR: 'jane-doe' }, dir);
  assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /BEADS_ACTOR is set to a name with no -bot-/);
  assert.ok(!fs.existsSync(log), 'bd must never run');
});

test('a Codex session (CODEX_THREAD_ID, no Claude id) claims under a derived per-session id', { skip: SKIP }, () => {
  const r = claim(['bd-test9', '--claim-only'], {
    ...NO_SESSION,
    CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1',
  });
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /Claiming as: claim-test-bot-daefdad1/);
});

test('claiming through a directory symlink actually pulls and publishes the claim', { skip: SKIP }, () => {
  const alias = path.join(tmp, 'checkout-alias');
  // A Windows 'dir' symlink needs Developer Mode or admin (EPERM otherwise); a junction is the
  // same aliased directory path and needs neither.
  fs.symlinkSync(checkout, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const { dir, log } = recordingBin('symlink');
  const r = spawnSync('bash', [path.join(alias, 'scripts/claim.sh'), 'bd-symlink', '--claim-only'], {
    cwd: alias, encoding: 'utf8',
    env: { ...stubbedEnv(dir), BEADS_ACTOR: 'claim-test-bot-0000feed', GITHUB_TOKEN: '' },
  });
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
  // The bash stub writes LF and the Windows bd.cmd CRLF into the same log.
  const calls = fs.readFileSync(log, 'utf8').trim().split(/\r?\n/);
  const pull = calls.indexOf('dolt pull');
  const claim = calls.indexOf('update bd-symlink --claim');
  const push = calls.indexOf('dolt push');
  assert.ok(pull >= 0 && claim > pull && push > claim, `sync must surround the claim, not silently skip:\n${calls.join('\n')}`);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'main');
});

test('AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR=1 still lets a deliberate shared claim through', { skip: SKIP }, () => {
  const r = claim(['bd-test10', '--claim-only'], { ...NO_SESSION, AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR: '1' });
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /SHARED identity 'claim-test'/);
});

test('leaves the invoking checkout on main and creates a dedicated worktree', { skip: SKIP }, () => {
  const r = claim(['bd-test1', 'fix/my-branch', '--no-install']);
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);

  // The whole point of the bead: the shared checkout must not have moved.
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'main');

  // The branch exists, in its own worktree, and is published.
  const dest = path.join(tmp, 'checkout-my-branch');
  assert.ok(fs.existsSync(dest), `expected a worktree at ${dest}\n${r.stdout}`);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], dest), 'fix/my-branch');
  assert.match(git(['branch', '-r'], checkout), /origin\/fix\/my-branch/);
});

test('strips the type prefix rather than pasting the whole branch into the path', { skip: SKIP }, () => {
  const r = claim(['bd-test2', 'feat/nested/thing', '--no-install']);
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);

  // The old trailing advice substituted only 'feat/', so a fix/ branch produced
  // `<repo>-fix/<rest>`, a nested dir under a stray `<repo>-fix` parent. Any remaining
  // separator must be flattened, and no stray parent may appear.
  assert.ok(fs.existsSync(path.join(tmp, 'checkout-nested-thing')));
  assert.ok(!fs.existsSync(path.join(tmp, 'checkout-feat')));
  assert.ok(!fs.existsSync(path.join(tmp, 'checkout-nested')));
});

test('fails loudly instead of clobbering when the target directory exists', { skip: SKIP }, () => {
  fs.mkdirSync(path.join(tmp, 'checkout-taken'));
  fs.writeFileSync(path.join(tmp, 'checkout-taken', 'keep.txt'), 'do not clobber\n');

  const r = claim(['bd-test3', 'fix/taken', '--no-install']);
  assert.notEqual(r.status, 0, 'expected a non-zero exit for an existing directory');
  assert.match(`${r.stdout}${r.stderr}`, /already exists/);
  assert.equal(fs.readFileSync(path.join(tmp, 'checkout-taken', 'keep.txt'), 'utf8'), 'do not clobber\n');
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'main');
});

test('--in-place still branches the current checkout for a deliberate caller', { skip: SKIP }, () => {
  const r = claim(['bd-test4', 'fix/in-place', '--in-place']);
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
  assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'fix/in-place');
  git(['checkout', 'main'], checkout);
});

test('claims from a checkout that is not on main, the worktree path no longer requires main', { skip: SKIP }, () => {
  // The on-main precondition predated the worktree-first rewrite and
  // guarded a `git checkout -b` ending the script no longer has. The worktree path bases on
  // a freshly fetched origin/main inside worktree-new.sh and never touches this HEAD, so a
  // session already inside a worktree can pick up another bead through the sanctioned helper.
  git(['checkout', '-b', 'some/other'], checkout);
  try {
    const r = claim(['bd-test5', 'fix/from-branch', '--no-install']);
    assert.equal(r.status, 0, `claim.sh failed off main:\n${r.stdout}\n${r.stderr}`);
    // The invoking checkout's HEAD is untouched, and no `git pull origin main` ran against
    // the feature branch (a pull here would merge main into it as a side effect).
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'some/other');
    assert.ok(!/Pulling latest main/.test(r.stdout), 'must not pull main into a feature branch');
    assert.ok(fs.existsSync(path.join(tmp, 'checkout-from-branch')));
  } finally {
    git(['checkout', 'main'], checkout);
  }
});

test('--in-place still refuses to run off main, the one mode that branches this checkout', { skip: SKIP }, () => {
  // Bails before the dolt sync step, so (unlike the claim() cases) this runs on Windows.
  git(['checkout', '-b', 'some/other2'], checkout);
  try {
    const r = claim(['bd-test6', 'fix/in-place-off-main', '--in-place']);
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /--in-place branches THIS checkout/);
    assert.equal(git(['symbolic-ref', '--short', 'HEAD'], checkout), 'some/other2');
  } finally {
    git(['checkout', 'main'], checkout);
  }
});

/**
 * A `bd` whose `show` prints `issueJson` and whose every call is logged, so both halves of the
 * fresh-claim refusal are observable: what the script said, and that it never reached `update`.
 * The `.cmd` sibling is the one the Node-side sync spawns on Windows (it only needs to succeed).
 */
function showBin(tag, issueJson) {
  const dir = path.join(tmp, `bin-${tag}`);
  const log = path.join(dir, 'bd-calls.log');
  fs.mkdirSync(dir);
  const bashLog = log.replace(/\\/g, '/');
  fs.writeFileSync(
    path.join(dir, 'bd'),
    `#!/usr/bin/env bash\necho "$*" >> "${bashLog}"\nif [ "$1" = "show" ]; then\ncat <<'JSON'\n${issueJson}\nJSON\nfi\nexit 0\n`,
    { mode: 0o755 },
  );
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(dir, 'bd.cmd'), `@echo off\r\n>>"${log}" echo %*\r\nexit /b 0\r\n`);
  }
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split(/\r?\n/) : []);
  return { dir, calls };
}

const heldBy = (id, assignee, hoursAgo, status = 'in_progress') =>
  JSON.stringify([{ id, assignee, status, started_at: new Date(Date.now() - hoursAgo * 3_600_000).toISOString() }]);

test('refuses another actor\'s claim under 4h old: nothing is claimed or published', { skip: SKIP }, () => {
  const bin = showBin('fresh', heldBy('bd-fresh', 'other-bot-bbbbbbbb', 1));
  const r = claim(['bd-fresh', '--claim-only'], {}, bin.dir);
  assert.equal(r.status, 1, `expected a refusal:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /refusing to claim bd-fresh: it is held by "other-bot-bbbbbbbb", claimed 1 hour ago/);
  assert.match(r.stderr, /AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 bash scripts\/claim\.sh bd-fresh/);
  const calls = bin.calls();
  assert.ok(calls.some((c) => c.startsWith('show bd-fresh')), `the lookup must have run:\n${calls.join('\n')}`);
  assert.ok(!calls.some((c) => c.startsWith('update')), `nothing may be claimed or cleared:\n${calls.join('\n')}`);
  assert.ok(!calls.includes('dolt push'), 'nothing may be published');
});

test('AGENT_TOOLING_ALLOW_CLAIM_STEAL=1 takes over a fresh claim deliberately', { skip: SKIP }, () => {
  const bin = showBin('steal', heldBy('bd-steal', 'other-bot-bbbbbbbb', 1));
  const r = claim(['bd-steal', '--claim-only'], { AGENT_TOOLING_ALLOW_CLAIM_STEAL: '1' }, bin.dir);
  assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
  assert.ok(bin.calls().includes('update bd-steal --claim'), `the claim must have been made:\n${bin.calls().join('\n')}`);
});

test('a claim older than the window is reclaimable, and AGENT_TOOLING_CLAIM_COLLISION_HOURS moves the window', { skip: SKIP }, () => {
  const old = showBin('stale-claim', heldBy('bd-old', 'other-bot-bbbbbbbb', 5));
  const r = claim(['bd-old', '--claim-only'], {}, old.dir);
  assert.equal(r.status, 0, `a 5h-old claim must not be refused:\n${r.stdout}\n${r.stderr}`);

  const mid = showBin('narrow-window', heldBy('bd-mid', 'other-bot-bbbbbbbb', 1));
  const narrow = claim(['bd-mid', '--claim-only'], { AGENT_TOOLING_CLAIM_COLLISION_HOURS: '0.5' }, mid.dir);
  assert.equal(narrow.status, 0, `a 1h-old claim is outside a 0.5h window:\n${narrow.stdout}\n${narrow.stderr}`);
});

test('your own claim and a parked bead are never refused', { skip: SKIP }, () => {
  const mine = showBin('mine', heldBy('bd-mine', 'claim-test-bot-0000feed', 1));
  assert.equal(claim(['bd-mine', '--claim-only'], {}, mine.dir).status, 0);
  const parked = showBin('parked', heldBy('bd-parked', 'other-bot-bbbbbbbb', 1, 'open'));
  const r = claim(['bd-parked', '--claim-only'], {}, parked.dir);
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.ok(parked.calls().includes('update bd-parked -a '), `a stale attribution on an open bead is cleared first:\n${parked.calls().join('\n')}`);
});

test('worktreeNamePattern from agent-tooling.json names the worktree, and the repo name is the primary checkout\'s', { skip: SKIP }, () => {
  const cfg = path.join(checkout, 'agent-tooling.json');
  fs.writeFileSync(cfg, JSON.stringify({ worktreeNamePattern: 'wt-<repo>-<slug>' }));
  try {
    const r = claim(['bd-cfg', 'feat/cfg-name', '--no-install']);
    assert.equal(r.status, 0, `claim.sh failed:\n${r.stdout}\n${r.stderr}`);
    assert.ok(fs.existsSync(path.join(tmp, 'wt-checkout-cfg-name')), `expected the configured name:\n${r.stdout}`);
  } finally {
    fs.rmSync(cfg, { force: true });
  }
});

test('a script from another set that is not vendored is named, with its set, before anything is synced', { skip: SKIP }, () => {
  // A checkout that has claim.sh and its libs but neither the verified sync (beads set) nor the
  // actor id (base): the failure must name the file and the set, and must not touch bd.
  const lonely = path.join(tmp, 'lonely');
  fs.mkdirSync(path.join(lonely, 'scripts', 'lib'), { recursive: true });
  for (const f of ['claim.sh', 'claim-age.mjs', 'agent-actor-id.mjs', 'agent-tooling-config.mjs']) {
    fs.copyFileSync(path.join(SCRIPTS_DIR, f), path.join(lonely, 'scripts', f));
  }
  for (const f of CLAIM_LIBS) fs.copyFileSync(path.join(SCRIPTS_DIR, 'lib', f), path.join(lonely, 'scripts', 'lib', f));
  const { dir, log } = recordingBin('lonely');
  const r = spawnSync('bash', ['scripts/claim.sh', 'bd-lonely', '--claim-only'], {
    cwd: lonely, encoding: 'utf8', env: { ...stubbedEnv(dir), BEADS_ACTOR: 'claim-test-bot-0000feed' },
  });
  assert.equal(r.status, 1, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /bd-dolt-sync\.mjs is not vendored here/);
  assert.match(r.stderr, /the beads set/);
  assert.match(r.stderr, /--set asks,beads,worktree/);
  assert.ok(!fs.existsSync(log), 'bd must never run');
});

test('a crashed claim-age helper does not block the claim, but warns that it went unverified', { skip: SKIP }, () => {
  const helper = path.join(checkout, 'scripts', 'claim-age.mjs');
  const original = fs.readFileSync(helper);
  fs.writeFileSync(helper, 'process.exitCode = 2;\n');
  try {
    const bin = showBin('crashed-helper', heldBy('bd-crash', 'other-bot-bbbbbbbb', 1));
    const r = claim(['bd-crash', '--claim-only'], {}, bin.dir);
    assert.equal(r.status, 0, `a broken helper must not block the claim:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.stderr, /fresh-claim check could not run \(claim-age\.mjs exited 2\)/);
    assert.match(r.stderr, /UNVERIFIED/);
    assert.ok(bin.calls().includes('update bd-crash --claim'), 'the claim still goes ahead');
  } finally {
    fs.writeFileSync(helper, original);
  }
});
