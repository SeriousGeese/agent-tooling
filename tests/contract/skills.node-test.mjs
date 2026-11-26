// The contract the vendored process skills keep. A skill is prose a consumer's agents read, so
// the properties worth guarding are structural:
//
//  1. Every vendored SKILL.md has YAML frontmatter with a non-empty `name` (equal to its
//     directory) and `description`, because harnesses discover a skill from them.
//  2. A consumer's own advice lives in a consumer-owned overlay, `LOCAL.md`, beside the skill.
//     Sync never reads, writes or lists it, so a vendored skill must read correctly without one:
//     any mention of LOCAL.md is introduced as optional ("If a `LOCAL.md` exists beside this
//     file ..."), and no LOCAL.md is ever in the manifest (one on disk under a vendored root
//     would also fail manifest.node-test.mjs, which requires every file there to be listed).
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
  const m = source.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].trim().replace(/^"(.*)"$/s, '$1');
  }
  return out;
}

const OPTIONAL_INTRO = /If a `LOCAL\.md` exists beside this file/;

/** Phrasings that make LOCAL.md sound mandatory or the only home of a step the skill needs. */
export const REQUIRED_PHRASING = [
  /\b(?:requires?|must have|needs|cannot run without|can't run without|depends on) (?:a |an |the )?`?LOCAL\.md/i,
  /\bwithout (?:a |an |the )?`?LOCAL\.md`?,? (?:it |this |the skill )?(?:cannot|can't|will not|won't|does not work)/i,
  /\b(?:named|listed|described|defined|given|carried|specified|documented) (?:in|by) (?:the )?`?LOCAL\.md/i,
  /`LOCAL\.md` (?:carries|names|lists|has the|holds the|defines|specifies|contains)/i,
  /\b(?:is|are) (?:in|listed in|named in) `LOCAL\.md`/i,
  /\bsee `LOCAL\.md`/i,
];

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
    for (const re of REQUIRED_PHRASING) {
      const hit = source.match(re);
      if (hit) bad.push(`${file}: treats LOCAL.md as required or the only source (${JSON.stringify(hit[0])})`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the required-phrasing detector catches each phrasing it is meant to', () => {
  for (const s of [
    'a LOCAL.md is required: it needs a `LOCAL.md` here',
    'cannot run without LOCAL.md',
    'the command named in `LOCAL.md`',
    'the table is listed in `LOCAL.md`',
    '`LOCAL.md` carries the table',
    '`LOCAL.md` names the helper',
    'the URL is in `LOCAL.md`',
    'see `LOCAL.md`',
  ]) {
    assert.ok(REQUIRED_PHRASING.some((re) => re.test(s)), `not caught: ${s}`);
  }
  assert.ok(!REQUIRED_PHRASING.some((re) => re.test('If a `LOCAL.md` exists beside this file, read it first: it holds specifics.')));
});

test('frontmatterOf reads CRLF files', () => {
  assert.deepEqual(frontmatterOf('---\r\nname: x\r\ndescription: y\r\n---\r\n# T\r\n'), { name: 'x', description: 'y' });
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

// A lead's merge watcher exited on the absence of checks:PENDING and reported a finished run while
// jobs were still pending: a head with no check run yet prints checks:NONE, which lacks PENDING too.
test('the beads-bulk merge Monitor exits only on positive terminal tokens', () => {
  const text = readFileSync(path.join(REPO, '.agents', 'skills', 'beads-bulk', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const monitor = text.split('\n').find((l) => l.startsWith('Track merges with a `Monitor`'));
  assert.ok(monitor, 'the Track merges paragraph is still there');
  assert.match(monitor, /Exit only on a positive terminal token/);
  for (const token of ['`merged`', '`closed`', '`checks:SUCCESS`', '`checks:FAILURE`', '`checks:ERROR`', '`checks:NONE`']) {
    assert.ok(monitor.includes(token), `names ${token}`);
  }
  assert.match(monitor, /never on the absence of `checks:PENDING`/);
});

// A handoff's takeover combined --if-assignee with --force, which bd 1.3.x rejects as a flag-group error
// before writing; the loop read that as "someone else holds it" for a bead nobody else held.
test('prompt-next-work takes beads over with --if-assignee alone and tells a refusal from a command error', () => {
  const text = readFileSync(path.join(REPO, '.agents', 'skills', 'prompt-next-work', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const takeovers = text.split('\n').filter((l) => /bd update\b.*--if-assignee/.test(l));
  assert.ok(takeovers.length >= 2, 'the takeover command is still written out');
  // The command itself: from `bd update` to the end of its code span (or line).
  for (const l of takeovers) {
    const command = /bd update[^`]*/.exec(l)[0];
    assert.doesNotMatch(command, /--force/, `never --force beside --if-assignee: ${command}`);
  }
  const block = text.slice(text.indexOf('### Take the beads over'), text.indexOf('### Watchers start first'));
  assert.match(block, /elif \[ "\$rc" -eq 13 \]; then/, 'exit 13 is the refusal');
  assert.match(block, /TAKEOVER STOPPED at \$refused: someone else holds it now \(exit 13\)/);
  assert.match(block, /TAKEOVER FAILED at \$failed: bd refused the command itself/);
});

// A print-mode worker started its gate in the background and ended its turn to wait; the process exited
// with no commit and no PR.
test('beads-bulk tells print-mode workers to run everything in the foreground, and documents resumable claude -p workers', () => {
  const text = readFileSync(path.join(REPO, '.agents', 'skills', 'beads-bulk', 'SKILL.md'), 'utf8').replace(/\r\n/g, '\n');
  const must = text.slice(text.indexOf('### Every implementation-subagent prompt MUST include'));
  assert.match(must, /When the worker runs as `claude -p` \(print mode\)[^\n]*Run every command in the foreground/);
  assert.match(text, /\*\*The parallel option for such a lead: `claude -p` workers\.\*\*/);
  assert.match(text, /claude -p --resume <session_id>/);
  assert.match(text, /--output-format stream-json/);
});
