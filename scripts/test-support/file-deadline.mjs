// A per-file deadline for `node --test` child processes.
//
// Loaded via `--import` by scripts/run-node-tests.mjs, so it runs in EVERY test file's child
// process. Node does not apply `--import` to the runner's parent (see async-failure-diagnostics.mjs),
// and the NODE_TEST_CONTEXT check below keeps it inert anywhere else too.
//
// The bug this exists for: a CI run printed `ok 2527` and then nothing
// for 41 minutes until the job was cancelled. Node reports files strictly in
// order, so one file that never finishes holds back the output of every file after it, and the log
// names nobody. A per-test `--test-timeout` does not bound that: the timed-out test fails, but the
// child process or timer that hung it still keeps the file's event loop alive, so the file never
// exits and the run still hangs.
//
// So this bounds the FILE. When the file's process has run for AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS
// (default 10 minutes; a healthy suite finishes far inside that), it prints a
// banner naming the file and what was still keeping it alive, then exits 1. node --test reports
// that as a failing test file, so the hang becomes a named failure in the log and in the summary.
//
// The timer is unref'd: it never keeps a finished file alive. It changes nothing about a file that
// finishes inside the budget.

export const DEFAULT_FILE_TIMEOUT_MS = 10 * 60_000;
export const TAG = '[file-deadline]';

/** The budget in ms from the environment, or the default; a value that is not a positive number is ignored. */
export function fileTimeoutMs(env = process.env) {
  const raw = Number(env.AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_FILE_TIMEOUT_MS;
}

/** The banner printed when the deadline fires. Pure, so it can be tested without waiting. */
export function deadlineBanner({ file, ms, pid, resources }) {
  const counts = new Map();
  for (const r of resources) counts.set(r, (counts.get(r) ?? 0) + 1);
  const alive = [...counts].map(([r, n]) => (n > 1 ? `${r} x${n}` : r)).join(', ') || 'nothing reported';
  return (
    `\n${TAG} ${file} did not finish within ${ms} ms; exiting it (pid ${pid}).\n` +
    `${TAG}   still alive: ${alive}\n` +
    `${TAG}   A test is waiting on something that never settles, usually a child process or a timer.\n` +
    `${TAG}   Run the file alone with node --test to see which test. Budget: AGENT_TOOLING_NODE_TEST_FILE_TIMEOUT_MS.\n\n`
  );
}

if (process.env.NODE_TEST_CONTEXT) {
  const ms = fileTimeoutMs();
  const timer = setTimeout(() => {
    process.stderr.write(
      deadlineBanner({ file: process.argv[1] ?? '<unknown test file>', ms, pid: process.pid, resources: process.getActiveResourcesInfo() }),
      () => process.exit(1),
    );
    // If the write callback never runs (a wedged stderr pipe), exit anyway.
    setTimeout(() => process.exit(1), 2_000).unref();
  }, ms);
  timer.unref();
}
