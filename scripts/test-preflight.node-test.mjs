import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MIN_FREE_INODES,
  PYTHON_CANDIDATES,
  bashResolutionPlan,
  inodeGroupName,
  inodePreflightFailure,
  inodeUsage,
  isWslBashLauncher,
  patternMatchesPath,
  patternMatchesRootPath,
  pythonResolutionReport,
  regenerableCaches,
  resolveOnWindowsPath,
  testPathPatternWarning,
  topInodeConsumers,
  underselectingBracketPatternWarning,
  withBashPlanApplied,
} from './test-preflight.mjs';

// ───────────────────────────────────────────────────────────── inode preflight

const statfs = (files, ffree) => () => ({ files, ffree, bsize: 4096, blocks: 1, bfree: 1 });

test('inodeUsage reports what the filesystem says', () => {
  assert.deepEqual(inodeUsage('/tmp', { statfsSync: statfs(1048576, 9) }), {
    files: 1048576,
    ffree: 9,
  });
});

test('inodeUsage returns null when the platform reports no inode total (Windows)', () => {
  assert.equal(inodeUsage('/tmp', { statfsSync: statfs(0, 0) }), null);
});

test('inodeUsage returns null rather than throwing when the path cannot be stat-ed', () => {
  assert.equal(
    inodeUsage('/nope', {
      statfsSync: () => {
        throw new Error('ENOENT');
      },
    }),
    null,
  );
});

test('inodeUsage returns null when statfsSync is unavailable', () => {
  assert.equal(inodeUsage('/tmp', { statfsSync: undefined }), null);
});

test('the measured disaster state fails the preflight', () => {
  // The real numbers from the incident: 9 free of 1048576, with 49G of 63G free.
  const msg = inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(1048576, 9) });
  assert.ok(msg, 'expected a failure message');
  assert.match(msg, /OUT OF INODES/);
  assert.match(msg, /blame your code/);
});

test('the failure names df -i, because df -h is the check that misleads', () => {
  const msg = inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(1048576, 9) });
  assert.match(msg, /df -i/);
  assert.match(msg, /df -h/); // ...and says why df -h disagrees
});

test('regenerableCaches names exactly the two caches, under the given tmpdir', () => {
  assert.deepEqual(regenerableCaches('/tmp'), ['/tmp/jest_rs', '/tmp/node-compile-cache']);
  assert.deepEqual(regenerableCaches('/scratch/'), [
    '/scratch/jest_rs',
    '/scratch/node-compile-cache',
  ]);
});

test('the remedy is based on the TEMP DIRECTORY, not on whichever path was starved', () => {
  // jest's cacheDirectory is itself under tmpdir, so the starved path checked
  // first may be /tmp/jest_rs — from which a naive join builds /tmp/jest_rs/jest_rs.
  const msg = inodePreflightFailure({
    consumers: () => [],
    dirs: ['/tmp/jest_rs'],
    tmpdir: '/tmp',
    statfsSync: statfs(1048576, 9),
  });
  assert.match(msg, /test-cache maintenance command/);
  assert.match(msg, /df -i \/tmp\/jest_rs/); // the diagnosis still names what was measured
});

test('the failure prints the exact remedy, and only the regenerable caches', () => {
  const msg = inodePreflightFailure({
    consumers: () => [],
    dirs: ['/tmp'],
    tmpdir: '/tmp',
    statfsSync: statfs(1048576, 9),
  });
  assert.match(msg, /test-cache maintenance command/);
  // The remedy tells the reader to check for a running test process before touching either cache.
  assert.match(msg, /Check for active test processes/);
  assert.match(msg, /ONLY these regenerable caches/);
});

test('the failure explains the misattribution shape, which is the tell', () => {
  const msg = inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(1048576, 9) });
  assert.match(msg, /SUITES/);
  assert.match(msg, /TESTS/);
});

test('a healthy filesystem produces no failure', () => {
  assert.equal(inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(1048576, 900000) }), null);
});

test('the floor is the boundary: one below fails, exactly at it passes', () => {
  const at = inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(1048576, MIN_FREE_INODES) });
  const below = inodePreflightFailure({
    consumers: () => [],
    dirs: ['/tmp'],
    statfsSync: statfs(1048576, MIN_FREE_INODES - 1),
  });
  assert.equal(at, null);
  assert.ok(below);
});

