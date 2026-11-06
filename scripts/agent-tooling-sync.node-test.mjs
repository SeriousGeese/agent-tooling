// Tests for agent-tooling-sync.mjs. Every case builds a throwaway git repository shaped like
// agent-tooling and syncs from it with --from, so nothing here touches the network. This file
// is vendored too, so it locates the script relative to itself and never spells the neutral
// prefix as one literal (sync rewrites that literal on the way in).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  for (const bad of ['../x', '/abs/x', 'C:/x', 'scripts\\x.mjs', 'src/x.ts', 'scripts', 'scripts/../x', 'scripts/./x', '']) {
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

    await sync({ into: dst, ref: src.sha, sets: ['asks'], from: src.root });
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
