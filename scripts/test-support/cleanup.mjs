// Non-throwing temp-directory removal for the node:test suites.
//
// The distinction this encodes, and the reason it is not just `try {} catch {}`
// inline everywhere:
//
//   * Failing to remove a scratch directory is NOT a product defect. It means a
//     process outside our control is still holding a handle to it. On Windows
//     that is routine and documented: `dolt push` leaves a detached telemetry
//     process holding `.dolt/eventsData/dolt.lock` for up to ~15-20s, and a
//     dependency installer a hook spawned detached may still be running. Letting that EPERM fail the suite reports
//     a lock contention as a code failure.
//
//   * But it must never be SILENT. A leaked temp dir is worth knowing about,
//     and a swallowed error is exactly how the next unexplained mystery
//     gets built. So every failure prints a loud, tagged, self-explaining line
//     naming the directory and the reason.
//
//   * And it must never THROW OUT OF A `finally`. Several suites call cleanup
//     from a `finally` guarding a real assertion; a throw there replaces the
//     assertion's message with an EPERM and destroys the actual diagnosis.
//
// Deliberately NOT used by the suites that build fake `.git` marker files
// and nothing else.
// Those directories contain only plain files this process wrote, no child
// process ever touches them, and nothing can hold a lock on them - so a removal
// failure there really would be surprising and SHOULD fail loudly as an error.

import fs from 'node:fs';

// Only these codes mean "something still holds a handle / the OS will not let go yet".
// EPERM, EBUSY and ENOTEMPTY are the Windows spellings (a live better-sqlite3 handle, a detached
// child, an AV scan); EACCES is the POSIX spelling of the same consequence. Anything else (EIO,
// ENOSPC, EINVAL, a TypeError from a bad argument) is a real fault and is rethrown.
const LEAK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

/**
 * Close every better-sqlite3 handle that is still open; ignores undefined/null and handles a
 * test already closed. Call it in a `finally` BEFORE removeTempDir: a test that fails on an
 * assertion leaves its handle open, and on Windows an open handle makes the directory removal
 * fail with EPERM.
 *
 * Never throws: better-sqlite3 refuses to close while a statement cursor (`.iterate()`) is
 * mid-flight ("connection is busy"), which is exactly the state a failed assertion leaves
 * behind, and a throw out of a `finally` would replace that assertion. A failed close is
 * reported (the same `[cleanup]` format as removeTempDir) and the remaining handles are still
 * closed.
 *
 * @param {...({ open?: boolean, close: () => unknown }|null|undefined)} dbs
 * @returns {boolean} true if every handle is closed, false if any close failed.
 */
export function closeDatabases(...dbs) {
  let allClosed = true;
  for (const db of dbs) {
    if (!db || db.open === false) continue;
    try {
      db.close();
    } catch (err) {
      allClosed = false;
      process.stderr.write(
        '\n[cleanup] could not close a database handle\n' +
          `[cleanup]   ${/** @type {any} */ (err)?.code ?? 'error'}: ${/** @type {any} */ (err)?.message ?? err}\n` +
          '[cleanup]   Continuing so the test\'s own failure is not replaced by a cleanup error.\n\n',
      );
    }
  }
  return allClosed;
}

/**
 * Remove a scratch directory, reporting rather than throwing when something still holds it.
 * Only EPERM, EBUSY, ENOTEMPTY and EACCES are swallowed (after rmSync's own short retry for the
 * first three); every other error is rethrown.
 *
 * Close every database handle BEFORE calling this. Closing is what makes removal succeed; the
 * swallow here only keeps a cleanup failure from replacing a test's own assertion error when a
 * handle was left open by that failure.
 *
 * @param {string|null|undefined} dir  Directory to remove; no-op when falsy.
 * @param {string} context             Short label for the log line, e.g. the test file name.
 * @param {{ rm?: typeof fs.rmSync }} [options]  `rm` is a seam for tests.
 * @returns {boolean}                  true if the directory is gone, false if it leaked.
 */
export function removeTempDir(dir, context = 'test', options = {}) {
  if (!dir) return true;
  const rm = options.rm ?? fs.rmSync;
  try {
    // force: true swallows ENOENT only - it does NOT swallow Windows EPERM/EBUSY. The retries
    // ride out a handle that is about to close (an exiting child, an AV scan).
    rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (err) {
    if (!LEAK_CODES.has(/** @type {any} */ (err)?.code)) throw err;
    process.stderr.write(
      `\n[cleanup] ${context}: could not remove scratch dir ${dir}\n` +
        `[cleanup]   ${/** @type {any} */ (err)?.code ?? 'error'}: ${/** @type {any} */ (err)?.message ?? err}\n` +
        '[cleanup]   Left on disk deliberately rather than failing the suite - a lingering\n' +
        '[cleanup]   process (git/dolt/npm) most likely still holds a handle. Not a product\n' +
        '[cleanup]   defect. Delete it by hand if it accumulates.\n\n',
    );
    return false;
  }
}