test('a platform that cannot report inodes never fails the run', () => {
  assert.equal(inodePreflightFailure({ consumers: () => [], dirs: ['/tmp'], statfsSync: statfs(0, 0) }), null);
});

test('duplicate directories are reported once', () => {
  const msg = inodePreflightFailure({
    consumers: () => [],
    dirs: ['/tmp', '/tmp', '/tmp'],
    statfsSync: statfs(1048576, 9),
  });
  assert.equal(msg.split('/tmp:').length - 1, 1);
});

test('every starved directory is named', () => {
  const msg = inodePreflightFailure({
    consumers: () => [],
    dirs: ['/tmp', '/var/cache'],
    statfsSync: statfs(1048576, 9),
  });
  assert.match(msg, /\/tmp:/);
  assert.match(msg, /\/var\/cache:/);
});

test('inodePreflightFailure runs against the real filesystem without throwing', () => {
  // No assertion on the verdict — this box's /tmp state is not the test. What is
  // under test is that the real statfs path is wired up and cannot explode.
  assert.doesNotThrow(() => inodePreflightFailure());
});

// ────────────────────────────────────────────────────── test path pattern check

const ROOT = '/var/home/dev/git/example/repo-guest-character-sheet-ab12c';

test('an issue id in the worktree name is recognised as matching everything', () => {
  // The measured case: ab12c appears in NO test path, only in the directory.
  assert.equal(patternMatchesRootPath('ab12c', ROOT), true);
});

test('a branch slug in the worktree name is recognised too', () => {
  assert.equal(patternMatchesRootPath('guest-character-sheet', ROOT), true);
  assert.equal(patternMatchesRootPath('guest-character', ROOT), true);
});

test('a pattern with a path separator is a real narrowing and is left alone', () => {
  assert.equal(patternMatchesRootPath('session/guest-character-sheet', ROOT), false);
  assert.equal(patternMatchesRootPath('route.test', ROOT), false);
  assert.equal(patternMatchesRootPath('mapViewerFileSizes|MapViewerLayout', ROOT), false);
});

test('an empty alternation branch is caught by the same check', () => {
  // Different cause, identical outcome: the regex matches the empty string, so
  // it matches every path.
  assert.equal(patternMatchesRootPath('uiKitConventions|', ROOT), true);
  assert.equal(patternMatchesRootPath('|b', ROOT), true);
  assert.equal(patternMatchesRootPath('(a|)', ROOT), true);
});

test('an empty pattern is not flagged — jest treats no pattern as unset', () => {
  assert.equal(patternMatchesRootPath('', ROOT), false);
});

test('an invalid regex is left to jest, which reports it itself', () => {
  assert.equal(patternMatchesRootPath('[unclosed', ROOT), false);
});

test('a targeted run produces no warning', () => {
  assert.equal(
    testPathPatternWarning({ patterns: ['session/guest-character-sheet'], rootDir: ROOT }),
    null,
  );
});

test('no patterns at all produces no warning — a full run is not a mistake', () => {
  assert.equal(testPathPatternWarning({ patterns: [], rootDir: ROOT }), null);
});

