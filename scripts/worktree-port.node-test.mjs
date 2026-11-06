/**
 * Local test-port hygiene for scripts/worktree-port.sh.
 *
 * A test run may hold a block of three ports: the app on PORT and two stand-ins on PORT+1 and
 * PORT+2. worktree-port.sh used to hand out any port in 3100-3499, so two worktrees one port
 * apart shared a stand-in. It now hands out ports on a stride of 3, so two blocks either
 * coincide (a loud bind failure) or cannot overlap.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'worktree-port.sh');

function portFor(name) {
  const r = spawnSync('bash', [SCRIPT, name], { encoding: 'utf8' });
  assert.equal(r.status, 0, `worktree-port.sh ${name} failed: ${r.stderr}`);
  return Number(r.stdout.trim());
}

// Enough names to spread over most slots, shaped like real branch names.
const NAMES = Array.from({ length: 150 }, (_, i) => `fix/some-change-bd-${i.toString(36)}x${i}`);
const PORTS = NAMES.map(portFor);

test('every port is in 3100-3498 and starts a block of three that stays below 3500', () => {
  for (const port of PORTS) {
    assert.ok(Number.isInteger(port), `not an integer: ${port}`);
    assert.ok(port >= 3100 && port + 2 <= 3499, `out of range: ${port}`);
  }
});

test('two different ports are always at least 3 apart, so their PORT..PORT+2 blocks never overlap', () => {
  const distinct = [...new Set(PORTS)].sort((a, b) => a - b);
  assert.ok(distinct.length > 50, `expected the names to spread over many slots, got ${distinct.length}`);
  for (let i = 1; i < distinct.length; i++) {
    assert.ok(distinct[i] - distinct[i - 1] >= 3, `${distinct[i - 1]} and ${distinct[i]} overlap`);
  }
});

test('the same name always gets the same port', () => {
  assert.equal(portFor(NAMES[0]), PORTS[0]);
  assert.equal(portFor('main'), portFor('main'));
});
