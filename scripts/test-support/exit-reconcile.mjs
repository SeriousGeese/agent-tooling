// Pure reconciliation of a `node --test` exit code against what the run
// actually reported.
//
// Kept separate from scripts/run-node-tests.mjs, and free of any I/O, so the
// interesting case — a nonzero exit with a green summary, which is exactly the
// shape that cannot be provoked on demand — is directly unit-testable.

import os from 'node:os';

/**
 * @param {object} input
 * @param {string} input.label            Human name for the gate, e.g. 'test:scripts'.
 * @param {number|null} input.code        Child exit code, or null if it died on a signal.
 * @param {string|null} input.signal      Signal name, or null.
 * @param {object|null} input.summary     Parsed summary-reporter JSON, or null if unreadable.
 * @returns {{exitCode: number, attributable: boolean, message: string|null}}
 */
export function reconcileExit({ label, code, signal, summary }) {
  // A green run of nothing is a typo in a glob, not a pass: node --test exits 0 when no
  // file matches. Only a summary that says zero tests ran turns it red; an unreadable
  // summary on a clean exit keeps its old meaning.
  if (code === 0 && !signal && summary?.counts && summary.counts.tests === 0) {
    return {
      exitCode: 1,
      attributable: true,
      message: `\n[${label}] node --test ran ZERO tests: no file matched, so the gate checked nothing. Fix the path or glob.`,
    };
  }
  if (code === 0 && !signal) {
    return { exitCode: 0, attributable: true, message: null };
  }

  // Never mask the runner's verdict. A signal death maps to the conventional
  // 128+signo so it is still nonzero even when `code` is null.
  const exitCode = signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 1);
  const how = signal ? `on signal ${signal}` : `with code ${code}`;
  const failed = summary?.counts?.failed;

  if (typeof failed === 'number' && failed > 0) {
    return {
      exitCode,
      attributable: true,
      message:
        `\n[${label}] node --test exited ${how} with ${failed} failing test(s) — ` +
        'see the failure list above.',
    };
  }

  const rule = '='.repeat(78);
  const lines = [
    '',
    rule,
    `[${label}] UNATTRIBUTED TEST-RUNNER FAILURE`,
    rule,
    `node --test exited ${how}, but the run reported NO failing tests.`,
    '',
  ];

  if (!summary) {
    lines.push(
      'The machine-readable summary could not be read, so the runner probably died',
      'before it finished reporting. Look for a crash or a killed process above.',
    );
  } else if (!summary.sawAnySummary) {
    lines.push(
      'The runner emitted no summary event at all — it did not reach the end of the',
      'run. Look for a crash, an OOM kill, or a killed child above.',
    );
  } else {
    lines.push(`Reported counts: ${JSON.stringify(summary.counts)}`);
    if (Array.isArray(summary.diagnostics) && summary.diagnostics.length > 0) {
      lines.push('', 'Error-shaped diagnostics captured during the run:');
      for (const d of summary.diagnostics) lines.push(`  - ${d}`);
    }
  }

  lines.push(
    '',
    'What this narrows it down to:',
    '  * It is NOT an ordinary failing test, and it is NOT a post-test unhandled',
    '    rejection inside a test FILE either — node --test attributes both of those',
    '    to the file and counts them in `fail`. A green summary rules them out.',
    '  * That leaves the test runner PARENT process. Node deliberately does not',
    '    apply --import/NODE_OPTIONS preloads to it, which is why the per-child',
    '    [async-failure] diagnostics cannot cover it.',
    '',
    'Next steps for whoever hits this:',
    '  1. Re-run immediately and note whether it reproduces. It did not for the',
    '     original reporter, on two separate trees.',
    '  2. Re-run as: node --test --test-reporter=tap <same files> — tap prints the',
    '     per-file exitCode/signal/failureType fields the spec reporter drops.',
    '  3. Check for a lingering process holding a temp dir (on Windows a detached',
    '     git process can hold a lock for ~15-20s).',
    '  4. Keep the full log and report it where this failure class is tracked: a second sighting is worth more than a guess.',
    rule,
    '',
  );

  return { exitCode, attributable: false, message: lines.join('\n') };
}