test('the warning names the pattern, the directory and the suite count', () => {
  const msg = testPathPatternWarning({ patterns: ['ab12c'], rootDir: ROOT, suiteCount: 1247 });
  assert.match(msg, /NOT A TARGETED RUN/);
  assert.match(msg, /ab12c/);
  assert.match(msg, /all 1247 suites/);
  assert.match(msg, new RegExp(ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(msg, /this pattern selected/);
});

test('the empty-branch case is explained as an empty branch, not as a directory match', () => {
  const msg = testPathPatternWarning({ patterns: ['uiKitConventions|'], rootDir: ROOT });
  assert.match(msg, /EMPTY STRING/);
  assert.match(msg, /empty alternation branch/);
});

test('the warning suggests a narrowing that works, and points at the suite count', () => {
  const msg = testPathPatternWarning({ patterns: ['ab12c'], rootDir: ROOT });
  assert.match(msg, /--testPathPatterns 'sessions\/guest-character-sheet'/);
  assert.match(msg, /Test Suites:/);
});

test('only the offending patterns are listed when a run mixes good and bad', () => {
  const msg = testPathPatternWarning({
    patterns: ['session/guest-character-sheet', 'ab12c'],
    rootDir: ROOT,
  });
  assert.match(msg, /ab12c/);
  assert.ok(
    !msg.includes("--testPathPatterns 'session/guest-character-sheet'"),
    'the legitimate pattern must not be listed as an offender',
  );
});

// ──────────────────────────────────── under-selection check ────

const CLONE_PANEL = `${ROOT}/src/app/campaigns/[id]/CloneCampaignPanel.test.tsx`;
const LIVE_STATUS = `${ROOT}/src/app/campaigns/[id]/CampaignLiveStatusProvider.test.tsx`;
const OTHER_MATCH = `${ROOT}/src/app/campaigns/CampaignList.test.tsx`;

test('patternMatchesPath matches the relative path', () => {
  assert.equal(patternMatchesPath('CampaignList.test', ROOT, OTHER_MATCH), true);
});

test('patternMatchesPath matches the absolute path too', () => {
  assert.equal(patternMatchesPath(ROOT.slice(1, 10), ROOT, OTHER_MATCH), true);
});

test('patternMatchesPath is case-insensitive, like jest', () => {
  assert.equal(patternMatchesPath('campaignlist', ROOT, OTHER_MATCH), true);
});

test('patternMatchesPath is false for an invalid regex — jest reports that itself', () => {
  assert.equal(patternMatchesPath('[unclosed', ROOT, OTHER_MATCH), false);
});

test('patternMatchesPath is false for an empty pattern', () => {
  assert.equal(patternMatchesPath('', ROOT, OTHER_MATCH), false);
});

test('patternMatchesPath reproduces the bug: [id] cannot match its own directory', () => {
  // `[id]` is a character class matching one of i/d, never the literal folder name —
  // this is the exact regex jest evaluates against CLONE_PANEL and finds no match.
  assert.equal(patternMatchesPath('src/app/campaigns/[id]/CloneCampaignPanel.test', ROOT, CLONE_PANEL), false);
});

test('patternMatchesPath matches a "/"-bearing pattern against a "\\"-separated path', () => {
  // jest gets this via `replacePathSepForRegex` (it rewrites `/` to `\\` when
  // path.sep is '\'); this module gets it by normalising the PATHS to '/'.
  // Either way the answer must be the same, because WITHOUT it every
  // '/'-bearing pattern misses on Windows — and then no pattern is ever seen
  // to have selected anything, the `some(other)` guard never fires, and the
  // whole under-selection warning is a silent no-op on the self-hosted fleet.
  const winRoot = 'D:\\Worktrees\\repo-x';
  const winPath = `${winRoot}\\src\\app\\campaigns\\CampaignList.test.tsx`;
  assert.equal(patternMatchesPath('src/app/campaigns/', winRoot, winPath), true);
  assert.equal(patternMatchesPath('campaigns/CampaignList.test', winRoot, winPath), true);
});

test('underselecting warning still fires when the paths are "\\"-separated', () => {
  // The end-to-end consequence of the test above, which is the thing that
  // actually regressed: same scenario as the dropped-selector reproduction, but with
  // Windows-shaped paths.
  const winRoot = 'D:\\Worktrees\\repo-x';
  const winClone = `${winRoot}\\src\\app\\campaigns\\[id]\\CloneCampaignPanel.test.tsx`;
  const winOther = `${winRoot}\\src\\app\\campaigns\\CampaignList.test.tsx`;
  const warning = underselectingBracketPatternWarning({
    patterns: ['src/app/campaigns/[id]/CloneCampaignPanel.test.tsx', 'src/app/campaigns/'],
    rootDir: winRoot,
    selectedFilePaths: [winOther, winClone],
  });
  assert.ok(warning, 'the dropped bracket selector must still be reported on Windows-shaped paths');
  assert.match(warning, /CloneCampaignPanel/);
});

test('patternMatchesPath anchors a leading "./" instead of letting the dot match any character', () => {
  // jest: `p.replace(/^\.\//, '^')`. Without it the leading `.` is a regex
  // wildcard, so './src/...' would need a literal '/src/...' SOMEWHERE in the
  // path and would miss a path that actually starts with 'src/'.
  assert.equal(patternMatchesPath('./src/app/campaigns/CampaignList.test', ROOT, OTHER_MATCH), true);
});

test('no warning with fewer than two patterns — the single-pattern case is already loud', () => {
  assert.equal(
    underselectingBracketPatternWarning({
      patterns: ['src/app/campaigns/[id]/CloneCampaignPanel.test'],
      rootDir: ROOT,
      selectedFilePaths: [],
    }),
    null,
  );
});

test('no warning when nothing was selected at all — every pattern failed together, not just the bracketed one', () => {
  assert.equal(
    underselectingBracketPatternWarning({
      patterns: ['src/app/campaigns/[id]/CloneCampaignPanel.test', 'src/app/campaigns/[id]/CampaignLiveStatusProvider.test'],
      rootDir: ROOT,
      selectedFilePaths: [],
    }),
    null,
  );
});

test('the dropped-selector reproduction: one bracket pattern dropped while a sibling selector succeeds', () => {
  const msg = underselectingBracketPatternWarning({
    patterns: ['campaigns/', 'src/app/campaigns/[id]/CloneCampaignPanel.test'],
    rootDir: ROOT,
    selectedFilePaths: [OTHER_MATCH],
  });
  assert.ok(msg, 'expected a warning');
  assert.match(msg, /SILENTLY DROPPED/);
  assert.match(msg, /another pattern in the same command selected some/);
  assert.match(msg, /SINGLE pattern/);
  assert.ok(msg.includes("--testPathPatterns 'src/app/campaigns/[id]/CloneCampaignPanel.test'"));
  assert.ok(!msg.includes("--testPathPatterns 'campaigns/'"), 'the pattern that actually matched must not be listed');
});

test('runTestsByPath: --runTestsByPath makes positional values literal paths, so no "dropped" warning', () => {
  // Same shape as the dropped-selector reproduction, but jest ran in literal-path mode: the
  // `[id]` path selected CLONE_PANEL verbatim, so it is in selectedFilePaths and nothing
  // was dropped. A character-class analysis of it would be a false alarm.
  const patterns = ['campaigns/', 'src/app/campaigns/[id]/CloneCampaignPanel.test.tsx'];
  const selectedFilePaths = [OTHER_MATCH, CLONE_PANEL];
  assert.equal(underselectingBracketPatternWarning({ patterns, rootDir: ROOT, selectedFilePaths, runTestsByPath: true }), null);
  // Even if the selected list is missing the file, literal mode never reasons about regexes.
  assert.equal(
    underselectingBracketPatternWarning({ patterns, rootDir: ROOT, selectedFilePaths: [OTHER_MATCH], runTestsByPath: true }),
    null,
  );
});

test('runTestsByPath: without --runTestsByPath the same regex selectors still warn', () => {
  const patterns = ['campaigns/', 'src/app/campaigns/[id]/CloneCampaignPanel.test.tsx'];
  for (const runTestsByPath of [false, undefined]) {
    const msg = underselectingBracketPatternWarning({ patterns, rootDir: ROOT, selectedFilePaths: [OTHER_MATCH], runTestsByPath });
    assert.ok(msg, 'a genuinely dropped regex selector must keep its warning');
    assert.match(msg, /SILENTLY DROPPED/);
  }
});

test('a bracket pattern that DID select something is not flagged', () => {
  // A character class can be a deliberate, working regex — `[Cc]ampaignList` matches
  // the real `CampaignList.test.tsx` file, so carrying an unescaped `[` alone must not
  // be enough to flag a pattern.
  assert.equal(
    underselectingBracketPatternWarning({
      patterns: ['[Cc]ampaignList.test', 'campaigns/CampaignList'],
      rootDir: ROOT,
      selectedFilePaths: [OTHER_MATCH],
    }),
    null,
  );
});

test('an escaped bracket is never flagged, even when it matches nothing — that is a deliberate literal, not the unescaped-bracket mistake', () => {
  assert.equal(
    underselectingBracketPatternWarning({
      patterns: ['campaigns/\\[nonexistent\\]/Nope.test', 'campaigns/CampaignList.test'],
      rootDir: ROOT,
      selectedFilePaths: [OTHER_MATCH],
    }),
    null,
  );
});

test('a bracket-free pattern that matches nothing is left to other checks, not this one', () => {
  assert.equal(
    underselectingBracketPatternWarning({
      patterns: ['campaigns/DoesNotExist.test', 'campaigns/CampaignList.test'],
      rootDir: ROOT,
      selectedFilePaths: [OTHER_MATCH],
    }),
    null,
  );
});

test('every offending pattern is listed when a run drops more than one', () => {
  const msg = underselectingBracketPatternWarning({
    patterns: [
      'campaigns/CampaignList.test',
      'src/app/campaigns/[id]/CloneCampaignPanel.test',
      'src/app/campaigns/[id]/CampaignLiveStatusProvider.test',
    ],
    rootDir: ROOT,
    selectedFilePaths: [OTHER_MATCH],
  });
  assert.ok(msg.includes("--testPathPatterns 'src/app/campaigns/[id]/CloneCampaignPanel.test'"));
  assert.ok(msg.includes("--testPathPatterns 'src/app/campaigns/[id]/CampaignLiveStatusProvider.test'"));
});

test('the warning never fails the run — it says so explicitly', () => {
  const msg = underselectingBracketPatternWarning({
    patterns: ['campaigns/CampaignList.test', 'src/app/campaigns/[id]/CloneCampaignPanel.test'],
    rootDir: ROOT,
    selectedFilePaths: [OTHER_MATCH],
  });
  assert.match(msg, /never fails the run/);
});

test('LIVE_STATUS fixture is itself unmatched by its own bracket pattern, mirroring the original demo', () => {
  assert.equal(
    patternMatchesPath('src/app/campaigns/[id]/CampaignLiveStatusProvider.test', ROOT, LIVE_STATUS),
    false,
  );
});

// ──────────────────────────────────────────── bash resolution preflight

const SYSTEM32_BASH = 'C:\\Windows\\System32\\bash.exe';
const GIT_BASH = 'C:\\Program Files\\Git\\bin\\bash.exe';

/** A fake Windows filesystem: `exists` is true only for the listed files. */
const fakeFs = (...files) => {
  const set = new Set(files.map((f) => f.toLowerCase()));
  return (p) => set.has(p.toLowerCase());
};

const WIN = { platform: 'win32' };

test('isWslBashLauncher recognises System32, its aliases and the WindowsApps stub, and not Git Bash', () => {
  assert.equal(isWslBashLauncher(SYSTEM32_BASH), true);
  assert.equal(isWslBashLauncher('c:\\windows\\sysnative\\bash.exe'), true);
  assert.equal(isWslBashLauncher('C:\\Users\\dev\\AppData\\Local\\Microsoft\\WindowsApps\\bash.exe'), true);
  assert.equal(isWslBashLauncher(GIT_BASH), false);
  assert.equal(isWslBashLauncher('C:\\Program Files\\Git\\usr\\bin\\bash.exe'), false);
});

test('resolveOnWindowsPath returns the FIRST bash.exe on PATH, and reads the key whatever its case', () => {
  const exists = fakeFs(SYSTEM32_BASH, GIT_BASH);
  const env = { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\bin' };
  assert.equal(resolveOnWindowsPath('bash', { env, exists }), SYSTEM32_BASH);
  assert.equal(
    resolveOnWindowsPath('bash', { env: { PATH: 'C:\\Program Files\\Git\\bin;C:\\Windows\\System32' }, exists }),
    GIT_BASH,
  );
  assert.equal(resolveOnWindowsPath('bash', { env: { PATH: 'C:\\nowhere' }, exists }), null);
});

test('bash preflight is a no-op off Windows and when opted out', () => {
  assert.equal(bashResolutionPlan({ platform: 'linux', env: {}, exists: () => false }).status, 'skip');
  assert.equal(
    bashResolutionPlan({ ...WIN, env: { PATH: 'C:\\Windows\\System32', AGENT_TOOLING_SKIP_BASH_PREFLIGHT: '1' }, exists: fakeFs(SYSTEM32_BASH) })
      .status,
    'skip',
  );
});

test('Git Bash first on PATH is fine and changes nothing', () => {
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Program Files\\Git\\bin;C:\\Windows\\System32' },
    exists: fakeFs(SYSTEM32_BASH, GIT_BASH),
  });
  assert.equal(plan.status, 'ok');
  assert.equal(plan.resolved, GIT_BASH);
});

test('the WSL-launcher shape: WSL launcher first and Git installed -> prepend Git bin, say why', () => {
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd', ProgramFiles: 'C:\\Program Files' },
    exists: fakeFs(SYSTEM32_BASH, GIT_BASH, 'C:\\Program Files\\Git\\cmd\\git.exe'),
  });
  assert.equal(plan.status, 'prepend');
  assert.equal(plan.prependDir, 'C:\\Program Files\\Git\\bin');
  assert.match(plan.message, /WSL launcher/);
  assert.match(plan.message, /execvpe/);
});

