import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { anchoredBeadIds, branchBeadId, anchorProblems, templateProblems, sizeProblems, migrationCollisions, checkMetadata, main, loadBeadConfig,
  BODY_LIMIT } from './pr-metadata.mjs';

// The pull_request_template.md a consumer ships: the sections and the unfilled placeholder.
const TEMPLATE = [
  '## Summary', '', '<!-- What changed and why. -->', '', 'Fixes: bd-', '',
  '<!-- The bead ids this PR completes, comma separated (Closes:, Resolves: and Bead: also work).',
  '     A PR that only advances a bead says "Part of bd-xxxx" here instead. Not bead work: "Fixes: none". -->', '',
  '## Verification', '', '<!-- What you ran. -->', '',
].join('\n');
const good = '## Summary\n\nA change.\n\nFixes: bd-abcde, bd-fghij.2\n\n## Verification\n\nnpm test\n';
const cfg = { beadPrefix: 'bd' };

test('anchoredBeadIds reads every anchor keyword and strips an (epic ...) parenthetical', () => {
  assert.deepEqual(anchoredBeadIds('Fixes: bd-aaaaa (epic bd-zzzzz)\nCloses: bd-bbbbb.3\nResolves: `bd-ccccc`\nBead: bd-ddddd', cfg),
    ['bd-aaaaa', 'bd-bbbbb.3', 'bd-ccccc', 'bd-ddddd']);
  assert.deepEqual(anchoredBeadIds('Part of bd-aaaaa', cfg), []);
});

test('an id written with markdown emphasis or code is still an anchor', () => {
  for (const id of ['_bd-abc12_', '**bd-abc12**', '`bd-abc12`', '*bd-abc12*']) {
    assert.deepEqual(anchoredBeadIds(`Fixes: ${id}`, cfg), ['bd-abc12'], id);
    assert.deepEqual(anchorProblems(`Fixes: ${id}`, 'feat/x-bd-abc12', cfg), [], id);
  }
});

test('a broken agent-tooling.json warns as a GitHub annotation and the checks run with defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-metadata-cfg-'));
  try {
    fs.writeFileSync(path.join(dir, 'agent-tooling.json'), '{ not json');
    let err = '';
    const config = loadBeadConfig({ root: dir, stderr: { write: chunk => { err += chunk; } } });
    assert.equal(config.beadPrefix, null);
    assert.match(err, /^::warning title=PR metadata::agent-tooling\.json is unusable/);
    assert.match(err, /not valid JSON/);
    assert.equal(err.trim().split('\n').length, 1);
    // A good (or absent) config is silent.
    err = '';
    fs.writeFileSync(path.join(dir, 'agent-tooling.json'), '{"beadPrefix":"bd"}');
    assert.equal(loadBeadConfig({ root: dir, stderr: { write: chunk => { err += chunk; } } }).beadPrefix, 'bd');
    assert.equal(err, '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('branchBeadId takes only the id the branch ends in', () => {
  assert.equal(branchBeadId('feat/thing-bd-abc12', cfg), 'bd-abc12');
  assert.equal(branchBeadId('feat/bd-abc12.4', cfg), 'bd-abc12.4');
  assert.equal(branchBeadId('feat/bd-abc12-followup', cfg), null);
  assert.equal(branchBeadId('main', cfg), null);
});

test('a bead-derived branch needs its id on an anchor line or a Part of sentence', () => {
  assert.deepEqual(anchorProblems(good, 'feat/x-bd-abcde', cfg), []);
  assert.deepEqual(anchorProblems('## Summary\nPart of bd-abcde, a slice.\n## Verification\n', 'feat/x-bd-abcde', cfg), []);
  const problems = anchorProblems('## Summary\nFixes: bd-other\n## Verification\n', 'feat/x-bd-abcde', cfg);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /ends in bd-abcde/);
  // A child id does not satisfy its parent: "Part of bd-abcde.2" is not "Part of bd-abcde".
  assert.equal(anchorProblems('Part of bd-abcde.2', 'feat/bd-abcde', cfg).length, 1);
});

test('the template placeholder and malformed ids are failures; "none" is allowed', () => {
  assert.match(anchorProblems(TEMPLATE, 'feat/no-bead', cfg)[0], /names no bead id|not a bead id/);
  assert.match(anchorProblems('Fixes: bd-xxxx', 'feat/no-bead', cfg)[0], /not a bead id/);
  assert.match(anchorProblems('Fixes: #123', 'feat/no-bead', cfg)[0], /not a bead id/);
  assert.deepEqual(anchorProblems('Fixes: none (dependency bump)', 'feat/no-bead', cfg), []);
  assert.deepEqual(anchorProblems('Fixes: bd-abcde, bd-fghij.2 (epic bd-zzzzz)', 'feat/no-bead', cfg), []);
  assert.deepEqual(anchorProblems('No anchor at all', 'feat/no-bead', cfg), []);
});

