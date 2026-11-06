// Async-failure diagnostics for `node --test` child processes.
//
// Loaded via `--import` by scripts/run-node-tests.mjs, which means it is
// evaluated in EVERY test file's child process (Node runs each test file in its
// own child by default, `--test-isolation=process`).
//
// It is deliberately observe-only. Both hooks below are chosen so they CANNOT
// change the outcome of a run:
//
//  * 'uncaughtExceptionMonitor' is the monitor-only sibling of
//    'uncaughtException'. Registering it does NOT suppress the default crash,
//    which a plain 'uncaughtException' listener would — and suppressing a crash
//    could silently turn a failing test file into a passing one. Never swap
//    this for 'uncaughtException'.
//
//  * 'unhandledRejection' has no monitor-only sibling, so this is a real
//    listener. It is additive rather than overriding: node:test's own harness
//    already registers an 'unhandledRejection' listener inside every test
//    child, so the default action is ALREADY overridden before we arrive and
//    the runner's attribution still runs alongside ours. We only log. We never
//    call process.exit, never touch process.exitCode, and never swallow.
//
// Scope note (important, and the reason the wrapper script exists at all):
// Node deliberately does NOT apply `--import` / NODE_OPTIONS preloads to the
// test runner's own PARENT process — verified on Node 24. So this file covers
// the children only. A failure originating in the parent is caught by
// scripts/run-node-tests.mjs's post-run exit-code reconciliation instead.

const tag = '[async-failure]';
let seen = 0;

function describe(value) {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  try {
    return typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function report(kind, err, extra) {
  seen += 1;
  const where = process.argv[1] ?? '<unknown test file>';
  process.stderr.write(
    `\n${tag} ${kind} in pid ${process.pid}\n` +
      `${tag}   test file: ${where}\n` +
      (extra ? `${tag}   ${extra}\n` : '') +
      `${tag}   ${describe(err).split('\n').join(`\n${tag}   `)}\n\n`,
  );
}

process.on('uncaughtExceptionMonitor', (err, origin) => {
  report('uncaughtException', err, `origin: ${origin}`);
});

process.on('unhandledRejection', (reason) => {
  report(
    'unhandledRejection',
    reason,
    'A promise rejected with no .catch(). If this fired after its test already ' +
      'reported, the usual cause is cleanup that was not awaited.',
  );
});

process.on('exit', (code) => {
  // Only speak up when we actually have something to attribute. A nonzero exit
  // with no diagnostic is normal here — it is how the runner reports an
  // ordinary failing test — and the wrapper handles that case.
  if (seen > 0 && code !== 0) {
    process.stderr.write(
      `${tag} pid ${process.pid} exiting with code ${code}; ` +
        `${seen} async failure(s) reported above explain it.\n`,
    );
  }
});
