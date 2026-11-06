#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, cpSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { removeTempDir } from './test-support/hygiene-temp-dir.mjs';
import { tryLoadConfig } from './agent-tooling-config.mjs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  ARCHIVE_REL,
  LABEL,
  RECURRENCE_LABEL,
  SELF_CHECK_FILES,
  SKIP_STALE_ENV,
  UPSTREAM_REL,
  VERIFY_EXIT,
  classifySelfVersion,
  staleCliMessage,
  buildCreateArgs,
  buildListArgs,
  entryTemplate,
  findArchiveEntry,
  formatVerifyLine,
  ghChildEnv,
  nextArchiveNumber,
  normalizeDrivePath,
  normalizeRepoName,
  parseArgs,
  recurrencePreamble,
  renderUpstream,
  repairMsysMangledTitle,
  repoLabel,
  repoNameFromRemoteUrl,
  resolveStoreCheckout,
  updateRegistry,
  upstreamKey,
  verdictNameForExit,
  verdictSymbolForExit,
  worstVerifyExit,
  archivedBeadIds,
  closingPrNumber,
  formatUnarchivedLines,
  unarchivedClosed,
} from './oddity-lib.mjs';

// The bead prefix the repo configures (any prefix when it sets none): archive ids in fixtures use it.
const BP = tryLoadConfig().config.beadPrefix ?? 'bd';

const cli = path.resolve('scripts/oddity.mjs');

const ARCHIVE = [
  '# Tooling Oddities — Archive',
  '',
  '## 14. claim.sh refuses to run from inside a worktree',
  '',
  '- **Date:** 2026-08-28 · **Repo:** Acme',
  '',
  `### Resolution (2026-08-29, bead ${BP}-qeges, PR #2680)`,
  '',
  `Fixed. Also touched ${BP}-3x93j.11.`,
  '',
  '---',
  '',
  '## 38. RECURRENCE of archived entries 17 / 26 / 31: MSYS mangles a PATH assignment too',
  '',
  '- **Date:** 2026-08-30',
  '',
  '# Resolved — second pass',
  '',
  '## 72. worktree-rm.sh accuses you of destroying a peer worktree',
  '',
  `- **Date:** 2026-09-03 · **Repo:** Acme (bead ${BP}-1r0lh)`,
  '',
].join('\n');

test('nextArchiveNumber continues the sequence past the highest header, never reusing', () => {
  assert.equal(nextArchiveNumber(ARCHIVE), 73);
  assert.equal(nextArchiveNumber(''), 1);
  assert.equal(nextArchiveNumber('## 5. five\n## 3. three\n'), 6);
});

test('findArchiveEntry returns the title, the body up to the next header, and the bead ids in order', () => {
  const e = findArchiveEntry(ARCHIVE, 14);
  assert.equal(e.number, 14);
  assert.equal(e.title, 'claim.sh refuses to run from inside a worktree');
  assert.deepEqual(e.beadIds, [`${BP}-qeges`, `${BP}-3x93j.11`]);
  assert.doesNotMatch(e.body, /RECURRENCE of archived entries 17/, 'the body must stop at the next entry');
});

test('findArchiveEntry stops at a top-level section header and handles the last entry', () => {
  assert.doesNotMatch(findArchiveEntry(ARCHIVE, 38).body, /Resolved — second pass/);
  assert.deepEqual(findArchiveEntry(ARCHIVE, 72).beadIds, [`${BP}-1r0lh`]);
  assert.equal(findArchiveEntry(ARCHIVE, 99), null);
});

test('the template carries every field of the filing convention', () => {
  const t = entryTemplate({ title: 'X', repo: 'Acme', date: '2026-09-05' });
  for (const field of ['Date', 'Repo', 'Symptom', 'Root cause', 'What was patched in the moment', 'Suggested systemic fix', 'Effort guess']) {
    assert.match(t, new RegExp(`\\*\\*${field}:\\*\\*`), `missing ${field}`);
  }
  assert.match(t, /2026-09-05/);
  assert.match(t, new RegExp(ARCHIVE_REL.replace(/[./]/g, '\\$&')));
});

test('buildCreateArgs: P3 + label by default, P2 + recurrence label + relates-to for a recurrence', () => {
  const plain = buildCreateArgs({ title: 'T', description: 'D' });
  assert.deepEqual(plain.slice(0, 2), ['create', 'T']);
  assert.equal(plain[plain.indexOf('-p') + 1], 'P3');
  assert.equal(plain[plain.indexOf('--labels') + 1], LABEL);
  assert.ok(!plain.includes('--deps'));
  assert.equal(plain.at(-1), '--silent');

  const recur = buildCreateArgs({ title: 'T', description: 'D', recurrence: true, deps: [`relates-to:${BP}-qeges`] });
  assert.equal(recur[recur.indexOf('-p') + 1], 'P2');
  assert.equal(recur[recur.indexOf('--labels') + 1], `${LABEL},${RECURRENCE_LABEL}`);
  assert.equal(recur[recur.indexOf('--deps') + 1], `relates-to:${BP}-qeges`);
});

test('buildCreateArgs passes --actor only for a per-session id, never a shared team name', () => {
  assert.deepEqual(buildCreateArgs({ title: 'T', description: 'D', actor: 'captain-goose-bot-1a2b3c4d' }).slice(0, 2), ['--actor', 'captain-goose-bot-1a2b3c4d']);
  assert.equal(buildCreateArgs({ title: 'T', description: 'D', actor: 'Captain Goose' })[0], 'create');
  assert.equal(buildCreateArgs({ title: 'T', description: 'D', priority: 'P1' }).at(5), 'P1');
});

test('recurrencePreamble names the archived entry and its beads', () => {
  const p = recurrencePreamble(findArchiveEntry(ARCHIVE, 14));
  assert.match(p, /RECURRENCE of archived entry 14: claim\.sh refuses/);
  assert.match(p, new RegExp(String.raw`${BP}-qeges, ${BP}-3x93j\.11`));
});

test('parseArgs: positionals, valued flags, booleans, --flag=value', () => {
  const a = parseArgs(['new', 'a title', 'more', '--repo', 'Acme', '--dry-run', '--priority=P2']);
  assert.equal(a.cmd, 'new');
  assert.deepEqual(a.positionals, ['a title', 'more']);
  assert.deepEqual(a.flags, { repo: 'Acme', 'dry-run': true, priority: 'P2' });
});

test('parseArgs refuses short and unknown flags instead of swallowing them into the title', () => {
  assert.throws(() => parseArgs(['new', '-p', 'P2', 'title']), /long flags only/);
  assert.throws(() => parseArgs(['new', '--titel', 'foo']), /unknown flag --titel/);
  assert.throws(() => parseArgs(['new', 'title', '--priority']), /needs a value/);
});

test("findArchiveEntry puts the entry's OWN bead first, not the first id that happens to appear", () => {
  const archive = [
    '## 55. two better-sqlite3 traps',
    '',
    `- **Date:** 2026-09-01 · **Repo:** Acme — closed by the ${BP}-3x93j.18 sweep (bead ${BP}-aaaa1)`,
    '',
    `### Resolution (2026-09-02, ${BP}-3x93j.18, PR #2898)`,
    '',
  ].join('\n');
  assert.deepEqual(findArchiveEntry(archive, 55).beadIds, [`${BP}-aaaa1`, `${BP}-3x93j.18`]);
});

