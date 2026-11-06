/**
 * EXECUTES scripts/worktree-dev.sh's untracked-server report (`reap`) against a sandboxed checkout
 * with a real `node … server.js` child.
 *
 * `list_server_processes` has two branches and neither had a test, so a break in either was
 * silent: the report just stops printing, which reads exactly like "nothing is running".
 *
 *   * Windows (Git Bash): `powershell.exe` + `Get-CimInstance Win32_Process`. This is the branch
 *     the branch that matters most on a Windows host. It should run in a Git Bash step on a
 *     Windows runner; the bash it needs is Git Bash, never System32's WSL launcher, which a pwsh
 *     PATH can put first.
 *   * Elsewhere: `pgrep -f` plus `/proc/<pid>/cmdline`. Pinned too, since it costs nothing and is
 *     what Linux CI actually runs.
 *
 * Each listing test proves the matching child IS reported and that a node child whose command line
 * does not name a server script is NOT. It asserts only on the pids THIS test started: the listing
 * is host-wide, and a shared self-hosted runner has other jobs' `node server.js` processes in it,
 * which come and go while the script reads them. On POSIX it also proves a pid the
 * registry already knows is suppressed. The sandbox is its own `git init`, so the registry under
 * its `.git` is a scratch file and never the shared one under this checkout's common dir.
 *
 * The tracked-chain test runs `worktree-dev.sh start` itself, with a stub `npm` on PATH that starts
 * a launcher which starts `node server.js`: the registry then holds the pid `start` recorded, which
 * is an ANCESTOR of the listed server, exactly as with the real npm → cross-env → tsx chain. That
 * server must not be reported as untracked, on both platforms. The Windows matching
 * rules (an MSYS pid's winpid, a stale ParentProcessId, a command line under the worktree) are also
 * pinned on Linux from a fixture CIM listing behind a stub `powershell.exe`.
 *
 * The same chain drives `stop`: the recorded pid is `npm run dev`, not a process-group
 * leader, so `stop` must walk the descendants from it and end the launcher and server.js too, on
 * POSIX (ps) and on Windows Git Bash (MSYS /proc plus `taskkill /T` by PID).
 *
 * The script spawns `powershell.exe` itself, so the bash it runs in gets the Windows PowerShell 5.1
 * env from scripts/lib/windows-powershell-env.mjs: a node started from pwsh would otherwise hand
 * PowerShell 7's module folders down to that child. Every child this file starts is
 * killed by its own pid in a `finally`, never by name.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { windowsPowerShellEnv } from './lib/windows-powershell-env.mjs';
import { removeTempDir } from './test-support/cleanup.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'worktree-dev.sh');

/** Git Bash on Windows (never `C:\Windows\System32\bash.exe`, the WSL launcher); plain bash elsewhere. */
function locateBash() {
  if (process.platform !== 'win32') return 'bash';
  const found = spawnSync('where', ['bash'], { encoding: 'utf8' }).stdout ?? '';
  const gitBash = found.split(/\r?\n/).map((l) => l.trim())
    .find((l) => l && !/\\(system32|windowsapps)\\/i.test(l));
  if (gitBash) return gitBash;
  // `where` found only the WSL launcher: derive Git Bash from git itself (…\Git\mingw64\libexec\git-core).
  const execPath = execFileSync('git', ['--exec-path'], { encoding: 'utf8' }).trim();
  const candidate = path.resolve(execPath, '..', '..', '..', 'bin', 'bash.exe');
  if (fs.existsSync(candidate)) return candidate;
  throw new Error(`could not locate Git Bash (where bash: ${JSON.stringify(found)})`);
}

/** A node child that stays alive until killed, started from `<dir>/<name>`; resolves once it runs. */
function startIdleNode(dir, name) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, "process.stdout.write('ready\\n'); setInterval(() => {}, 1 << 30);\n");
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.stdout.once('data', () => resolve(child));
  });
}

function killChild(child) {
  if (child && child.exitCode === null && child.signalCode === null) child.kill();
}

/** A fresh `git init` with a copy of the script under scripts/, and the path git reports for it. */
function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-dev-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(SCRIPT, path.join(dir, 'scripts', 'worktree-dev.sh'));
  // `start` reads the package manager through the config helpers, so the sandbox carries them.
  fs.mkdirSync(path.join(dir, 'scripts', 'lib'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', 'agent-config.sh'), path.join(dir, 'scripts', 'lib', 'agent-config.sh'));
  fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'agent-tooling-config.mjs'), path.join(dir, 'scripts', 'agent-tooling-config.mjs'));
  for (const lib of ['to-node-path.sh', 'to-node-path-probe.mjs']) {
    fs.copyFileSync(path.join(REPO_ROOT, 'scripts', 'lib', lib), path.join(dir, 'scripts', 'lib', lib));
  }
  execFileSync('git', ['init', '-q'], { cwd: dir });
  const porcelain = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: dir, encoding: 'utf8' });
  const worktreePath = porcelain.split(/\r?\n/).find((l) => l.startsWith('worktree ')).slice('worktree '.length);
  return { dir, worktreePath, registry: path.join(dir, '.git', 'worktree-dev-servers.tsv') };
}