test('the bead prefix comes from config: another prefix is not a bead id, and no prefix accepts any', () => {
  assert.match(anchorProblems('Fixes: zz-abcde', 'feat/no-bead', cfg)[0], /not a bead id of the form bd-xxxxx or bd-xxxxx\.N/);
  assert.deepEqual(anchorProblems('Fixes: zz-abcde, bd-fghij.2', 'feat/no-bead', { beadPrefix: null }), []);
  assert.match(anchorProblems('Fixes: zz-xxxx', 'feat/no-bead', { beadPrefix: null })[0], /not a bead id/);
  // No prefix: any `word-word` ending would read as an id, so a branch never implies one.
  assert.equal(branchBeadId('feat/x-zz-abc12', { beadPrefix: null }), null);
  assert.deepEqual(anchorProblems('No anchor', 'feat/fix-login', { beadPrefix: null }), []);
  assert.equal(branchBeadId('feat/x-zz-abc12', cfg), null);
});

test('the template sections are required for people and not for bots', () => {
  assert.deepEqual(templateProblems(good, 'someone'), []);
  assert.equal(templateProblems('Fixes: bd-abcde', 'someone').length, 2);
  assert.deepEqual(templateProblems('Bumps foo from 1 to 2.', 'dependabot[bot]'), []);
  assert.deepEqual(templateProblems(TEMPLATE, 'someone'), []);
});

test('the body size is bounded', () => {
  assert.deepEqual(sizeProblems('x'.repeat(BODY_LIMIT)), []);
  assert.equal(sizeProblems('x'.repeat(BODY_LIMIT + 1)).length, 1);
});

test('a migration number the base already holds is a collision; a new number is not', () => {
  const dir = 'db/migrations';
  const base = [`${dir}/0040_a.sql`, `${dir}/0041_b.sql`, `${dir}/meta/0041_snapshot.json`];
  assert.deepEqual(migrationCollisions([`${dir}/0042_c.sql`, `${dir}/meta/0042_snapshot.json`], base, dir), []);
  const problems = migrationCollisions([`${dir}/0041_mine.sql`], base, dir);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /number 0041, which the base branch already holds as db\/migrations\/0041_b\.sql/);
  // The snapshot is not counted twice.
  assert.deepEqual(migrationCollisions([`${dir}/meta/0041_snapshot.json`], base, dir), []);
  // No migrations directory configured: the check is off.
  assert.deepEqual(migrationCollisions([`${dir}/0041_mine.sql`], base), []);
});

test('checkMetadata groups every problem and the CLI prints annotations and exits 1', async () => {
  const result = checkMetadata({ body: 'Fixes: bd-xxxx', headRef: 'feat/bd-abcde', author: 'someone', config: cfg });
  assert.equal(result.ok, false);
  assert.equal(result.problems.anchor.length, 2);
  assert.equal(result.problems.template.length, 2);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-metadata-'));
  try {
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, good);
    let out = '';
    const stdout = { write: chunk => { out += chunk; } };
    const args = ['--body-file', bodyFile, '--head-ref', 'feat/bd-abcde', '--author', 'someone'];
    // No migrations directory: no git is read, and the metadata checks alone decide.
    assert.equal(await main(args, { cwd: dir, stdout, stderr: stdout, config: cfg }), 0);
    assert.match(out, /pr-metadata: ok/);
    // With one and no git repository here: the collision check cannot run and must say so rather than pass.
    out = '';
    const code = await main([...args, '--migrations-dir', 'db/migrations'], { cwd: dir, stdout, stderr: stdout, config: cfg });
    assert.equal(code, 1);
    assert.match(out, /migration-number check could not read git/);
    assert.equal(await main([], { cwd: dir, stdout, stderr: stdout }), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI catches a migration number the base branch already took, in a real repository', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-metadata-git-'));
  try {
    const run = (...args) => {
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, `${args.join(' ')}: ${r.stderr}`);
    };
    run('init', '-q', '-b', 'main');
    fs.mkdirSync(path.join(dir, 'db', 'migrations'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'db', 'migrations', '0001_a.sql'), 'select 1;\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'base');
    run('branch', 'base-tip');
    run('checkout', '-q', '-b', 'topic');
    fs.writeFileSync(path.join(dir, 'db', 'migrations', '0001_mine.sql'), 'select 2;\n');
    run('add', '-A');
    run('commit', '-q', '-m', 'topic');
    const bodyFile = path.join(dir, 'body.md');
    fs.writeFileSync(bodyFile, good);
    let out = '';
    const stdout = { write: chunk => { out += chunk; } };
    const code = await main(['--body-file', bodyFile, '--head-ref', 'feat/x', '--base', 'base-tip', '--head', 'HEAD', '--migrations-dir', 'db/migrations'],
      { cwd: dir, stdout, stderr: stdout, config: cfg });
    assert.equal(code, 1);
    assert.match(out, /Migration db\/migrations\/0001_mine\.sql takes number 0001/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
