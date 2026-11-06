// Tests for agent-tooling-config.mjs. Vendored too, so it locates the module relative to
// itself and never spells the neutral escape-hatch prefix as one literal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AgentToolingConfigError,
  CONFIG_FILE,
  DEFAULTS,
  KNOWN_KEYS,
  beadIdPattern,
  fillTemplate,
  findRoot,
  loadConfig,
  peopleOf,
  resolveConfig,
  tryLoadConfig,
  worktreeName,
} from './agent-tooling-config.mjs';

const P = ['AGENT', 'HOOKS', ''].join('_');

function repo(config) {
  const root = mkdtempSync(path.join(tmpdir(), 'agent-tooling-config-'));
  mkdirSync(path.join(root, '.git'));
  if (config !== undefined) {
    writeFileSync(path.join(root, CONFIG_FILE), typeof config === 'string' ? config : JSON.stringify(config));
  }
  return root;
}

test('every key has a default, and the defaults are neutral', () => {
  assert.deepEqual([...KNOWN_KEYS].sort(), [
    'beadPrefix',
    'claimHelper',
    'emDashPaths',
    'envPrefix',
    'gateWrappers',
    'packageManager',
    'people',
    'staleHookFiles',
    'worktreeNamePattern',
    'worktreeRoot',
    'worktreeScripts',
  ]);
  assert.equal(DEFAULTS.envPrefix, P);
  assert.equal(DEFAULTS.beadPrefix, null);
  assert.equal(DEFAULTS.packageManager, 'npm');
  assert.equal(DEFAULTS.worktreeRoot, '..');
  assert.equal(DEFAULTS.worktreeNamePattern, '<repo>-<slug>');
  assert.deepEqual(DEFAULTS.gateWrappers, ['gate.sh']);
  assert.deepEqual(DEFAULTS.people, []);
  assert.equal(DEFAULTS.claimHelper, 'scripts/claim.sh');
  assert.deepEqual(DEFAULTS.emDashPaths, []);
  assert.deepEqual(Object.keys(DEFAULTS.worktreeScripts).sort(), ['await', 'install', 'new', 'rm', 'stale']);
  assert.deepEqual(DEFAULTS.staleHookFiles, ['.claude/settings.json', 'scripts/hooks']);
});

