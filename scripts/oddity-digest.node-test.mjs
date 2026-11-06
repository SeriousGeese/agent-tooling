// Tests for scripts/oddity-digest.mjs, the body renderer behind a repo's scheduled upstream check.
// A consumer's own tests cover its workflow file and its real archive, registry and inbox.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { removeTempDir } from './test-support/hygiene-temp-dir.mjs';
import { tryLoadConfig } from './agent-tooling-config.mjs';
import {
  NO_REPO_LABEL,
  SWEEP_LAPSE_DAYS,
  daysSince,
  groupByRepo,
  listInbox,
  parseRepoList,
  renderDigest,
  renderUpstreamSection,
  stalenessLine,
} from './oddity-digest.mjs';

const cli = path.resolve('scripts/oddity-digest.mjs');

// The bead prefix the repo configures (any prefix when it sets none): archive ids in fixtures use it.
const BP = tryLoadConfig().config.beadPrefix ?? 'bd';
// Repos the digest always lists, even at zero.
const KNOWN_REPOS = ['acme', 'tools-repo', 'game-repo'];

const REGISTRY = {
  entries: [
    { repo: 'anthropics/claude-code', issue: 1, title: 'still broken', lastChecked: '2026-09-05', lastKnownState: 'OPEN' },
    { repo: 'anthropics/claude-code', issue: 2, title: 'fixed upstream', lastChecked: '2026-09-05', lastKnownState: 'OPEN' },
    { repo: 'anthropics/claude-code', issue: 3, title: 'unreadable', lastChecked: '2026-09-01', lastKnownState: 'CLOSED' },
  ],
};
const UPSTREAM = {
  retire: ['anthropics/claude-code#2'],
  unknown: ['anthropics/claude-code#3'],
  states: {
    'anthropics/claude-code#1': { state: 'OPEN', updatedAt: '2026-09-10T00:00:00Z' },
    'anthropics/claude-code#2': { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-09-11T08:00:00Z' },
  },
};
const ODDITIES = [
  { id: `${BP}-aaaa1`, title: 'acme thing', status: 'open', priority: 3, labels: ['tooling-oddity', 'repo:acme'], created_at: '2026-09-10T00:00:00Z' },
  { id: `${BP}-aaaa2`, title: 'acme recurrence', status: 'open', priority: 2, labels: ['tooling-oddity', 'repo:acme', 'recurrence'], created_at: '2026-09-12T00:00:00Z' },
  { id: `${BP}-bbbb1`, title: 'cloud thing', status: 'in_progress', priority: 3, labels: ['tooling-oddity', 'repo:tools-repo'], created_at: '2026-09-01T00:00:00Z' },
  { id: `${BP}-cccc1`, title: 'old unlabelled', status: 'deferred', priority: 4, labels: ['tooling-oddity'], created_at: '2026-08-01T00:00:00Z' },
  { id: `${BP}-dddd1`, title: 'already closed', status: 'closed', priority: 3, labels: ['tooling-oddity', 'repo:game-repo'], created_at: '2026-08-01T00:00:00Z' },
];

test('daysSince: whole days between ISO dates, null on garbage', () => {
  assert.equal(daysSince('2026-09-05', '2026-09-13'), 8);
  assert.equal(daysSince('2026-09-13T23:00:00Z', '2026-09-13'), 0);
  assert.equal(daysSince('not a date', '2026-09-13'), null);
  assert.equal(daysSince(undefined, '2026-09-13'), null);
});

test('stalenessLine: days since the newest lastChecked, names the oldest, and flags a lapsed sweep', () => {
  const line = stalenessLine(REGISTRY, '2026-09-13');
  assert.match(line, /8 day\(s\) since the registry's lastChecked \(2026-09-05\)/);
  assert.match(line, /oldest entry: 2026-09-01, 12 days/);
  assert.doesNotMatch(line, /lapsed/);
  const late = stalenessLine(REGISTRY, '2026-09-30');
  assert.ok(daysSince('2026-09-05', '2026-09-30') > SWEEP_LAPSE_DAYS);
  assert.match(late, /weekly sweep appears to have lapsed/);
  assert.match(stalenessLine({ entries: [{}] }, '2026-09-13'), /no entry carries a `lastChecked`/);
});

test('upstream section: CLOSED is a RETIRE line naming the desktop verify command; OPEN stays; missing is UNKNOWN, never open', () => {
  const { lines, retire, unknown, open } = renderUpstreamSection(REGISTRY, UPSTREAM);
  const text = lines.join('\n');
  assert.equal(retire, 1);
  assert.equal(unknown, 1);
  assert.equal(open, 1);
  assert.match(text, /\*\*RETIRE\*\* `anthropics\/claude-code#2` — fixed upstream\. Closed upstream \(COMPLETED 2026-09-11\) — run `node scripts\/oddity\.mjs verify 2` in a desktop session\./);
  assert.match(text, /open `anthropics\/claude-code#1` — still broken; workaround stays/);
  assert.match(text, /\*\*UNKNOWN\*\* `anthropics\/claude-code#3`.*last known CLOSED on 2026-09-01/);
  assert.match(text, /does NOT retire them/);
});

test('upstream section: no upstream output at all says the check did not run, and counts every entry unknown', () => {
  const { lines, unknown, retire } = renderUpstreamSection(REGISTRY, null);
  assert.equal(unknown, 3);
  assert.equal(retire, 0);
  assert.match(lines.join('\n'), /upstream check did not run/);
});

test('groupByRepo: every known repo appears even at zero, closed rows dropped, unlabelled rows kept visibly', () => {
  const groups = groupByRepo(ODDITIES, KNOWN_REPOS);
  for (const r of KNOWN_REPOS) assert.ok(groups.has(r), `missing ${r}`);
  assert.deepEqual(groups.get('acme').map((r) => r.id), [`${BP}-aaaa1`, `${BP}-aaaa2`]);
  assert.deepEqual(groups.get('tools-repo').map((r) => r.id), [`${BP}-bbbb1`]);
  assert.deepEqual(groups.get('game-repo'), [], 'a closed row is not an open entry');
  assert.deepEqual(groups.get(NO_REPO_LABEL).map((r) => r.id), [`${BP}-cccc1`]);
});

test('renderDigest: summary counts, recurrence first, per-repo sections, staleness, footer', () => {
  const { body, counts } = renderDigest({ registry: REGISTRY, upstream: UPSTREAM, oddities: ODDITIES, today: '2026-09-13', runUrl: 'https://example.test/run/1', knownRepos: KNOWN_REPOS });
  assert.deepEqual(counts, { retire: 1, unknown: 1, open: 1, total: 4, unarchived: null, parked: 0 });
  assert.match(body, /^Tooling-oddities check for \*\*2026-09-13\*\* — retire 1 · unknown 1 · open upstream 1 · open entries 4\n/);
  assert.match(body, /https:\/\/example\.test\/run\/1/);
  assert.match(body, /### repo:acme — 2/);
  assert.match(body, /### repo:game-repo — 0\n\n_none_/);
  assert.match(body, /### \(no repo label\) — 1/);
  assert.ok(body.indexOf(`${BP}-aaaa2`) < body.indexOf(`${BP}-aaaa1`), 'the recurrence lists before the plain entry');
  assert.match(body, new RegExp(String.raw`\`${BP}-aaaa2\` acme recurrence \(P2, open, RECURRENCE, 1d old\)`));
  assert.match(body, /Registry staleness/);
  assert.doesNotMatch(body, /\n{3,}/, 'no runs of blank lines');
  assert.doesNotMatch(body, new RegExp(`${BP}-dddd1`));
});

test('renderDigest: closed-but-unarchived entries are counted and listed when the closed listing and archive are both given', () => {
  const archiveText = `## 75. old\n\n- **Date:** 2026-09-05 · **Repo:** Acme (bead ${BP}-dddd1)\n`;
  const closed = [
    { id: `${BP}-dddd1`, title: 'already archived', status: 'closed', closed_at: '2026-09-05T00:00:00Z', labels: ['tooling-oddity'] },
    { id: `${BP}-eeee1`, title: 'fixed by PR', status: 'closed', closed_at: '2026-09-08T00:00:00Z', labels: ['tooling-oddity', 'repo:acme'], close_reason: 'Auto-closed: merged via PR #3170 (fix)' },
    { id: `${BP}-eeee2`, title: 'fixed by hand', status: 'closed', closed_at: '2026-09-12T00:00:00Z', labels: ['tooling-oddity'], close_reason: 'Closed' },
  ];
  const { body, counts } = renderDigest({ registry: REGISTRY, upstream: UPSTREAM, oddities: ODDITIES, closed, archiveText, today: '2026-09-13' });
  assert.equal(counts.unarchived, 2);
  assert.match(body, /open entries 4 · unarchived 2\n/);
  assert.match(body, /## Closed by a PR, not yet archived\n\n2 closed entries with no Resolution block in the archive \(oldest closed 2026-09-08, 5d ago\)/);
  assert.match(body, new RegExp(String.raw`- \`${BP}-eeee1\` fixed by PR \(PR #3170\)\n- \`${BP}-eeee2\` fixed by hand\n`));
  assert.doesNotMatch(body, new RegExp(String.raw`${BP}-dddd1\` already archived`));

  // Without the pair, no section and no count, never a misleading zero.
  const without = renderDigest({ registry: REGISTRY, upstream: UPSTREAM, oddities: ODDITIES, closed, today: '2026-09-13' });
  assert.equal(without.counts.unarchived, null);
  assert.doesNotMatch(without.body, /unarchived|not yet archived/);
  const clean = renderDigest({ registry: REGISTRY, upstream: UPSTREAM, oddities: ODDITIES, closed: [closed[0]], archiveText, today: '2026-09-13' });
  assert.equal(clean.counts.unarchived, 0);
  assert.match(clean.body, /_none — every closed entry has an archive block\._/);
});

test('renderDigest: a skipped digest says why and never lists entries', () => {
  const { body, counts } = renderDigest({ registry: REGISTRY, upstream: UPSTREAM, oddities: null, unavailable: 'bd is not on this runner', today: '2026-09-13' });
  assert.equal(counts.total, null);
  assert.match(body, /open entries n\/a \(digest skipped\)/);
  assert.match(body, /_Digest skipped: bd is not on this runner\. Not reconstructed from older data/);
  assert.doesNotMatch(body, /### repo:/);
  assert.match(body, /\n\n---\n/, 'a line directly above --- would render as a heading');
});

test('renderDigest: a freshness note and parked cloud-session entries are both surfaced', () => {
  const { body, counts } = renderDigest({
    registry: REGISTRY,
    upstream: UPSTREAM,
    oddities: [],
    note: 'The DoltHub pull failed on the runner.',
    inboxFiles: ['2026-09-13-cloud-thing.md'],
    today: '2026-09-13',
  });
  assert.equal(counts.parked, 1);
  assert.match(body, /_The DoltHub pull failed on the runner\._/);
  assert.match(body, /## Parked by cloud sessions, not yet filed/);
  assert.match(body, /`2026-09-13-cloud-thing\.md`/);
});

test('listInbox: markdown entries only, README excluded, missing dir is empty', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oddity-inbox-'));
  try {
    writeFileSync(path.join(dir, 'README.md'), 'x');
    writeFileSync(path.join(dir, 'b.md'), 'x');
    writeFileSync(path.join(dir, 'a.md'), 'x');
    writeFileSync(path.join(dir, 'note.txt'), 'x');
    assert.deepEqual(listInbox(dir), ['a.md', 'b.md']);
    assert.deepEqual(listInbox(path.join(dir, 'nope')), []);
  } finally {
    removeTempDir(dir, 'oddity-digest.node-test');
  }
});

test('CLI: renders from files, degrades an unreadable listing to "skipped", rejects unknown flags', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'oddity-digest-'));
  try {
    const reg = path.join(dir, 'reg.json');
    const up = path.join(dir, 'up.json');
    const odd = path.join(dir, 'odd.json');
    const bad = path.join(dir, 'bad.json');
    writeFileSync(reg, JSON.stringify(REGISTRY));
    writeFileSync(up, JSON.stringify(UPSTREAM));
    writeFileSync(odd, JSON.stringify(ODDITIES));
    writeFileSync(bad, '{ not json');

    const ok = spawnSync(process.execPath, [cli, '--registry', reg, '--upstream-json', up, '--oddities-json', odd, '--today', '2026-09-13'], { encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /open entries 4/);

    const broken = spawnSync(process.execPath, [cli, '--registry', reg, '--upstream-json', bad, '--oddities-json', bad, '--today', '2026-09-13'], { encoding: 'utf8' });
    assert.equal(broken.status, 0, broken.stderr);
    assert.match(broken.stdout, /upstream check did not run/);
    assert.match(broken.stdout, /Digest skipped: the bead listing at .* was missing or not a JSON array/);

    const unknownFlag = spawnSync(process.execPath, [cli, '--registry', reg, '--write'], { encoding: 'utf8' });
    assert.equal(unknownFlag.status, 2);
    assert.match(unknownFlag.stderr, /unknown argument --write/);
  } finally {
    removeTempDir(dir, 'oddity-digest.node-test');
  }
});

test('parseRepoList trims, lower-cases and drops empty names; --known-repos lists repos at zero', () => {
  assert.deepEqual(parseRepoList(' Acme, tools-repo ,,'), ['acme', 'tools-repo']);
  assert.deepEqual(parseRepoList(undefined), []);
  const dir = mkdtempSync(path.join(tmpdir(), 'oddity-digest-known-'));
  try {
    const reg = path.join(dir, 'reg.json');
    const odd = path.join(dir, 'odd.json');
    writeFileSync(reg, JSON.stringify(REGISTRY));
    writeFileSync(odd, JSON.stringify([]));
    const r = spawnSync(process.execPath, [cli, '--registry', reg, '--oddities-json', odd, '--known-repos', 'acme,game-repo', '--today', '2026-09-13'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /### repo:acme — 0\n\n_none_/);
    assert.match(r.stdout, /### repo:game-repo — 0\n\n_none_/);
  } finally {
    removeTempDir(dir, 'oddity-digest.node-test');
  }
});