test('Git is found from the standard install root even when git.exe is not on PATH', () => {
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' },
    exists: fakeFs(SYSTEM32_BASH, GIT_BASH),
  });
  assert.equal(plan.status, 'prepend');
  assert.equal(plan.prependDir, 'C:\\Program Files\\Git\\bin');
});

test('the git.exe on PATH wins over the default install root', () => {
  const custom = 'D:\\Tools\\Git\\bin\\bash.exe';
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Windows\\System32;D:\\Tools\\Git\\cmd', ProgramFiles: 'C:\\Program Files' },
    exists: fakeFs(SYSTEM32_BASH, GIT_BASH, custom, 'D:\\Tools\\Git\\cmd\\git.exe'),
  });
  assert.equal(plan.prependDir, 'D:\\Tools\\Git\\bin');
});

test('no bash on PATH at all is treated like the WSL launcher: prepend when Git exists', () => {
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' },
    exists: fakeFs(GIT_BASH),
  });
  assert.equal(plan.status, 'prepend');
  assert.match(plan.message, /no `bash.exe` is on PATH/);
});

test('WSL launcher and NO Git Bash anywhere fails early with an actionable message', () => {
  const plan = bashResolutionPlan({
    ...WIN,
    env: { PATH: 'C:\\Windows\\System32', ProgramFiles: 'C:\\Program Files' },
    exists: fakeFs(SYSTEM32_BASH),
  });
  assert.equal(plan.status, 'fail');
  assert.match(plan.message, /NO USABLE bash/);
  assert.match(plan.message, /execvpe\(\/bin\/bash\) failed/);
  assert.match(plan.message, /Git for Windows/);
  assert.match(plan.message, /AGENT_TOOLING_SKIP_BASH_PREFLIGHT=1/);
});