test('a missing file yields the defaults, marked not found', () => {
  const root = repo();
  try {
    const cfg = loadConfig({ root });
    assert.equal(cfg.found, false);
    assert.equal(cfg.root, path.resolve(root));
    for (const key of KNOWN_KEYS) assert.deepEqual(cfg[key], DEFAULTS[key], key);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every key is read when set', () => {
  const full = {
    $comment: 'ignored',
    envPrefix: 'ACME_',
    beadPrefix: 'Acme',
    packageManager: 'pnpm',
    worktreeRoot: '/d/Worktrees',
    worktreeNamePattern: 'Acme-<slug>',
    gateWrappers: ['gate.sh', 'run-node-tests.mjs'],
    people: ['alice', 'bob'],
    claimHelper: 'tools/claim.sh',
    emDashPaths: ['content/', 'docs/guide/'],
    worktreeScripts: { new: 'bash tools/wt.sh <slug> <branch>', await: 'bash tools/wt.sh --await <path>', install: 'bash tools/wt.sh --install <path>', rm: 'bash tools/rm.sh <path>', stale: 'bash tools/rm.sh --stale' },
    staleHookFiles: ['.claude/settings.json', 'tools/hooks', 'tools/claim.sh'],
  };
  const root = repo(full);
  try {
    const cfg = loadConfig({ root });
    assert.equal(cfg.found, true);
    for (const key of KNOWN_KEYS) assert.deepEqual(cfg[key], full[key], key);
    assert.equal('$comment' in cfg, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('worktreeScripts merges per key over the defaults', () => {
  const cfg = resolveConfig({ worktreeScripts: { rm: 'bash x.sh <path>' } });
  assert.equal(cfg.worktreeScripts.rm, 'bash x.sh <path>');
  assert.equal(cfg.worktreeScripts.new, DEFAULTS.worktreeScripts.new);
});

test('an unknown key is an error that names the known keys', () => {
  assert.throws(() => resolveConfig({ envPrefx: 'ACME_' }), (err) => {
    assert.ok(err instanceof AgentToolingConfigError);
    assert.match(err.message, /unknown key "envPrefx"/);
    assert.match(err.message, /known: .*envPrefix/);
    return true;
  });
  assert.throws(() => resolveConfig({ worktreeScripts: { create: 'x' } }), /worktreeScripts" has unknown key\(s\) create/);
});

test('each key rejects a value of the wrong shape', () => {
  const bad = {
    envPrefix: ['acme_', 'ACME'],
    beadPrefix: ['', 'a-b', 7],
    packageManager: ['cargo'],
    worktreeRoot: ['', 3],
    worktreeNamePattern: ['no-slug', ''],
    gateWrappers: ['gate.sh', ['scripts/gate.sh'], [1]],
    people: [
      'zed',
      ['Alice'],
      [3],
      ['alice', 'alice'],
      [{ display: 'No handle' }],
      [{ handle: 'alice', nick: 'x' }],
      [{ handle: 'alice', actorBases: ['Alice Smith'] }],
      [{ handle: 'alice', emails: ['not-an-email'] }],
      [{ handle: 'alice', display: '' }],
      ['alice', { handle: 'alice' }],
    ],
    claimHelper: [null, '../claim.sh', '/abs/claim.sh', 'C:/x.sh', 'scripts\\claim.sh'],
    emDashPaths: ['content/', ['../up']],
    worktreeScripts: [null, [], { new: '' }],
    staleHookFiles: [['/abs'], 'x'],
  };
  for (const [key, values] of Object.entries(bad)) {
    for (const value of values) {
      assert.throws(() => resolveConfig({ [key]: value }), new RegExp(`"${key}"`), `${key}=${JSON.stringify(value)}`);
    }
  }
  assert.throws(() => resolveConfig([]), /JSON object/);
  assert.equal(resolveConfig({ beadPrefix: null }).beadPrefix, null);
});

test('people takes handles or person objects, and peopleOf gives one shape for both', () => {
  const cfg = resolveConfig({
    people: ['bob', { handle: 'alice', display: 'Alice S.', actorBases: ['alice-smith', 'asmith-bot'], emails: ['alice@example.com'] }],
  });
  assert.deepEqual(peopleOf(cfg), [
    { handle: 'bob', display: 'Bob', actorBases: [], emails: [] },
    { handle: 'alice', display: 'Alice S.', actorBases: ['alice-smith', 'asmith-bot'], emails: ['alice@example.com'] },
  ]);
  assert.deepEqual(peopleOf(resolveConfig({})), []);
  // Deep-frozen: a hook cannot edit the shared config through a person object.
  assert.throws(() => {
    cfg.people[1].actorBases.push('mallory');
  }, TypeError);
  // peopleOf hands back copies, so a caller may edit what it got.
  const copy = peopleOf(cfg);
  copy[1].actorBases.push('x');
  assert.deepEqual(cfg.people[1].actorBases, ['alice-smith', 'asmith-bot']);
});

test('invalid JSON throws from loadConfig and falls back in tryLoadConfig', () => {
  const root = repo('{ not json');
  try {
    assert.throws(() => loadConfig({ root }), /not valid JSON/);
    const { config, error } = tryLoadConfig({ root });
    assert.match(error, /not valid JSON/);
    assert.equal(config.found, false);
    assert.equal(config.envPrefix, P);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findRoot stops at the nearest config or .git, including a worktree .git file', () => {
  const outer = repo({ envPrefix: 'OUTER_' });
  try {
    const deep = path.join(outer, 'scripts', 'hooks');
    mkdirSync(deep, { recursive: true });
    assert.equal(findRoot(deep), path.resolve(outer));
    assert.equal(loadConfig({ from: deep }).envPrefix, 'OUTER_');

    // A linked worktree nested inside the primary checkout: its `.git` is a file.
    const wt = path.join(outer, '.claude', 'worktrees', 'wt1');
    mkdirSync(path.join(wt, 'scripts', 'hooks'), { recursive: true });
    writeFileSync(path.join(wt, '.git'), 'gitdir: elsewhere\n');
    assert.equal(findRoot(path.join(wt, 'scripts', 'hooks')), path.resolve(wt));
    assert.equal(loadConfig({ from: path.join(wt, 'scripts', 'hooks') }).found, false);
  } finally {
    rmSync(outer, { recursive: true, force: true });
  }
});

test('helpers: fillTemplate, worktreeName, beadIdPattern', () => {
  assert.equal(fillTemplate('bash w.sh --await <path>', { path: '/x' }), 'bash w.sh --await /x');
  assert.equal(fillTemplate('bash w.sh <slug> <branch>', { slug: 's' }), 'bash w.sh s <branch>');
  assert.equal(worktreeName({ worktreeNamePattern: '<repo>-<slug>', root: '/git/Widget' }, 'fix-1'), 'Widget-fix-1');
  assert.equal(worktreeName({ worktreeNamePattern: 'Acme-<slug>' }, 'fix-1'), 'Acme-fix-1');
  const scoped = beadIdPattern({ beadPrefix: 'Acme' });
  assert.ok(scoped.test('closes Acme-x1y2z.3'));
  assert.equal(scoped.test('closes bd-x1y2z'), false);
  assert.ok(beadIdPattern({ beadPrefix: null }).test('bd-abc12'));
});
