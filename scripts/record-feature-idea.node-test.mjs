#!/usr/bin/env node
// scripts/record-feature-idea.sh must not read a FAILED duplicate check as "no duplicates":
// a bd that errors, or prints something that is not a JSON array, stops the script before it
// creates anything. Driven through bash with an exported FUNCTION standing in for `bd`, so no
// PATH shim has to be exec'd (the Windows limitation the other bash tests also avoid).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { removeTempDir } from './test-support/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'record-feature-idea.sh').split(path.sep).join('/');

const have = (cmd) => {
  try {
    return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
};
const SKIP = (() => {
  try {
    if (spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status !== 0) return 'requires bash on PATH';
  } catch {
    return 'requires bash on PATH';
  }
  return have('jq') ? false : 'requires jq on PATH';
})();

// `bd list` answers $BD_LIST_OUT with status $BD_LIST_RC; `bd create` answers a bead id; all else succeeds.
const WRAPPER = `
bd() {
  echo "bd $*" >> "$CALL_LOG"
  case "$1" in
    list) printf '%s' "$BD_LIST_OUT"; return "\${BD_LIST_RC:-0}" ;;
    create) cat > /dev/null; echo '{"id":"stub-1"}'; return 0 ;;
  esac
  return 0
}
export -f bd
sleep() { :; }
export -f sleep
exec bash "$0" "$@"
`;

function run({ listOut, listRc = 0 }) {
  const dir = mkdtempSync(path.join(tmpdir(), 'record-idea-'));
  try {
    const log = path.join(dir, 'calls.log').split(path.sep).join('/');
    const r = spawnSync('bash', ['-c', WRAPPER, SCRIPT, 'A title', 'A description'], {
      encoding: 'utf8',
      env: { ...process.env, CALL_LOG: log, BD_LIST_OUT: listOut, BD_LIST_RC: String(listRc) },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8') : '';
    return { ...r, calls, created: /^bd create /m.test(calls) };
  } finally {
    removeTempDir(dir, 'record-feature-idea.node-test');
  }
}

test('malformed bd output is a failed duplicate check, not "no duplicates": exit 1, cause named, nothing created', { skip: SKIP }, () => {
  for (const listOut of ['this is not json', '{"error":"locked"}', '']) {
    const r = run({ listOut });
    assert.equal(r.status, 1, `${JSON.stringify(listOut)}: ${r.stderr}`);
    assert.match(r.stderr, /duplicate check failed/);
    assert.match(r.stderr, /did not return a JSON array/);
    assert.equal(r.created, false, `nothing may be created: ${r.calls}`);
  }
});

test('a bd list that exits non-zero stops the script before creating anything', { skip: SKIP }, () => {
  const r = run({ listOut: '[]', listRc: 3 });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /duplicate check failed: 'bd list --title-contains' exited 3/);
  assert.equal(r.created, false);
});

test('an empty array creates the bead; a non-empty one warns and still creates', { skip: SKIP }, () => {
  const none = run({ listOut: '[]' });
  assert.equal(none.status, 0, none.stderr);
  assert.equal(none.created, true);
  assert.doesNotMatch(none.stdout, /potential duplicate/);

  const some = run({ listOut: '[{"id":"x-1"},{"id":"x-2"}]' });
  assert.equal(some.status, 0, some.stderr);
  assert.match(some.stdout, /Found 2 potential duplicate/);
  assert.equal(some.created, true);
});