/** process.env for the script, with `extra` merged and `binDir` (if any) first on PATH. */
function scriptEnv({ binDir, extra = {} } = {}) {
  const env = windowsPowerShellEnv(process.env);
  delete env.NODE_TEST_CONTEXT;
  if (binDir) {
    const key = Object.keys(env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
    env[key] = `${binDir}${path.delimiter}${env[key] ?? ''}`;
  }
  return { ...env, ...extra };
}

/**
 * Output goes to files, not pipes: `start` backgrounds a subshell that keeps its inherited stdout
 * open for the server's whole life, so a piped spawnSync would sit out its full timeout (and then
 * report the exit status bash already had). `r.error` is asserted so that cannot pass silently.
 */
function runScript(bash, sandboxDir, args, opts = {}) {
  // Inside the sandbox: `start`'s background subshell still holds these files open, and the
  // sandbox is removed only after that subshell is stopped.
  const outDir = fs.mkdtempSync(path.join(sandboxDir, '.script-out-'));
  const outFile = path.join(outDir, 'stdout');
  const errFile = path.join(outDir, 'stderr');
  const outFd = fs.openSync(outFile, 'w');
  const errFd = fs.openSync(errFile, 'w');
  let r;
  try {
    r = spawnSync(bash, ['scripts/worktree-dev.sh', ...args], {
      cwd: sandboxDir, env: scriptEnv(opts), timeout: 60_000, stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  const stdout = fs.readFileSync(outFile, 'utf8');
  const stderr = fs.readFileSync(errFile, 'utf8');
  if (opts.stderrSink) opts.stderrSink.push(stderr);
  assert.ok(!r.error && r.status === 0,
    `worktree-dev.sh ${args.join(' ')} exited ${r.status} (${r.error ?? 'no spawn error'})\nstdout:\n${stdout}\nstderr:\n${stderr}`);
  return stdout;
}

function reap(bash, sandboxDir, opts) {
  return runScript(bash, sandboxDir, ['reap'], opts);
}

/** An executable LF shell script at `<dir>/<name>`. */
function writeExecutable(dir, name, body) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, body);
  fs.chmodSync(file, 0o755);
  return file;
}

/** A path with forward slashes only, safe inside a bash double-quoted string on every platform. */
const slashed = (p) => p.split(path.sep).join('/');

async function waitFor(predicate, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * On a win32 failure only: what the script had to match with. The registry rows, every process in
 * Git Bash's /proc (pid, MSYS ppid, winpid, command line), the cygpath forms of each registered
 * path, and the CIM ParentProcessId chain up from the server. Empty string elsewhere.
 */
function windowsDiagnostics(bash, sandbox, serverPid) {
  if (process.platform !== 'win32') return '';
  const script = writeExecutable(sandbox.dir, 'diag.sh', [
    'echo "--- registry"; cat "$REG"',
    'echo "--- msys /proc: pid ppid winpid cmdline"',
    'for d in /proc/[0-9]*; do',
    '  printf "%s %s %s %s\\n" "${d##*/}" "$(cat "$d/ppid" 2>/dev/null)" "$(cat "$d/winpid" 2>/dev/null)" "$(tr "\\0" " " < "$d/cmdline" 2>/dev/null | cut -c1-110)"',
    'done',
    'echo "--- cygpath forms"',
    'while IFS="$(printf "\\t")" read -r _ _ p _; do echo "raw=$p long=$(cygpath -m -l "$p" 2>&1) short=$(cygpath -m -s "$p" 2>&1)"; done < "$REG"',
    'echo "--- CIM chain from the server"',
    'powershell.exe -NoProfile -Command \'$p = [int]$env:SERVER_PID; for ($i = 0; $i -lt 16 -and $p; $i++) { $x = Get-CimInstance Win32_Process -Filter "ProcessId = $p"; if (-not $x) { "$p <gone>"; break }; "$p <- $($x.ParentProcessId) $($x.CreationDate.ToString("HH:mm:ss.fff")) $($x.Name) $($x.CommandLine)"; $p = [int]$x.ParentProcessId }\' 2>&1',
    '',
  ].join('\n'));
  const r = spawnSync(bash, [slashed(script)], {
    env: scriptEnv({ extra: { REG: slashed(sandbox.registry), SERVER_PID: String(serverPid) } }),
    encoding: 'utf8', timeout: 60_000,
  });
  return `\n=== win32 diagnostics ===\n${r.stdout ?? ''}${r.stderr ?? ''}${r.error ? `\n${r.error}` : ''}`;
}

function killPid(pid) {
  try { process.kill(pid); } catch { /* already gone */ }
}

const hasPgrepOnly = () =>
  spawnSync('sh', ['-c', 'command -v pgrep && ! command -v powershell.exe'], { stdio: 'ignore' }).status === 0;

/** The `[untracked-servers]   <pid>|…` rows, keyed by pid. */
function reportedPids(stdout) {
  return new Set([...stdout.matchAll(/^\[untracked-servers\] {3}(\d+)\|/gm)].map((m) => Number(m[1])));
}

async function assertListing(t) {
  const bash = locateBash();
  const sandbox = makeSandbox();
  const children = [];
  t.after(() => {
    for (const c of children) killChild(c);
    removeTempDir(sandbox.dir);
  });

  const server = await startIdleNode(sandbox.dir, 'server.js');
  children.push(server);
  const idle = await startIdleNode(sandbox.dir, 'idle.js');
  children.push(idle);

  const first = reap(bash, sandbox.dir);
  const pids = reportedPids(first);
  assert.ok(pids.has(server.pid), `a live node server.js (pid ${server.pid}) must be listed as untracked:\n${first}`);
  assert.ok(!pids.has(idle.pid), `a node child that runs no server script (pid ${idle.pid}) must not be listed:\n${first}`);
  assert.match(first, /another live session's server looks identical from here/, 'the ownership warning follows the listing');
  const row = first.split(/\r?\n/).find((l) => l.includes(`   ${server.pid}|`));
  // The script cuts the command line at 120 characters, so a long node path (a CI tool cache) can
  // push `server.js` off the end; the pid match above is what identifies the row.
  assert.match(row, /^\[untracked-servers\] {3}\d+\|[^|]+\|.*node/i, `the row is <pid>|<started>|<command line>: ${row}`);

  // A registry row for the same pid, on the sandbox's own live worktree path (so reap keeps it and
  // kills nothing), takes it off the untracked list. POSIX only: a Windows PID in the registry is
  // not what `start` writes (it records a Git Bash pid), and `kill -0` on a Windows PID fails in
  // Git Bash, so reap would drop the row as dead. The tracked-chain test below covers Windows with
  // the pid `start` really records.
  if (process.platform === 'win32') return;
  fs.writeFileSync(sandbox.registry, `${server.pid}\t39998\t${sandbox.worktreePath}\n`);
  const second = reap(bash, sandbox.dir);
  assert.ok(!reportedPids(second).has(server.pid), `a pid the registry knows must not be reported as untracked:\n${second}`);
  assert.equal(server.exitCode, null, 'reap must not have killed a server on a live worktree');
}

test('Windows: the PowerShell CIM listing reports a live node server.js child, not a non-server node child', {
  skip: process.platform !== 'win32' && 'Windows only (the powershell.exe branch)',
}, assertListing);

test('POSIX: the pgrep listing reports a live node server.js child, not a non-server node child', {
  skip: (process.platform === 'win32' && 'POSIX only (the pgrep branch)')
    || (!hasPgrepOnly() && 'needs pgrep, and no powershell.exe on PATH (WSL would take the Windows branch)'),
}, assertListing);

test('POSIX: a server.js pid that exits between pgrep and the read does not truncate the listing', {
  skip: (process.platform === 'win32' && 'POSIX only (the pgrep branch)')
    || (!hasPgrepOnly() && 'needs pgrep, and no powershell.exe on PATH'),
}, async (t) => {
  // The merge-queue failure: on a shared runner another job's server.js exited after pgrep listed
  // it, the failed /proc read ended the listing subshell under `set -e`, and every later pid,
  // this test's own server, was silently missing. A stub pgrep that lists a pid which cannot
  // exist (above any pid_max) BEFORE the real ones makes that race deterministic.
  const bash = locateBash();
  const sandbox = makeSandbox();
  const children = [];
  t.after(() => {
    for (const c of children) killChild(c);
    removeTempDir(sandbox.dir);
  });
  const realPgrep = execFileSync('sh', ['-c', 'command -v pgrep'], { encoding: 'utf8' }).trim();
  const binDir = path.join(sandbox.dir, 'fakebin');
  writeExecutable(binDir, 'pgrep', `#!/bin/sh\necho 999999999\nexec "${realPgrep}" "$@"\n`);

  const server = await startIdleNode(sandbox.dir, 'server.js');
  children.push(server);
  const out = reap(bash, sandbox.dir, { binDir });
  assert.ok(reportedPids(out).has(server.pid), `the live server.js (pid ${server.pid}) must still be listed after a vanished pid:\n${out}`);
  assert.ok(!reportedPids(out).has(999999999), `a vanished pid must not be reported:\n${out}`);
});

/**
 * `worktree-dev.sh start` over a stub `npm` that starts a launcher which starts `node server.js`,
 * the same npm → launcher → server.js depth as the real npm → cross-env → tsx → node chain. Resolves
 * once server.js runs. The test's t.after() stops the script's server, then kills the chain's own
 * pids (read from the file the launcher writes), so a failed assertion leaves nothing behind.
 */
async function startStubChain(t, { extra = {}, stderrSink } = {}) {
  const bash = locateBash();
  const sandbox = makeSandbox();
  const pidsFile = path.join(sandbox.dir, 'chain-pids.json');
  let started = false;
  t.after(() => {
    if (started) {
      try { runScript(bash, sandbox.dir, ['stop']); } catch { /* the kills below still run */ }
    }
    if (fs.existsSync(pidsFile)) {
      const { launcher, server } = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
      killPid(server);
      killPid(launcher);
    }
    removeTempDir(sandbox.dir);
  });

  // `start` skips its install when node_modules exists, and --port skips worktree-port.sh.
  fs.mkdirSync(path.join(sandbox.dir, 'node_modules'));
  fs.writeFileSync(path.join(sandbox.dir, 'server.js'), "setInterval(() => {}, 1 << 30);\nprocess.stdout.write('ready\\n');\n");
  // The launcher stands in for cross-env/tsx: a node process between npm and server.js.
  fs.writeFileSync(path.join(sandbox.dir, 'dev-launcher.mjs'), [
    "import { spawn } from 'node:child_process';",
    "import fs from 'node:fs';",
    `const child = spawn(process.execPath, [${JSON.stringify(path.join(sandbox.dir, 'server.js'))}], { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true });`,
    "child.stdout.once('data', () => {",
    `  fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({ launcher: process.pid, server: child.pid }));`,
    '});',
    'setInterval(() => {}, 1 << 30);',
    '',
  ].join('\n'));
  // Not `exec`: npm stays the parent, as the real one does.
  const binDir = path.join(sandbox.dir, 'fakebin');
  writeExecutable(binDir, 'npm',
    `#!/usr/bin/env bash\n"${slashed(process.execPath)}" "${slashed(path.join(sandbox.dir, 'dev-launcher.mjs'))}"\n`);

  runScript(bash, sandbox.dir, ['start', '--port', '39996'], { binDir, extra, stderrSink });
  started = true;
  const { launcher, server } = await waitFor(
    () => fs.existsSync(pidsFile) && JSON.parse(fs.readFileSync(pidsFile, 'utf8')),
    'the stub dev chain to start server.js',
  );
  const registryPid = Number(fs.readFileSync(sandbox.registry, 'utf8').split('\t')[0]);
  assert.notEqual(registryPid, server, 'the registry holds the npm pid, not the server pid, as with the real chain');
  return { bash, sandbox, binDir, launcher, server, registryPid };
}

/** Whether `pid` is a running process (a Linux zombie, killed but not yet reaped, is not). */
function isRunning(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return true; // no /proc (Windows, macOS): the signal-0 probe is all there is
  }
}

test('a server started by `worktree-dev.sh start` descends from its registry pid and is not reported as untracked', {
  skip: process.platform !== 'win32' && !hasPgrepOnly() && 'needs pgrep, and no powershell.exe on PATH',
}, async (t) => {
  const { bash, sandbox, binDir, server, registryPid } = await startStubChain(t);

  const tracked = reap(bash, sandbox.dir, { binDir });
  if (reportedPids(tracked).has(server)) {
    assert.fail(`a server descending from registry pid ${registryPid} must not be reported:\n${tracked}`
      + `${windowsDiagnostics(bash, sandbox, server)}`);
  }
  assert.ok(fs.readFileSync(sandbox.registry, 'utf8').includes(`${registryPid}\t`), `reap must keep the live tracked row:\n${tracked}`);

  // Non-vacuity: the same live server IS listed once nothing in the registry accounts for it.
  const registryRow = fs.readFileSync(sandbox.registry, 'utf8');
  fs.writeFileSync(sandbox.registry, '');
  const untracked = reap(bash, sandbox.dir, { binDir });
  assert.ok(reportedPids(untracked).has(server), `with an empty registry the same server (pid ${server}) must be listed:\n${untracked}`);
  fs.writeFileSync(sandbox.registry, registryRow); // so the `stop` in t.after() finds it
});

test('`worktree-dev.sh stop` ends the whole tree `start` began: the launcher and server.js do not survive', async (t) => {
  // The recorded pid is `npm run dev`, which is not a process-group leader, so `kill -- -<pid>`
  // never worked and the old fallback reached npm alone: the server below it kept the port and
  // data/development.db open. The stub chain is deliberately deeper than one hop.
  const { bash, sandbox, binDir, launcher, server } = await startStubChain(t);
  assert.ok(isRunning(server) && isRunning(launcher), 'the chain is up before stop');
  assert.match(fs.readFileSync(sandbox.registry, 'utf8').trimEnd().split('\t')[3] ?? '', /^(st|ps):\S+$/,
    'start records the root\'s start-time token in the registry\'s 4th column (pid-reuse guard)');

  const out = runScript(bash, sandbox.dir, ['stop'], { binDir });
  assert.match(out, /^Stopped pid \d+/m, `stop reports the server it found:\n${out}`);
  await waitFor(() => !isRunning(server) && !isRunning(launcher),
    `the launcher (${launcher}) and server.js (${server}) to be gone after stop`, 15_000);
  assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trim(), '', 'stop drops the registry row');

  // And `reap` no longer finds an orphan to report for it.
  const after = reap(bash, sandbox.dir, { binDir });
  assert.ok(!reportedPids(after).has(server), `a stopped server must not be reported as untracked:\n${after}`);
});

/**
 * A live bash process that has nothing to do with the sandbox, standing in for whatever now holds a
 * pid a stale registry row names. `pid` is the bash itself, as bash sees it (an MSYS pid on Windows,
 * which is what a registry row holds and what `kill -0` in the script can test). `cwd` is where it
 * runs; `marker` is text the script puts in its own command line (a trailing comment), so a case can
 * make it look like a dev server. Its `sleep` child and it are both stopped by pid on cleanup.
 */
async function startUnrelatedBashProcess(t, bash, { cwd = os.tmpdir(), marker = '' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-dev-unrelated-'));
  const pidFile = path.join(dir, 'pid');
  const sleepFile = path.join(dir, 'sleep-pid');
  const script = `echo $$ > "${slashed(pidFile)}"; sleep 300 & echo $! > "${slashed(sleepFile)}"; wait # ${marker}`;
  const wrapper = spawn(bash, ['-c', script], { cwd, stdio: 'ignore', windowsHide: true });
  const read = (file) => fs.existsSync(file) && fs.readFileSync(file, 'utf8').trim();
  const pid = Number(await waitFor(() => read(pidFile) && read(sleepFile) && read(pidFile), 'the unrelated process to start'));
  const sleepPid = Number(read(sleepFile));
  t.after(() => {
    spawnSync(bash, ['-c', 'kill "$1" "$2" 2>/dev/null; true', '_', String(pid), String(sleepPid)], { stdio: 'ignore' });
    killChild(wrapper);
    removeTempDir(dir);
  });
  const alive = () => spawnSync(bash, ['-c', 'kill -0 "$1"', '_', String(pid)], { stdio: 'ignore' }).status === 0;
  assert.ok(alive(), 'the unrelated process is up');
  return { pid, alive };
}

const LEGACY_WARNING = /worktree-dev: legacy registry row for pid \d+ has no identity token; not killing it\. Stop it yourself if it is still your dev server\./;

// PID reuse (review of PR 5674): a tree kill from a recycled pid would take an unrelated
// process and its whole subtree. `stop` and `reap` must prove the pid is still the recorded process,
// and a row with no start-time token (a legacy row, or a bare .dev-server.pid) can never be proven,
// however much its process looks like a dev server: it is dropped, with a warning, and never signalled.
for (const { label, rowFor, legacy, process: procOpts } of [
  {
    label: 'a recorded start-time token that does not match',
    rowFor: (pid, wt) => `${pid}\t39997\t${wt}\tst:1`,
    legacy: false,
  },
  {
    label: 'a legacy row (no token) whose process has npm and server.js on its command line',
    rowFor: (pid, wt) => `${pid}\t39997\t${wt}`,
    legacy: true,
    process: () => ({ marker: 'npm run dev server.js' }),
  },
  {
    label: 'a legacy row (no token) whose process runs from inside the worktree',
    rowFor: (pid, wt) => `${pid}\t39997\t${wt}`,
    legacy: true,
    process: (sandbox) => ({ cwd: sandbox.dir }),
  },
]) {
  test(`stop and reap leave an unrelated live process alone when a stale registry row names its pid: ${label}`, async (t) => {
    const bash = locateBash();
    const sandbox = makeSandbox();
    t.after(() => removeTempDir(sandbox.dir));
    const unrelated = await startUnrelatedBashProcess(t, bash, procOpts ? procOpts(sandbox) : {});

    fs.writeFileSync(sandbox.registry, `${rowFor(unrelated.pid, sandbox.worktreePath)}\n`);
    const stderrs = [];
    const stopped = runScript(bash, sandbox.dir, ['stop'], { stderrSink: stderrs });
    assert.match(stopped, /left alone/, `stop must refuse and say so:\n${stopped}`);
    assert.ok(unrelated.alive(), `stop must not signal pid ${unrelated.pid}:\n${stopped}`);
    assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trim(), '', 'stop drops the row');
    if (legacy) assert.match(stderrs.join(''), LEGACY_WARNING, 'stop warns about the legacy row on stderr');

    // reap only kills when the row's worktree is gone, so point the row at one that is.
    const gone = path.join(sandbox.dir, 'worktree-that-is-gone');
    fs.writeFileSync(sandbox.registry, `${rowFor(unrelated.pid, slashed(gone))}\n`);
    const reaped = reap(bash, sandbox.dir, { stderrSink: stderrs });
    assert.match(reaped, /left alone/, `reap must refuse and say so:\n${reaped}`);
    assert.ok(unrelated.alive(), `reap must not signal pid ${unrelated.pid}:\n${reaped}`);
    assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trim(), '', 'reap drops the row');
    if (legacy) assert.equal(stderrs.filter((s) => LEGACY_WARNING.test(s)).length, 2, 'reap warns too');
  });
}

test('a bare .dev-server.pid with no token is dropped, not killed, and `start` does not call a legacy row running', async (t) => {
  const bash = locateBash();
  const sandbox = makeSandbox();
  let startedServer = false;
  t.after(() => {
    if (startedServer) {
      try { runScript(bash, sandbox.dir, ['stop']); } catch { /* best effort */ }
    }
    removeTempDir(sandbox.dir);
  });
  const unrelated = await startUnrelatedBashProcess(t, bash, { marker: 'npm run dev server.js', cwd: sandbox.dir });

  fs.writeFileSync(path.join(sandbox.dir, '.dev-server.pid'), `${unrelated.pid}\n`);
  const stderrs = [];
  const stopped = runScript(bash, sandbox.dir, ['stop'], { stderrSink: stderrs });
  assert.match(stopped, /left alone/, stopped);
  assert.match(stderrs.join(''), LEGACY_WARNING);
  assert.ok(unrelated.alive(), 'a token-less .dev-server.pid is never signalled');
  assert.ok(!fs.existsSync(path.join(sandbox.dir, '.dev-server.pid')), 'stop drops the pid file');

  // `start` with a legacy row for a live pid must not answer "Already running": it provisions and starts.
  fs.mkdirSync(path.join(sandbox.dir, 'node_modules'));
  const binDir = path.join(sandbox.dir, 'fakebin');
  writeExecutable(binDir, 'npm', '#!/usr/bin/env bash\nexec "' + slashed(process.execPath) + '" -e "setInterval(() => {}, 1 << 30)"\n');
  fs.writeFileSync(sandbox.registry, `${unrelated.pid}\t39997\t${sandbox.worktreePath}\n`);
  startedServer = true;
  const started = runScript(bash, sandbox.dir, ['start', '--port', '39997'], { binDir, stderrSink: stderrs });
  assert.doesNotMatch(started, /Already running/, started);
  assert.match(started, /^Started pid \d+/m, started);
  assert.ok(unrelated.alive(), 'start never signals the legacy row\'s pid');
});

test('a host with no readable /proc/<pid>/stat gets no token: stop and reap leave the server alone and warn', async (t) => {
  // macOS has no /proc. A `ps -o lstart=` fallback has one-second resolution, so a pid recycled in
  // the same second would pass it; the script records NO token instead and fails safe. The empty
  // directory stands in for a /proc that has nothing readable in it.
  const noProc = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-dev-noproc-'));
  t.after(() => removeTempDir(noProc));
  const env = { WORKTREE_DEV_PROC_ROOT: noProc };
  const stderrs = [];
  const { bash, sandbox, binDir, launcher, server, registryPid } = await startStubChain(t, { extra: env, stderrSink: stderrs });

  assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trimEnd().split('\t').length, 3,
    'start records a 3-column row (no token) when /proc/<pid>/stat is unreadable');
  assert.match(stderrs.join(''), /no \/proc\/<pid>\/stat, so pid \d+ cannot be identity-checked later/, 'start says so');

  const stopped = runScript(bash, sandbox.dir, ['stop'], { extra: env, binDir, stderrSink: stderrs });
  assert.match(stopped, /left alone/, `stop must refuse and say so:\n${stopped}`);
  assert.match(stderrs.slice(1).join(''), LEGACY_WARNING, 'stop prints the stop-it-yourself warning');
  assert.ok(isRunning(server) && isRunning(launcher), 'stop must not have killed the chain');
  assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trim(), '', 'stop drops the row');

  // reap only kills when the row's worktree is gone, so point a row at one that is.
  const gone = path.join(sandbox.dir, 'worktree-that-is-gone');
  fs.writeFileSync(sandbox.registry, `${registryPid}\t39996\t${slashed(gone)}\n`);
  const before = stderrs.length;
  const reaped = reap(bash, sandbox.dir, { extra: env, binDir, stderrSink: stderrs });
  assert.match(reaped, /left alone/, `reap must refuse and say so:\n${reaped}`);
  assert.match(stderrs.slice(before).join(''), LEGACY_WARNING, 'reap prints the warning too');
  assert.ok(isRunning(server) && isRunning(launcher), 'reap must not have killed the chain');
  assert.equal(fs.readFileSync(sandbox.registry, 'utf8').trim(), '', 'reap drops the row');
});

