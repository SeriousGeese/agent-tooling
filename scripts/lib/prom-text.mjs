// The two Prometheus textfile helpers the session tracker needs: label escaping and the writer
// name that keeps two hosts sharing one node_exporter textfile directory from replacing each
// other's file.

/** Label value escaping per the text exposition format: backslash, double quote and newline. */
export function escapePromLabel(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n');
}

/**
 * Which writer this process is, as a file-name part and the `writer` label. A Windows host and
 * its WSL distro can point --prom-dir at one textfile directory; each writes its own file, and
 * every series carries `writer`, so neither replaces the other's file and no two series collide.
 * `windows` on win32, otherwise Node's platform name as is (`linux`, or e.g. `darwin` for a
 * one-off run on a Mac): a third platform is a third writer, and folding it into `linux` would
 * collide with a real Linux writer in a shared directory.
 */
export function promWriter(platform = process.platform) {
  return platform === 'win32' ? 'windows' : String(platform);
}