// ── an MSYS-mangled title is repaired, and never quietly ──────────
// A quoted argument that merely BEGINS with `/` is rewritten by MSYS argv conversion,
// with no error and no warning, so the corrupted title is what the active log and the
// weekly sweep show from then on. This repo steers straight into it: every slash command
// is `/bead`, `/beadsBulk`, `/asks`, and a bead about one opens with its name.

test('repairMsysMangledTitle restores the leading slash the Git install root replaced', () => {
  const cases = [
    ['C:/Program Files/Git/beadsBulk has no peer ping before the gate', '/beadsBulk has no peer ping before the gate'],
    ['C:\\Program Files\\Git\\asks skips deferred beads', '/asks skips deferred beads'],
    ['C:/Program Files (x86)/Git/conditions/ renders SRD prose publicly', '/conditions/ renders SRD prose publicly'],
    ['D:/Tools/Git/window-review misses churn', '/window-review misses churn'],
  ];
  for (const [mangled, want] of cases) {
    const r = repairMsysMangledTitle(mangled);
    assert.equal(r.repaired, true, `not detected: ${mangled}`);
    assert.equal(r.title, want);
    assert.equal(r.original, mangled);
  }
});

test('repairMsysMangledTitle leaves an ordinary title completely alone', () => {
  for (const title of [
    'rtk eats a clustered grep flag',
    'the Git hook did not run',                       // names Git, but is not a path
    'C:/git/work/Acme is the primary checkout', // an absolute path, no Git root
    '/beadsBulk has no peer ping',                     // already correct — MSYS did not fire
    '',
  ]) {
    const r = repairMsysMangledTitle(title);
    assert.equal(r.repaired, false, `false positive on: ${title}`);
    assert.equal(r.title, title);
  }
});

// ── CLI, --dry-run only: no bd, no Dolt, no network ──────────────────────────

// The session's own AGENT_TOOLING_CHECKOUT / stub must never leak into a test: each test states
// the store it means. The self-staleness guard is skipped by default so
// these tests stay hermetic, run from a worktree legitimately behind main, every CLI
// case would otherwise fail with a staleness refusal instead of what it asserts; the
// guard has its own fixture-repo tests below that unset the skip explicitly.
function cleanEnv(extra = {}) {
  const env = { ...process.env, BEADS_ACTOR: 'test-bot-0123abcd', [SKIP_STALE_ENV]: '1', ...extra };
  for (const k of ['AGENT_TOOLING_CHECKOUT', 'ODDITY_BD_STUB', 'ODDITY_STUB_DB', 'ODDITY_GH_STUB', 'ODDITY_GH_STUB_LOG', 'ODDITY_GH_STUB_STATE']) if (!(k in extra)) delete env[k];
  for (const [k, v] of Object.entries(extra)) if (v === undefined) delete env[k];
  return env;
}

function run(args, cwd, extraEnv = {}, bin = cli) {
  return spawnSync(process.execPath, [bin, ...args], { cwd, encoding: 'utf8', env: cleanEnv(extraEnv) });
}

// Every file the CLI imports, so a store checkout can carry a copy that runs from inside it.
const CLI_FILES = [...SELF_CHECK_FILES, 'scripts/agent-tooling-config.mjs'];

/**
 * Give a fixture store its own copy of the CLI. This is how the CLI is used across repos
 * (`node "$CHECKOUT/scripts/oddity.mjs"` from another repo) and it is what makes a sibling store
 * discoverable: the sibling directory is named by the beadPrefix of the CLI's own config.
 * Returns the path of the copy's entry point.
 */
function installCli(root) {
  for (const rel of CLI_FILES) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    cpSync(path.resolve(rel), path.join(root, rel));
  }
  return path.join(root, 'scripts', 'oddity.mjs');
}

