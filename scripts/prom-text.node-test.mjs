import { strict as assert } from 'node:assert';
import test from 'node:test';
import { escapePromLabel, promWriter } from './lib/prom-text.mjs';

test('escapePromLabel escapes backslash, double quote and newline, and tolerates null', () => {
  assert.equal(escapePromLabel('a\\b'), 'a\\\\b');
  assert.equal(escapePromLabel('say "hi"'), 'say \\"hi\\"');
  assert.equal(escapePromLabel('one\ntwo\r\nthree'), 'one\\ntwo\\nthree');
  assert.equal(escapePromLabel(null), '');
  assert.equal(escapePromLabel(undefined), '');
  assert.equal(escapePromLabel(7), '7');
});

test('promWriter names windows for win32 and passes any other platform through', () => {
  assert.equal(promWriter('win32'), 'windows');
  assert.equal(promWriter('linux'), 'linux');
  assert.equal(promWriter('darwin'), 'darwin');
  assert.equal(typeof promWriter(), 'string');
});
