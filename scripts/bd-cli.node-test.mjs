import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { BD_MAX_BUFFER, BD_TIMEOUT_MS, bd, bdJson, parseBdJsonRows } from './lib/bd-cli.mjs';
import { removeTempDir } from './test-support/cleanup.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * scripts/lib/bd-cli.mjs is the shared `bd` caller. A copy without a maxBuffer is one
 * tracker-growth away from a bare `spawnSync bd ENOBUFS`. These pin the option and the shared parse.
 */
describe('bd-cli', () => {
  test('passes a maxBuffer well above Node\'s 1 MB default, and the timeout', () => {
    let seen;
    const out = bd(['list', '--json'], {
      exec: (cmd, args, opts) => {
        seen = { cmd, args, opts };
        return '[]';
      },
    });
    assert.equal(out, '[]');
    assert.equal(seen.cmd, 'bd');
    assert.deepEqual(seen.args, ['list', '--json']);
    assert.equal(seen.opts.maxBuffer, BD_MAX_BUFFER);
    assert.ok(BD_MAX_BUFFER >= 64 * 1024 * 1024);
    assert.equal(seen.opts.timeout, BD_TIMEOUT_MS);
  });

  test('a failure names the command and stderr, unless allowFailure', () => {
    const exec = () => {
      const e = new Error('boom');
      e.stderr = 'database locked';
      throw e;
    };
    assert.throws(() => bd(['show', 'X'], { exec }), /bd show X\n {2}database locked/);
    assert.equal(bd(['show', 'X'], { exec, allowFailure: true }), '');
  });

  test('parseBdJsonRows accepts every shape bd emits', () => {
    assert.deepEqual(parseBdJsonRows(''), []);
    assert.deepEqual(parseBdJsonRows('not json'), []);
    assert.deepEqual(parseBdJsonRows('[{"id":"a"}]'), [{ id: 'a' }]);
    assert.deepEqual(parseBdJsonRows('{"issues":[{"id":"b"}]}'), [{ id: 'b' }]);
    assert.deepEqual(parseBdJsonRows('{"id":"c"}'), [{ id: 'c' }]);
    assert.deepEqual(bdJson(['list'], { exec: () => ' [{"id":"d"}] \n' }), [{ id: 'd' }]);
  });

  // A real child process (a stub `bd` first on PATH, never the real binary) printing > 1 MB:
  // the injected-exec tests above prove the option is passed, this proves it is honoured.
  test('returns a > 1 MB stdout from a stubbed bd intact', { skip: process.platform === 'win32' }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'bd-cli-stub-'));
    const oldPath = process.env.PATH;
    try {
      const stub = path.join(dir, 'bd');
      const body = "process.stdout.write(JSON.stringify([{ id: 'big', pad: 'x'.repeat(3 * 1024 * 1024) }]));";
      writeFileSync(stub, `#!${process.execPath}\n${body}\n`);
      chmodSync(stub, 0o755);
      process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
      const out = bd(['list', '--json']);
      assert.ok(out.length > 3 * 1024 * 1024, "stdout over Node's 1 MB default arrives whole");
      const rows = bdJson(['list', '--json']);
      assert.equal(rows[0].id, 'big');
      assert.equal(rows[0].pad.length, 3 * 1024 * 1024);
    } finally {
      process.env.PATH = oldPath;
      removeTempDir(dir, 'bd-cli.node-test');
    }
  });

  // Each caller that exists in this checkout uses the shared helper; a local bd()/runBd() copy
  // is how one of them once lacked the maxBuffer backstop.
  test('callers import the shared helper and define no bd() of their own', () => {
    const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
    for (const file of ['ask.mjs', 'hygiene-bd-lib.mjs', 'bead-chains.mjs']) {
      const abs = path.join(HERE, file);
      if (!existsSync(abs)) continue;
      const src = stripComments(readFileSync(abs, 'utf8'));
      assert.ok(/from '\.\/lib\/bd-cli\.mjs'/.test(src), `${file} must import ./lib/bd-cli.mjs`);
      assert.ok(!/^\s*(export\s+)?(async\s+)?function\s+(run)?[bB]d\s*\(/m.test(src), `${file} must not define its own bd()/runBd()`);
    }
  });
});
