// Every vendored script that runs only when it is the entry point checks that with ONE idiom:
//
//   realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
//
// Both sides go through realpath, so a symlinked, junctioned or 8.3-short-named path still
// matches (node resolves import.meta.url but leaves argv[1] as typed). Consumer guardrails
// accept the bare `realpathSync(...)` call imported from node:fs, not `fs.realpathSync(...)`, and
// refuse the older `import.meta.url === pathToFileURL(process.argv[1]).href` comparison, so a
// port that drifts from the idiom fails here before it fails in a consumer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseManifest, selectFiles } from '../../scripts/agent-tooling-sync.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(REPO, 'manifest.json'), 'utf8')));
const scripts = selectFiles(manifest, ['all']).filter((f) => f.endsWith('.mjs') && !/\.(node-)?test\.mjs$/.test(f));

const BARE = /(?<![.\w])realpathSync\(process\.argv\[1\]\)\s*===\s*(?<![.\w])realpathSync\(fileURLToPath\(import\.meta\.url\)\)/;
const IMPORTS_BARE = /import\s+(?:[\w$]+\s*,\s*)?\{[^}]*\brealpathSync\b[^}]*\}\s*from\s*['"]node:fs['"]/;
const OLD_GUARD = /import\.meta\.url\s*===|pathToFileURL\(\s*process\.argv\[1\]/;

/** The entry-check problems in a source text, or [] when it is clean or has no entry check. */
export function entryProblems(source) {
  const lines = source.split('\n').filter((l) => /process\.argv\[1\]/.test(l) && /realpathSync/.test(l));
  const problems = [];
  if (OLD_GUARD.test(source)) problems.push('uses the pathToFileURL / import.meta.url === comparison');
  for (const l of lines) if (!BARE.test(l)) problems.push(`entry check is not the bare idiom: ${l.trim()}`);
  if (lines.length && !IMPORTS_BARE.test(source)) problems.push("does not import { realpathSync } from 'node:fs'");
  return problems;
}

test('the entry-check scan accepts the bare idiom and flags each way of drifting from it', () => {
  const good = "import { realpathSync } from 'node:fs';\nreturn Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));";
  assert.deepEqual(entryProblems(good), []);
  assert.deepEqual(entryProblems("import fs, { realpathSync } from 'node:fs';\nrealpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));"), []);
  assert.equal(entryProblems("import fs from 'node:fs';\nfs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));").length, 2, 'qualified calls and no import');
  assert.equal(entryProblems("import fs, { realpathSync } from 'node:fs';\nfs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));").length, 1, 'qualified calls');
  assert.equal(entryProblems("if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {}").length, 1, 'the old comparison');
  assert.deepEqual(entryProblems('const x = 1;'), [], 'a library with no entry check is fine');
});

test('every vendored script with an entry check uses the bare realpathSync idiom', () => {
  const bad = [];
  let withCheck = 0;
  for (const file of scripts) {
    const src = readFileSync(path.join(REPO, file), 'utf8');
    if (/process\.argv\[1\]/.test(src) && /realpathSync/.test(src)) withCheck += 1;
    for (const p of entryProblems(src)) bad.push(`${file}: ${p}`);
  }
  assert.ok(withCheck > 10, 'the scan found the scripts that carry an entry check');
  assert.deepEqual(bad, []);
});
