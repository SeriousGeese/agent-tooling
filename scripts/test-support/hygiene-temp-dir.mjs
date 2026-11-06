// Non-throwing temp-directory removal for the hygiene node:test suites.
//
// Failing to remove a scratch directory is NOT a product defect: it means a process outside our
// control still holds a handle to it. On Windows that is routine (a detached dolt telemetry
// process, an installer spawned detached, an antivirus scan), and letting that EPERM fail the
// suite reports a lock contention as a code failure.
//
// But it must never be SILENT (every failure prints a tagged line naming the directory and the
// reason), and it must never THROW OUT OF A `finally` (a throw there replaces the assertion's
// message with an EPERM and destroys the actual diagnosis).
import fs from 'node:fs';

// Only these codes mean "something still holds a handle / the OS will not let go yet". Anything
// else (EIO, ENOSPC, EINVAL, a TypeError from a bad argument) is a real fault and is rethrown.
const LEAK_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

/**
 * Remove a scratch directory, reporting rather than throwing when something still holds it.
 * @param {string|null|undefined} dir  Directory to remove; no-op when falsy.
 * @param {string} context             Short label for the log line, e.g. the test file name.
 * @param {{ rm?: typeof fs.rmSync }} [options]  `rm` is a seam for tests.
 * @returns {boolean}                  true if the directory is gone, false if it leaked.
 */
export function removeTempDir(dir, context = 'test', options = {}) {
  if (!dir) return true;
  const rm = options.rm ?? fs.rmSync;
  try {
    // force: true swallows ENOENT only. The retries ride out a handle that is about to close.
    rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    return true;
  } catch (err) {
    if (!LEAK_CODES.has(/** @type {any} */ (err)?.code)) throw err;
    process.stderr.write(
      `\n[cleanup] ${context}: could not remove scratch dir ${dir}\n` +
        `[cleanup]   ${/** @type {any} */ (err)?.code ?? 'error'}: ${/** @type {any} */ (err)?.message ?? err}\n` +
        '[cleanup]   Left on disk deliberately rather than failing the suite; a lingering\n' +
        '[cleanup]   process most likely still holds a handle. Delete it by hand if it accumulates.\n\n',
    );
    return false;
  }
}
