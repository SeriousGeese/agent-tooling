// A malformed agent-tooling.json must not read as an EMPTY routing table. With no people, /asks
// cannot resolve anyone and the SessionStart banner prints nothing, so pending asks would look
// absent. A genuinely MISSING config stays fail-open and silent.
//
// The scripts run as real processes from a scratch copy, so the config walk (which starts at the
// script's own directory) finds the scratch agent-tooling.json and never this repository's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPeopleLoadError, loadPeople, peopleFromConfig } from './ask-lib.mjs';
import { configErrorLine } from './hooks/ask-inbox.mjs';
import { main } from './ask.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COPIED = [
  'ask.mjs',
  'ask-lib.mjs',
  'agent-actor-id.mjs',
  'agent-tooling-config.mjs',
  'lib/bd-cli.mjs',
  'hooks/ask-inbox.mjs',
];

/** A scratch consumer: a copy of the scripts under test, a `.git` marker and an optional config. */
function scratch(configText) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ask-config-error-'));
  mkdirSync(path.join(dir, '.git'));
  for (const rel of COPIED) {
    mkdirSync(path.dirname(path.join(dir, 'scripts', rel)), { recursive: true });
    copyFileSync(path.join(HERE, rel), path.join(dir, 'scripts', rel));
  }
  if (configText !== undefined) writeFileSync(path.join(dir, 'agent-tooling.json'), configText);
  return dir;
}

const run = (dir, rel, args = []) =>
  spawnSync(process.execPath, [path.join(dir, 'scripts', rel), ...args], {
    encoding: 'utf8',
    // No bd or git on PATH: nothing past the config check can succeed, which is the point.
    env: { PATH: '', SystemRoot: process.env.SystemRoot ?? '', BEADS_ACTOR: 'alice-bot-deadbeef', ASK_PERSON: '' },
  });

const withScratch = (configText, fn) => {
  const dir = scratch(configText);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  }
};

test('loadPeople separates a missing config (no error) from a broken one (the reason)', () => {
  withScratch(undefined, (dir) => {
    assert.deepEqual(loadPeople({ root: dir }), { people: [], error: null });
  });
  withScratch('{not json', (dir) => {
    const { people, error } = loadPeople({ root: dir });
    assert.deepEqual(people, []);
    assert.match(error, /agent-tooling\.json/);
    assert.match(error, /not valid JSON/);
    assert.deepEqual(peopleFromConfig({ root: dir }), [], 'the old fail-open form still reads as nobody');
  });
  withScratch('{"people": "alice"}', (dir) => {
    assert.ok(loadPeople({ root: dir }).error, 'a config that parses but fails validation is a load error too');
  });
  withScratch('{"people": ["alice"]}', (dir) => {
    const loaded = loadPeople({ root: dir });
    assert.equal(loaded.error, null);
    assert.deepEqual(loaded.people.map((p) => p.key), ['alice']);
  });
});

test("the default load reports no error for this repository's config", () => {
  assert.equal(defaultPeopleLoadError(), null);
});

test('ask.mjs main(): a load error is reported and exits 1 before any routing, --help still works', () => {
  const out = { log: [], error: [] };
  const deps = {
    people: undefined,
    peopleError: '/x/agent-tooling.json: not valid JSON (boom)',
    bd: () => assert.fail('bd must not run'),
    sync: () => assert.fail('sync must not run'),
    log: (l) => out.log.push(l),
    warn: () => {},
    error: (l) => out.error.push(l),
  };
  assert.equal(main(['bd-1', 'bob'], deps), 1);
  assert.equal(out.error.length, 1);
  assert.equal(out.error[0], 'ask: /x/agent-tooling.json: not valid JSON (boom)', 'the loader message, once');
  assert.equal(main(['list'], deps), 1);
  assert.equal(main(['--help'], deps), 0);
  assert.match(out.log.at(-1), /People: \(none loaded: \/x\/agent-tooling\.json: not valid JSON \(boom\)\)/);
});

test('ask.mjs as a process: malformed config prints one error naming the file and exits non-zero', () => {
  withScratch('{not json', (dir) => {
    for (const args of [['list'], ['bd-1', 'bob'], ['clear', 'bd-1', 'bob']]) {
      const r = run(dir, 'ask.mjs', args);
      assert.notEqual(r.status, 0, args.join(' '));
      assert.match(r.stderr, /^ask: .*agent-tooling\.json: not valid JSON/);
      assert.equal(r.stderr.split('agent-tooling.json').length, 2, 'the file name appears once');
      assert.equal(r.stderr.trim().split('\n').length, 1, 'one line');
      assert.doesNotMatch(r.stderr, /Unknown person/i, 'never falls through to "unknown person"');
    }
  });
});

test('ask.mjs as a process: a missing config is not a load error', () => {
  withScratch(undefined, (dir) => {
    const r = run(dir, 'ask.mjs', ['bd-1', 'bob']);
    assert.doesNotMatch(r.stderr, /cannot load agent-tooling/);
  });
});

test('the banner hook prints exactly one [asks] diagnostic for a malformed config and still exits 0', () => {
  withScratch('{not json', (dir) => {
    const r = run(dir, 'hooks/ask-inbox.mjs');
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^\[asks\] .*agent-tooling\.json/);
    assert.match(lines[0], /not valid JSON/);
  });
});

test('the banner hook stays silent and exits 0 for a missing config, and for a valid one it cannot use', () => {
  for (const config of [undefined, '{"people": ["alice"]}']) {
    withScratch(config, (dir) => {
      const r = run(dir, 'hooks/ask-inbox.mjs');
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
    });
  }
});

test('configErrorLine is a single line even when the reason spans several', () => {
  assert.equal(configErrorLine('a\n  b').includes('\n'), false);
});
