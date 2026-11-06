/**
 * Tests for scripts/bd-repo-guard.mjs.
 *
 * The classification tests are pure. The snapshot/restore tests drive the module through a fake
 * `deps`, so they assert the exact git argv it issues - which is the part that matters: a
 * `--hard` where a `--mixed` was intended would destroy a contributor's uncommitted work, and no
 * amount of end-state checking on a fake filesystem would catch that substitution.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';

import {
  BD_OWNED_FILES,
  isBdOwnedPath,
  classifyChurnCommits,
  snapshot,
  restore,
  main,
} from './bd-repo-guard.mjs';

// ---------------------------------------------------------------------------
// Fake deps
// ---------------------------------------------------------------------------

/**
 * @param opts.files    in-memory filesystem, { [path]: contents }
 * @param opts.git      (args) => { status, stdout, stderr } | undefined  (undefined = exit 0, empty)
 */
function makeDeps({ files = {}, git = () => undefined } = {}) {
  const fs = { ...files };
  const calls = [];
  const logs = [];
  const warns = [];
  const deps = {
    run(cmd, args) {
      calls.push([cmd, ...args].join(' '));
      if (cmd !== 'git') return { status: 0, stdout: '', stderr: '' };
      const r = git(args, fs);
      return r ?? { status: 0, stdout: '', stderr: '' };
    },
    log: (...a) => logs.push(a.join(' ')),
    warn: (...a) => warns.push(a.join(' ')),
    exists: (p) => Object.hasOwn(fs, norm(p)),
    readFile: (p) => {
      if (!Object.hasOwn(fs, norm(p))) throw new Error(`ENOENT ${p}`);
      return fs[norm(p)];
    },
    writeFile: (p, data) => { fs[norm(p)] = data; },
    mkdir: () => {},
  };
  return { deps, fs, calls, logs, warns };
}

const norm = (p) => p.split(path.sep).join('/');

/** A git fake for a repo whose HEAD is `head` and where `cleanFiles` are unmodified. */
function gitAt(head, cleanFiles) {
  return (args) => {
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
      return head === null
        ? { status: 128, stdout: '', stderr: 'fatal: bad revision' }
        : { status: 0, stdout: `${head}\n`, stderr: '' };
    }
    if (args[0] === 'diff') {
      const file = args[args.length - 1];
      return { status: cleanFiles.includes(file) ? 0 : 1, stdout: '', stderr: '' };
    }
    return undefined;
  };
}

// ---------------------------------------------------------------------------
// isBdOwnedPath
// ---------------------------------------------------------------------------

test('isBdOwnedPath accepts every declared bd-owned file', () => {
  for (const f of BD_OWNED_FILES) assert.equal(isBdOwnedPath(f), true, f);
});

test('isBdOwnedPath accepts anything under .beads/', () => {
  assert.equal(isBdOwnedPath('.beads/config.yaml'), true);
  assert.equal(isBdOwnedPath('.beads/hooks/pre-push'), true);
  assert.equal(isBdOwnedPath('.beads/deeply/nested/thing.json'), true);
});

test('isBdOwnedPath rejects repo source, docs and lookalikes', () => {
  assert.equal(isBdOwnedPath('AGENTS.md'), false);
  assert.equal(isBdOwnedPath('src/lib/urls.ts'), false);
  assert.equal(isBdOwnedPath('scripts/setup-repo.sh'), false);
  // Not under .beads/ - a sibling directory whose name merely starts the same way.
  assert.equal(isBdOwnedPath('.beadsx/config.yaml'), false);
  assert.equal(isBdOwnedPath('docs/.beads/notes.md'), false);
});

test('isBdOwnedPath normalises windows separators and a leading ./', () => {
  assert.equal(isBdOwnedPath('./.beads/config.yaml'), true);
  assert.equal(isBdOwnedPath(['.claude', 'settings.json'].join(path.sep)), true);
});

test('isBdOwnedPath rejects non-strings and empty', () => {
  assert.equal(isBdOwnedPath(''), false);
  assert.equal(isBdOwnedPath(undefined), false);
  assert.equal(isBdOwnedPath(null), false);
  assert.equal(isBdOwnedPath(42), false);
});

