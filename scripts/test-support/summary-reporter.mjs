// Machine-readable summary reporter for `node --test`.
//
// Why this exists: `scripts/run-node-tests.mjs` needs to know whether a nonzero
// exit code from the test runner was EXPLAINED by a reported test failure. It
// cannot learn that from stdout, because the human reporter's output is
// inherited straight through to the terminal (that is what keeps the spec
// reporter's TTY colouring intact). So we attach a SECOND reporter whose
// destination is a temp file, and read that file after the run.
//
// It emits exactly one line of JSON and nothing else. It never writes to
// stdout and never influences the run's outcome.

/**
 * @param {AsyncIterable<{type: string, data: any}>} source
 */
export default async function* summaryReporter(source) {
  /** @type {any} */
  let rootSummary = null;
  let sawAnySummary = false;
  const failedFiles = new Set();
  const diagnostics = [];

  for await (const event of source) {
    if (event.type === 'test:fail') {
      const file = event.data?.file;
      if (file) failedFiles.add(file);
    } else if (event.type === 'test:summary') {
      sawAnySummary = true;
      // The root summary is the one with no `file` — it covers the whole run.
      // Per-file summaries carry the file path.
      if (!event.data?.file) rootSummary = event.data;
    } else if (event.type === 'test:diagnostic') {
      const message = event.data?.message;
      // Keep only diagnostics that look like a real problem. The runner emits a
      // pile of routine `tests 318` / `duration_ms` counters through this same
      // channel and we do not want them in the banner.
      if (typeof message === 'string' && /error|reject|uncaught|exception/i.test(message)) {
        diagnostics.push(message);
      }
    }
  }

  yield `${JSON.stringify({
    sawAnySummary,
    counts: rootSummary?.counts ?? null,
    success: rootSummary?.success ?? null,
    failedFiles: [...failedFiles],
    diagnostics,
  })}\n`;
}
