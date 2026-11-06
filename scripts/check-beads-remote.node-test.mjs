import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  check,
  expectedFromArgs,
  isGitRemote,
  parseDoltRemotes,
  parseSyncRemote,
} from './check-beads-remote.mjs';

const EXPECTED_REMOTE = 'https://doltremoteapi.dolthub.com/acme/ExampleBeads';
const DB_NAME = 'exampledb';

// check() joins its paths with path.join, which on win32 emits backslashes; the mock's
// `exists` compares by string, so the expected paths are built the same way rather than as
// POSIX literals. Otherwise every spec here reads "config.yaml is missing" on Windows.
const REPO = path.resolve('/repo');
const CONFIG = path.join(REPO, '.beads', 'config.yaml');
const DOLT_DIR = path.join(REPO, '.beads', 'embeddeddolt', DB_NAME);

function makeDeps({
  config,
  remotes = `origin ${EXPECTED_REMOTE}`,
  doltDir = true,
  doltOk = true,
  expected = EXPECTED_REMOTE,
}) {
  const deps = {
    /** @type {string[]} */
    errors: [],
    /** @type {string[]} */
    logs: [],
    expected,
    dbName: DB_NAME,
    read: () => config,
    exists: (p) => (p === CONFIG ? config !== undefined : p === DOLT_DIR && doltDir),
    run: () => (doltOk ? { status: 0, stdout: remotes, stderr: '' } : { status: 1, stdout: '', stderr: 'no dolt' }),
    log: (...a) => deps.logs.push(a.join(' ')),
    error: (...a) => deps.errors.push(a.join(' ')),
  };
  return deps;
}

describe('parseSyncRemote', () => {
  test('reads the nested form bd normalizes to', () => {
    assert.equal(parseSyncRemote(`sync:\n    remote: "${EXPECTED_REMOTE}"\n`), EXPECTED_REMOTE);
  });

  test('reads the flat form a human writes', () => {
    assert.equal(parseSyncRemote(`sync.remote: "${EXPECTED_REMOTE}"\n`), EXPECTED_REMOTE);
  });

  test('ignores commented-out lines', () => {
    // config.yaml quotes the old git URL in a comment as the thing NOT to have; that must never
    // be mistaken for the live setting.
    const yaml = [
      '# sync.remote: "git+https://github.com/acme/example.git"',
      '#     remote: "git+ssh://git@github.com/acme/Example"',
      'sync:',
      `    remote: "${EXPECTED_REMOTE}"`,
    ].join('\n');
    assert.equal(parseSyncRemote(yaml), EXPECTED_REMOTE);
  });

  test('does not read a remote out of an unrelated block', () => {
    assert.equal(parseSyncRemote('backup:\n    remote: "nope"\n'), null);
  });

  test('returns null when the key is absent', () => {
    assert.equal(parseSyncRemote('issue-prefix: "abc"\n'), null);
  });

  test('tolerates single quotes and bare values', () => {
    assert.equal(parseSyncRemote(`sync.remote: '${EXPECTED_REMOTE}'`), EXPECTED_REMOTE);
    assert.equal(parseSyncRemote(`sync.remote: ${EXPECTED_REMOTE}`), EXPECTED_REMOTE);
  });
});

describe('parseDoltRemotes', () => {
  test('maps names to urls', () => {
    assert.deepEqual(parseDoltRemotes(`origin ${EXPECTED_REMOTE} \nbackup https://x/y`), {
      origin: EXPECTED_REMOTE,
      backup: 'https://x/y',
    });
  });

  test('returns an empty map for empty output', () => {
    assert.deepEqual(parseDoltRemotes(''), {});
  });
});

describe('isGitRemote', () => {
  test('tells a git remote from a DoltHub one', () => {
    for (const u of ['git+https://github.com/a/b.git', 'git+ssh://git@github.com/a/B', 'https://github.com/a/b.git', 'git@github.com:a/b.git']) {
      assert.equal(isGitRemote(u), true, u);
    }
    assert.equal(isGitRemote(EXPECTED_REMOTE), false);
  });
});