// ---------------------------------------------------------------------------
// classifyChurnCommits
// ---------------------------------------------------------------------------

const bdCommit = (sha, subject = 'bd: update sync.remote') =>
  ({ sha, subject, files: ['.beads/config.yaml'] });

test('classifyChurnCommits: the real observed shape is safe', () => {
  const v = classifyChurnCommits([
    bdCommit('05170d78', 'bd: clear sync.remote'),
    bdCommit('f5e4b913', 'bd: update sync.remote'),
    bdCommit('0747aeb2', 'bd: clear sync.remote'),
    bdCommit('ac7c200c', 'bd: update sync.remote'),
  ]);
  assert.equal(v.safe, true);
  assert.equal(v.reason, null);
  assert.deepEqual(v.offenders, []);
});

test('classifyChurnCommits: an empty list is NOT safe', () => {
  // "nothing to undo" must never read as "undo authorised" - that is what would let a caller
  // reset on a range it failed to compute.
  const v = classifyChurnCommits([]);
  assert.equal(v.safe, false);
  assert.equal(v.reason, 'no-commits');
});

test('classifyChurnCommits: rejects non-arrays', () => {
  assert.equal(classifyChurnCommits(null).safe, false);
  assert.equal(classifyChurnCommits(undefined).safe, false);
});

test('classifyChurnCommits: a foreign FILE in an otherwise bd-looking commit is refused', () => {
  const v = classifyChurnCommits([
    bdCommit('aaa1'),
    { sha: 'bbb2', subject: 'bd: update sync.remote', files: ['.beads/config.yaml', 'src/app/page.tsx'] },
  ]);
  assert.equal(v.safe, false);
  assert.equal(v.reason, 'foreign-commits');
  assert.equal(v.offenders.length, 1);
  assert.equal(v.offenders[0].sha, 'bbb2');
  assert.equal(v.offenders[0].reason, 'files');
  assert.deepEqual(v.offenders[0].files, ['src/app/page.tsx']);
});

test('classifyChurnCommits: a foreign SUBJECT on a bd-owned file is refused', () => {
  // Someone else's real commit that happens to touch .beads/ must not be reset away.
  const v = classifyChurnCommits([
    { sha: 'ccc3', subject: 'chore: retune beads config', files: ['.beads/config.yaml'] },
  ]);
  assert.equal(v.safe, false);
  assert.equal(v.offenders[0].reason, 'subject');
});

test('classifyChurnCommits: a commit with NO files is refused', () => {
  // An empty file list is what a failed `git show` looks like. Reading it as "no foreign
  // files" would let a parse failure authorise the reset.
  const v = classifyChurnCommits([{ sha: 'ddd4', subject: 'bd: update sync.remote', files: [] }]);
  assert.equal(v.safe, false);
  assert.equal(v.offenders[0].reason, 'no-files');
});