/** A /proc/<pid>/stat whose field 22 (starttime) is `start`; only that field and the comm matter. */
function fakeStat(pid, start) {
  const fields = Array(20).fill('0');
  fields[0] = 'S';
  fields[19] = String(start);
  return `${pid} (fake proc) ${fields.join(' ')}\n`;
}

/**
 * Three live, unrelated bash processes arranged as a tree by a FIXTURE /proc (WORKTREE_DEV_PROC_ROOT):
 * root R, with A and B as its children. The script's tree walk and tokens come from the fixture; the
 * signals go to the real processes. `bStart: null` leaves B with no readable stat (no token).
 */
async function setupFixtureTree(t, { bStart }) {
  const bash = locateBash();
  const sandbox = makeSandbox();
  const fakeProc = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree-dev-fakeproc-'));
  t.after(() => { removeTempDir(fakeProc); removeTempDir(sandbox.dir); });
  const R = await startUnrelatedBashProcess(t, bash);
  const A = await startUnrelatedBashProcess(t, bash);
  const B = await startUnrelatedBashProcess(t, bash);
  const writeProc = (pid, ppid, start) => {
    const dir = path.join(fakeProc, String(pid));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ppid'), `${ppid}\n`);
    if (start == null) fs.rmSync(path.join(dir, 'stat'), { force: true });
    else fs.writeFileSync(path.join(dir, 'stat'), fakeStat(pid, start));
  };
  writeProc(R.pid, 1, 1000);
  writeProc(A.pid, R.pid, 2000);
  writeProc(B.pid, R.pid, bStart);
  fs.writeFileSync(sandbox.registry, `${R.pid}\t39991\t${sandbox.worktreePath}\tst:1000\n`);
  return { bash, sandbox, fakeProc, R, A, B, writeProc, env: { WORKTREE_DEV_PROC_ROOT: slashed(fakeProc) } };
}

