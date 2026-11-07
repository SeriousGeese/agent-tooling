// The strict-mode knob of the ritual smoke: AGENT_TOOLING_RITUAL_REQUIRE_ALL=1 turns a skip
// caused by a missing file into a failure that names the file. Proven end to end: a throwaway
// test file that asks for a file this repository does not have runs in a child node --test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { removeTempDir } from '../test-support/cleanup.mjs';
import { REQUIRE_ALL_KNOB, requireAll, skipUnlessPresent } from './ritual-support.mjs';

const SUPPORT_URL = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), 'ritual-support.mjs')).href;
const MISSING = 'scripts/hooks/no-such-guard-for-the-knob-test.mjs';

function runChild(extraEnv) {
  const dir = mkdtempSync(path.join(tmpdir(), 'ritual-knob-'));
  try {
    const file = path.join(dir, 'probe.node-test.mjs');
    writeFileSync(
      file,
      [
        `import { ritualTest, skipUnlessPresent } from ${JSON.stringify(SUPPORT_URL)};`,
        `ritualTest('needs a missing file', { skip: skipUnlessPresent(${JSON.stringify(MISSING)}) }, () => {});`,
        '',
      ].join('\n'),
    );
    const env = { ...process.env };
    // An inherited NODE_TEST_CONTEXT makes a nested `node --test` run nothing and exit 0.
    for (const k of Object.keys(env)) if ([REQUIRE_ALL_KNOB, 'NODE_TEST_CONTEXT'].includes(k.toUpperCase())) delete env[k];
    return spawnSync(process.execPath, ['--test', '--test-reporter=tap', file], { encoding: 'utf8', env: { ...env, ...extraEnv } });
  } finally {
    removeTempDir(dir, 'ritual-support.node-test');
  }
}

test('requireAll reads only the exact value 1', () => {
  assert.equal(requireAll({ [REQUIRE_ALL_KNOB]: '1' }), true);
  assert.equal(requireAll({ [REQUIRE_ALL_KNOB]: '0' }), false);
  assert.equal(requireAll({ [REQUIRE_ALL_KNOB]: '' }), false);
  assert.equal(requireAll({}), false);
});

test('skipUnlessPresent names every missing file and is false when all exist', () => {
  assert.equal(skipUnlessPresent('manifest.json'), false);
  assert.match(skipUnlessPresent('manifest.json', MISSING), new RegExp(MISSING.replace(/\./g, '\\.')));
});

test('without the knob a missing file skips green', () => {
  const r = runChild({});
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /# skipped 1/);
});

test('with the knob a missing file is a failure that names the file', () => {
  const r = runChild({ [REQUIRE_ALL_KNOB]: '1' });
  assert.notEqual(r.status, 0, 'strict mode must fail');
  assert.match(r.stdout, /# fail 1/);
  assert.ok(r.stdout.includes(MISSING), `the failure names the missing file:\n${r.stdout}`);
});
