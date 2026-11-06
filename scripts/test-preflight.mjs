// Two checks a test run makes about ITSELF before it starts, because both
// failure modes are reported as something else entirely.
//
// ── 1. FREE INODES ────────────────────────────────────────────────
//
// `npm test` once reported **1196 of 1245 suites FAILED** (82 failed tests,
// 3294 passed) in 356s against a three-file change whose `type-check` and
// `lint` were both green. The cause was not in the diff: `/tmp` had **9 free
// inodes of 1048576** while 49G of its 63G was free. Jest cannot write its
// transform cache, so suites die at COLLECTION time, before asserting
// anything:
//
//     jest: failed to cache transform results in: /tmp/jest_rs/jest-transform-cache-…
//     Failure message: ENOSPC: no space left on device, open '…'
//
// Three things make that expensive rather than merely annoying:
//
//   * `df -h` agrees there is space. The error says "no space left on device"
//     and the obvious check says there is plenty, so the natural next move is
//     to disbelieve the error and start bisecting the diff. `df -i` is the
//     check that answers it, and nothing points there.
//   * Jest attributes the failure to the code under test — an ordinary
//     `● Test suite failed to run` with a source excerpt and a caret under an
//     import line, which reads as a module-resolution problem in that file.
//   * It is silent until it is total. Both caches grow monotonically across
//     every session on the box, and N concurrent sessions share one `/tmp`, so
//     the session that hits the wall is not the one that filled it.
//
// The shape is the tell and belongs in the message: 1196 SUITES failing while
// only 82 TESTS fail means almost nothing RAN. No ordinary regression does
// that. Same family as the rule that a nonzero exit with no diagnostics is
// not evidence about the code.
//
// This deliberately does NOT clean up by itself. `/tmp/jest_rs` is shared by
// every session on this box, so deleting it under a peer's running jest costs
// them a cache miss or a transient failure. The supported maintenance command
// checks for test processes before removing only these two regenerable caches.
//
// ── 2. A TEST PATH PATTERN THAT SELECTS EVERYTHING ─────
//
// `--testPathPatterns` is matched against the **absolute** path, and
// worktrees are commonly named `<repo>-<slug>-<issueid>`. So a
// pattern echoing the branch slug or the issue id — the two strings anyone
// reaches for FIRST when narrowing a run — matches the directory component of
// every file in the tree and silently selects all ~1247 suites. Measured:
// `--testPathPatterns 'ab12c'` selected 1237 suites in a worktree where
// that issue id appears in no test path at all, only in the directory name.
//
// The failure is in the SAFE direction — it over-runs, never under-runs — which
// is exactly why nobody notices, and it is not free: ~4 minutes per "quick
// check" on a box where concurrent sessions already contend for CPU, and a
// `Tests: 18846 passed` that reads as the result of a four-branch pattern.
//
// An **empty alternation branch** (`'a|'`, `'|b'`, a pattern joined from a list
// with a trailing `|`) has the same outcome from a different cause, and this
// catches it with the same test: a regex that matches the root directory's own
// path matches every file under it, whatever the file is called.
//
// This one WARNS and never fails. Over-running is the safe direction; a fix
// that traded it for under-running would be worse than the bug.
//
// ── 3. A BRACKET-BEARING SELECTOR SILENTLY DROPPED AMONG SEVERAL ──
//
// This is the MIRROR of check 2 — UNDER-selection instead of over-selection —
// and it needed a separate check because check 2's tell (the suite count) does
// not survive contact with more than one positional pattern.
//
// The single-pattern case is already covered: a jest positional
// argument is a regex, not a glob, so `src/app/adventures/[id]/NoteEditor.test.tsx`
// is read as a character class matching one of `i`/`d` — never the literal
// `[id]` directory — and the pattern matches nothing. With ONE pattern that is
// loud: jest exits with "No tests found" or reports `Test Suites: 0`.
//
// It stops being loud the moment a run passes SEVERAL positional patterns at
// once, which is exactly how an automated worker narrows a run to more than
// one changed file. jest ORs every pattern together (`TestPathPatternsExecutor
// .isMatch` returns true on the first pattern that matches), so the suites the
// OTHER patterns found still run. A 12-pattern run where one pattern is
// `src/app/campaigns/[id]/CloneCampaignPanel.test.tsx` reports
// `Test Suites: 11 passed, 11 total` and exits 0 — an ordinary-looking count,
// one short of what was intended, with nothing pointing at which selector went
// missing. Neither of the single-pattern tells (an error, or a suite count of zero)
// exists in this shape.
//
// A mutation-check CLI can warn about this exact character for
// its own callers, so the "unescaped" predicate is SHARED rather than
// re-derived — the two checks must agree on what an escaped `[` is. It lives
// HERE and such a CLI imports it, not the other way round: this module is
// loaded by a jest globalSetup and reporter on every single
// jest run, and pointing that hot path at a large CLI that imports
// `node:child_process` would put every test run in the repo behind whatever
// that file does at import time.
//
// This is the under-selection direction, so like check 2 it WARNS and never
// fails: a run that otherwise passed should not be blocked on this, and the
// whole point is that the drop is currently invisible, not that it should be
// fatal.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * True when `ch` appears in `value` without a regex backslash escape in front
 * of it. (An even number of preceding backslashes means the backslashes
 * escape each other, so the character itself is still live.)
 *
 * Shared with callers that re-export it (a mutation-check CLI, for one) — see the
 * header note above for why it is defined in this module and not in them.
 *
 * @param {string} value
 * @param {string} ch  a single character
 */