// No token, no signal (review of PR 5674): every pid in the tree, descendants as well as
// the root, needs a readable start-time token at snapshot time and again right before its signal,
// and the two must match. A looser rule (e.g. "its parent is still in the tree") passes a recycled pid.
test('a descendant with no readable token is never signalled; the rest of the tree is', async (t) => {
  const { bash, sandbox, R, A, B, env } = await setupFixtureTree(t, { bStart: null });
  const out = runScript(bash, sandbox.dir, ['stop'], { extra: env });
  assert.match(out, /^Stopped pid \d+/m, out);
  await waitFor(() => !R.alive() && !A.alive(), 'the root and its tokened child to be ended', 15_000);
  assert.ok(B.alive(), `pid ${B.pid} has no token and must not be signalled:\n${out}`);
});

test('a descendant whose token changes between the snapshot and the signal is skipped', async (t) => {
  const { bash, sandbox, fakeProc, R, A, B, env } = await setupFixtureTree(t, { bStart: 3000 });
  // Runs after the snapshot and before the first signal: B "exits and its pid is reused", i.e. the
  // pid now reads a different start time.
  const hook = path.join(sandbox.dir, 'after-snapshot.sh');
  fs.writeFileSync(hook, `printf '%s\\n' '${fakeStat(B.pid, 3001).trim()}' > "${slashed(path.join(fakeProc, String(B.pid), 'stat'))}"\n`);
  const out = runScript(bash, sandbox.dir, ['stop'], { extra: { ...env, WORKTREE_DEV_TEST_AFTER_SNAPSHOT: slashed(hook) } });
  assert.match(out, /^Stopped pid \d+/m, out);
  await waitFor(() => !R.alive() && !A.alive(), 'the root and the unchanged child to be ended', 15_000);
  assert.ok(B.alive(), `pid ${B.pid}'s token changed after the snapshot and it must not be signalled:\n${out}`);
});

