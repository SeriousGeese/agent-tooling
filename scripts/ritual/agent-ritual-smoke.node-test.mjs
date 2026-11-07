#!/usr/bin/env node
// Agent-ritual conformance smoke.
//
// One fast, HERMETIC end-to-end walk of the agent ritual, the way an agent does it:
// claim -> worktree -> gates -> teardown, plus the stale-hooks warning. Every individual
// guard already has a unit test; nothing else exercises the loop END TO END, so ritual
// regressions are otherwise discovered by a human session hitting them rather than by CI.
// This is that CI.
//
// Neutral and config-driven. Consumer values come from the consumer's agent-tooling.json
// (beadPrefix, worktreeNamePattern, claimHelper, envPrefix) through the one loader, and from
// the AGENT_TOOLING_* knobs that sync rewrites to the consumer's prefix. A step that needs a
// script from a set this repository did not install is SKIPPED, with the missing file named
// in the skip reason, never imported: a set is closed over base and itself.
//
//   step 1, 1b, 1c, 2a  claim.sh, worktree-new.sh, claim-age.mjs, bd-dolt-sync.mjs
//   step 2a (logic)     claim-age.mjs
//   step 2b, 3, 3b      the block-bare-claim and block-masked-gates hooks
//   step 3c, 3d, 3e     .claude/settings.json plus the guards it must register
//   step 4              the block-worktree-branch-switch hook
//   step 6              worktree-rm.sh
//   step 7              the check-stale-hooks hook
//
// Steps that only one consumer can run (a script that exists in no shared set) belong in a
// consumer-owned overlay test beside this file that imports ./ritual-support.mjs; the
// numbering skips 5 for that reason. See "The ritual set" in the README.
//
// Hermeticity: every step runs against a throwaway git repo with a bare "origin" and a
// throwaway JSON beads "database" (fixtures/bd-stub.cjs on a temp PATH dir). bd's real sync
// path (bd-dolt-sync.mjs -> `bd dolt pull|push`) is neutralised by the stub returning exit 0.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { DISTINCT_ACTOR_RE, resolveActorId } from '../agent-actor-id.mjs';
import { removeTempDir } from '../test-support/cleanup.mjs';
import {
  GIT_ENV,
  REPO,
  SETTINGS_FILE,
  SKIP_BASH,
  beadId,
  cleanup,
  consumer,
  escapeRe,
  firstReason,
  git,
  hasFile,
  hatch,
  loadOptional,
  makeBinDir,
  mkRoot,
  readJsonOptional,
  real,
  repoFixture,
  runHook,
  scriptsDir,
  skipUnlessPresent,
  spawnDiag,
  withBin,
  worktreeName,
} from './ritual-support.mjs';

// Optional modules from other sets (dynamic, so they never become closure edges).
const claimAge = await loadOptional('scripts/claim-age.mjs');
const bareClaim = await loadOptional('scripts/hooks/block-bare-claim.mjs');
const maskedGates = await loadOptional('scripts/hooks/block-masked-gates.mjs');
const settings = readJsonOptional(SETTINGS_FILE);

// claim.sh and everything it runs through.
const CLAIM_FILES = [
  'scripts/claim.sh',
  'scripts/worktree-new.sh',
  'scripts/claim-age.mjs',
  'scripts/bd-dolt-sync.mjs',
];
const SKIP_CLAIM = firstReason(SKIP_BASH, skipUnlessPresent(...CLAIM_FILES));
const CLAIM_HELPER_RE = escapeRe(consumer.claimHelper);