describe('expectedFromArgs', () => {
  test('takes the flag, then the environment variable, else null', () => {
    assert.equal(expectedFromArgs(['--expected', 'u1'], { AGENT_TOOLING_BEADS_REMOTE: 'u2' }), 'u1');
    assert.equal(expectedFromArgs(['--expected=u3'], {}), 'u3');
    assert.equal(expectedFromArgs([], { AGENT_TOOLING_BEADS_REMOTE: 'u2' }), 'u2');
    assert.equal(expectedFromArgs([], {}), null);
  });
});

describe('check', () => {
  test('passes when config and the dolt CLI both name DoltHub', () => {
    const deps = makeDeps({ config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n` });
    assert.equal(check(REPO, deps), 0);
    assert.ok(deps.logs.join('\n').includes('Beads remote OK'));
  });

  test('fails, and names the cause, when bd has re-pointed config at the git origin', () => {
    // This is bd's actual misbehaviour: it auto-detects the GitHub origin and commits it.
    const deps = makeDeps({
      config: 'sync.remote: "git+https://github.com/acme/example.git"\n',
    });
    assert.equal(check(REPO, deps), 1);
    const out = deps.errors.join('\n');
    assert.ok(out.includes('bd auto-detecting the GitHub git origin'));
    assert.ok(out.includes('do NOT commit the auto-detected one'));
  });

  test('fails when the dolt CLI remote is missing, because push/pull are then silent no-ops', () => {
    const deps = makeDeps({
      config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`,
      remotes: '',
    });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('silent NO-OP'));
  });

  test('fails when the dolt CLI remote points somewhere else', () => {
    const deps = makeDeps({
      config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`,
      remotes: 'origin https://doltremoteapi.dolthub.com/acme/SomethingElse',
    });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('SomethingElse'));
  });

  test('does NOT fail a checkout that has not been bootstrapped yet', () => {
    // No embedded database means no dolt remote can exist; that is a setup step, not drift.
    const deps = makeDeps({ config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`, doltDir: false });
    assert.equal(check(REPO, deps), 0);
  });

  test('reports a missing config rather than throwing', () => {
    const deps = makeDeps({ config: undefined });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('missing'));
  });

  test('reports an absent dolt CLI', () => {
    const deps = makeDeps({ config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`, doltOk: false });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('dolt CLI installed'));
  });

  test('fails when config names a different remote than the pinned one', () => {
    const deps = makeDeps({ config: 'sync:\n    remote: "https://doltremoteapi.dolthub.com/acme/Other"\n' });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('expected'));
  });
});

describe('check without a pinned remote', () => {
  test('passes when config and the dolt CLI agree on a non-git remote', () => {
    const deps = makeDeps({ config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`, expected: null });
    assert.equal(check(REPO, deps), 0);
  });

  test('fails when sync.remote is a git URL', () => {
    const deps = makeDeps({
      config: 'sync.remote: "git+ssh://git@github.com/acme/Example"\n',
      remotes: 'origin git+ssh://git@github.com/acme/Example',
      expected: null,
    });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('git remote'));
  });

  test('fails when sync.remote is missing', () => {
    const deps = makeDeps({ config: 'issue-prefix: "abc"\n', expected: null });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('MISSING'));
  });

  test('fails when the dolt CLI remote disagrees with config', () => {
    const deps = makeDeps({
      config: `sync:\n    remote: "${EXPECTED_REMOTE}"\n`,
      remotes: 'origin https://doltremoteapi.dolthub.com/acme/Elsewhere',
      expected: null,
    });
    assert.equal(check(REPO, deps), 1);
    assert.ok(deps.errors.join('\n').includes('Elsewhere'));
  });
});
