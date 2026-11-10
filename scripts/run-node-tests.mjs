#!/usr/bin/env node
// Wrapper around `node --test` that makes an UNATTRIBUTED nonzero exit
// self-describing.
//
// The bug this exists for: a `npm run test:scripts` gate once exited 1 while
// its own summary reported `tests 318 / pass 318 / fail 0`, with nothing in the
// log to explain it. That is the most expensive shape a flake can have — the
// next person to hit it has no thread to pull. This wrapper does not prevent
// that failure and does not claim to know its cause. It makes it legible.
//
// What it does, in order:
//
//  1. Runs the real `node --test`, stdio inherited, so the human-facing output
//     is what it was before (including the spec reporter's TTY colours). The
//     reporter default is replicated explicitly — spec on a TTY, tap otherwise,
//     the same rule node applies itself — because passing --test-reporter at all
//     turns node's own default off.
//
//  2. Attaches a SECOND, machine-readable reporter writing to a temp file, so
//     the wrapper can reconcile the runner's exit code against the run's
//     reported failure count without reading (or disturbing) stdout.
//
//  3. --imports scripts/test-support/async-failure-diagnostics.mjs into every
//     test child, so a post-test unhandled rejection or uncaught exception
//     prints a tagged reason + stack instead of vanishing.
//
//  4. --imports scripts/test-support/file-deadline.mjs into every test child, so a
//     file that never finishes is exited after AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS
//     (default 10 min) with a banner naming it, instead of hanging the whole run
//     silently until CI cancels the job.
//
//  5. On a nonzero exit, prints what scripts/test-support/exit-reconcile.mjs
//     decides: one quiet line when the failure is attributable to a reported
//     test, and a loud UNATTRIBUTED banner when it is not.
//
// It never rewrites a failure into another failure. Whatever the runner exited with is what this
// script exits with; a signal death becomes 128+signo. Masking a failure here
// would defeat the entire point of the gate. The ONE exception is narrow and loud: a test file
// whose subtests all passed but whose child died at exit with a native crash code (0xC0000005,
// see test-support/exit-reconcile.mjs) is re-run once on its own, with a banner; a second crash
// or any real failure anywhere in the run keeps the run red.
//
// Usage: node scripts/run-node-tests.mjs <label> <test file or glob>...

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bashResolutionPlan, inodePreflightFailure, withBashPlanApplied } from './test-preflight.mjs';
import { reconcileExit, teardownCrashCodes, teardownCrashRetryFiles } from './test-support/exit-reconcile.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIAGNOSTICS = path.join(HERE, 'test-support', 'async-failure-diagnostics.mjs');
const SUMMARY_REPORTER = path.join(HERE, 'test-support', 'summary-reporter.mjs');
const FILE_DEADLINE = path.join(HERE, 'test-support', 'file-deadline.mjs');

const [label, ...testArgs] = process.argv.slice(2);

if (!label || testArgs.length === 0) {
  console.error('usage: node scripts/run-node-tests.mjs <label> <test file or glob>...');
  process.exit(2);
}

// The FIRST argument is a label, never a test file. Passing files only makes the
// first one the label, and it is then silently never run. Refuse anything shaped like a path.
function looksLikeTestPath(arg) {
  if (/\.[cm]?[jt]s$/.test(arg) || arg.includes('*')) return true;
  try {
    return fs.statSync(arg).isFile();
  } catch {
    return false;
  }
}
if (looksLikeTestPath(label)) {
  console.error(
    `[run-node-tests] "${label}" looks like a test file, but the first argument is a LABEL and is not run as a test.\n` +
      'usage: node scripts/run-node-tests.mjs <label> <test file or glob>...',
  );
  process.exit(2);
}

// Same reason as the inode check in test-preflight.mjs: out of inodes, the very next
// line — mkdtempSync into os.tmpdir() — fails with ENOSPC while `df -h` reports
// tens of gigabytes free, and every test child that writes a temp file or a
// compile-cache entry fails in a way that reads as a code problem. These gates
// share /tmp/node-compile-cache with jest and with every other session on this
// box, so they hit the same wall.
if (process.env.AGENT_TOOLING_SKIP_INODE_PREFLIGHT !== '1') {
  const failure = inodePreflightFailure({ dirs: [os.tmpdir()] });
  if (failure) {
    console.error(`\n[${label}] ${failure}\n`);
    process.exit(1);
  }
}

const humanReporter = process.stdout.isTTY ? 'spec' : 'tap';

const summaryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-test-summary-'));
const summaryFile = path.join(summaryDir, 'summary.json');

