// Tests for agent-tooling-sync.mjs. Every case builds a throwaway git repository shaped like
// agent-tooling and syncs from it with --from, so nothing here touches the network. This file
// is vendored too, so it locates the script relative to itself and never spells the neutral
// prefix as one literal (sync rewrites that literal on the way in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CONFIG_FILE,
  DEFAULT_SHA_FILE,
  NEUTRAL_PREFIX,
  check,
  cicdOwnedPaths,
  formatShaFile,
  isEnvPrefix,
  isPinnedRef,
  isSafePath,
  parseArgs,
  parseManifest,
  parseShaFile,
  selectFiles,
  sync,
  transform,
} from './agent-tooling-sync.mjs';

const SYNC = fileURLToPath(new URL('./agent-tooling-sync.mjs', import.meta.url));
const P = NEUTRAL_PREFIX;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' } }).trim();
}

function write(root, rel, body) {
  const abs = path.join(root, ...rel.split('/'));
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, body);
}

/** An agent-tooling-shaped repo with one commit; returns { root, sha }. */
function fakeSource(manifest, files) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-tooling-src-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.email', 't@example.com']);
  git(root, ['config', 'user.name', 'T']);
  git(root, ['config', 'core.autocrlf', 'false']);
  write(root, 'manifest.json', JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'tooling']);
  return { root, sha: git(root, ['rev-parse', 'HEAD']) };
}

function commit(root, manifest, files) {
  if (manifest) write(root, 'manifest.json', JSON.stringify(manifest));
  for (const [rel, body] of Object.entries(files)) write(root, rel, body);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'change']);
  return git(root, ['rev-parse', 'HEAD']);
}

const consumer = () => mkdtempSync(path.join(tmpdir(), 'agent-tooling-dst-'));
const clean = (...dirs) => dirs.forEach((d) => rmSync(d, { recursive: true, force: true }));
/** Removes a symlink or junction itself, never what it points at. */
function unlinkLink(p) {
  try {
    unlinkSync(p);
  } catch {
    rmdirSync(p);
  }
}

const SCRIPT = `if (process.env.${P}ALLOW_X === '1') process.exit(0);\n// set ${P}ALLOW_X=1\n`;
const MANIFEST = {
  base: ['scripts/base.mjs'],
  sets: {
    asks: ['scripts/ask.mjs', 'scripts/hooks/ask-inbox.mjs'],
    worktree: ['scripts/claim.sh'],
    skills: ['.agents/skills/x/SKILL.md'],
    empty: [],
  },
};
const FILES = {
  'scripts/base.mjs': 'base\n',
  'scripts/ask.mjs': SCRIPT,
  'scripts/hooks/ask-inbox.mjs': 'inbox\n',
  'scripts/claim.sh': 'claim\n',
  '.agents/skills/x/SKILL.md': '# x\n',
};

test('pure helpers', () => {
  assert.equal(isPinnedRef('a'.repeat(40)), true);
  for (const bad of ['main', 'v1', 'abc123', 'A'.repeat(40)]) assert.equal(isPinnedRef(bad), false, bad);
  assert.equal(isEnvPrefix('ACME_'), true);
  assert.equal(isEnvPrefix('acme_'), false);
  for (const ok of ['scripts/a.mjs', 'scripts/hooks/ask-inbox.mjs', '.agents/skills/x/SKILL.md', 'docs/agents/shared/a.md', 'templates/a.yml']) {
    assert.equal(isSafePath(ok), true, ok);
  }
  for (const bad of ['../x', '/abs/x', 'C:/x', 'scripts\\x.mjs', 'src/x.ts', 'scripts', 'scripts/../x', 'scripts/./x', '', 'scripts/x.', 'scripts/CON', 'scripts/nul.txt', 'docs/com1.md', 'scripts/LPT9']) {
    assert.equal(isSafePath(bad), false, JSON.stringify(bad));
  }
  assert.deepEqual(parseArgs(['--into', '.', '--check']), {
    into: '.',
    shaFile: DEFAULT_SHA_FILE,
    cicdShaFile: 'scripts/hooks/CICD-HOOKS-SHA',
    check: true,
  });
  assert.deepEqual(parseArgs(['--into', '.', '--set', 'asks, worktree']).sets, ['asks', 'worktree']);
  assert.deepEqual(parseArgs(['--into', '.', '--set', 'none']).sets, []);
  assert.throws(() => parseArgs(['--into', '.', '--set', 'none,asks']), /cannot be combined/);
  assert.equal(isSafePath('scripts/console.mjs'), true, 'a reserved name only as the whole stem');
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.throws(() => parseArgs(['--into']), /needs a value/);
});

