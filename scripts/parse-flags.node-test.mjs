// Tests for scripts/lib/parse-flags.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseFlags } from './lib/parse-flags.mjs';

test('a boolean flag is present without consuming a value', () => {
  const { flags, positionals } = parseFlags(['--print', 'x'], {
    flags: { print: { type: 'boolean' } },
  });
  assert.deepEqual(flags, { print: true });
  assert.deepEqual(positionals, ['x']);
});

test('a string flag (the default type) consumes the next token', () => {
  const { flags } = parseFlags(['--shard', '3'], { flags: { shard: {} } });
  assert.equal(flags.shard, '3');
});

test('a string flag at the end of argv is present with value undefined, not absent', () => {
  // Distinguishing "not passed" (key absent) from "passed with nothing after it" (key
  // present, value undefined) is load-bearing for callers like e2e-shard-plan.mjs that give
  // a trailing bare flag its own meaning (`--shared-of` with nothing after == the whole suite).
  const { flags } = parseFlags(['--source'], { flags: { source: {} } });
  assert.ok('source' in flags);
  assert.equal(flags.source, undefined);
  const notPassed = parseFlags([], { flags: { source: {} } });
  assert.ok(!('source' in notPassed.flags));
});

test('an alias matches literally and resolves to the canonical name', () => {
  const { flags: byLong } = parseFlags(['--description', 'x'], {
    flags: { description: { aliases: ['-d'] } },
  });
  const { flags: byShort } = parseFlags(['-d', 'x'], {
    flags: { description: { aliases: ['-d'] } },
  });
  assert.deepEqual(byLong, { description: 'x' });
  assert.deepEqual(byShort, { description: 'x' });
});

test('a declared flag name matches only the --prefixed token, never the bare name', () => {
  // The bug this pins: an earlier version registered the bare spec key ("print") instead of
  // "--print" as the matched token, so every declared long flag was silently unrecognised and
  // fell through to "unknown flag", caught only by hand-testing ci-port.mjs's --print, since
  // none of its own node-tests exercised that flag.
  const bare = parseFlags(['print'], { flags: { print: { type: 'boolean' } } });
  assert.deepEqual(bare.flags, {}, 'the bare word is not a flag match at all');
  assert.deepEqual(bare.positionals, ['print'], 'so it falls through to a positional');

  const { flags } = parseFlags(['--print'], { flags: { print: { type: 'boolean' } } });
  assert.deepEqual(flags, { print: true });
});

test('an array flag collects every following non-flag token', () => {
  const { flags } = parseFlags(['--from-report', 'a.json', 'b.json', '--write'], {
    flags: { 'from-report': { type: 'array' }, write: { type: 'boolean' } },
  });
  assert.deepEqual(flags['from-report'], ['a.json', 'b.json']);
  assert.equal(flags.write, true);
});

test('an array flag with nothing following is an empty array, not absent', () => {
  const { flags } = parseFlags(['--from-report'], { flags: { 'from-report': { type: 'array' } } });
  assert.deepEqual(flags['from-report'], []);
});

test('an unrecognised leading-dash token throws by default', () => {
  assert.throws(() => parseFlags(['--bogus'], { flags: {} }), /unknown flag "--bogus"/);
});

test('the thrown error uses spec.ErrorClass when given', () => {
  class MyError extends Error {}
  assert.throws(() => parseFlags(['--bogus'], { flags: {}, ErrorClass: MyError }), MyError);
});

test('unknownFlags: "positional" treats an unrecognised leading-dash token as a positional instead', () => {
  const { flags, positionals } = parseFlags(['--bogus', 'x'], {
    flags: {},
    unknownFlags: 'positional',
  });
  assert.deepEqual(flags, {});
  assert.deepEqual(positionals, ['--bogus', 'x']);
});

test('positionals and flags interleave in argv order for positionals', () => {
  const { positionals } = parseFlags(['a', '--print', 'b'], { flags: { print: { type: 'boolean' } } });
  assert.deepEqual(positionals, ['a', 'b']);
});

test('an empty argv produces empty flags and positionals', () => {
  const { flags, positionals } = parseFlags([], { flags: { print: { type: 'boolean' } } });
  assert.deepEqual(flags, {});
  assert.deepEqual(positionals, []);
});