test('classifyChurnCommits: one bad commit poisons an otherwise safe range', () => {
  const v = classifyChurnCommits([
    bdCommit('aaa1'),
    { sha: 'bbb2', subject: 'feat: real work', files: ['src/x.ts'] },
    bdCommit('ccc3'),
  ]);
  assert.equal(v.safe, false);
  assert.equal(v.offenders.length, 1);
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

test('snapshot records HEAD and only the CLEAN bd-owned files', () => {
  const { deps, fs } = makeDeps({
    files: {
      'CLAUDE.md': 'claude original',
      'GEMINI.md': 'gemini original',
      '.claude/settings.json': '{"a":1}',
      '.beads/config.yaml': 'sync.remote: "https://dolthub"',
    },
    // GEMINI.md is already modified by the contributor - must NOT be snapshotted.
    git: gitAt('abc123', ['CLAUDE.md', '.claude/settings.json', '.beads/config.yaml']),
  });

  const r = snapshot('/snap', deps);

  assert.equal(r.ok, true);
  assert.equal(r.head, 'abc123');
  assert.deepEqual(r.clean, ['CLAUDE.md', '.claude/settings.json', '.beads/config.yaml']);
  assert.equal(fs['/snap/HEAD'], 'abc123');
  assert.equal(fs['/snap/files/.beads/config.yaml'], 'sync.remote: "https://dolthub"');
  assert.equal(fs['/snap/files/GEMINI.md'], undefined, 'a dirty file must not be captured');
});

test('snapshot skips a bd-owned file that does not exist', () => {
  const { deps, fs } = makeDeps({
    files: { 'CLAUDE.md': 'x' },
    git: gitAt('abc123', ['CLAUDE.md', 'GEMINI.md', '.claude/settings.json', '.beads/config.yaml']),
  });
  const r = snapshot('/snap', deps);
  assert.deepEqual(r.clean, ['CLAUDE.md']);
  assert.equal(fs['/snap/clean.txt'], 'CLAUDE.md\n');
});

test('snapshot tolerates a repo with no HEAD', () => {
  const { deps, fs } = makeDeps({ files: { 'CLAUDE.md': 'x' }, git: gitAt(null, ['CLAUDE.md']) });
  const r = snapshot('/snap', deps);
  assert.equal(r.head, null);
  assert.equal(fs['/snap/HEAD'], '');
});

// ---------------------------------------------------------------------------
// restore
// ---------------------------------------------------------------------------

/** Snapshot state as it exists on disk after a `snapshot` run, for restore tests. */
function snapFiles(head, files) {
  const out = { '/snap/HEAD': head, '/snap/clean.txt': `${Object.keys(files).join('\n')}\n` };
  for (const [f, c] of Object.entries(files)) out[`/snap/files/${f}`] = c;
  return out;
}

test('restore rewrites a file bd changed and leaves an untouched one alone', () => {
  const { deps, fs, logs } = makeDeps({
    files: {
      ...snapFiles('abc123', { 'CLAUDE.md': 'original', '.beads/config.yaml': 'flat: key' }),
      'CLAUDE.md': 'original',                 // bd left this one alone
      '.beads/config.yaml': 'sync:\n  remote: x', // bd rewrote this one
    },
    git: gitAt('abc123', []),
  });

  const r = restore('/snap', deps);

  assert.equal(r.ok, true);
  assert.equal(r.reset, false, 'HEAD did not move, so nothing to reset');
  assert.deepEqual(r.reverted, ['.beads/config.yaml']);
  assert.equal(fs['.beads/config.yaml'], 'flat: key');
  assert.equal(logs.some((l) => l.includes('reverted .beads/config.yaml')), true);
});

test('restore resets HEAD with --mixed when every new commit is bd-owned', () => {
  const { deps, fs, calls, logs } = makeDeps({
    files: {
      ...snapFiles('abc123', { '.beads/config.yaml': 'flat: key' }),
      '.beads/config.yaml': 'sync:\n  remote: x',
    },
    git: (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: 'c1\nc2\n', stderr: '' };
      if (args[0] === 'log') return { status: 0, stdout: 'bd: update sync.remote\n', stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: '\n.beads/config.yaml\n', stderr: '' };
      return undefined;
    },
  });

  const r = restore('/snap', deps);

  assert.equal(r.reset, true);
  // The exact form is the assertion: --hard here would discard uncommitted work.
  assert.ok(calls.includes('git reset --mixed abc123'), `argv was: ${calls.join(' | ')}`);
  assert.ok(!calls.some((c) => c.includes('reset --hard')), 'must never reset --hard');
  // ...and the file content is put back by the restore loop, not by the reset.
  assert.equal(fs['.beads/config.yaml'], 'flat: key');
  assert.equal(logs.some((l) => l.includes('reset HEAD back to abc123')), true);
});

test('restore REFUSES to reset when a new commit is not bd-owned, and says why', () => {
  const { deps, calls, warns } = makeDeps({
    files: snapFiles('abc123', {}),
    git: (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: 'c1\n', stderr: '' };
      if (args[0] === 'log') return { status: 0, stdout: 'feat: someone real work\n', stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: '\nsrc/app/page.tsx\n', stderr: '' };
      return undefined;
    },
  });

  const r = restore('/snap', deps);

  assert.equal(r.reset, false);
  assert.ok(!calls.some((c) => c.startsWith('git reset')), 'must not reset on a foreign commit');
  const text = warns.join('\n');
  assert.ok(text.includes('HEAD moved during setup'), text);
  assert.ok(text.includes('feat: someone real work'), text);
  assert.ok(text.includes('src/app/page.tsx'), text);
});