export function hasUnescaped(value, ch) {
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== ch) continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && value[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 0) return true;
  }
  return false;
}

/**
 * Free inodes below this and a full jest run is at real risk of the failure
 * above. Not a guess about jest's exact appetite — it is a floor far enough
 * above zero that the run either succeeds or is stopped with a legible reason,
 * never the 1196-red middle.
 */
export const MIN_FREE_INODES = 20_000;

/**
 * The regenerable caches that hold the inodes, under `tmpdir`. Deleting either
 * costs a cache miss and nothing else; NOTHING WIDER may be swept, because
 * `/tmp/claude-*` holds other sessions' scratchpads.
 *
 * @param {string} tmpdir
 */
export function regenerableCaches(tmpdir) {
  const base = tmpdir.replace(/[/\\]+$/, '');
  return [`${base}/jest_rs`, `${base}/node-compile-cache`];
}

/**
 * The group a top-level temp entry belongs to: its leading name tokens up to the
 * first one carrying a digit (a pid, PR number or uid), at most three. So
 * `scratch-applied-4521-9.txt` -> `scratch-applied`, `tsx-1000` -> `tsx`.
 *
 * @param {string} name
 */
export function inodeGroupName(name) {
  const kept = [];
  for (const token of name.split('-')) {
    if (/\d/.test(token) || kept.length >= 3) break;
    kept.push(token);
  }
  return kept.length ? kept.join('-') : name;
}

/**
 * Who is holding the inodes under `dir`: every entry (directories walked, to a
 * budget) counted into its top-level group, largest first. In one measured case the two
 * known caches were small and ~93,000 scratch files plus a 75k-entry
 * `tsx-<uid>` cache held the rest, which nobody could see without measuring by hand.
 * Returns [] when `dir` cannot be read.
 *
 * @param {string} dir
 * @param {{ readdirSync?: Function, limit?: number, budget?: number }} [deps]
 * @returns {{ name: string, count: number }[]}
 */