// A throwaway git repo holding a small archive and a .beads dir, a store checkout as
// far as the CLI can tell, so it resolves ARCHIVE_REL against it, not the real repo.
function fixture(root = mkdtempSync(path.join(tmpdir(), 'oddity-test-'))) {
  mkdirSync(root, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  mkdirSync(path.join(root, '.beads'), { recursive: true });
  // The store's own config: its bead prefix names the default repo label (acme) and the sibling dir.
  writeFileSync(path.join(root, 'agent-tooling.json'), JSON.stringify({ beadPrefix: 'Acme' }));
  const archive = path.join(root, ARCHIVE_REL);
  mkdirSync(path.dirname(archive), { recursive: true });
  writeFileSync(archive, ARCHIVE);
  return root;
}

/** A git repo outside the store whose origin remote is `remote`. */
function otherRepo(root, remote) {
  mkdirSync(root, { recursive: true });
  spawnSync('git', ['init', '-q', root]);
  if (remote) spawnSync('git', ['-C', root, 'remote', 'add', 'origin', remote]);
  return root;
}

/** Normalized for comparison: forward slashes, real path, lowercase (Windows paths are case-insensitive). */
function norm(p) {
  let real = p;
  try {
    real = realpathSync.native(p);
  } catch {
    /* keep as given */
  }
  return real.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/** Every `-C <dir>` the dry-run printed, normalized. */
function dashCDirs(stdout) {
  return [...stdout.matchAll(/\[dry-run\] bd -C (\S+)/g)].map((m) => norm(m[1]));
}

test('`new --dry-run` prints the pull → create → push sequence with the template and label, and creates nothing', () => {
  const root = fixture();
  try {
    const r = run(['new', 'sed ate my backslash', '--dry-run'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] bd dolt pull/);
    assert.match(r.stdout, /\[dry-run\] bd --actor test-bot-0123abcd create "sed ate my backslash" --type bug -p P3 --labels tooling-oddity,repo:acme --description /);
    assert.doesNotMatch(r.stdout, / -C /, 'inside a store checkout nothing changes: no -C');
    assert.match(r.stdout, /\*\*Symptom:\*\*/);
    assert.match(r.stdout, /\[dry-run\] bd dolt push/);
    assert.match(r.stdout, new RegExp(`filed as ${BP}-dryrun`));
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`new` files the REPAIRED title and shouts about it', () => {
  const root = fixture();
  try {
    const r = run(['new', 'C:/Program Files/Git/beadsBulk has no peer ping before the gate', '--dry-run'], root);
    assert.equal(r.status, 0, r.stderr);

    // The bead gets the title the filer actually typed…
    assert.match(r.stdout, /create "\/beadsBulk has no peer ping before the gate"/);
    assert.doesNotMatch(r.stdout, /create "C:\/Program Files/);

    // …and the repair is impossible to miss. A silent repair is the same failure as the
    // silent corruption, one layer along: the whole defect was a success message printed
    // over a title nobody re-read.
    assert.match(r.stderr, /MSYS PATH MANGLING DETECTED AND REPAIRED/);
    assert.match(r.stderr, /READ THIS/);
    assert.match(r.stderr, /MSYS_NO_PATHCONV=1/, 'the warning must name the prevention');
    assert.match(r.stderr, /received: C:\/Program Files\/Git\/beadsBulk/, 'it must show what arrived');
    assert.match(r.stderr, /filing as: \/beadsBulk/, 'and what it is filing');
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`new` says nothing about mangling for an ordinary title', () => {
  const root = fixture();
  try {
    const r = run(['new', 'rtk eats a clustered grep flag', '--dry-run'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /MSYS PATH MANGLING/, `cried mangling on a clean title:\n${r.stderr}`);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`recur N --dry-run` prefixes the title, bumps to P2, adds the recurrence label and relates to the archived bead', () => {
  const root = fixture();
  try {
    const r = run(['recur', '14', 'it happened again', '--dry-run'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(String.raw`create "RECURRENCE of archived entry 14: it happened again" --type bug -p P2 --labels tooling-oddity,repo:acme,recurrence --deps relates-to:${BP}-qeges`));
    assert.match(r.stdout, /The archived resolution was supposed to cover this/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`recur` refuses an entry number the archive does not have', () => {
  const root = fixture();
  try {
    const r = run(['recur', '999', 'x', '--dry-run'], root);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no archive entry numbered 999/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`--body-file` replaces the template with the file content', () => {
  const root = fixture();
  try {
    const body = path.join(root, 'entry.md');
    writeFileSync(body, '- **Symptom:** the real text\n');
    const r = run(['new', 't', '--body-file', body, '--dry-run'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /the real text/);
    assert.doesNotMatch(r.stdout, /<what you saw/);
    assert.match(r.stdout, /Description taken from --body-file/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`next-number` reads the archive in the repo it runs from', () => {
  const root = fixture();
  try {
    const r = run(['next-number'], root);
    assert.equal(r.stdout.trim(), '73');
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

// ── one friction store for every repo on the box ───────────────
// Every entry from every repo is a single-prefix bead in the store database; the origin
// repo is a `repo:<name>` label; a caller outside a store checkout reaches the database
// with `bd -C <store checkout>`, found from $AGENT_TOOLING_CHECKOUT or a sibling directory named by the repo's beadPrefix.

test('repoNameFromRemoteUrl: origin basename, .git stripped, lowercased, for https, ssh and local remotes', () => {
  const cases = [
    ['https://github.com/acmeorg/Acme.git', 'acme'],
    ['git@github.com:acmeorg/tools-repo.git', 'tools-repo'],
    ['https://github.com/acmeorg/Game-Repo', 'game-repo'],
    ['ssh://git@github.com/x/Game-Repo.git/', 'game-repo'],
    ['C:/git/work/Game-Repo', 'game-repo'],
    ['C:\\git\\work\\Acme.git', 'acme'],
    ['', ''],
  ];
  for (const [url, want] of cases) assert.equal(repoNameFromRemoteUrl(url), want, url);
});

test('repo labels are normalized and refuse a name that cannot be a label', () => {
  assert.equal(repoLabel('Acme'), 'repo:acme');
  assert.equal(repoLabel(' tools-repo '), 'repo:tools-repo');
  assert.equal(normalizeRepoName('Game-Repo'), 'game-repo');
  assert.throws(() => normalizeRepoName('toolsRepo cloud'), /not a usable repo name/);
  assert.throws(() => normalizeRepoName(''), /not a usable repo name/);
});

test('buildCreateArgs: repo:<name> rides next to tooling-oddity, and -C leads every other global flag', () => {
  const a = buildCreateArgs({ title: 'T', description: 'D', actor: 'captain-goose-bot-1a2b3c4d', repo: 'tools-repo', bdDir: 'C:/git/store' });
  assert.deepEqual(a.slice(0, 5), ['-C', 'C:/git/store', '--actor', 'captain-goose-bot-1a2b3c4d', 'create']);
  assert.equal(a[a.indexOf('--labels') + 1], 'tooling-oddity,repo:tools-repo');
  const r = buildCreateArgs({ title: 'T', description: 'D', recurrence: true, repo: 'game-repo' });
  assert.equal(r[r.indexOf('--labels') + 1], 'tooling-oddity,repo:game-repo,recurrence');
  assert.equal(r[0], 'create', 'no bdDir, no -C');
});

test('buildListArgs narrows to one repo with a second -l, which bd ANDs', () => {
  assert.deepEqual(buildListArgs(), ['list', '-l', 'tooling-oddity', '--flat', '-n', '0']);
  assert.deepEqual(buildListArgs({ repo: 'Game-Repo', json: true, bdDir: 'C:/d' }), ['-C', 'C:/d', 'list', '-l', 'tooling-oddity', '-l', 'repo:game-repo', '--flat', '-n', '0', '--json']);
});

test('resolveStoreCheckout: local beats everything, an explicit AGENT_TOOLING_CHECKOUT beats the sibling, a WRONG one fails loudly', () => {
  const store = new Set([path.join('base', 'Acme'), path.join('elsewhere', 'Acme'), path.join('base', 'bd-wt')]);
  const isStoreCheckout = (d) => store.has(path.normalize(d));
  const other = path.join('base', 'tools-repo');

  assert.deepEqual(resolveStoreCheckout({ callerRoot: path.join('base', 'bd-wt'), env: { AGENT_TOOLING_CHECKOUT: path.join('elsewhere', 'Acme') }, isStoreCheckout }), {
    root: path.join('base', 'bd-wt'),
    bdDir: '',
    mode: 'local',
  });
  assert.equal(resolveStoreCheckout({ callerRoot: other, env: { AGENT_TOOLING_CHECKOUT: path.join('elsewhere', 'Acme') }, isStoreCheckout }).bdDir, path.join('elsewhere', 'Acme'));
  assert.deepEqual(resolveStoreCheckout({ callerRoot: other, env: {}, isStoreCheckout, siblingName: 'Acme' }), { root: path.join('base', 'Acme'), bdDir: path.join('base', 'Acme'), mode: 'sibling' });
  assert.match(resolveStoreCheckout({ callerRoot: other, env: {}, isStoreCheckout }).error, /no sibling name to look for/, 'no beadPrefix, no sibling discovery');

  const wrong = resolveStoreCheckout({ callerRoot: other, env: { AGENT_TOOLING_CHECKOUT: 'nope' }, isStoreCheckout });
  assert.match(wrong.error, /AGENT_TOOLING_CHECKOUT=nope is not a store checkout/, 'a set-but-wrong AGENT_TOOLING_CHECKOUT must not silently lose to the sibling');

  const none = resolveStoreCheckout({ callerRoot: path.join('lonely', 'repo'), env: {}, isStoreCheckout, siblingName: 'Acme' });
  assert.match(none.error, /cannot find the store checkout/);
  assert.match(none.error, /export AGENT_TOOLING_CHECKOUT=/, 'the failure must print the line that fixes it');
});

test('normalizeDrivePath turns a Git Bash /c/… AGENT_TOOLING_CHECKOUT into C:/… on Windows only', () => {
  assert.equal(normalizeDrivePath('/c/git/store', 'win32'), 'C:/git/store');
  assert.equal(normalizeDrivePath('C:/git/store', 'win32'), 'C:/git/store');
  assert.equal(normalizeDrivePath('/c/git/store', 'linux'), '/c/git/store');
});

test('from another repo with AGENT_TOOLING_CHECKOUT: every bd call is -C <store>, the label defaults from origin, the archive resolves under the store', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-xrepo-'));
  try {
    const store = fixture(path.join(base, 'checkouts', 'Acme'));
    const caller = otherRepo(path.join(base, 'work', 'tools-repo'), 'https://github.com/acmeorg/tools-repo.git');

    const r = run(['recur', '14', 'the hook sync dropped a file', '--dry-run'], caller, { AGENT_TOOLING_CHECKOUT: store });
    assert.equal(r.status, 0, r.stderr);
    const dirs = dashCDirs(r.stdout);
    assert.equal(dirs.length, 3, `pull, create and push must all carry -C:\n${r.stdout}`);
    for (const d of dirs) assert.equal(d, norm(store));
    assert.match(r.stdout, new RegExp(String.raw`--labels tooling-oddity,repo:tools-repo,recurrence --deps relates-to:${BP}-qeges`), 'archive entry 14 was read from the store checkout');
    assert.match(r.stdout, /\*\*Repo:\*\* tools-repo/);

    assert.equal(run(['next-number'], caller, { AGENT_TOOLING_CHECKOUT: store }).stdout.trim(), '73', 'numbering comes from the store archive, untouched');
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

test('from another repo without AGENT_TOOLING_CHECKOUT: a sibling store checkout is found; --repo overrides the default', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-sib-'));
  try {
    const store = fixture(path.join(base, 'Acme'));
    const bin = installCli(store);
    const caller = otherRepo(path.join(base, 'Game-Repo'), 'git@github.com:acmeorg/Game-Repo.git');

    const r = run(['new', 'Git Bash ate the Unity path', '--dry-run'], caller, {}, bin);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(dashCDirs(r.stdout), [norm(store), norm(store), norm(store)]);
    assert.match(r.stdout, /--labels tooling-oddity,repo:game-repo --description/);

    const o = run(['new', 'x', '--repo', 'Tools-Repo', '--dry-run'], caller, {}, bin);
    assert.match(o.stdout, /--labels tooling-oddity,repo:tools-repo --description/);
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

test('inside a store worktree that is NOT $AGENT_TOOLING_CHECKOUT, nothing changes: no -C', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-wt-'));
  try {
    const primary = fixture(path.join(base, 'Acme'));
    const worktree = fixture(path.join(base, 'bd-some-bead'));
    const r = run(['new', 't', '--dry-run'], worktree, { AGENT_TOOLING_CHECKOUT: primary });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(dashCDirs(r.stdout), []);
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

test('no store checkout reachable: exit 1 with the export line, and no bd call', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-lonely-'));
  try {
    const caller = otherRepo(path.join(base, 'nest', 'lonely'), 'https://github.com/x/lonely.git');
    const r = run(['new', 't', '--dry-run'], caller);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /export AGENT_TOOLING_CHECKOUT=/);
    assert.doesNotMatch(r.stdout, /\[dry-run\] bd/);

    const wrong = run(['list'], caller, { AGENT_TOOLING_CHECKOUT: path.join(base, 'nest') });
    assert.equal(wrong.status, 1);
    assert.match(wrong.stderr, /is not a store checkout/);
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

test('ACCEPTANCE (stub bd): entries filed from the store, tools-repo and game-repo land in ONE queue, single-prefix, each with its repo label', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-queue-'));
  try {
    const store = fixture(path.join(base, 'Acme'));
    const bin = installCli(store);
    const toolsRepo = otherRepo(path.join(base, 'elsewhere', 'tools-repo'), 'https://github.com/acmeorg/tools-repo.git');
    const gameRepo = otherRepo(path.join(base, 'Game-Repo'), 'git@github.com:acmeorg/Game-Repo.git');
    const stubEnv = { ODDITY_BD_STUB: path.resolve('scripts/test-support/oddity-bd-stub.mjs'), ODDITY_STUB_DB: path.join(base, 'stub-db.json'), CLAUDE_CODE_SESSION_ID: undefined };

    for (const [cwd, extra, title] of [
      [store, {}, 'from store'],
      [toolsRepo, { AGENT_TOOLING_CHECKOUT: store }, 'from tools-repo'],
      [gameRepo, {}, 'from game-repo (sibling discovery)'],
    ]) {
      const r = run(['new', title], cwd, { ...stubEnv, ...extra }, bin);
      assert.equal(r.status, 0, `${title}: ${r.stderr}`);
      assert.match(r.stdout, /^bd-stub\d+$/m, 'one id prefix for every repo that files into the store');
    }

    const all = run(['list', '--json'], gameRepo, stubEnv, bin);
    assert.equal(all.status, 0, all.stderr);
    const queue = JSON.parse(all.stdout);
    assert.deepEqual(queue.map((b) => b.title), ['from store', 'from tools-repo', 'from game-repo (sibling discovery)']);
    for (const b of queue) assert.match(b.id, /^bd-/);
    assert.deepEqual(queue.map((b) => b.labels.find((l) => l.startsWith('repo:'))), ['repo:acme', 'repo:tools-repo', 'repo:game-repo']);

    const onlyGameRepo = run(['list', '--repo', 'game-repo', '--json'], toolsRepo, { ...stubEnv, AGENT_TOOLING_CHECKOUT: store }, bin);
    assert.deepEqual(JSON.parse(onlyGameRepo.stdout).map((b) => b.title), ['from game-repo (sibling discovery)']);

    // The bd-side calls ran with no -C; every call from the other two repos was aimed at the store checkout.
    const { calls } = JSON.parse(readFileSync(stubEnv.ODDITY_STUB_DB, 'utf8'));
    assert.deepEqual(calls.slice(0, 3).map((c) => c.dir), [null, null, null]);
    for (const c of calls.slice(3)) assert.equal(norm(c.dir), norm(store), JSON.stringify(c));
    assert.equal(run(['next-number'], toolsRepo, { AGENT_TOOLING_CHECKOUT: store }, bin).stdout.trim(), '73', 'archive numbering untouched');
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

test('no arguments prints usage and exits 1', () => {
  const r = run([], process.cwd());
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage:/);
});

// ── closed by a PR, never archived ───────────────────────────────

const ARCHIVE_WITH_TWO = [
  '# archive',
  '',
  '## 75. something',
  '',
  `- **Date:** 2026-09-05 · **Repo:** Acme (bead ${BP}-arch1)`,
  '',
  `### Resolution (2026-09-05, PR #2965 / ${BP}-arch1)`,
  '',
  `Fixed alongside ${BP}-arch2.`,
  '',
].join('\n');

test('archivedBeadIds: every id the archive mentions, in headers, bullets and Resolution prose', () => {
  const ids = archivedBeadIds(ARCHIVE_WITH_TWO);
  assert.ok(ids.has(`${BP}-arch1`) && ids.has(`${BP}-arch2`));
  assert.equal(ids.size, 2);
  assert.equal(archivedBeadIds('').size, 0);
});

test('closingPrNumber reads the close-beads reason and nothing else', () => {
  assert.equal(closingPrNumber({ close_reason: 'Auto-closed: merged via PR #3169 (feat(oddity): …)' }), 3169);
  assert.equal(closingPrNumber({ close_reason: 'Closed' }), null);
  assert.equal(closingPrNumber({}), null);
});

test('unarchivedClosed: closed rows the archive does not mention, oldest closed first, each with its PR', () => {
  const rows = [
    { id: `${BP}-arch1`, status: 'closed', closed_at: '2026-09-05T00:00:00Z', title: 'archived', labels: ['tooling-oddity'] },
    { id: `${BP}-newer`, status: 'closed', closed_at: '2026-09-13T10:00:00Z', title: 'newer', labels: ['tooling-oddity', 'repo:acme'], close_reason: 'Auto-closed: merged via PR #3191 (x)' },
    { id: `${BP}-older`, status: 'closed', closed_at: '2026-09-06T10:00:00Z', title: 'older', labels: ['tooling-oddity'], close_reason: 'Closed' },
    { id: `${BP}-open1`, status: 'open', title: 'still open', labels: ['tooling-oddity'] },
  ];
  const out = unarchivedClosed(rows, archivedBeadIds(ARCHIVE_WITH_TWO));
  assert.deepEqual(out.map((r) => [r.id, r.pr]), [[`${BP}-older`, null], [`${BP}-newer`, 3191]]);
  const lines = formatUnarchivedLines(out);
  assert.match(lines[0], new RegExp(String.raw`^${BP}-older {2}closed 2026-09-06 {2}no PR named {2}\[\(no repo label\)\] {2}older$`));
  assert.match(lines[1], new RegExp(String.raw`^${BP}-newer {2}closed 2026-09-13 {2}PR #3191 {2}\[repo:acme\] {2}newer$`));
  assert.deepEqual(unarchivedClosed(undefined, new Set()), []);
});

test('`unarchived` (stub bd) lists closed-but-unarchived entries through the store, and is empty when the archive names them all', () => {
  const base = mkdtempSync(path.join(tmpdir(), 'oddity-test-unarchived-'));
  try {
    const store = fixture(path.join(base, 'Acme'));
    const toolsRepo = otherRepo(path.join(base, 'elsewhere', 'tools-repo'), 'https://github.com/acmeorg/tools-repo.git');
    const dbPath = path.join(base, 'stub-db.json');
    const stubEnv = { ODDITY_BD_STUB: path.resolve('scripts/test-support/oddity-bd-stub.mjs'), ODDITY_STUB_DB: dbPath, CLAUDE_CODE_SESSION_ID: undefined };
    // Two closed by PRs since the last sweep, one closed AND archived (the fixture archive
    // names bd-1r0lh), one still open. `list` must keep ignoring all the closed ones.
    writeFileSync(dbPath, JSON.stringify({
      next: 1,
      calls: [],
      beads: [
        { id: `${BP}-1r0lh`, title: 'archived already', labels: ['tooling-oddity'], status: 'closed', closed_at: '2026-09-04T00:00:00Z' },
        { id: `${BP}-fixd2`, title: 'fixed by a PR', labels: ['tooling-oddity', 'repo:tools-repo'], status: 'closed', closed_at: '2026-09-12T00:00:00Z', close_reason: 'Auto-closed: merged via PR #3170 (fix)' },
        { id: `${BP}-fixd1`, title: 'fixed earlier', labels: ['tooling-oddity', 'repo:acme'], status: 'closed', closed_at: '2026-09-08T00:00:00Z', close_reason: 'Auto-closed: merged via PR #3100 (fix)' },
        { id: `${BP}-open9`, title: 'still open', labels: ['tooling-oddity', 'repo:acme'], status: 'open' },
      ],
    }));

    const r = run(['unarchived'], toolsRepo, { ...stubEnv, AGENT_TOOLING_CHECKOUT: store });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^2 closed entries with no archive block/m);
    assert.ok(r.stdout.indexOf(`${BP}-fixd1`) < r.stdout.indexOf(`${BP}-fixd2`), 'oldest closed first');
    assert.match(r.stdout, new RegExp(String.raw`${BP}-fixd2 {2}closed 2026-09-12 {2}PR #3170 {2}\[repo:tools-repo\]`));
    assert.doesNotMatch(r.stdout, new RegExp(String.raw`${BP}-1r0lh|${BP}-open9`));

    const json = JSON.parse(run(['unarchived', '--json', '--repo', 'acme'], toolsRepo, { ...stubEnv, AGENT_TOOLING_CHECKOUT: store }).stdout);
    assert.deepEqual(json.map((b) => b.id), [`${BP}-fixd1`], '--repo narrows it, like list');

    // The store resolution is the same one `list` uses: every call from tools-repo went -C <store>.
    const { calls } = JSON.parse(readFileSync(dbPath, 'utf8'));
    for (const c of calls) assert.equal(norm(c.dir), norm(store), JSON.stringify(c));
    assert.ok(calls.every((c) => c.cmd === 'list'), 'unarchived never mutates or syncs');

    const listed = run(['list', '--json'], store, stubEnv);
    assert.deepEqual(JSON.parse(listed.stdout).map((b) => b.id), [`${BP}-open9`], '`list` still shows open entries only');
  } finally {
    removeTempDir(base, 'oddity.node-test');
  }
});

// ── upstream registry: retire a workaround when its Claude Code issue closes ──

const REGISTRY = {
  entries: [
    {
      repo: 'anthropics/claude-code',
      issue: 1,
      title: 'still broken',
      workaround: { hooks: ['scripts/hooks/a.mjs'], docs: ['doc rule A'] },
      verifyBeforeRetiring: 'run probe A',
      lastChecked: '2026-01-01',
      lastKnownState: 'OPEN',
    },
    {
      repo: 'anthropics/claude-code',
      issue: 2,
      title: 'fixed upstream',
      workaround: { hooks: ['scripts/hooks/b.mjs'], settings: ['.claude/settings.json (b)'], docs: [] },
      verifyBeforeRetiring: 'run probe B',
      lastChecked: '2026-01-01',
      lastKnownState: 'OPEN',
    },
    {
      repo: 'anthropics/claude-code',
      issue: 3,
      title: 'unreadable',
      workaround: { docs: ['rule C'] },
      verifyBeforeRetiring: 'run probe C',
      lastChecked: '2026-01-01',
      lastKnownState: 'OPEN',
    },
  ],
};
const STATES = {
  'anthropics/claude-code#1': { state: 'OPEN', updatedAt: '2026-09-01T00:00:00Z' },
  'anthropics/claude-code#2': { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-09-04T15:09:18Z' },
};

test('renderUpstream: closed → RETIRE with the verify recipe and the workaround files; open → stays; missing → UNKNOWN, never OPEN', () => {
  const { lines, retire, unknown } = renderUpstream(REGISTRY, new Map(Object.entries(STATES)));
  const text = lines.join('\n');
  assert.deepEqual(retire.map(upstreamKey), ['anthropics/claude-code#2']);
  assert.deepEqual(unknown.map(upstreamKey), ['anthropics/claude-code#3']);
  assert.match(text, /✓ CLOSED {2}anthropics\/claude-code#2 \(COMPLETED 2026-09-04\) — fixed upstream/);
  assert.match(text, /RETIRE the workaround after verifying/);
  assert.match(text, /run probe B/);
  assert.match(text, /scripts\/hooks\/b\.mjs; \.claude\/settings\.json \(b\)/);
  assert.match(text, /○ OPEN {4}anthropics\/claude-code#1 \(updated 2026-09-01\) — still broken; workaround stays/);
  assert.match(text, /\? UNKNOWN anthropics\/claude-code#3 — state could not be read; last known OPEN on 2026-01-01/);
  assert.match(text, /1 workaround\(s\) to retire: anthropics\/claude-code#2/);
});

test('updateRegistry refreshes only the entries whose state was read', () => {
  const updated = updateRegistry(REGISTRY, new Map(Object.entries(STATES)), '2026-09-12');
  assert.equal(updated.entries[0].lastChecked, '2026-09-12');
  assert.equal(updated.entries[0].lastKnownState, 'OPEN');
  assert.equal(updated.entries[1].lastKnownState, 'CLOSED');
  assert.equal(updated.entries[2].lastChecked, '2026-01-01', 'an unreadable state must not be stamped as checked');
  assert.equal(REGISTRY.entries[1].lastKnownState, 'OPEN', 'pure: the input is not mutated');
});

test('`upstream --states-file` renders without gh, exits 2 when something is retirable, and --write stamps the registry', () => {
  const root = fixture();
  try {
    const regPath = path.join(root, UPSTREAM_REL);
    writeFileSync(regPath, JSON.stringify(REGISTRY));
    const statesPath = path.join(root, 'states.json');
    writeFileSync(statesPath, JSON.stringify(STATES));

    const r = run(['upstream', '--states-file', statesPath, '--write'], root);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stdout, /RETIRE the workaround/);
    assert.match(r.stdout, /updated lastChecked\/lastKnownState .* for 2 of 3 entries/);
    const written = JSON.parse(readFileSync(regPath, 'utf8'));
    assert.equal(written.entries[1].lastKnownState, 'CLOSED');
    assert.equal(written.entries[2].lastKnownState, 'OPEN');

    const none = run(['upstream', '--states-file', statesPath, '--json'], root);
    const parsed = JSON.parse(none.stdout);
    assert.deepEqual(parsed.retire, ['anthropics/claude-code#2']);
    assert.deepEqual(parsed.unknown, ['anthropics/claude-code#3']);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('ghChildEnv drops GITHUB_TOKEN but keeps GH_TOKEN, and does not mutate its input', () => {
  const input = { GITHUB_TOKEN: 'bad', GH_TOKEN: 'good', PATH: '/bin' };
  const out = ghChildEnv(input);
  assert.equal('GITHUB_TOKEN' in out, false);
  assert.equal(out.GH_TOKEN, 'good');
  assert.equal(out.PATH, '/bin');
  assert.equal(input.GITHUB_TOKEN, 'bad', 'pure: the input is not mutated');
});

test('`upstream --json` on a runner: GH_TOKEN reaches gh, GITHUB_TOKEN does not, and states are read', () => {
  const root = fixture();
  try {
    writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(REGISTRY));
    const logPath = path.join(root, 'gh-calls.jsonl');
    const stub = { ODDITY_GH_STUB: path.resolve('scripts/test-support/oddity-gh-stub.mjs'), ODDITY_GH_STUB_LOG: logPath };

    const r = run(['upstream', '--json'], root, { ...stub, GH_TOKEN: 'runner-token', GITHUB_TOKEN: 'also-set', ODDITY_GH_STUB_STATE: 'CLOSED' });
    assert.equal(r.status, 2, `every entry CLOSED → exit 2\n${r.stderr}`);
    const parsed = JSON.parse(r.stdout);
    assert.deepEqual(parsed.unknown, [], 'with GH_TOKEN honoured, no entry may read UNKNOWN');
    assert.equal(parsed.retire.length, REGISTRY.entries.length);
    assert.equal(parsed.states['anthropics/claude-code#1'].state, 'CLOSED');

    const calls = readFileSync(logPath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(calls.length, REGISTRY.entries.length, 'one gh call per registry entry');
    for (const c of calls) {
      assert.equal(c.GH_TOKEN, 'runner-token', 'GH_TOKEN must reach gh — it is how the cron authenticates');
      assert.equal(c.hasGithubToken, false, 'GITHUB_TOKEN must still be dropped');
      assert.deepEqual(c.args.slice(0, 2), ['issue', 'view']);
    }

    // The negative control: without GH_TOKEN the (stub) gh is unauthenticated, so the
    // test above is not passing merely because the stub answers everything.
    const unauth = run(['upstream', '--json'], root, { ...stub, GH_TOKEN: undefined, GITHUB_TOKEN: 'only-this' });
    assert.equal(unauth.status, 0);
    assert.equal(JSON.parse(unauth.stdout).unknown.length, REGISTRY.entries.length);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

// ── `oddity.mjs verify`, a runnable verdict instead of prose ──

test('verdictNameForExit / verdictSymbolForExit: the three named verdicts, anything else is an error, never silently retirable', () => {
  assert.equal(verdictNameForExit(VERIFY_EXIT.RETIRABLE), 'RETIRABLE');
  assert.equal(verdictNameForExit(VERIFY_EXIT.STILL_REPRODUCES), 'STILL-REPRODUCES');
  assert.equal(verdictNameForExit(VERIFY_EXIT.NEEDS_MANUAL), 'NEEDS-MANUAL');
  assert.match(verdictNameForExit(VERIFY_EXIT.USAGE_ERROR), /ERROR/);
  assert.match(verdictNameForExit(47), /ERROR/, 'an unrecognized code must read as an error, never as RETIRABLE');
  assert.equal(verdictSymbolForExit(VERIFY_EXIT.RETIRABLE), '✓');
  assert.equal(verdictSymbolForExit(VERIFY_EXIT.STILL_REPRODUCES), '✗');
  assert.equal(verdictSymbolForExit(VERIFY_EXIT.NEEDS_MANUAL), '○');
  assert.equal(verdictSymbolForExit(47), '!');
});

test('formatVerifyLine: one line, no prose to interpret', () => {
  const entry = { repo: 'anthropics/claude-code', issue: 88561, title: 'Bash tool collapses backslashes' };
  assert.equal(formatVerifyLine(entry, VERIFY_EXIT.RETIRABLE), '✓ RETIRABLE  anthropics/claude-code#88561 — Bash tool collapses backslashes');
  assert.equal(formatVerifyLine(entry, VERIFY_EXIT.STILL_REPRODUCES), '✗ STILL-REPRODUCES  anthropics/claude-code#88561 — Bash tool collapses backslashes');
  assert.equal(formatVerifyLine(entry, VERIFY_EXIT.NEEDS_MANUAL), '○ NEEDS-MANUAL  anthropics/claude-code#88561 — Bash tool collapses backslashes');
});

test('worstVerifyExit: a single STILL-REPRODUCES outranks any number of NEEDS-MANUAL; empty input is a usage error', () => {
  assert.equal(worstVerifyExit([VERIFY_EXIT.RETIRABLE]), VERIFY_EXIT.RETIRABLE);
  assert.equal(worstVerifyExit([VERIFY_EXIT.RETIRABLE, VERIFY_EXIT.NEEDS_MANUAL, VERIFY_EXIT.NEEDS_MANUAL]), VERIFY_EXIT.NEEDS_MANUAL);
  assert.equal(worstVerifyExit([VERIFY_EXIT.NEEDS_MANUAL, VERIFY_EXIT.STILL_REPRODUCES, VERIFY_EXIT.RETIRABLE]), VERIFY_EXIT.STILL_REPRODUCES);
  assert.equal(worstVerifyExit([VERIFY_EXIT.RETIRABLE, 47]), 47, 'a script crash/unknown code outranks NEEDS-MANUAL and RETIRABLE');
  assert.equal(worstVerifyExit([]), VERIFY_EXIT.USAGE_ERROR);
});

test('renderUpstream prints a `verify:` pointer under a RETIRE line only when the entry carries a verify block', () => {
  const withVerify = {
    entries: [{ ...REGISTRY.entries[1], verify: { kind: 'bash-tool', script: 'scripts/oddity-verify/2.mjs', expect: 'x' } }],
  };
  const { lines } = renderUpstream(withVerify, new Map(Object.entries(STATES)));
  assert.match(lines.join('\n'), /verify: node scripts\/oddity\.mjs verify 2 \(desktop session\)/);

  const withoutVerify = renderUpstream(REGISTRY, new Map(Object.entries(STATES)));
  assert.doesNotMatch(withoutVerify.lines.join('\n'), /verify: node scripts\/oddity\.mjs verify/);
});

// A fixture store checkout with its own upstream registry pointing at STUB verify
// scripts (never the real .mjs recipes, those are exercised in
// scripts/oddity-verify.node-test.mjs without ever going through the Bash tool's
// command-text channel). One stub per verdict, plus a crashing one.
function verifyFixture() {
  const root = fixture();
  const dir = path.join(root, 'scripts', 'oddity-verify');
  mkdirSync(dir, { recursive: true });
  const stub = (name, body) => {
    const rel = `scripts/oddity-verify/${name}.mjs`;
    writeFileSync(path.join(root, rel), body);
    return rel;
  };
  const retirable = stub('retirable', "console.log('all clear'); process.exit(0);\n");
  const reproduces = stub('reproduces', "console.log('still broken'); process.exit(1);\n");
  const manual = stub('manual', "console.log('needs a human'); process.exit(3);\n");
  const crashes = stub('crashes', "throw new Error('boom');\n");
  const registry = {
    entries: [
      { repo: 'anthropics/claude-code', issue: 1001, title: 'retirable stub', verify: { kind: 'bash-tool', script: retirable, expect: 'x' } },
      { repo: 'anthropics/claude-code', issue: 1002, title: 'reproduces stub', verify: { kind: 'bash-tool', script: reproduces, expect: 'x' } },
      { repo: 'anthropics/claude-code', issue: 1003, title: 'manual stub', verify: { kind: 'manual', script: manual, expect: 'x' } },
      { repo: 'anthropics/claude-code', issue: 1004, title: 'crashing stub', verify: { kind: 'bash-tool', script: crashes, expect: 'x' } },
    ],
  };
  writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(registry));
  return root;
}

test('`verify <issue>` runs that entry\'s script and prints its one-line verdict: RETIRABLE, STILL-REPRODUCES, NEEDS-MANUAL, and a crash reads as an error (never silently retirable)', () => {
  const root = verifyFixture();
  try {
    const retirable = run(['verify', '1001'], root);
    assert.equal(retirable.status, VERIFY_EXIT.RETIRABLE, retirable.stderr);
    assert.match(retirable.stdout, /^✓ RETIRABLE {2}anthropics\/claude-code#1001 — retirable stub$/m);
    assert.match(retirable.stdout, /all clear/);

    const reproduces = run(['verify', '1002'], root);
    assert.equal(reproduces.status, VERIFY_EXIT.STILL_REPRODUCES);
    assert.match(reproduces.stdout, /^✗ STILL-REPRODUCES {2}anthropics\/claude-code#1002 — reproduces stub$/m);

    const manual = run(['verify', '1003'], root);
    assert.equal(manual.status, VERIFY_EXIT.NEEDS_MANUAL);
    assert.match(manual.stdout, /^○ NEEDS-MANUAL {2}anthropics\/claude-code#1003 — manual stub$/m);

    // Node's own default for an uncaught exception is exit 1, the same number
    // this scheme uses for STILL-REPRODUCES (following the bead's own suggested
    // mapping). The two are not required to be distinguishable by exit code
    // alone; what matters, and what the bead's own phrasing requires ("script
    // crash → not RETIRABLE"), is that a crash can never read as exit 0.
    const crashes = run(['verify', '1004'], root);
    assert.notEqual(crashes.status, VERIFY_EXIT.RETIRABLE, 'a crashing script must never read as RETIRABLE');
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`verify <issue>` forwards extra argv untouched to the script (a probe string, not a CLI flag)', () => {
  const root = fixture();
  try {
    const dir = path.join(root, 'scripts', 'oddity-verify');
    mkdirSync(dir, { recursive: true });
    const rel = 'scripts/oddity-verify/echo.mjs';
    writeFileSync(path.join(root, rel), "console.log(JSON.stringify(process.argv.slice(2))); process.exit(0);\n");
    const registry = { entries: [{ repo: 'anthropics/claude-code', issue: 2001, title: 'echo stub', verify: { kind: 'bash-tool', script: rel, expect: 'x' } }] };
    writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(registry));

    const r = run(['verify', '2001', '--receive', 'not a known CLI flag', 'trailing'], root);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\["--receive","not a known CLI flag","trailing"\]/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`verify --all` prints one line per entry with no extra prose, and exits with the WORST verdict', () => {
  const root = verifyFixture();
  try {
    const r = run(['verify', '--all'], root);
    assert.equal(r.status, VERIFY_EXIT.STILL_REPRODUCES, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines.length, 4, `expected exactly one line per entry, got:\n${r.stdout}`);
    assert.match(lines[0], /^✓ RETIRABLE {2}anthropics\/claude-code#1001/);
    assert.match(lines[1], /^✗ STILL-REPRODUCES {2}anthropics\/claude-code#1002/);
    assert.match(lines[2], /^○ NEEDS-MANUAL {2}anthropics\/claude-code#1003/);
    assert.doesNotMatch(r.stdout, /all clear|still broken|needs a human/, '--all must not print the scripts\' own prose, only the verdict lines');
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`verify --all` with every entry retirable exits 0', () => {
  const root = fixture();
  try {
    const dir = path.join(root, 'scripts', 'oddity-verify');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(root, 'scripts/oddity-verify/ok1.mjs'), 'process.exit(0);\n');
    writeFileSync(path.join(root, 'scripts/oddity-verify/ok2.mjs'), 'process.exit(0);\n');
    const registry = {
      entries: [
        { repo: 'anthropics/claude-code', issue: 3001, title: 'a', verify: { kind: 'bash-tool', script: 'scripts/oddity-verify/ok1.mjs', expect: 'x' } },
        { repo: 'anthropics/claude-code', issue: 3002, title: 'b', verify: { kind: 'bash-tool', script: 'scripts/oddity-verify/ok2.mjs', expect: 'x' } },
      ],
    };
    writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(registry));
    const r = run(['verify', '--all'], root);
    assert.equal(r.status, 0, r.stderr);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`verify` refuses an unknown issue number and a missing verify block, without running anything', () => {
  const root = verifyFixture();
  try {
    const missing = run(['verify', '9999'], root);
    assert.equal(missing.status, VERIFY_EXIT.USAGE_ERROR);
    assert.match(missing.stderr, /no upstream registry entry for issue 9999/);

    const registry = JSON.parse(readFileSync(path.join(root, UPSTREAM_REL), 'utf8'));
    delete registry.entries[0].verify;
    writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(registry));
    const noVerify = run(['verify', '1001'], root);
    assert.equal(noVerify.status, VERIFY_EXIT.USAGE_ERROR);
    assert.match(noVerify.stderr, /has no verify block/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('`verify` with no arguments prints usage and exits 1; `verify --help` exits 0', () => {
  const root = verifyFixture();
  try {
    const none = run(['verify'], root);
    assert.equal(none.status, 1);
    assert.match(none.stderr, /usage:/);

    const help = run(['verify', '--help'], root);
    assert.equal(help.status, 0);
    assert.match(help.stderr, /usage:/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('a nonexistent verify script reads as a usage error, never a silent RETIRABLE', () => {
  const root = fixture();
  try {
    const registry = { entries: [{ repo: 'anthropics/claude-code', issue: 4001, title: 'ghost script', verify: { kind: 'bash-tool', script: 'scripts/oddity-verify/does-not-exist.mjs', expect: 'x' } }] };
    writeFileSync(path.join(root, UPSTREAM_REL), JSON.stringify(registry));
    const r = run(['verify', '4001'], root);
    assert.equal(r.status, VERIFY_EXIT.USAGE_ERROR);
    assert.match(r.stdout, /verify script not found/);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

// ── Self-staleness guard ─────────────────────────────────────────

test('classifySelfVersion: current, stale, modified and unknown verdicts', () => {
  const hist = ['h-old-1', 'h-old-2'];
  assert.equal(classifySelfVersion({ diskHash: 'h-tip', tipHash: 'h-tip', historicalHashes: hist }), 'current');
  assert.equal(classifySelfVersion({ diskHash: 'h-old-2', tipHash: 'h-tip', historicalHashes: hist }), 'stale');
  assert.equal(classifySelfVersion({ diskHash: 'h-local', tipHash: 'h-tip', historicalHashes: hist }), 'modified');
  assert.equal(classifySelfVersion({ diskHash: '', tipHash: 'h-tip', historicalHashes: hist }), 'unknown');
  assert.equal(classifySelfVersion({ diskHash: 'h-x', tipHash: '' }), 'unknown');
});

test('staleCliMessage names the file, the remedy, and the escape hatch', () => {
  const msg = staleCliMessage({ scriptRoot: '/some/store', rel: 'scripts/oddity.mjs' });
  assert.match(msg, /STALE oddity CLI/);
  assert.match(msg, /AGENT_TOOLING_CHECKOUT=<current store worktree>/);
  assert.match(msg, /AGENT_TOOLING_ODDITY_SKIP_STALE_CHECK=1/);
});

function gitIn(root, args) {
  const r = spawnSync('git', ['-C', root, '-c', 'user.email=t@test.local', '-c', 'user.name=Test', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout.trim();
}

/**
 * A throwaway bd-shaped checkout carrying its own copy of the CLI: v1 committed,
 * then v2 (a trailing marker appended to every SELF_CHECK_FILE) committed and
 * installed as the LOCAL `origin/main` ref, the exact thing the guard compares
 * against. The disk starts at v2 (current); tests then move it where they need it.
 */
function staleCliFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'oddity-test-stale-'));
  mkdirSync(path.join(root, 'scripts'), { recursive: true });
  for (const rel of CLI_FILES) {
    cpSync(path.resolve(rel), path.join(root, rel));
  }
  mkdirSync(path.join(root, '.beads'), { recursive: true });
  const archive = path.join(root, ARCHIVE_REL);
  mkdirSync(path.dirname(archive), { recursive: true });
  writeFileSync(archive, ARCHIVE);
  spawnSync('git', ['init', '-q', root]);
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'v1']);
  const v1 = gitIn(root, ['rev-parse', 'HEAD']);
  for (const rel of SELF_CHECK_FILES) appendFileSync(path.join(root, rel), '\n// v2 marker (fixture)\n');
  gitIn(root, ['add', '-A']);
  gitIn(root, ['commit', '-q', '-m', 'v2']);
  const v2 = gitIn(root, ['rev-parse', 'HEAD']);
  gitIn(root, ['update-ref', 'refs/remotes/origin/main', v2]);
  return { root, v1, v2 };
}

function runFixtureCli(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [path.join(root, 'scripts', 'oddity.mjs'), ...args], {
    cwd: root,
    encoding: 'utf8',
    env: cleanEnv(extraEnv),
  });
}

test('a stale CLI copy REFUSES every command with the remedy; the escape hatch runs it anyway', () => {
  const { root, v1 } = staleCliFixture();
  try {
    // Older committed version on disk while origin/main knows v2, the sibling-primary shape.
    gitIn(root, ['checkout', '-q', v1, '--', ...SELF_CHECK_FILES]);
    const r = runFixtureCli(root, ['next-number'], { [SKIP_STALE_ENV]: undefined });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /STALE oddity CLI/);
    assert.match(r.stderr, /AGENT_TOOLING_ODDITY_SKIP_STALE_CHECK=1/);
    assert.equal(r.stdout, '', 'a refused run must not half-answer');

    const skipped = runFixtureCli(root, ['next-number']);
    assert.equal(skipped.status, 0, skipped.stderr);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

test('a current copy and a locally modified (in-development) copy both run', () => {
  const { root } = staleCliFixture();
  try {
    const current = runFixtureCli(root, ['next-number'], { [SKIP_STALE_ENV]: undefined });
    assert.equal(current.status, 0, current.stderr);

    // An uncommitted edit matches no committed version: development must not be blocked.
    appendFileSync(path.join(root, 'scripts', 'oddity.mjs'), '\n// local dev edit\n');
    const modified = runFixtureCli(root, ['next-number'], { [SKIP_STALE_ENV]: undefined });
    assert.equal(modified.status, 0, modified.stderr);
  } finally {
    removeTempDir(root, 'oddity.node-test');
  }
});

// ── the label, the archive and registry paths: neutral defaults, env overrides ──

function libWithEnv(env) {
  const href = pathToFileURL(path.resolve('scripts/oddity-lib.mjs')).href;
  const code = `import(${JSON.stringify(href)}).then((m) => process.stdout.write(JSON.stringify({ LABEL: m.LABEL, DEFAULT: m.ODDITY_LABEL_DEFAULT, ARCHIVE_REL: m.ARCHIVE_REL, UPSTREAM_REL: m.UPSTREAM_REL })))`;
  const clean = { ...process.env };
  for (const k of ['AGENT_TOOLING_ODDITY_LABEL', 'AGENT_TOOLING_ODDITY_ARCHIVE', 'AGENT_TOOLING_ODDITY_UPSTREAM']) delete clean[k];
  const r = spawnSync(process.execPath, ['-e', code], { encoding: 'utf8', env: { ...clean, ...env } });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('the oddity label is the named default, and AGENT_TOOLING_ODDITY_LABEL overrides it', () => {
  const base = libWithEnv({});
  assert.equal(base.DEFAULT, 'tooling-oddity');
  assert.equal(base.LABEL, 'tooling-oddity');
  assert.equal(libWithEnv({ AGENT_TOOLING_ODDITY_LABEL: 'friction' }).LABEL, 'friction');
  assert.equal(libWithEnv({ AGENT_TOOLING_ODDITY_LABEL: 'friction' }).DEFAULT, 'tooling-oddity', 'the constant itself never moves');
});

test('the archive and registry paths have neutral defaults, each overridable from the environment', () => {
  const base = libWithEnv({});
  assert.equal(base.ARCHIVE_REL, 'docs/agents/tooling-oddities-archive.md');
  assert.equal(base.UPSTREAM_REL, 'docs/agents/tooling-oddities-upstream.json');
  const over = libWithEnv({ AGENT_TOOLING_ODDITY_ARCHIVE: 'notes/arch.md', AGENT_TOOLING_ODDITY_UPSTREAM: 'notes/up.json' });
  assert.equal(over.ARCHIVE_REL, 'notes/arch.md');
  assert.equal(over.UPSTREAM_REL, 'notes/up.json');
});