test('restore REFUSES to reset when the commit range cannot be read', () => {
  const { deps, calls } = makeDeps({
    files: snapFiles('abc123', {}),
    git: (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { status: 128, stdout: '', stderr: 'fatal' };
      return undefined;
    },
  });
  const r = restore('/snap', deps);
  assert.equal(r.reset, false);
  assert.ok(!calls.some((c) => c.startsWith('git reset')));
});

test('restore still puts files back when it refused to reset HEAD', () => {
  // The two halves are independent: a foreign commit must not cost the contributor the
  // file restore, which is safe regardless.
  const { deps, fs } = makeDeps({
    files: {
      ...snapFiles('abc123', { 'CLAUDE.md': 'original' }),
      'CLAUDE.md': 'bd appended a managed block',
    },
    git: (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: 'c1\n', stderr: '' };
      if (args[0] === 'log') return { status: 0, stdout: 'feat: real\n', stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: '\nsrc/x.ts\n', stderr: '' };
      return undefined;
    },
  });
  const r = restore('/snap', deps);
  assert.equal(r.reset, false);
  assert.deepEqual(r.reverted, ['CLAUDE.md']);
  assert.equal(fs['CLAUDE.md'], 'original');
});

test('restore reports a failed git reset instead of claiming success', () => {
  const { deps, warns } = makeDeps({
    files: snapFiles('abc123', {}),
    git: (args) => {
      if (args[0] === 'rev-parse') return { status: 0, stdout: 'def456\n', stderr: '' };
      if (args[0] === 'rev-list') return { status: 0, stdout: 'c1\n', stderr: '' };
      if (args[0] === 'log') return { status: 0, stdout: 'bd: update sync.remote\n', stderr: '' };
      if (args[0] === 'show') return { status: 0, stdout: '\n.beads/config.yaml\n', stderr: '' };
      if (args[0] === 'reset') return { status: 1, stdout: '', stderr: 'nope' };
      return undefined;
    },
  });
  const r = restore('/snap', deps);
  assert.equal(r.reset, false);
  assert.ok(warns.join('\n').includes('git reset --mixed abc123 failed'));
});

test('restore on a missing snapshot warns and does nothing', () => {
  const { deps, calls, warns } = makeDeps({ files: {}, git: gitAt('abc123', []) });
  const r = restore('/snap', deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no-snapshot');
  assert.ok(!calls.some((c) => c.startsWith('git reset')));
  assert.ok(warns.join('\n').includes('no snapshot'));
});

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

test('main dispatches snapshot and restore, and always exits 0', () => {
  const a = makeDeps({ files: { 'CLAUDE.md': 'x' }, git: gitAt('abc123', ['CLAUDE.md']) });
  assert.equal(main(['snapshot', '/snap'], a.deps), 0);
  assert.equal(a.fs['/snap/HEAD'], 'abc123');

  const b = makeDeps({ files: a.fs, git: gitAt('abc123', ['CLAUDE.md']) });
  assert.equal(main(['restore', '/snap'], b.deps), 0);
});

test('main returns 2 on a bad invocation', () => {
  const { deps, warns } = makeDeps();
  assert.equal(main([], deps), 2);
  assert.equal(main(['snapshot'], deps), 2, 'a missing dir is a usage error');
  assert.equal(main(['bogus', '/snap'], deps), 2);
  assert.ok(warns.join('\n').includes('Usage:'));
});

test('main swallows a thrown error so a setup script continues', () => {
  // The guard is a tidy-up, not a prerequisite: a crash here must not cost the contributor
  // the steps that come after it under `set -e`.
  const { deps, warns } = makeDeps({ files: {}, git: gitAt('abc123', ['CLAUDE.md']) });
  deps.mkdir = () => { throw new Error('boom'); };
  assert.equal(main(['snapshot', '/snap'], deps), 0);
  assert.ok(warns.join('\n').includes('boom'));
});