// node:test sets NODE_TEST_CONTEXT in every test child. If it leaks into this
// process's env, the `node --test` we spawn assumes it is itself a test child,
// reports over the v8 serializer channel instead of running as a runner, and
// exits 0 having silently run nothing. A gate that passes by doing nothing is
// the worst outcome available, so strip it unconditionally: this script is
// always the top-level runner.
let childEnv = { ...process.env };
delete childEnv.NODE_TEST_CONTEXT;

// Same reason again: on Windows the test children spawn bare `bash`, which is the WSL
// launcher unless Git Bash is ahead of System32 on THIS process's PATH. Suites that probe
// `bash` silently SKIP cases when the probe fails. Put Git Bash first for the
// children, or stop with the remedy when none exists.
const bashPlan = bashResolutionPlan();
if (bashPlan.status === 'fail') {
  console.error(`\n[${label}] ${bashPlan.message}\n`);
  process.exit(1);
}
if (bashPlan.status === 'prepend') {
  childEnv = withBashPlanApplied(childEnv, bashPlan);
  console.error(`[${label}] ${bashPlan.message}`);
}

const baseArgs = [
  '--import',
  pathToFileURL(DIAGNOSTICS).href,
  '--import',
  pathToFileURL(FILE_DEADLINE).href,
  '--test',
  '--test-reporter',
  humanReporter,
  '--test-reporter-destination',
  'stdout',
  '--test-reporter',
  pathToFileURL(SUMMARY_REPORTER).href,
  '--test-reporter-destination',
];

/** One `node --test` run; resolves with how it ended. The summary reporter writes to `dest`. */
function runOnce(files, dest) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...baseArgs, dest, ...files], { stdio: 'inherit', env: childEnv });
    child.on('error', (err) => {
      console.error(`\n[${label}] FAILED TO START the test runner: ${err.stack ?? err}`);
      resolve({ startFailed: true });
    });
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

const first = await runOnce(testArgs, summaryFile);
if (first.startFailed) {
  cleanup();
  process.exitCode = 1;
} else {
  let { code, signal } = first;
  let summary = readSummaryFrom(summaryFile);

  // A file whose subtests ALL passed but whose child then died with a native crash code at exit
  // (0xC0000005 under load on Windows) is retried ONCE, loudly, and only that file. Any other
  // failure in the run, or a second crash, keeps the failing verdict: CI stays strict.
  if (code !== 0 && !signal) {
    const retryFiles = teardownCrashRetryFiles(
      summary,
      teardownCrashCodes(process.env.AGENT_TOOLING_TEARDOWN_CRASH_EXIT_CODES),
    );
    if (retryFiles.length > 0) {
      const rule = '!'.repeat(78);
      console.error(
        `\n${rule}\n[${label}] TEARDOWN CRASH RETRY: exit ${code} (0x${(code >>> 0).toString(16).toUpperCase()}) after every subtest passed in:\n` +
          retryFiles.map((f) => `    ${f}`).join('\n') +
          `\n  A native crash at process exit is not an assertion. Re-running ONLY those files once.` +
          `\n  If they crash or fail again the run FAILS.\n${rule}\n`,
      );
      const retrySummaryFile = path.join(summaryDir, 'summary-retry.json');
      const retry = await runOnce(retryFiles, retrySummaryFile);
      if (!retry.startFailed) {
        if (retry.code === 0 && !retry.signal) {
          console.error(`[${label}] teardown crash retry PASSED for ${retryFiles.length} file(s): the first run's crash was transient.`);
        } else {
          console.error(`[${label}] teardown crash retry FAILED again (exit ${retry.code ?? retry.signal}); reporting the failure.`);
        }
        code = retry.code;
        signal = retry.signal;
        summary = readSummaryFrom(retrySummaryFile);
      }
    }
  }

  cleanup();
  const { exitCode, message } = reconcileExit({ label, code, signal, summary });
  if (message) console.error(message);
  // process.exitCode rather than process.exit(): the banner is the whole point
  // of this script, and process.exit() can truncate a pending write to a piped
  // stderr. Nothing else is keeping the loop alive, so this exits immediately.
  process.exitCode = exitCode;
}

function readSummaryFrom(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8').trim();
    return raw ? JSON.parse(raw) : null;
  } catch {
    // An unreadable summary is itself a signal, and reconcileExit says so.
    return null;
  }
}

function cleanup() {
  // Removing our own temp dir must never be the thing that fails the gate — but
  // it must not be silent either, so a leak is reported rather than swallowed.
  try {
    fs.rmSync(summaryDir, { recursive: true, force: true });
  } catch (err) {
    console.error(`[${label}] warning: could not remove ${summaryDir}: ${err.message}`);
  }
}
