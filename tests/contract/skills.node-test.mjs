// The contract the vendored process skills keep. A skill is prose a consumer's agents read, so
// the properties worth guarding are structural:
//
//  1. Every vendored SKILL.md has YAML frontmatter with a non-empty `name` (equal to its
//     directory) and `description`, because harnesses discover a skill from them.
//  2. A consumer's own advice lives in a consumer-owned overlay, `LOCAL.md`, beside the skill.
//     Sync never reads, writes or lists it, so a vendored skill must read correctly without one:
//     any mention of LOCAL.md is introduced as optional ("If a `LOCAL.md` exists beside this
//     file ..."), and no LOCAL.md is ever in the manifest or under a vendored root.
//  3. Neutrality (no consumer names, people or hostnames) is enforced for every vendored file by
//     manifest.node-test.mjs; the skills are covered there too.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseManifest, selectFiles } from '../../scripts/agent-tooling-sync.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(REPO, 'manifest.json'), 'utf8')));
const all = selectFiles(manifest, ['all']);

const SKILL_RE = /^\.agents\/skills\/([^/]+)\/SKILL\.md$/;
const skillFiles = all.filter((f) => SKILL_RE.test(f));

/** Parse the leading `---` frontmatter into a flat key map (values are single-line strings). */
export function frontmatterOf(source) {
  const m = source.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^"(.*)"$/s, '$1');
  }
  return out;
}

const OPTIONAL_INTRO = /If a `LOCAL\.md` exists beside this file/;

test('the skills set ships the process skills (so the checks below have something to read)', () => {
  assert.ok(manifest.sets.skills.length > 0, 'sets.skills is empty');
  const names = new Set(skillFiles.map((f) => f.match(SKILL_RE)[1]));
  for (const expected of [
    'ask-review',
    'bead-chains',
    'bead-workflow',
    'beads-bulk',
    'beads-hygiene',
    'dependabot-handler',
    'mvp-readiness',
    'prompt-next-work',
    'recurring-task',
    'window-review',
  ]) {
    assert.ok(names.has(expected), `missing skill: ${expected}`);
  }
});

test('every vendored SKILL.md has frontmatter with a name matching its directory and a description', () => {
  const bad = [];
  for (const file of skillFiles) {
    const dir = file.match(SKILL_RE)[1];
    const fm = frontmatterOf(readFileSync(path.join(REPO, file), 'utf8'));
    if (!fm) {
      bad.push(`${file}: no frontmatter`);
      continue;
    }
    if (fm.name !== dir) bad.push(`${file}: name ${JSON.stringify(fm.name)} is not ${JSON.stringify(dir)}`);
    if (!fm.description || fm.description.length < 20) bad.push(`${file}: missing or trivial description`);
  }
  assert.deepEqual(bad, []);
});

test('frontmatter parsing sees what it is meant to (so a clean result means something)', () => {
  assert.deepEqual(frontmatterOf('---\nname: x\ndescription: "a b"\n---\n# T\n'), { name: 'x', description: 'a b' });
  assert.equal(frontmatterOf('# T\nno frontmatter\n'), null);
});

test('a vendored SKILL.md that mentions LOCAL.md introduces it as optional, first', () => {
  const bad = [];
  for (const file of skillFiles) {
    const source = readFileSync(path.join(REPO, file), 'utf8');
    const first = source.search(/LOCAL\.md/);
    if (first < 0) continue;
    const intro = source.search(OPTIONAL_INTRO);
    if (intro < 0) bad.push(`${file}: mentions LOCAL.md but never says it is optional`);
    else if (intro > first) bad.push(`${file}: LOCAL.md is mentioned before the optional introduction`);
    if (/\b(?:requires?|must have|needs) (?:a |an |the )?`?LOCAL\.md/i.test(source)) {
      bad.push(`${file}: treats LOCAL.md as required`);
    }
  }
  assert.deepEqual(bad, []);
});

test('no LOCAL.md is listed in the manifest (overlays are consumer-owned; sync never touches them)', () => {
  const listed = all.filter((f) => path.posix.basename(f) === 'LOCAL.md');
  assert.deepEqual(listed, []);
  assert.deepEqual(
    JSON.stringify(manifest).match(/LOCAL\.md/g) ?? [],
    [],
    'manifest.json mentions LOCAL.md',
  );
});
