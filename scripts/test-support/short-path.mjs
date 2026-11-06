// The 8.3 short spelling of an existing Windows path, for tests that must prove a script treats two
// spellings of one directory as one. GitHub's Windows runner reports os.tmpdir() as
// C:\Users\RUNNER~1\..., while git reports C:\Users\runneradmin\..., so a path comparison that is
// right on a developer box (no short component in the temp dir) breaks only in CI.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { windowsPowerShellEnv } from '../lib/windows-powershell-env.mjs';

const PS = [
  '$p = $env:SHORT_PATH_IN',
  '$fso = New-Object -ComObject Scripting.FileSystemObject',
  'if ((Get-Item -LiteralPath $p).PSIsContainer) { $fso.GetFolder($p).ShortPath } else { $fso.GetFile($p).ShortPath }',
].join('; ');

/**
 * The short spelling of `p`, or null when this is not Windows, the volume has short names disabled,
 * or no component of the path gets one (so there is nothing to prove).
 */
export function shortForm(p) {
  if (process.platform !== 'win32') return null;
  try {
    const long = realpathSync.native(p);
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PS], {
      encoding: 'utf8',
      env: { ...windowsPowerShellEnv(process.env), SHORT_PATH_IN: long },
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out && out.toLowerCase() !== long.toLowerCase() ? out : null;
  } catch {
    return null;
  }
}