// ── Step 1 — claim.sh ───────────────────────────────────────────────────────
test(
  'step 1 — claim.sh claims under the session actor id, leaves the checkout on main, and creates a published dedicated worktree',
  { skip: SKIP_CLAIM },
  () => {
    const f = repoFixture('claim', { userName: 'Ritual Tester', withConfig: true });
    try {
      const binDir = makeBinDir(f.root);
      const dbPath = path.join(f.root, 'beads.json');
      const id = beadId('ritual1');
      writeFileSync(
        dbPath,
        JSON.stringify({ [id]: { id, title: 'ritual', status: 'open', assignee: null, started_at: null } }),
      );

      const FIXTURE_SID = 'ritualsmoke0000feed';
      const branch = 'feat/ritual-smoke-claim';
      const expected = resolveActorId({
        env: { CLAUDE_CODE_SESSION_ID: FIXTURE_SID },
        gitUserName: () => 'Ritual Tester',
      });

      const env = withBin(binDir, {
        CLAUDE_CODE_SESSION_ID: FIXTURE_SID,
        RITUAL_BD_DB: dbPath,
        BEADS_ACTOR: '', // force claim.sh to DERIVE the per-session id
        // ...and derive it from the FIXTURE's git identity. resolveActorId reads
        // BEADS_ACTOR_BASE ahead of git user.name, so an inherited one (a repo's own tooling may
        // set it per session) would silently decide the answer and make the "hermetic" smoke
        // fail on any machine that has it exported.
        BEADS_ACTOR_BASE: '',
        ...GIT_ENV,
      });
      const r = spawnSync('bash', [path.join(scriptsDir, 'claim.sh'), id, branch, '--no-install'], {
        cwd: f.work,
        encoding: 'utf8',
        env,
      });
      assert.equal(r.status, 0, `claim.sh failed:\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

      // (a) the assignee is the session-SUFFIXED id, not a bare team name
      const db = JSON.parse(readFileSync(dbPath, 'utf8'));
      assert.equal(db[id].assignee, expected.id, 'assignee is the derived per-session id');
      assert.match(db[id].assignee, DISTINCT_ACTOR_RE, 'assignee carries the session suffix');

      // (b) the invoking checkout is still on main (claim.sh must not switch it)
      assert.equal(git(f.work, 'symbolic-ref', '--short', 'HEAD'), 'main');

      // (c) a dedicated worktree exists at the path the consumer's worktreeNamePattern gives
      const dest = path.join(f.root, worktreeName('ritual-smoke-claim'));
      assert.ok(existsSync(dest), `worktree dir ${dest} exists`);
      assert.equal(real(git(dest, 'rev-parse', '--show-toplevel')), real(dest));

      // (d) the branch is published to the fixture remote
      assert.match(git(f.work, 'ls-remote', '--heads', 'origin', branch), new RegExp(branch));
    } finally {
      cleanup(f.root);
    }
  },
);

test(
  'step 1b — claim.sh works from INSIDE a linked worktree: claims, leaves that worktree’s HEAD alone, creates the new worktree',
  { skip: SKIP_CLAIM },
  () => {
    // The worktree-creating path must not require being on main: a session already living in
    // a worktree picking up another bead is the documented flow. Only --in-place still needs main.
    const f = repoFixture('claim-nested', { userName: 'Ritual Tester', withConfig: true });
    try {
      const binDir = makeBinDir(f.root);
      const dbPath = path.join(f.root, 'beads.json');
      const id = beadId('ritual1b');
      writeFileSync(
        dbPath,
        JSON.stringify({ [id]: { id, title: 'ritual', status: 'open', assignee: null, started_at: null } }),
      );

      // Put the invoking session where a real one lives: a linked worktree on its own branch.
      const home = path.join(f.root, worktreeName('ritual-home'));
      git(f.work, 'worktree', 'add', '-q', home, '-b', 'claude/ritual-home');

      const env = withBin(binDir, {
        CLAUDE_CODE_SESSION_ID: 'ritualsmoke0000feed',
        RITUAL_BD_DB: dbPath,
        BEADS_ACTOR: '',
        BEADS_ACTOR_BASE: '',
        ...GIT_ENV,
      });
      const branch = 'feat/ritual-smoke-nested';
      const r = spawnSync('bash', [path.join(scriptsDir, 'claim.sh'), id, branch, '--no-install'], {
        cwd: home,
        encoding: 'utf8',
        env,
      });
      assert.equal(r.status, 0, `claim.sh failed from a linked worktree:\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`);

      // (a) the bead is claimed
      const db = JSON.parse(readFileSync(dbPath, 'utf8'));
      assert.match(db[id].assignee ?? '', DISTINCT_ACTOR_RE, 'assignee carries the session suffix');

      // (b) the invoking worktree's HEAD is untouched
      assert.equal(git(home, 'symbolic-ref', '--short', 'HEAD'), 'claude/ritual-home');

      // (c) the new worktree exists as a sibling of the PRIMARY checkout, on its branch
      const dest = path.join(f.root, worktreeName('ritual-smoke-nested'));
      assert.ok(existsSync(dest), `worktree dir ${dest} exists`);
      assert.equal(git(dest, 'symbolic-ref', '--short', 'HEAD'), branch);

      // (d) --in-place is the one mode that still demands main
      const inPlace = spawnSync(
        'bash',
        [path.join(scriptsDir, 'claim.sh'), id, 'feat/ritual-smoke-inplace', '--in-place'],
        { cwd: home, encoding: 'utf8', env },
      );
      assert.notEqual(inPlace.status, 0, '--in-place off main must fail');
      assert.match(inPlace.stdout + inPlace.stderr, /--in-place branches THIS checkout/);
    } finally {
      cleanup(f.root);
    }
  },
);

test(
  'step 1c — claim.sh with NO session identity (a Codex/human shell) refuses before touching the bead, and a Codex thread id claims per-session',
  { skip: firstReason(SKIP_BASH, skipUnlessPresent('scripts/claim.sh')) },
  () => {
    // From Codex, claim.sh once printed "Claiming as: <person>" and published a shared name. A
    // PreToolUse hook is Claude-only, so the helper itself must refuse. The refusal happens
    // before any bd call, so this half needs only claim.sh.
    const f = repoFixture('claim-nosession', { userName: 'Ritual Tester', withConfig: true });
    try {
      const binDir = makeBinDir(f.root);
      const dbPath = path.join(f.root, 'beads.json');
      const id = beadId('ritual1c');
      const seed = { [id]: { id, title: 'ritual', status: 'open', assignee: null, started_at: null } };
      writeFileSync(dbPath, JSON.stringify(seed));

      const base = {
        RITUAL_BD_DB: dbPath,
        CLAUDE_CODE_SESSION_ID: '',
        CODEX_THREAD_ID: '',
        BEADS_ACTOR: '',
        BEADS_ACTOR_BASE: '',
        AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR: '',
        ...GIT_ENV,
      };
      const run = (extra) =>
        spawnSync('bash', [path.join(scriptsDir, 'claim.sh'), id, '--claim-only'], {
          cwd: f.work,
          encoding: 'utf8',
          env: withBin(binDir, { ...base, ...extra }),
        });

      const refused = run({});
      assert.equal(refused.status, 1, `expected a refusal:\n${refused.stdout}\n${refused.stderr}`);
      assert.match(refused.stderr, new RegExp(`refusing to claim ${escapeRe(id)} under a shared actor identity`));
      assert.deepEqual(JSON.parse(readFileSync(dbPath, 'utf8')), seed, 'the bead DB is untouched');

      if (SKIP_CLAIM) return; // the claiming half needs the rest of claim.sh's scripts
      const codex = run({ CODEX_THREAD_ID: '01a073bb-07f8-7bd1-a37f-5028daefdad1' });
      assert.equal(codex.status, 0, `claim.sh failed under Codex:\n${codex.stdout}\n${codex.stderr}`);
      assert.equal(JSON.parse(readFileSync(dbPath, 'utf8'))[id].assignee, 'ritual-tester-bot-daefdad1');
    } finally {
      cleanup(f.root);
    }
  },
);

// ── Step 2 — claim guards ────────────────────────────────────────────────────
// The fresh-claim check lives in claim.sh (claim-age.mjs); the PreToolUse hook only refuses a
// bare `bd update --claim` so agents go through claim.sh.
test('step 2a — claim.sh refuses a fresh actor stealing an in-progress claim, and the steal hatch takes it over (end to end)', { skip: SKIP_CLAIM }, () => {
  const f = repoFixture('collide', { userName: 'Ritual Tester', withConfig: true });
  try {
    const binDir = makeBinDir(f.root);
    const dbPath = path.join(f.root, 'beads.json');
    const id = beadId('ritual2');
    const minuteAgo = new Date(Date.now() - 60_000).toISOString();
    const seed = {
      [id]: { id, title: 'held', status: 'in_progress', assignee: 'other-bot-bbbbbbbb', started_at: minuteAgo },
    };
    writeFileSync(dbPath, JSON.stringify(seed));
    const run = (extra = {}) =>
      spawnSync('bash', [path.join(scriptsDir, 'claim.sh'), id, '--claim-only'], {
        cwd: f.work,
        encoding: 'utf8',
        env: withBin(binDir, {
          CLAUDE_CODE_SESSION_ID: 'aaaaaaaa11', // a DIFFERENT, session-distinct actor
          BEADS_ACTOR: '',
          BEADS_ACTOR_BASE: '',
          AGENT_TOOLING_ALLOW_CLAIM_STEAL: '',
          AGENT_TOOLING_ALLOW_SHARED_CLAIM_ACTOR: '',
          AGENT_TOOLING_CLAIM_COLLISION_HOURS: '',
          RITUAL_BD_DB: dbPath,
          ...GIT_ENV,
          ...extra,
        }),
      });

    const refused = run();
    assert.equal(refused.status, 1, `expected a refusal:\n${refused.stdout}\n${refused.stderr}`);
    assert.match(refused.stderr, /held by "other-bot-bbbbbbbb"/);
    assert.deepEqual(JSON.parse(readFileSync(dbPath, 'utf8')), seed, 'the bead DB is untouched');

    const stolen = run({ AGENT_TOOLING_ALLOW_CLAIM_STEAL: '1' });
    assert.equal(stolen.status, 0, `the steal hatch failed:\n${stolen.stdout}\n${stolen.stderr}`);
    assert.match(JSON.parse(readFileSync(dbPath, 'utf8'))[id].assignee, /^ritual-tester-bot-/);
  } finally {
    cleanup(f.root);
  }
});

test('step 2a (logic) — decide() blocks a fresh cross-actor steal but not a stale one or your own claim', { skip: claimAge ? false : skipUnlessPresent('scripts/claim-age.mjs') }, () => {
  const { decide } = claimAge;
  const now = Date.parse('2026-08-23T12:00:00Z');
  const fresh = { assignee: 'other-bot-bbbbbbbb', status: 'in_progress', started_at: new Date(now - 60_000).toISOString() };
  const stale = { assignee: 'other-bot-bbbbbbbb', status: 'in_progress', started_at: new Date(now - 5 * 3_600_000).toISOString() };
  const mine = { assignee: 'claimant-bot-aaaaaaaa', status: 'in_progress', started_at: new Date(now - 60_000).toISOString() };
  const open = { assignee: '', status: 'open', started_at: null };
  const base = { me: 'claimant-bot-aaaaaaaa', meBase: 'claimant', windowHours: 4, now };

  assert.equal(decide({ issue: fresh, ...base }).blocked, true, 'fresh cross-actor steal is blocked');
  assert.equal(decide({ issue: stale, ...base }).blocked, false, 'a claim older than the window is reclaimable');
  assert.equal(decide({ issue: mine, ...base }).blocked, false, '--claim is idempotent for your own claim');
  assert.equal(decide({ issue: open, ...base }).blocked, false, 'an unclaimed bead is free');
});

test('step 2b — block-bare-claim refuses a bare `bd update --claim` and names the claim helper', { skip: skipUnlessPresent('scripts/hooks/block-bare-claim.mjs') }, () => {
  const env = { ...process.env, [hatch('ALLOW_BARE_CLAIM')]: '' };
  const r = runHook('block-bare-claim.mjs', `bd update ${beadId('ritual3')} --claim`, { env });
  assert.equal(r.status, 2, `expected a refusal; got ${r.status}\n${r.stderr}`);
  assert.match(r.stderr, new RegExp(`${CLAIM_HELPER_RE} <id> --claim-only`));
  assert.equal(runHook('block-bare-claim.mjs', `bash ${consumer.claimHelper} ${beadId('x')} feat/y`, { env }).status, 0);
});

test('step 2b (logic) — the claim helper and prose about a claim are not bare claims', { skip: bareClaim ? false : skipUnlessPresent('scripts/hooks/block-bare-claim.mjs') }, () => {
  const { bareClaimSegment } = bareClaim;
  assert.equal(bareClaimSegment(`bash ${consumer.claimHelper} ${beadId('x')} --claim-only`), null);
  assert.equal(bareClaimSegment(`git commit -m "bd update ${beadId('x')} --claim is refused"`), null);
  assert.notEqual(bareClaimSegment(`cd /x && timeout 90 bd update ${beadId('ritual4')} --claim`), null);
  assert.equal(bareClaimSegment('echo not a claim'), null);
});

// ── Step 3 — masked-gates hook ───────────────────────────────────────────────
const SKIP_MASKED = skipUnlessPresent('scripts/hooks/block-masked-gates.mjs');

test('step 3 — block-masked-gates: a gate piped to a filter is blocked; bare / pipefail-peek / quoted-gate-word pass', { skip: SKIP_MASKED }, () => {
  const blocked = runHook('block-masked-gates.mjs', 'npm test | tail -5');
  assert.equal(blocked.status, 2, 'a gate piped into tail is blocked');
  assert.match(blocked.stderr, /masks its exit code/);

  assert.equal(runHook('block-masked-gates.mjs', 'npm test').status, 0, 'the same gate bare passes');
  assert.equal(
    runHook('block-masked-gates.mjs', 'set -o pipefail; npm test 2>&1 | tail -5').status,
    0,
    'the pipefail peek escape hatch passes',
  );
  assert.equal(
    runHook('block-masked-gates.mjs', `bd update ${beadId('x')} --notes "remember to run npm run lint" | tail -1`).status,
    0,
    'a gate word inside a quoted argument is not a gate',
  );

  // The exported predicate must agree with the hook's exit behaviour.
  assert.equal(maskedGates.isMaskedGate('npm test | tail -5'), true);
  assert.equal(maskedGates.isMaskedGate('npm test'), false);
  assert.equal(maskedGates.isMaskedGate('set -o pipefail; npm test | tail -5'), false);
});

test('step 3b — block-masked-gates covers the PowerShell tool too, with its own hatch', { skip: SKIP_MASKED }, () => {
  // The hook is registered under `Bash|PowerShell` and branches on tool_name. PowerShell has no
  // pipefail (a pipeline ending in a cmdlet reports the CMDLET's success), so the hatch there
  // is an explicit $LASTEXITCODE read.
  const blocked = runHook('block-masked-gates.mjs', 'npx jest | Select-Object -Last 5', {
    toolName: 'PowerShell',
  });
  assert.equal(blocked.status, 2, 'a gate piped into a PS cmdlet is blocked');
  assert.match(blocked.stderr, /\$LASTEXITCODE/);

  assert.equal(
    runHook('block-masked-gates.mjs', 'npx jest 2>&1 | Select-Object -Last 5; "EXIT:$LASTEXITCODE"', {
      toolName: 'PowerShell',
    }).status,
    0,
    'the $LASTEXITCODE peek escape hatch passes',
  );

  // Bash blocks every downstream pipeline stage because its exit code can mask the gate, but it
  // keeps Bash-specific advice rather than PowerShell guidance.
  const bashBlocked = runHook('block-masked-gates.mjs', 'npx jest | Select-Object -Last 5', { toolName: 'Bash' });
  assert.equal(bashBlocked.status, 2, 'a gate piped into any Bash command is blocked');
  assert.match(bashBlocked.stderr, /no pipefail by default/);
  assert.doesNotMatch(bashBlocked.stderr, /\$LASTEXITCODE/);

  assert.equal(maskedGates.isMaskedGatePowerShell('npx jest | Select-Object -Last 5'), true);
  assert.equal(maskedGates.isMaskedGatePowerShell('npx jest'), false);
  assert.equal(maskedGates.isMaskedGatePowerShell('npx jest | select -Last 5; "$LASTEXITCODE"'), false);
});

/** The tools a hook file is registered under in .claude/settings.json, across every PreToolUse group naming it. */
function registeredTools(guard) {
  const matchers = (settings.hooks?.PreToolUse ?? [])
    .filter((g) => (g.hooks ?? []).some((h) => String(h.command).includes(guard)))
    .map((g) => g.matcher ?? '');
  return new Set(matchers.flatMap((m) => m.split('|')));
}

test('step 3c — settings.json really registers each cross-shell guard for BOTH tools', { skip: firstReason(skipUnlessPresent(SETTINGS_FILE)) }, (t) => {
  // The predicate can be perfect and the guard still absent: a hook only runs for the tools its
  // matcher names. Every guard whose hazard exists in both shells is listed here, so a future
  // registration under a Bash-only group fails HERE rather than on the day the PowerShell tool
  // runs the incident command. Guards absent from this checkout are not asserted on (they are
  // not installed); a guard that IS installed must be registered. Bash-only guards (the `\\`
  // collapse, heredoc size) are deliberately absent: their hazard is the Bash tool's handoff.
  const guards = [
    'block-masked-gates.mjs',
    'block-uncommitted-restore.mjs',
    'block-npx-unlisted.mjs',
    'block-break-glass.mjs',
    'block-pattern-kill.mjs',
  ].filter((g) => hasFile(`scripts/hooks/${g}`));
  if (guards.length === 0) {
    t.skip('none of the cross-shell guards is installed under scripts/hooks');
    return;
  }
  for (const guard of guards) {
    const tools = registeredTools(guard);
    assert.ok(tools.size > 0, `${guard} is registered at all`);
    assert.ok(tools.has('Bash'), `${guard}: expected a Bash matcher; got ${[...tools].join(',')}`);
    assert.ok(tools.has('PowerShell'), `${guard}: expected a PowerShell matcher; got ${[...tools].join(',')}`);
  }
});

test('step 3d — block-break-glass keeps break-glass human-only, for every tool that can reach it', { skip: skipUnlessPresent(SETTINGS_FILE, 'scripts/hooks/block-break-glass.mjs') }, () => {
  // The `break-glass` label, BREAK_GLASS* variables and `gh pr merge --admin` are human-only.
  // The guard has NO hatch on purpose, so this proves an inline one does not work, and that the
  // Monitor and MCP registrations exist alongside Bash and PowerShell (3c covers those two).
  const tools = registeredTools('block-break-glass.mjs');
  assert.ok(tools.has('Monitor'), `expected a Monitor matcher; got ${[...tools].join(',')}`);
  assert.ok(tools.has('mcp__.*'), `expected an mcp__.* matcher; got ${[...tools].join(',')}`);

  const blocked = runHook('block-break-glass.mjs', 'gh pr edit 5 --add-label break-glass');
  assert.equal(blocked.status, 2, 'adding the label is blocked');
  assert.match(blocked.stderr, /HUMAN-ONLY/);
  assert.equal(runHook('block-break-glass.mjs', `${hatch('ALLOW_BREAK_GLASS')}=1 gh pr merge 5 --admin`).status, 2, 'no hatch');
  assert.equal(runHook('block-break-glass.mjs', 'gh pr edit 5 --remove-label break-glass').status, 0, 'removal passes');
  assert.equal(runHook('block-break-glass.mjs', 'gh pr merge 5 --squash --match-head-commit abc').status, 0, 'plain merge');
});

test(
  'step 3e — every repo hook resolves the repo root, so a session in a subdirectory stays guarded',
  { skip: firstReason(SKIP_BASH, skipUnlessPresent(SETTINGS_FILE, 'scripts/hooks/block-break-glass.mjs', 'scripts/hooks/block-orphaned-worktree-cwd.mjs')) },
  () => {
    // A bare `node scripts/hooks/x.mjs` resolves against the cwd, so from any subdirectory the guard
    // dies with `Cannot find module`, which the harness treats as non-blocking and runs the tool
    // call anyway. Each registration therefore resolves the checkout root first.
    const commands = Object.values(settings.hooks).flatMap((groups) => groups.flatMap((g) => g.hooks.map((h) => String(h.command))));
    const repoCommands = commands.filter((c) => c.includes('scripts/'));
    assert.ok(repoCommands.length > 0, 'found the repo hooks');
    for (const command of repoCommands) {
      assert.doesNotMatch(command, /(?:\b(?:node|bash) |')scripts\//, `resolves against the cwd: ${command}`);
    }

    const guard = commands.find((c) => c.includes('block-break-glass.mjs'));
    assert.ok(guard, 'block-break-glass.mjs is registered');
    const run = spawnSync('bash', ['-c', guard], {
      cwd: path.join(REPO, 'scripts', 'lib'),
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --admin' } }),
      encoding: 'utf8',
    });
    assert.equal(run.status, 2, `the guard ran from a subdirectory and refused: ${spawnDiag(run)}`);
    assert.match(run.stderr, /HUMAN-ONLY/);

    const orphan = commands.find((c) => c.includes('block-orphaned-worktree-cwd.mjs'));
    assert.ok(orphan, 'block-orphaned-worktree-cwd.mjs is registered');
    const live = spawnSync('bash', ['-c', orphan], {
      cwd: path.join(REPO, 'scripts', 'lib'),
      input: JSON.stringify({ tool_name: 'Bash', cwd: path.join(REPO, 'scripts', 'lib'), tool_input: { command: 'git status' } }),
      encoding: 'utf8',
    });
    assert.equal(live.status, 0, `a live subdirectory is not an orphaned worktree: ${spawnDiag(live)}`);

    // git failing outright must not turn the path into /scripts/... and so fail open: the old
    // relative path worked from the root, and still has to.
    const noGit = spawnSync('bash', ['-c', guard], {
      cwd: REPO,
      env: { ...process.env, GIT_DIR: path.join(REPO, 'no-such-git-dir') },
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'gh pr merge 5 --admin' } }),
      encoding: 'utf8',
    });
    assert.equal(noGit.status, 2, `the guard ran from the root with git failing: ${noGit.stderr}`);

    // An emptied worktree: git walks up to the checkout that holds it, whose guard must still refuse.
    const emptied = path.join(REPO, '.claude', 'worktrees', `ritual-emptied-${process.pid}`);
    mkdirSync(emptied, { recursive: true });
    try {
      const blocked = spawnSync('bash', ['-c', orphan], {
        cwd: emptied,
        input: JSON.stringify({ tool_name: 'Bash', cwd: emptied, tool_input: { command: 'git status' } }),
        encoding: 'utf8',
        env: { ...process.env, [hatch('ALLOW_ORPHANED_WORKTREE_CWD')]: '' },
      });
      assert.equal(blocked.status, 2, `an emptied worktree is refused: ${blocked.stderr}`);
    } finally {
      removeTempDir(emptied, 'agent-ritual-smoke.node-test');
    }
  },
);

// ── Step 4 — worktree branch-switch hook ─────────────────────────────────────
test('step 4 — block-worktree-branch-switch blocks `checkout -b` inside a worktree, allows it in the primary', { skip: skipUnlessPresent('scripts/hooks/block-worktree-branch-switch.mjs') }, () => {
  const root = mkRoot('wtsw');
  try {
    const primary = path.join(root, 'primary');
    const worktree = path.join(root, 'worktree');
    mkdirSync(path.join(primary, '.git'), { recursive: true }); // .git DIR -> primary
    mkdirSync(worktree, { recursive: true });
    writeFileSync(path.join(worktree, '.git'), 'gitdir: ../primary/.git/worktrees/worktree\n'); // .git FILE -> linked worktree

    const hook = 'block-worktree-branch-switch.mjs';
    const key = hatch('ALLOW_WORKTREE_BRANCH_SWITCH');
    const cleanEnv = { ...process.env, [key]: '' };
    const blocked = runHook(hook, 'git checkout -b feat/foo', { cwd: worktree, env: cleanEnv });
    assert.equal(blocked.status, 2, 'checkout -b inside a worktree is blocked');
    assert.match(blocked.stderr, /worktree's branch in place/);

    assert.equal(
      runHook(hook, 'git checkout -b feat/foo', { cwd: primary, env: cleanEnv }).status,
      0,
      'checkout -b in the primary checkout is allowed',
    );
    assert.equal(
      runHook(hook, 'git checkout -b feat/foo', { cwd: worktree, env: { ...process.env, [key]: '1' } }).status,
      0,
      'the escape hatch allows it',
    );
  } finally {
    cleanup(root);
  }
});

// ── Step 5 — consumer overlay ────────────────────────────────────────────────
// Reserved. A merge-time script that exists in no shared set (for example one that closes
// beads from a merged PR's body) is exercised by a consumer-owned overlay test that imports
// ./ritual-support.mjs and the stubs in ./fixtures. See the README.

// ── Step 6 — worktree-rm.sh teardown ─────────────────────────────────────────
test('step 6 — worktree-rm removes the target from the primary, spares siblings, and refuses to remove its own cwd', { skip: firstReason(SKIP_BASH, skipUnlessPresent('scripts/worktree-rm.sh')) }, () => {
  const f = repoFixture('teardown');
  try {
    const wtA = path.join(f.root, 'wt-a');
    const wtB = path.join(f.root, 'wt-b');
    git(f.work, 'worktree', 'add', '-q', wtA, '-b', 'feat/a');
    git(f.work, 'worktree', 'add', '-q', wtB, '-b', 'feat/b');
    const script = path.join(scriptsDir, 'worktree-rm.sh');
    const env = { ...process.env, ...GIT_ENV, WORKTREE_RM_SKIP_GH: '1' };

    // (a) refuses to remove the worktree it is running FROM
    const selfRm = spawnSync('bash', [script, wtA], { cwd: wtA, encoding: 'utf8', env });
    assert.equal(selfRm.status, 1, 'self-removal is refused');
    assert.match(selfRm.stderr, /running from INSIDE it/);
    assert.ok(existsSync(wtA), 'the target survives a refusal');

    // (b) from the primary, the target goes and every sibling survives
    const rm = spawnSync('bash', [script, wtA], { cwd: f.work, encoding: 'utf8', env });
    assert.equal(rm.status, 0, `worktree-rm failed:\n${rm.stdout}\n${rm.stderr}`);
    assert.ok(!existsSync(wtA), 'the target is gone');
    assert.ok(existsSync(wtB), 'the sibling survives');
  } finally {
    cleanup(f.root);
  }
});

// ── Step 7 — stale-hooks SessionStart warning ────────────────────────────────
test('step 7 — check-stale-hooks warns when a watched hook file differs from origin/main, and is silent when current', { skip: firstReason(SKIP_BASH, skipUnlessPresent('scripts/hooks/check-stale-hooks.mjs')) }, () => {
  const f = repoFixture('stalehooks');
  try {
    const hook = path.join(scriptsDir, 'hooks', 'check-stale-hooks.mjs');
    const env = { ...process.env, ...GIT_ENV };

    // current: HEAD == origin/main -> silent
    git(f.work, 'fetch', '-q', 'origin');
    const quiet = spawnSync(process.execPath, [hook], { cwd: f.work, encoding: 'utf8', env });
    assert.equal(quiet.status, 0);
    assert.doesNotMatch(quiet.stdout, /hooks-stale/, 'a current worktree is silent');

    // stale: advance origin/main with a WATCHED-file change, rewind HEAD behind it
    mkdirSync(path.join(f.work, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(f.work, 'scripts', 'hooks', 'guard.mjs'), '// v2\n');
    git(f.work, 'add', '.');
    git(f.work, 'commit', '-q', '-m', 'update a watched hook');
    git(f.work, 'push', '-q', 'origin', 'main');
    git(f.work, 'reset', '--hard', '-q', 'HEAD~1');
    git(f.work, 'fetch', '-q', 'origin');

    const stale = spawnSync(process.execPath, [hook], { cwd: f.work, encoding: 'utf8', env });
    assert.equal(stale.status, 0, 'the hook always exits 0');
    assert.match(stale.stdout, /\[hooks-stale\]/, 'a stale worktree is warned');
    assert.match(stale.stdout, /scripts\/hooks\/guard\.mjs/, 'the changed watched file is named');
  } finally {
    cleanup(f.root);
  }
});
