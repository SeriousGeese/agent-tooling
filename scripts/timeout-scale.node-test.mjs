import test from 'node:test';
import assert from 'node:assert/strict';
import { timeoutScale, scaledMs } from './test-support/timeout-scale.mjs';

test('an explicit scale wins, even in CI', () => {
  assert.equal(timeoutScale({ AGENT_TOOLING_NODE_TEST_TIMEOUT_SCALE: '2.5', CI: 'true' }, 'linux'), 2.5);
});

test('an unusable scale falls back to the platform default', () => {
  for (const bad of ['0', '-1', 'abc']) {
    assert.equal(timeoutScale({ AGENT_TOOLING_NODE_TEST_TIMEOUT_SCALE: bad }, 'linux'), 1);
  }
});

test('CI stays strict, a local win32 host gets headroom', () => {
  assert.equal(timeoutScale({ CI: 'true' }, 'win32'), 1);
  assert.equal(timeoutScale({ CI: 'false' }, 'win32'), 3);
  assert.equal(timeoutScale({}, 'win32'), 3);
  assert.equal(timeoutScale({}, 'linux'), 1);
});

test('scaledMs multiplies and rounds', () => {
  assert.equal(scaledMs(60_000, { AGENT_TOOLING_NODE_TEST_TIMEOUT_SCALE: '1.5' }, 'linux'), 90_000);
});