test('control: with every token readable and unchanged the whole fixture tree is ended', async (t) => {
  const { bash, sandbox, R, A, B, env } = await setupFixtureTree(t, { bStart: 3000 });
  runScript(bash, sandbox.dir, ['stop'], { extra: env });
  await waitFor(() => !R.alive() && !A.alive() && !B.alive(), 'all three fixture processes to be ended', 15_000);
});

test('Windows matching rules, from a fixture CIM listing: winpid ancestry and a command line under the worktree', {
  // On Windows a live Windows PID in the registry is pruned by `kill -0`, so this fixture runs
  // where the registry's live pid is a real local pid; the real Windows chain is the test above.
  skip: process.platform === 'win32' && 'fixture for the Windows branch; the real chain test covers win32',
}, async (t) => {
  const bash = locateBash();
  const sandbox = makeSandbox();
  const children = [];
  t.after(() => {
    for (const c of children) killChild(c);
    removeTempDir(sandbox.dir);
  });
  // A live local pid stands in for the MSYS pid `start` records; its winpid is 7001.
  const npmStandIn = await startIdleNode(sandbox.dir, 'idle.js');
  children.push(npmStandIn);
  fs.writeFileSync(sandbox.registry, `${npmStandIn.pid}\t39995\t${sandbox.worktreePath}\n`);
  const procRoot = path.join(sandbox.dir, 'fakeproc');
  fs.mkdirSync(path.join(procRoot, String(npmStandIn.pid)), { recursive: true });
  fs.writeFileSync(path.join(procRoot, String(npmStandIn.pid), 'winpid'), '7001\n');
  // An MSYS exec breaks the CIM chain: server 8005's Windows ancestors stop at 9001, which is MSYS
  // pid 555 (the npm bash), whose MSYS parent 556 (nohup's subshell) is the registry pid's child.
  for (const [msys, files] of [['555', { winpid: '9001\n', ppid: '556\n' }], ['556', { ppid: `${npmStandIn.pid}\n` }]]) {
    fs.mkdirSync(path.join(procRoot, msys), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(procRoot, msys, name), body);
  }

  // The worktree as a Windows command line would spell it: backslashes, different case.
  const winWorktree = sandbox.worktreePath.split('/').join(String.fromCharCode(92)).toUpperCase();
  const bs = String.fromCharCode(92);
  const rows = [
    `8001|7101 7001 4|2026-11-03 10:00|C:${bs}nodejs${bs}node.exe C:${bs}elsewhere${bs}server.js`,
    `8002|4|2026-11-03 10:01|"C:${bs}nodejs${bs}node.exe" ${winWorktree}${bs}node_modules${bs}tsx${bs}dist${bs}cli.mjs server.js`,
    `8003|4|2026-11-03 10:02|C:${bs}nodejs${bs}node.exe C:${bs}other${bs}server.bundle.js`,
    `8004|4|2026-11-03 10:03|C:${bs}nodejs${bs}node.exe ${winWorktree}-sibling${bs}server.js`,
    `8005|9001|2026-11-03 10:04|C:${bs}nodejs${bs}node.exe C:${bs}elsewhere${bs}server.js`,
  ];
  const fixture = path.join(sandbox.dir, 'cim-fixture.txt');
  fs.writeFileSync(fixture, `${rows.join('\r\n')}\r\n`);
  const binDir = path.join(sandbox.dir, 'fakebin');
  writeExecutable(binDir, 'powershell.exe', `#!/bin/sh\ncat "${slashed(fixture)}"\n`);

  const out = reap(bash, sandbox.dir, { binDir, extra: { WORKTREE_DEV_PROC_ROOT: procRoot } });
  assert.deepEqual([...reportedPids(out)].sort(), [8003, 8004],
    `8001 descends from the registry pid's winpid, 8005 reaches it through the MSYS ppid chain and 8002 runs from inside the worktree; 8003 and the sibling-prefix 8004 are untracked:\n${out}`);
  assert.equal(npmStandIn.exitCode, null, 'reap must not have killed the live registry pid');
});