test('withBashPlanApplied prepends once, keeping the existing PATH key (Path, not a second PATH)', () => {
  const env = { Path: 'C:\\Windows\\System32', Other: 'x' };
  const next = withBashPlanApplied(env, { status: 'prepend', prependDir: 'C:\\Program Files\\Git\\bin' });
  assert.deepEqual(Object.keys(next).sort(), ['Other', 'Path']);
  assert.equal(next.Path, 'C:\\Program Files\\Git\\bin;C:\\Windows\\System32');
  assert.equal(env.Path, 'C:\\Windows\\System32', 'the input env is not mutated');
});

test('withBashPlanApplied leaves env alone for every other status', () => {
  const env = { PATH: 'C:\\Windows\\System32' };
  for (const status of ['skip', 'ok', 'fail']) {
    assert.equal(withBashPlanApplied(env, { status, prependDir: 'C:\\x' }), env);
  }
});

test('bashResolutionPlan runs against the real host without throwing', () => {
  assert.ok(['skip', 'ok', 'prepend', 'fail'].includes(bashResolutionPlan().status));
});

// ───────────────────────────────────────────── python preflight

/** A fake spawnSync: `table` maps candidate name -> result; unlisted names are ENOENT. */
const fakeSpawn = (table, calls = []) => (name, args) => {
  calls.push([name, ...args]);
  return table[name] ?? { status: null, error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
};
const STORE_STUB = {
  status: 9009,
  stdout: '',
  stderr: 'Python was not found; run without arguments to install from the Microsoft Store',
};

test('python preflight is a no-op off Windows and when opted out', () => {
  const spawn = () => assert.fail('must not probe');
  assert.equal(pythonResolutionReport({ platform: 'linux', env: {}, spawn }).status, 'skip');
  assert.equal(pythonResolutionReport({ platform: 'win32', env: { AGENT_TOOLING_SKIP_PYTHON_PREFLIGHT: '1' }, spawn }).status, 'skip');
});

test('the first candidate that can `import sys` is accepted, in the shell helper lookup order', () => {
  const calls = [];
  const report = pythonResolutionReport({
    platform: 'win32',
    env: {},
    spawn: fakeSpawn({ python3: STORE_STUB, python: { status: 0 } }, calls),
  });
  assert.equal(report.status, 'ok');
  assert.equal(report.found, 'python');
  assert.deepEqual(
    calls.map((c) => c[0]),
    PYTHON_CANDIDATES,
  );
  assert.deepEqual(calls[0].slice(1), ['-c', 'import sys']);
});

test('the Store-stub shape: only the Microsoft Store stub -> missing, naming the stub and the failing suites', () => {
  const report = pythonResolutionReport({
    platform: 'win32',
    env: {},
    spawn: fakeSpawn({ python3: STORE_STUB, python: STORE_STUB }),
  });
  assert.equal(report.status, 'missing');
  assert.match(report.message, /NO WORKING PYTHON/);
  assert.match(report.message, /python3: Microsoft Store alias stub/);
  assert.match(report.message, /python3\.11: not on PATH/);
  assert.match(report.message, /suites that shell out to a Python helper/);
  assert.match(report.message, /never fails the run/);
});

test('a stub is recognised by its own message even when the exit status differs', () => {
  const report = pythonResolutionReport({
    platform: 'win32',
    env: {},
    spawn: fakeSpawn({ python: { status: 1, stderr: 'Python was not found; run without arguments' } }),
  });
  assert.match(report.message, /python: Microsoft Store alias stub/);
});

test('a candidate that runs but exits nonzero is reported with its status', () => {
  const report = pythonResolutionReport({ platform: 'win32', env: {}, spawn: fakeSpawn({ python3: { status: 3 } }) });
  assert.equal(report.status, 'missing');
  assert.match(report.message, /python3: exited 3/);
});

test('pythonResolutionReport runs against the real host without throwing', () => {
  assert.ok(['skip', 'ok', 'missing'].includes(pythonResolutionReport().status));
});

// ── top inode consumers ─────────────────────────────────────────

test('inodeGroupName groups by the leading non-numeric tokens', () => {
  assert.equal(inodeGroupName('scratch-applied-4521-9.txt'), 'scratch-applied');
  assert.equal(inodeGroupName('tsx-1000'), 'tsx');
  assert.equal(inodeGroupName('jest_rs'), 'jest_rs');
  assert.equal(inodeGroupName('12345'), '12345');
});

/** Fake readdir over a { dir: [[name, isDir], ...] } tree. */
function fakeReaddir(tree) {
  return dir => {
    if (!(dir in tree)) throw new Error(`ENOENT ${dir}`);
    return tree[dir].map(([name, isDir]) => ({
      name,
      isDirectory: () => Boolean(isDir),
      isSymbolicLink: () => false,
    }));
  };
}

test('topInodeConsumers counts files and walks directories, largest group first', () => {
  const readdirSync = fakeReaddir({
    '/tmp': [
      ['scratch-applied-1-2.md', false],
      ['scratch-applied-1-3.md', false],
      ['scratch-dropped-1-2.md', false],
      ['tsx-1000', true],
      ['claude-1000', true],
    ],
    '/tmp/tsx-1000': [['a', false], ['b', false], ['sub', true]],
    '/tmp/tsx-1000/sub': [['c', false]],
    '/tmp/claude-1000': [],
  });
  assert.deepEqual(topInodeConsumers('/tmp', { readdirSync }), [
    { name: 'tsx', count: 5 },
    { name: 'scratch-applied', count: 2 },
    { name: 'claude', count: 1 },
    { name: 'scratch-dropped', count: 1 },
  ]);
  assert.equal(topInodeConsumers('/tmp', { readdirSync, limit: 1 }).length, 1);
});

test('topInodeConsumers returns [] for an unreadable directory', () => {
  assert.deepEqual(topInodeConsumers('/nope', { readdirSync: fakeReaddir({}) }), []);
});

test('the failure names the top consumers, so the next person need not measure', () => {
  const msg = inodePreflightFailure({
    dirs: ['/tmp'],
    tmpdir: '/tmp',
    statfsSync: statfs(1048576, 9),
    consumers: () => [
      { name: 'scratch-applied', count: 13000 },
      { name: 'tsx', count: 75821 },
    ],
  });
  assert.match(msg, /Top inode consumers under \/tmp/);
  assert.match(msg, /75,821\s+tsx/);
  assert.match(msg, /13,000\s+scratch-applied/);
  assert.match(msg, /scratch files older than a day/);
});

test('the failure omits the consumers section when nothing could be measured', () => {
  const msg = inodePreflightFailure({ dirs: ['/tmp'], statfsSync: statfs(1048576, 9), consumers: () => [] });
  assert.doesNotMatch(msg, /Top inode consumers/);
});
