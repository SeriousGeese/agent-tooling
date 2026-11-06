/**
 * scripts/lib/windows-powershell-env.mjs: a Windows PowerShell 5.1 child never inherits
 * PowerShell 7's module folders. Node built-ins only, so deadline-windows.yml runs this
 * on a real Windows runner under `shell: pwsh`, the exact parent that hands those folders down.
 */

import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isPowerShell7ModuleDir, windowsPowerShellEnv } from './lib/windows-powershell-env.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

test('PowerShell 7 module folders are recognised, Windows PowerShell and custom ones are not', () => {
  for (const ps7 of [
    'C:\\Users\\me\\Documents\\PowerShell\\Modules',
    'C:\\Program Files\\PowerShell\\Modules',
    'c:\\program files\\powershell\\7\\Modules',
    'C:/Program Files/PowerShell/7/Modules',
  ]) assert.equal(isPowerShell7ModuleDir(ps7), true, ps7);
  for (const keep of [
    'C:\\Program Files\\WindowsPowerShell\\Modules',
    'C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
    'C:\\Users\\me\\Documents\\WindowsPowerShell\\Modules',
    'D:\\tools\\ps-modules',
  ]) assert.equal(isPowerShell7ModuleDir(keep), false, keep);
});

test('the 5.1 env keeps every other entry in order, and every other key', () => {
  const env = {
    Path: 'C:\\x',
    PSModulePath: 'C:\\Users\\me\\Documents\\PowerShell\\Modules;C:\\Program Files\\PowerShell\\Modules;c:\\program files\\powershell\\7\\Modules;C:\\Program Files\\WindowsPowerShell\\Modules;D:\\tools\\ps-modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
  };
  assert.deepEqual(windowsPowerShellEnv(env), {
    Path: 'C:\\x',
    PSModulePath: 'C:\\Program Files\\WindowsPowerShell\\Modules;D:\\tools\\ps-modules;C:\\WINDOWS\\system32\\WindowsPowerShell\\v1.0\\Modules',
  });
  assert.notEqual(windowsPowerShellEnv(env), env, 'a copy, never the caller\'s object');
});

test('the key is matched case-insensitively, and a path of only PowerShell 7 folders is dropped so 5.1 builds its default', () => {
  assert.deepEqual(windowsPowerShellEnv({ PSMODULEPATH: 'C:\\Program Files\\PowerShell\\7\\Modules' }), {});
  assert.deepEqual(windowsPowerShellEnv({ Path: 'x' }), { Path: 'x' });
});

test('on Windows: a 5.1 child started with PowerShell 7 folders first imports Microsoft.PowerShell.Security through this env', { skip: process.platform !== 'win32' && 'Windows only' }, () => {
  const ps51 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const poisoned = { ...process.env, PSModulePath: `C:\\Program Files\\PowerShell\\7\\Modules;${process.env.PSModulePath ?? ''}` };
  const probe = 'try { Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; [void](Get-Acl $env:TEMP); "SECURITY OK" } catch { "SECURITY FAILED: " + $_.Exception.Message }';
  const r = spawnSync(ps51, ['-NoProfile', '-NonInteractive', '-Command', probe], { env: windowsPowerShellEnv(poisoned), encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /SECURITY OK/, r.stdout);
});

test('every script that spawns powershell.exe gives it the 5.1 env', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.m?js$/.test(entry.name) || /\.node-test\.mjs$|\.test\.[cm]?js$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      if (/\b(?:spawn|spawnSync|start|execFile|execFileSync)\(\s*'powershell\.exe'/.test(text) && !text.includes('windowsPowerShellEnv(')) {
        offenders.push(path.relative(SCRIPTS, full).split(path.sep).join('/'));
      }
    }
  };
  walk(SCRIPTS);
  assert.deepEqual(offenders, []);
});