test('transform normalises CRLF and rewrites only the neutral prefix', () => {
  assert.equal(transform(`a ${P}X\r\nb Z${P}Y\r\n`, 'ACME_'), `a ACME_X\nb Z${P}Y\n`);
});

test('the SHA file round-trips, including no sets', () => {
  const rec = { ref: 'b'.repeat(40), envPrefix: 'ACME_', sets: ['asks', 'worktree'], files: ['scripts/a.mjs'] };
  assert.deepEqual(parseShaFile(formatShaFile(rec)), rec);
  const none = { ...rec, sets: [] };
  assert.match(formatShaFile(none), /^sets: none$/m);
  assert.deepEqual(parseShaFile(formatShaFile(none)), none);
  assert.throws(() => parseShaFile('files:\n'), /missing its ref/);
  // A record is plain text: a ref that is not a pinned SHA is refused, never passed to git or a URL.
  assert.throws(() => parseShaFile(formatShaFile({ ...rec, ref: '--output=x' })), /not a full 40-hex/);
});

test('sync refuses an unpinned ref even when called as a library', async () => {
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: 'main', from: dst }), /full 40-hex/);
  } finally {
    clean(dst);
  }
});

test('a stale file is deleted only when the manifest at the recorded ref shipped it', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root });
    // A consumer's own file, written into the record by hand.
    write(dst, 'scripts/mine.mjs', 'consumer-owned\n');
    const shaPath = path.join(dst, DEFAULT_SHA_FILE);
    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace('files:\n', 'files:\n  scripts/mine.mjs\n'));
    await sync({ into: dst, ref: src.sha, from: src.root });
    assert.equal(readFileSync(path.join(dst, 'scripts/mine.mjs'), 'utf8'), 'consumer-owned\n');
  } finally {
    clean(src.root, dst);
  }
});

test('the one-owner rule ignores case, in sync and in --check', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    write(dst, 'scripts/hooks/CICD-HOOKS-SHA', 'ref: ' + 'c'.repeat(40) + '\nenv-prefix: ACME_\nfiles:\n  Ask-Inbox.mjs\n');
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root }), /refusing to write 1 path/);
    // A record written before CICD claimed the path: --check names the double ownership.
    rmSync(path.join(dst, 'scripts/hooks/CICD-HOOKS-SHA'));
    await sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root });
    write(dst, 'scripts/hooks/CICD-HOOKS-SHA', 'ref: ' + 'c'.repeat(40) + '\nenv-prefix: ACME_\nfiles:\n  ask-inbox.mjs\n');
    const problems = await check({ into: dst, from: src.root });
    assert.ok(problems.some((p) => /recorded by both/.test(p)), problems.join('\n'));
  } finally {
    clean(src.root, dst);
  }
});

test('a symlinked directory that leads outside --into is refused before anything is written', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  const elsewhere = consumer();
  try {
    symlinkSync(elsewhere, path.join(dst, 'scripts'), 'junction');
    await assert.rejects(sync({ into: dst, ref: src.sha, from: src.root }), /symlink in the path leads outside --into/);
    assert.deepEqual(readdirSync(elsewhere), [], 'nothing written through the link');
  } finally {
    unlinkLink(path.join(dst, 'scripts'));
    clean(src.root, dst, elsewhere);
  }
});