export function topInodeConsumers(dir, deps = {}) {
  const readdirSync = deps.readdirSync ?? fs.readdirSync;
  const limit = deps.limit ?? 6;
  let budget = deps.budget ?? 2_000_000;
  /** @type {Map<string, number>} */
  const groups = new Map();
  let top;
  try {
    top = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const base = dir.replace(/[/\\]+$/, '');
  for (const entry of top) {
    const group = inodeGroupName(entry.name);
    let count = 1;
    if (entry.isDirectory() && !entry.isSymbolicLink?.()) {
      const stack = [`${base}/${entry.name}`];
      while (stack.length && budget > 0) {
        const current = stack.pop();
        let children;
        try {
          children = readdirSync(current, { withFileTypes: true });
        } catch {
          continue;
        }
        count += children.length;
        budget -= children.length;
        for (const child of children) {
          if (child.isDirectory() && !child.isSymbolicLink?.()) stack.push(`${current}/${child.name}`);
        }
      }
    }
    budget -= 1;
    groups.set(group, (groups.get(group) ?? 0) + count);
  }
  return [...groups]
    .map(([name, count]) => ({ name, count }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    .slice(0, limit);
}

/**
 * `{ files, ffree }` for the filesystem holding `dir`, or null when the
 * platform does not report inode counts (Windows reports zeros) or the path
 * cannot be stat'd.
 *
 * @param {string} dir
 * @param {{ statfsSync?: (p: string) => { files?: number|bigint, ffree?: number|bigint } }} [deps]
 */
export function inodeUsage(dir, deps = {}) {
  // `in` rather than `??`: an explicit `{ statfsSync: undefined }` must mean
  // "there is no statfs here" (an old Node, the branch below), not "fall back to
  // the real one" — otherwise that branch is untestable.
  const statfsSync = 'statfsSync' in deps ? deps.statfsSync : fs.statfsSync;
  if (typeof statfsSync !== 'function') return null;
  let st;
  try {
    st = statfsSync(dir);
  } catch {
    return null;
  }
  const files = Number(st?.files ?? 0);
  const ffree = Number(st?.ffree ?? 0);
  // A filesystem that reports no inode total has no inode limit to check.
  if (!Number.isFinite(files) || files <= 0) return null;
  if (!Number.isFinite(ffree)) return null;
  return { files, ffree };
}

/**
 * The message for a run that must not start, or null when there are enough
 * inodes (or the platform cannot say).
 *
 * @param {{ dirs?: string[], min?: number, tmpdir?: string, statfsSync?: Function, consumers?: (dir: string) => { name: string, count: number }[] }} [options]
 * @returns {string | null}
 */
export function inodePreflightFailure(options = {}) {
  const dirs = options.dirs ?? [os.tmpdir()];
  const min = options.min ?? MIN_FREE_INODES;

  /** @type {{ dir: string, files: number, ffree: number }[]} */
  const starved = [];
  const seen = new Set();
  for (const dir of dirs) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const usage = inodeUsage(dir, options);
    if (usage && usage.ffree < min) starved.push({ dir, ...usage });
  }
  if (starved.length === 0) return null;

  const lines = [
    'OUT OF INODES — the test run was stopped before it could blame your code.',
    '',
  ];
  for (const { dir, files, ffree } of starved) {
    const used = files - ffree;
    const pct = Math.round((used / files) * 100);
    lines.push(`  ${dir}: ${ffree.toLocaleString()} free inodes of ${files.toLocaleString()} (${pct}% used)`);
  }
  const worst = starved[0].dir;
  const scanDir = options.tmpdir ?? os.tmpdir();
  const consumers = (options.consumers ?? topInodeConsumers)(scanDir);
  if (consumers.length) {
    lines.push('', `Top inode consumers under ${scanDir}:`);
    for (const { name, count } of consumers) lines.push(`  ${count.toLocaleString().padStart(10)}  ${name}`);
  }
  lines.push(
    '',
    'This is NOT a disk-space problem, and `df -h` will tell you there is plenty of room.',
    'The runner cannot write its transform / compile cache, so work fails at COLLECTION time',
    'and is attributed to whatever file it was reading. Under jest that is an ordinary-looking',
    '"● Test suite failed to run" with a caret under an import line, which reads as a module-',
    'resolution bug in that file. The tell is the shape: hundreds of SUITES failing while only',
    'a handful of TESTS do means almost nothing ran.',
    '',
    'Confirm it:',
    `  df -i ${worst}            # IUse% at 100 while df -h shows space free`,
    '',
    'Fix it — these are regenerable. Check for active test processes first, then',
    'remove ONLY these regenerable caches (jest_rs, node-compile-cache) plus your own scratch files older than a day,',
    "and leave other sessions' scratchpads and everything else alone. If this repository has a",
    'test-cache maintenance command, it does exactly that safely; run it.',
    '',
    'Then re-run. A cleared cache took one measured run from 1196 failed suites in 356s',
    'to 1245 suites / 19012 tests green in 28s.',
    '',
    'Override with AGENT_TOOLING_SKIP_INODE_PREFLIGHT=1 if you know better than this check.',
  );
  return lines.join('\n');
}

/**
 * True when `pattern` (a jest `--testPathPatterns` value, matched as an
 * unanchored regex against the ABSOLUTE path) matches the root directory
 * itself — in which case it matches every file under it regardless of the
 * file's repo-relative path, and the run is not targeted at all.
 *
 * @param {string} pattern
 * @param {string} rootDir
 */
export function patternMatchesRootPath(pattern, rootDir) {
  if (typeof pattern !== 'string' || pattern === '') return false;
  let re;
  try {
    re = new RegExp(pattern);
  } catch {
    return false; // jest reports an invalid pattern itself, loudly
  }
  return re.test(rootDir);
}

/**
 * A warning for every `--testPathPatterns` value that selects the whole suite,
 * or null when each one really narrows the run.
 *
 * @param {{ patterns?: string[], rootDir?: string, suiteCount?: number }} options
 * @returns {string | null}
 */
export function testPathPatternWarning({ patterns = [], rootDir = '', suiteCount } = {}) {
  const blind = patterns.filter(p => patternMatchesRootPath(p, rootDir));
  if (blind.length === 0) return null;

  const ran = suiteCount === undefined ? 'every suite in the repo' : `all ${suiteCount} suites`;
  const lines = [
    'NOT A TARGETED RUN — this pattern selected ' + ran + '.',
    '',
  ];
  for (const p of blind) {
    const why = new RegExp(p).test('')
      ? 'matches the EMPTY STRING (an empty alternation branch, e.g. a trailing "|"), so it matches every path'
      : `matches the worktree directory itself (${rootDir}), so it matches every file under it`;
    lines.push(`  --testPathPatterns '${p}'`, `      ${why}`);
  }
  lines.push(
    '',
    'jest matches these as an unanchored regex against the ABSOLUTE path, and a worktree directory',
    'often names a worktree <repo>-<slug>-<issueid> — so a pattern naming the issue or the branch',
    'slug matches the directory, not a test file. The run still passes; it just tells you',
    'nothing about the four suites you meant to check.',
    '',
    'Narrow it with something that cannot appear in a directory above the repo root:',
    "  --testPathPatterns 'sessions/guest-character-sheet'   # a slash makes it unambiguous",
    "  --testPathPatterns 'route.test'                       # or name the file",
    '',
    'Either way, read the "Test Suites:" count below against what you meant to run.',
  );
  return lines.join('\n');
}

/**
 * True when `pattern` matches `absPath` the way jest matches a
 * `--testPathPatterns` / positional value: an unanchored, case-insensitive
 * regex, tried against the path relative to `rootDir` and again against the
 * absolute path.
 *
 * Modelled on `@jest/pattern`'s `TestPathPatternsExecutor.isMatch`, but it is
 * a DELIBERATE APPROXIMATION of it, not a mirror — `@jest/pattern` is a
 * TRANSITIVE dependency this repo does not declare, so importing the real
 * executor here would couple every jest run to a package `package.json` never
 * names. Two of its steps are reproduced and one is not:
 *
 *   * reproduced — a leading `./` (or `.\` on Windows) becomes `^`, so
 *     `./foo.test.ts` anchors instead of letting the `.` match any character;
 *   * reproduced in EFFECT — jest runs the pattern through
 *     `replacePathSepForRegex`, which rewrites `/` to `\\` when
 *     `path.sep === '\\'` so a `/`-bearing pattern still matches a
 *     `\`-separated path. Normalising the PATHS to `/` reaches the same answer
 *     for the patterns people actually write, without re-deriving that regex
 *     rewrite. **This is load-bearing, not cosmetic:** without it every
 *     `/`-bearing pattern fails to match on Windows, so no pattern is ever
 *     seen to have "selected something", the `some(other)` guard below never
 *     fires, and the whole under-selection check degrades to a SILENT NO-OP on
 *     exactly the self-hosted Windows fleet where automated workers run;
 *   * NOT reproduced — a pattern written with literal `\` separators. jest
 *     handles it, this returns false. Warn-only, and nobody hand-writes
 *     Windows-separator jest patterns, so the cost is a missed warning rather
 *     than a false one — the safe direction for a diagnostic.
 *
 * @param {string} pattern
 * @param {string} rootDir
 * @param {string} absPath
 */
export function patternMatchesPath(pattern, rootDir, absPath) {
  if (typeof pattern !== 'string' || pattern === '') return false;
  let re;
  try {
    // jest: `p.replace(/^\.\//, '^')`, plus the `.\` form when sep is '\'.
    re = new RegExp(pattern.replace(/^\.[/\\]/, '^'), 'i');
  } catch {
    return false; // jest reports an invalid pattern itself, loudly
  }
  const toPosix = (p) => p.replaceAll('\\', '/');
  const relPath = toPosix(path.relative(rootDir || '/', absPath));
  return re.test(relPath) || re.test(toPosix(absPath));
}

/**
 * A warning for every pattern that carries an unescaped `[` and matched NONE
 * of the suites this run actually selected, while at least one OTHER pattern
 * in the same run matched some — the signature that distinguishes a silently
 * dropped selector from the already-loud single-pattern,
 * zero-suite case, which this deliberately does not
 * duplicate: requiring another pattern to have matched something is what
 * keeps this off a run where every pattern, including the offending one,
 * legitimately selected nothing.
 *
 * jest ORs every pattern together, so the set of suites a run selects is the
 * UNION of what each pattern matches on its own — nothing is filtered out of
 * that union afterward. Checking a single pattern against the union (rather
 * than against the whole repo, which this file has no way to enumerate) is
 * therefore exactly equivalent to asking "did this pattern contribute
 * anything": any file it matches anywhere is necessarily already part of the
 * union this run reports.
 *
 * @param {{ patterns?: string[], rootDir?: string, selectedFilePaths?: string[], runTestsByPath?: boolean }} options
 * @returns {string | null}
 */
export function underselectingBracketPatternWarning({
  patterns = [],
  rootDir = '',
  selectedFilePaths = [],
  runTestsByPath = false,
} = {}) {
  // `--runTestsByPath`: jest treats every
  // positional value as a LITERAL file path, not a regex, so a `[id]` directory
  // is matched verbatim and nothing was dropped. Regex analysis would be wrong.
  if (runTestsByPath) return null;
  if (!Array.isArray(patterns) || patterns.length < 2) return null;
  if (!Array.isArray(selectedFilePaths) || selectedFilePaths.length === 0) return null;

  const matchesSomething = (pattern) => selectedFilePaths.some((abs) => patternMatchesPath(pattern, rootDir, abs));

  const offenders = patterns.filter((pattern) => {
    if (!hasUnescaped(pattern, '[')) return false;
    if (matchesSomething(pattern)) return false; // it selected something — not the bug
    return patterns.some((other) => other !== pattern && matchesSomething(other));
  });
  if (offenders.length === 0) return null;

  const lines = [
    'A SELECTOR WAS SILENTLY DROPPED — this pattern matched ZERO of the suites this run selected, while',
    'another pattern in the same command selected some.',
    '',
  ];
  for (const p of offenders) {
    lines.push(
      `  --testPathPatterns '${p}'`,
      "      unescaped '[' — a CHARACTER CLASS, not a literal bracket. A Next.js dynamic segment such as",
      '      `[id]` matches one of `i`/`d`, never the literal directory name, so this pattern selected',
      '      nothing on its own.',
    );
  }
  lines.push(
    '',
    'With a SINGLE pattern this is already loud — jest exits with "No tests found" or reports',
    '`Test Suites: 0`. It goes quiet only here, with several patterns at once: jest',
    'ORs every positional/--testPathPatterns value together, so the suites the OTHER patterns found',
    'still ran, the count still looks ordinary — one short of what was intended — and nothing before',
    'this warning named which selector went missing.',
    '',
    'Escape the literal brackets so the regex means what the directory name says:',
    "  --testPathPatterns 'campaigns/\\[id\\]/CloneCampaignPanel.test'",
    "  --testPathPatterns 'campaigns/.id./CloneCampaignPanel.test'   # or let '.' stand in for each bracket",
    '',
    'This is a WARNING and never fails the run — under-selection should not block a run that otherwise',
    'passed; the point is only that the drop is now visible.',
  );
  return lines.join('\n');
}

// ── 4. WHICH `bash` A TEST'S CHILD PROCESS WILL RUN ───────────────
//
// On Windows a Node test that spawns bare `bash` (`execFileSync('bash', …)`,
// `spawnSync('bash', …)`) resolves it through the PATH of the PROCESS THAT RAN
// JEST, not through whatever shell the human typed the command into. Typing the
// gate into Git Bash, or invoking `C:/Program Files/Git/bin/bash.exe` by
// absolute path, changes nothing for the children: from PowerShell or a plain
// Windows PATH the first `bash.exe` is `C:\Windows\System32\bash.exe`, the WSL
// launcher, which then dies with
//
//     <3>WSL (10 - Relay) ERROR: CreateProcessCommon:818: execvpe(/bin/bash) failed
//
// Every shell-driven suite
// fails with that, attributed to the script under test. Worse, a suite that
// probes `bash` SKIPS cases when the probe fails, so the gate is
// green having asserted nothing.
//
// This resolves `bash` the way a child would, and:
//   * the first hit is Git's bash (or any non-WSL bash) → nothing to do;
//   * it is the WSL launcher / absent, and a Git for Windows install is found →
//     PREPEND that install's `bin` for this run's children, and say so;
//   * it is the WSL launcher / absent and no Git Bash is found → FAIL early with
//     the actionable remedy, before a single suite is collected.
//
// Only `<git>\bin` is prepended (bash.exe, sh.exe), never `usr\bin`: that holds
// find/sort/… and would shadow the Windows ones for every child. No global
// machine configuration is touched; the change lives in this run's env only.
// It is Windows-only: elsewhere `bash` is not the WSL launcher.

/** The WSL launcher stub locations: System32 (and its WOW64 aliases) and the WindowsApps alias dir. */
const WSL_BASH_RE = /[\\/](?:windows[\\/](?:system32|sysnative|syswow64)|windowsapps)[\\/]bash\.exe$/i;

/**
 * True when `exePath` is the WSL launcher (or the Microsoft Store alias for it)
 * rather than a real bash.
 *
 * @param {string} exePath
 */
export function isWslBashLauncher(exePath) {
  return typeof exePath === 'string' && WSL_BASH_RE.test(exePath);
}

/** The key PATH lives under in `env`, whatever case Windows spelled it in. */
function pathKeyOf(env) {
  return Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
}

/**
 * The first `<name>.exe` a Windows child would find walking PATH, or null.
 *
 * @param {string} name  bare executable name, no extension
 * @param {{ env?: Record<string, string|undefined>, exists?: (p: string) => boolean }} [options]
 */
export function resolveOnWindowsPath(name, { env = process.env, exists = fs.existsSync } = {}) {
  const raw = env[pathKeyOf(env)] ?? '';
  for (const entry of raw.split(';')) {
    const dir = entry.trim().replace(/^"|"$/g, '');
    if (!dir) continue;
    const candidate = `${dir.replace(/[\\/]+$/, '')}\\${name}.exe`;
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * Git for Windows install roots (the directory holding `bin\bash.exe`), most
 * specific first: the install the `git.exe` on PATH belongs to, then the
 * standard install locations. Only roots that really contain a bash are returned.
 *
 * @param {{ env?: Record<string, string|undefined>, exists?: (p: string) => boolean }} [options]
 * @returns {string[]}
 */
export function gitInstallRoots({ env = process.env, exists = fs.existsSync } = {}) {
  /** @type {string[]} */
  const roots = [];
  const git = resolveOnWindowsPath('git', { env, exists });
  if (git) {
    // `<root>\cmd\git.exe`, `<root>\bin\git.exe` or `<root>\mingw64\bin\git.exe`.
    let dir = git.replace(/[\\/][^\\/]+$/, '');
    for (let i = 0; i < 3 && dir; i += 1) {
      roots.push(dir);
      dir = dir.replace(/[\\/][^\\/]+$/, '');
    }
  }
  for (const key of ['ProgramFiles', 'ProgramW6432', 'ProgramFiles(x86)']) {
    if (env[key]) roots.push(`${env[key]}\\Git`);
  }
  if (env.LOCALAPPDATA) roots.push(`${env.LOCALAPPDATA}\\Programs\\Git`);
  return [...new Set(roots)].filter((root) => exists(`${root}\\bin\\bash.exe`));
}

/**
 * Decide what a test run on this host must do about `bash`.
 *
 *   `skip`:    not Windows, or opted out; nothing to check
 *   `ok`:      bare `bash` already resolves to a non-WSL bash
 *   `prepend`: it does not, but Git Bash exists: prepend `prependDir` to PATH
 *   `fail`:    it does not and no Git Bash was found: stop, with `message`
 *
 * Pure: every filesystem and environment read is injectable.
 *
 * @param {{ platform?: string, env?: Record<string, string|undefined>, exists?: (p: string) => boolean }} [options]
 * @returns {{ status: 'skip'|'ok'|'prepend'|'fail', resolved: string|null, prependDir?: string, message?: string }}
 */
export function bashResolutionPlan({ platform = process.platform, env = process.env, exists = fs.existsSync } = {}) {
  if (platform !== 'win32' || env.AGENT_TOOLING_SKIP_BASH_PREFLIGHT === '1') return { status: 'skip', resolved: null };

  const resolved = resolveOnWindowsPath('bash', { env, exists });
  if (resolved && !isWslBashLauncher(resolved)) return { status: 'ok', resolved };

  const why = resolved
    ? `bare \`bash\` resolves to ${resolved}, the WSL launcher`
    : 'no `bash.exe` is on PATH at all';
  const [root] = gitInstallRoots({ env, exists });
  if (root) {
    const prependDir = `${root}\\bin`;
    return {
      status: 'prepend',
      resolved,
      prependDir,
      message:
        `[bash-preflight] ${why}, which dies with "execvpe(/bin/bash) failed" for every shell-driven suite.\n` +
        `[bash-preflight] Prepended ${prependDir} to PATH for this run's child processes. ` +
        'Make it permanent for your shell by putting that directory ahead of C:\\Windows\\System32 on PATH.',
    };
  }
  return {
    status: 'fail',
    resolved,
    message: [
      'NO USABLE bash FOR TEST SUBPROCESSES: the run was stopped before it could blame your code.',
      '',
      `  ${why}, and no Git for Windows install was found to substitute.`,
      '',
      'Node tests that spawn bare `bash` resolve it through the PATH of the process running the tests,',
      'not through the shell you typed the command into. The Windows default puts',
      'C:\\Windows\\System32\\bash.exe (the WSL launcher) first, and it fails every shell-driven suite',
      'with `execvpe(/bin/bash) failed`, attributed to the script under test, not to the machine.',
      '',
      'Fix it: install Git for Windows, then put its bin directory ahead of System32 for this process:',
      '  PowerShell:  $env:PATH = "C:\\Program Files\\Git\\bin;" + $env:PATH',
      '  Git Bash:    already correct, run the gate from Git Bash',
      '',
      'Override with AGENT_TOOLING_SKIP_BASH_PREFLIGHT=1 if you know better than this check.',
    ].join('\n'),
  };
}

/**
 * `env` with the plan's `prependDir` put first on PATH, preserving whatever
 * case the PATH key is spelled in (a spread copy of `process.env` on Windows
 * holds `Path`, and writing `PATH` beside it would leave two keys).
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ status: string, prependDir?: string }} plan
 */
export function withBashPlanApplied(env, plan) {
  if (plan.status !== 'prepend' || !plan.prependDir) return env;
  const key = pathKeyOf(env);
  return { ...env, [key]: `${plan.prependDir};${env[key] ?? ''}` };
}

// ── 5. A WORKING `python` FOR SHELL HELPERS ────────────────────────────────
//
// A suite that runs a shell script which pipes data through a Python helper depends on an
// interpreter being present. A typical helper already does the right thing about interpreters
// (it tries `$PYTHON_BIN`, `python3.11`, `python3`, `python` and keeps the first one that can run
// `-c 'import sys'`, so the Windows Store alias stub is skipped, and hands a native-Windows Python
// a `C:\` path). What it cannot do is conjure an interpreter on a box that has
// none, and then the failure is reported as something else entirely:
//
//     Python was not found; run without arguments to install from the Microsoft Store, ...
//     HTTP 200 after 1s but the response carried NO usable message content
//
// Several suites' worth of red that reads as a parsing bug in the code under test while CI, which
// has python3, is green. Workers each spent a diagnosis cycle deciding it was unrelated.
//
// This runs the same candidates a child would and WARNS when none works. It never fails the run:
// only a handful of suites need Python, and blocking every jest run on a box for that would be the
// worse trade. Windows only; elsewhere `python3` is a real interpreter or plainly absent.

/** The candidates a shell helper's interpreter lookup tries, in its order. */
export const PYTHON_CANDIDATES = ['python3.11', 'python3', 'python'];

/** Exit status of a Windows Microsoft Store app-execution-alias stub with no Python behind it. */
const STORE_STUB_STATUS = 9009;

/**
 * Probe each candidate with `-c "import sys"`, as `find_python_bin` does.
 *
 * @param {{
 *   platform?: string,
 *   env?: Record<string, string|undefined>,
 *   spawn?: (cmd: string, args: string[], opts: object) => { status: number|null, error?: Error & { code?: string }, stdout?: string, stderr?: string },
 * }} [options]
 * @returns {{ status: 'skip'|'ok'|'missing', found?: string, tried: { name: string, outcome: string }[], message?: string }}
 */
export function pythonResolutionReport({ platform = process.platform, env = process.env, spawn = spawnSync } = {}) {
  if (platform !== 'win32' || env.AGENT_TOOLING_SKIP_PYTHON_PREFLIGHT === '1') return { status: 'skip', tried: [] };

  /** @type {{ name: string, outcome: string }[]} */
  const tried = [];
  const candidates = env.PYTHON_BIN ? [env.PYTHON_BIN, ...PYTHON_CANDIDATES] : PYTHON_CANDIDATES;
  for (const name of candidates) {
    const res = spawn(name, ['-c', 'import sys'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    if (!res.error && res.status === 0) return { status: 'ok', found: name, tried };
    const said = `${res.stdout ?? ''}${res.stderr ?? ''}`;
    if (res.error?.code === 'ENOENT') tried.push({ name, outcome: 'not on PATH' });
    else if (res.error) tried.push({ name, outcome: `could not run (${res.error.code ?? res.error.message})` });
    else if (res.status === STORE_STUB_STATUS || /Python was not found/i.test(said)) {
      tried.push({ name, outcome: 'Microsoft Store alias stub (no Python behind it)' });
    } else tried.push({ name, outcome: `exited ${res.status}` });
  }

  return {
    status: 'missing',
    tried,
    message: [
      'NO WORKING PYTHON: suites that shell out to a Python helper will fail on this machine for a reason that is not in your diff.',
      '',
      ...tried.map(({ name, outcome }) => `  ${name}: ${outcome}`),
      '',
      'A shell script that runs a Python helper tries each name above and keeps the first that can run',
      '`-c "import sys"`. With no interpreter the helper step fails and the suite reports it as a',
      'parsing or content problem in the code under test, while CI, which has',
      'python3, stays green. That is this machine, not the code.',
      '',
      'Fix it: install Python 3 (`winget install Python.Python.3.12`) so one of the names above runs, or',
      'disable the stub under Settings > Apps > Advanced app settings > App execution aliases.',
      '',
      'This is a WARNING and never fails the run. Silence it with AGENT_TOOLING_SKIP_PYTHON_PREFLIGHT=1.',
    ].join('\n'),
  };
}
