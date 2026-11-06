// The env a Windows PowerShell 5.1 child (`powershell.exe`) should start with.
//
// pwsh 7 puts its OWN module folders first on PSModulePath (`Documents\PowerShell\Modules`,
// `Program Files\PowerShell\Modules`, `Program Files\PowerShell\7\Modules`), and every process it
// starts inherits that: a node script run from a pwsh terminal (Codex's shell, a developer's
// terminal) hands it to any `powershell.exe` it spawns. Windows PowerShell 5.1 then autoloads
// PowerShell 7's copy of a module of the same name. For Microsoft.PowerShell.Security that fails
// outright, `Error in TypeData "System.Security.AccessControl.ObjectSecurity": The member
// AuditToString is already present` (and Access, Sddl, Owner, ...), so Get-Acl / Set-Acl do not
// exist in that child. Reproduced 2026-10-25: the same 5.1 import succeeds with 5.1's own path and
// fails with PS7's folders first, and a node started from pwsh carries exactly that order.
//
// So a 5.1 child gets PSModulePath WITHOUT PowerShell 7's folders: every entry with a
// `PowerShell` path segment that is not `WindowsPowerShell`. Everything else (5.1's own folders,
// a custom module directory) is kept, in order. Entries arrive with either separator.

/** True for a PSModulePath entry that belongs to PowerShell 6+ (`...\PowerShell\...`, not `WindowsPowerShell`). Pure. */
export function isPowerShell7ModuleDir(dir) {
  return String(dir).split(/[\\/]+/).some((segment) => segment.toLowerCase() === 'powershell');
}

/** `env` with PowerShell 7's module folders taken out of PSModulePath; other keys untouched. Pure. */
export function windowsPowerShellEnv(env = process.env) {
  const out = { ...env };
  // Windows env names are case-insensitive; node exposes whichever spelling the parent used.
  const key = Object.keys(out).find((k) => k.toLowerCase() === 'psmodulepath');
  if (!key) return out;
  const kept = String(out[key]).split(';').filter((dir) => dir.trim() && !isPowerShell7ModuleDir(dir));
  if (kept.length === 0) delete out[key]; // 5.1 then builds its default path itself.
  else out[key] = kept.join(';');
  return out;
}