/** A file symlink, or null where the host refuses one (Windows without developer mode). */
function fileLink(target, at) {
  try {
    symlinkSync(target, at, 'file');
    return at;
  } catch (err) {
    if (/** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM') return null;
    throw err;
  }
}

test('a vendored target that is itself a symlinked file leading outside --into is refused, never written through', async (t) => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  const elsewhere = consumer();
  try {
    const victim = path.join(elsewhere, 'victim.txt');
    writeFileSync(victim, 'untouched\n');
    mkdirSync(path.join(dst, 'scripts'));
    if (!fileLink(victim, path.join(dst, 'scripts', 'base.mjs'))) {
      t.skip('this host cannot create a file symlink');
      return;
    }
    await assert.rejects(sync({ into: dst, ref: src.sha, from: src.root }), /symlink in the path leads outside --into/);
    assert.equal(readFileSync(victim, 'utf8'), 'untouched\n');
  } finally {
    clean(src.root, dst, elsewhere);
  }
});

test('a dangling symlink at a vendored target is refused, so a write cannot create its target', async (t) => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  const elsewhere = consumer();
  try {
    const nowhere = path.join(elsewhere, 'created-by-sync.txt');
    mkdirSync(path.join(dst, 'scripts'));
    if (!fileLink(nowhere, path.join(dst, 'scripts', 'base.mjs'))) {
      t.skip('this host cannot create a file symlink');
      return;
    }
    await assert.rejects(sync({ into: dst, ref: src.sha, from: src.root }), /resolves nowhere/);
    assert.deepEqual(readdirSync(elsewhere), []);
  } finally {
    clean(src.root, dst, elsewhere);
  }
});

test('a stale file reached through a symlinked directory outside --into is not deleted', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  const elsewhere = consumer();
  try {
    await sync({ into: dst, ref: src.sha, sets: ['skills'], from: src.root });
    // The skill dir is swapped for a link to an outside dir holding a same-named file.
    rmSync(path.join(dst, '.agents'), { recursive: true, force: true });
    write(elsewhere, 'skills/x/SKILL.md', 'outside\n');
    symlinkSync(elsewhere, path.join(dst, '.agents'), 'junction');
    await sync({ into: dst, ref: src.sha, sets: [], drop: true, from: src.root });
    assert.equal(readFileSync(path.join(elsewhere, 'skills/x/SKILL.md'), 'utf8'), 'outside\n');
  } finally {
    unlinkLink(path.join(dst, '.agents'));
    clean(src.root, dst, elsewhere);
  }
});

test('the record files are checked like any target: safe relative paths, no symlink escape', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  const elsewhere = consumer();
  try {
    for (const bad of ['../outside', '/abs/SHA', 'src/SHA', 'scripts\\SHA']) {
      await assert.rejects(sync({ into: dst, ref: src.sha, shaFile: bad, from: src.root }), /--sha-file must be/, bad);
      await assert.rejects(sync({ into: dst, ref: src.sha, cicdShaFile: bad, from: src.root }), /--cicd-sha-file must be/, bad);
      await assert.rejects(check({ into: dst, shaFile: bad, from: src.root }), /--sha-file must be/, bad);
    }
    // docs/ links outside: a record kept there is neither read nor written through the link.
    writeFileSync(path.join(elsewhere, 'SHA'), 'outside\n');
    symlinkSync(elsewhere, path.join(dst, 'docs'), 'junction');
    await assert.rejects(sync({ into: dst, ref: src.sha, shaFile: 'docs/SHA', from: src.root }), /symlink in the path leads outside --into/);
    await assert.rejects(sync({ into: dst, ref: src.sha, cicdShaFile: 'docs/SHA', from: src.root }), /symlink in the path leads outside --into/);
    assert.equal(readFileSync(path.join(elsewhere, 'SHA'), 'utf8'), 'outside\n');
  } finally {
    unlinkLink(path.join(dst, 'docs'));
    clean(src.root, dst, elsewhere);
  }
});

test('the CLI runs when reached through a symlinked or junctioned directory', () => {
  const dst = consumer();
  const link = path.join(consumer(), 'linked');
  try {
    symlinkSync(path.dirname(SYNC), link, 'junction');
    const r = spawnSync(process.execPath, [path.join(link, path.basename(SYNC)), '--into', dst, '--check'], { encoding: 'utf8' });
    assert.equal(r.status, 1, `--check through a link must run and fail on a missing record:\n${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /is missing/);
  } finally {
    unlinkLink(link);
    clean(dst, path.dirname(link));
  }
});

test('parseManifest and selectFiles', () => {
  const m = parseManifest(MANIFEST);
  assert.deepEqual(selectFiles(m, []), ['scripts/base.mjs']);
  assert.deepEqual(selectFiles(m, ['worktree', 'empty']), ['scripts/base.mjs', 'scripts/claim.sh']);
  assert.deepEqual(selectFiles(m, ['all']), Object.keys(FILES).sort());
  assert.throws(() => selectFiles(m, ['nope']), /unknown set "nope" \(known: asks, worktree, skills, empty, all\)/);
  assert.throws(() => parseManifest({ sets: {} }), /"base" must list/);
  assert.throws(() => parseManifest({ base: ['scripts/a'], sets: { all: [] } }), /reserved/);
  assert.throws(() => parseManifest({ base: ['scripts/a'], sets: { x: ['../escape'] } }), /unsafe path/);
  assert.throws(() => parseManifest({ base: ['src/a.ts'], sets: {} }), /unsafe path/);
});

test('sync writes base plus the named sets in place with the consumer prefix, and --check passes', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    const files = await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['asks'], from: src.root });
    assert.deepEqual(files, ['scripts/ask.mjs', 'scripts/base.mjs', 'scripts/hooks/ask-inbox.mjs']);
    const ask = readFileSync(path.join(dst, 'scripts/ask.mjs'), 'utf8');
    assert.match(ask, /ACME_ALLOW_X/);
    assert.equal(ask.includes(P), false);
    assert.equal(existsSync(path.join(dst, 'scripts/claim.sh')), false);
    const rec = parseShaFile(readFileSync(path.join(dst, DEFAULT_SHA_FILE), 'utf8'));
    assert.deepEqual(rec, { ref: src.sha, envPrefix: 'ACME_', sets: ['asks'], files });
    assert.deepEqual(await check({ into: dst, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('--check names an edited, a deleted and a CRLF-only file correctly, and a hand-edited record', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', sets: ['asks', 'worktree'], from: src.root });
    writeFileSync(path.join(dst, 'scripts/ask.mjs'), 'edited\n');
    rmSync(path.join(dst, 'scripts/claim.sh'));
    writeFileSync(path.join(dst, 'scripts/base.mjs'), 'base\r\n'); // autocrlf is not drift
    let problems = await check({ into: dst, from: src.root });
    assert.equal(problems.length, 2, problems.join('\n'));
    assert.match(problems[0], /scripts\/ask\.mjs: differs/);
    assert.match(problems[1], /scripts\/claim\.sh: missing/);

    const shaPath = path.join(dst, DEFAULT_SHA_FILE);
    writeFileSync(shaPath, readFileSync(shaPath, 'utf8').replace('sets: asks,worktree', 'sets: asks'));
    problems = await check({ into: dst, from: src.root });
    assert.ok(problems.some((p) => /file list does not match set\(s\) asks/.test(p)), problems.join('\n'));
  } finally {
    clean(src.root, dst);
  }
});

test('re-sync keeps the recorded sets; a dropped set or a de-listed file is deleted', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, sets: ['asks', 'worktree'], from: src.root });
    const again = await sync({ into: dst, ref: src.sha, from: src.root });
    assert.ok(again.includes('scripts/claim.sh'), 'recorded sets are sticky');

    // Narrowing the selection is refused, before writing, without --drop.
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root }), /would stop vendoring .*scripts\/claim\.sh.*--drop/);
    assert.equal(existsSync(path.join(dst, 'scripts/claim.sh')), true, 'nothing deleted by the refused sync');
    await sync({ into: dst, ref: src.sha, sets: ['asks'], drop: true, from: src.root });
    assert.equal(existsSync(path.join(dst, 'scripts/claim.sh')), false);

    const sha2 = commit(src.root, { ...MANIFEST, sets: { ...MANIFEST.sets, asks: ['scripts/ask.mjs'] } }, {});
    await sync({ into: dst, ref: sha2, from: src.root });
    assert.equal(existsSync(path.join(dst, 'scripts/hooks/ask-inbox.mjs')), false);
    assert.equal(existsSync(path.join(dst, 'scripts/ask.mjs')), true);
    assert.deepEqual(await check({ into: dst, from: src.root }), []);
  } finally {
    clean(src.root, dst);
  }
});

test('a stale file the consumer has changed or replaced is kept, even though the recorded ref shipped it', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, sets: ['asks', 'worktree'], from: src.root });
    // claim.sh is now the consumer's own (edited); the inbox hook is byte-for-byte vendored.
    write(dst, 'scripts/claim.sh', 'claim, the consumer version\n');
    await sync({ into: dst, ref: src.sha, sets: [], drop: true, from: src.root });
    assert.equal(readFileSync(path.join(dst, 'scripts/claim.sh'), 'utf8'), 'claim, the consumer version\n', 'an edited file is kept');
    assert.equal(existsSync(path.join(dst, 'scripts/hooks/ask-inbox.mjs')), false, 'an untouched vendored file is still deleted');
    // The prefix rewrite is part of what sync wrote: a file under the recorded prefix counts as unchanged.
    const src2 = fakeSource(MANIFEST, FILES);
    const dst2 = consumer();
    try {
      await sync({ into: dst2, ref: src2.sha, sets: ['asks'], envPrefix: 'ACME_', from: src2.root });
      assert.match(readFileSync(path.join(dst2, 'scripts/ask.mjs'), 'utf8'), /ACME_ALLOW_X/);
      await sync({ into: dst2, ref: src2.sha, sets: [], drop: true, from: src2.root });
      assert.equal(existsSync(path.join(dst2, 'scripts/ask.mjs')), false);
    } finally {
      clean(src2.root, dst2);
    }
  } finally {
    clean(src.root, dst);
  }
});

test('a path recorded in CICD-HOOKS-SHA is refused before anything is written', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    write(dst, 'scripts/hooks/CICD-HOOKS-SHA', 'ref: ' + 'c'.repeat(40) + '\nenv-prefix: ACME_\nfiles:\n  ask-inbox.mjs\n  sync.mjs\n');
    assert.deepEqual([...cicdOwnedPaths(dst, 'scripts/hooks/CICD-HOOKS-SHA')], ['scripts/hooks/ask-inbox.mjs', 'scripts/hooks/sync.mjs']);
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root }), /refusing to write 1 path\(s\).*scripts\/hooks\/ask-inbox\.mjs/);
    assert.equal(existsSync(path.join(dst, 'scripts/ask.mjs')), false, 'nothing written');
    assert.equal(existsSync(path.join(dst, DEFAULT_SHA_FILE)), false);
    // A set that does not touch a CICD path is fine.
    await sync({ into: dst, ref: src.sha, sets: ['worktree'], from: src.root });
    assert.equal(existsSync(path.join(dst, 'scripts/claim.sh')), true);
  } finally {
    clean(src.root, dst);
  }
});

test('an unknown set and an unsafe manifest path are refused before anything is written', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    await assert.rejects(sync({ into: dst, ref: src.sha, sets: ['nope'], from: src.root }), /unknown set "nope"/);
    const bad = commit(src.root, { base: ['scripts/base.mjs'], sets: { x: ['scripts/../../escape'] } }, {});
    await assert.rejects(sync({ into: dst, ref: bad, sets: ['x'], from: src.root }), /unsafe path/);
    assert.equal(existsSync(path.join(dst, 'scripts')), false);
  } finally {
    clean(src.root, dst);
  }
});

test('the env prefix defaults from agent-tooling.json; --env-prefix wins', async () => {
  const src = fakeSource(MANIFEST, FILES);
  const dst = consumer();
  try {
    writeFileSync(path.join(dst, CONFIG_FILE), JSON.stringify({ envPrefix: 'WIDGET_' }));
    await sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/ask.mjs'), 'utf8'), /WIDGET_ALLOW_X/);
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/ask.mjs'), 'utf8'), /ACME_ALLOW_X/);
    writeFileSync(path.join(dst, CONFIG_FILE), JSON.stringify({ envPrefix: 'bad' }));
    await assert.rejects(sync({ into: dst, ref: src.sha, from: src.root }), /PREFIX_/);
    // With no config and no flag, the recorded prefix is kept, never reset to neutral.
    rmSync(path.join(dst, CONFIG_FILE));
    await sync({ into: dst, ref: src.sha, from: src.root });
    assert.match(readFileSync(path.join(dst, 'scripts/ask.mjs'), 'utf8'), /ACME_ALLOW_X/);
  } finally {
    clean(src.root, dst);
  }
});

test('the sync script survives being vendored through its own prefix rewrite', async () => {
  const self = readFileSync(SYNC, 'utf8');
  const src = fakeSource({ base: ['scripts/agent-tooling-sync.mjs'], sets: {} }, { 'scripts/agent-tooling-sync.mjs': self });
  const dst = consumer();
  try {
    await sync({ into: dst, ref: src.sha, envPrefix: 'ACME_', from: src.root });
    const vendored = path.join(dst, 'scripts/agent-tooling-sync.mjs');
    const r = spawnSync(process.execPath, [vendored, '--into', dst, '--check', '--from', src.root], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /match their recorded ref/);
  } finally {
    clean(src.root, dst);
  }
});

test('the CLI refuses a movable ref and a malformed prefix, and --check exits 1 without a record', () => {
  const dst = consumer();
  try {
    const branch = spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', 'main'], { encoding: 'utf8' });
    assert.equal(branch.status, 2);
    assert.match(branch.stderr, /40-hex/);
    const prefix = spawnSync(process.execPath, [SYNC, '--into', dst, '--ref', 'a'.repeat(40), '--env-prefix', 'acme'], { encoding: 'utf8' });
    assert.equal(prefix.status, 2);
    assert.match(prefix.stderr, /PREFIX_/);
    const none = spawnSync(process.execPath, [SYNC, '--into', dst, '--check'], { encoding: 'utf8' });
    assert.equal(none.status, 1);
    assert.match(none.stdout, /AGENT-TOOLING-SHA is missing/);
  } finally {
    clean(dst);
  }
});
