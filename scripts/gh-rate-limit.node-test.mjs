// scripts/lib/gh-rate-limit.mjs: recognising GitHub's rate-limit answers and the
// doubling back-off. (A bash caller's copy of the pattern is checked by that caller's own test.)
import test from 'node:test';
import assert from 'node:assert/strict';

import { backoffFloorMs, backoffMs, isRateLimited } from './lib/gh-rate-limit.mjs';

test('recognises the primary and secondary limits as gh words them, and nothing else', () => {
  for (const text of [
    'gh: API rate limit exceeded for user ID 1. (HTTP 403)',
    'gh: You have exceeded a secondary rate limit. Please wait a few minutes before you try again. (HTTP 403)',
    'GraphQL: API rate limit exceeded (RATE_LIMITED)',
    'You have triggered an abuse detection mechanism.',
    'HTTP 429: Too Many Requests',
  ]) assert.equal(isRateLimited(text), true, text);
  for (const text of ['HTTP 404: Not Found', 'HTTP 502: Bad Gateway', 'Could not resolve to a PullRequest', '', null]) {
    assert.equal(isRateLimited(text), false, String(text));
  }
});

test('the back-off doubles from max(poll, floor) per consecutive hit and stops at the cap', () => {
  const opts = { floorMs: 60_000, capMs: 1_800_000 };
  assert.deepEqual([1, 2, 3, 4].map((h) => backoffMs(h, 300_000, opts)), [600_000, 1_200_000, 1_800_000, 1_800_000]);
  assert.equal(backoffMs(1, 0, opts), 120_000, 'a zero poll still backs off from the floor');
  assert.equal(backoffMs(1, 0, { floorMs: 0, capMs: 1 }), 0);
  assert.equal(backoffFloorMs({}), 60_000);
  assert.equal(backoffFloorMs({ AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS: '0' }), 0);
  assert.equal(backoffFloorMs({ AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS: 'x' }), 60_000);
});
