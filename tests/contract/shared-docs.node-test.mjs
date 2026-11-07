// The docs set ships next to whatever the consumer chose to vendor, so a shared doc that names a
// `scripts/` file sends a reader (and a consumer's doc-path check) to a file only this
// repository can promise. Every `scripts/...` path a shared doc names must be a file the
// manifest ships. A placeholder is written with angle brackets (`<your-gate>.mjs`), never as a
// plausible path: a consumer's stale-path guardrail rejected `scripts/your-gate.mjs` (DnD-i4yp8.2.12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseManifest, selectFiles } from '../../scripts/agent-tooling-sync.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHARED = path.join(REPO, 'docs', 'agents', 'shared');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(REPO, 'manifest.json'), 'utf8')));
const shipped = new Set(selectFiles(manifest, ['all']));

// A `scripts/` path with a file extension, not preceded by a path character (so `../scripts/x`
// and `lib/scripts/x` are not read as repo-root paths).
const SCRIPTS_PATH = /(?<![\w./-])scripts\/[\w./-]*\.[A-Za-z0-9]+/g;

function scriptsPaths(text) {
  return [...text.matchAll(SCRIPTS_PATH)].map((m) => m[0].replace(/[.]+$/, ''));
}

test('the scripts-path scan sees a plain path and skips a placeholder (so a clean result means something)', () => {
  assert.deepEqual(scriptsPaths('run `node scripts/your-gate.mjs` now.'), ['scripts/your-gate.mjs']);
  assert.deepEqual(scriptsPaths('see scripts/hooks/x.mjs.'), ['scripts/hooks/x.mjs']);
  assert.deepEqual(scriptsPaths('run `node <your-gate>.mjs`'), []);
  assert.deepEqual(scriptsPaths('run `node scripts/<your-gate>.mjs`'), []);
  assert.deepEqual(scriptsPaths('a relative ../scripts/x.mjs link'), []);
});

test('every scripts/ path a shared doc names is a file the manifest ships', () => {
  const docs = readdirSync(SHARED).filter((f) => f.endsWith('.md'));
  assert.ok(docs.length >= 5, `expected the five shared docs, found ${docs.length}`);
  const unknown = [];
  let seen = 0;
  for (const doc of docs) {
    const lines = readFileSync(path.join(SHARED, doc), 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of scriptsPaths(line)) {
        seen++;
        if (!shipped.has(p)) unknown.push(`docs/agents/shared/${doc}:${i + 1} -> ${p}`);
      }
    });
  }
  assert.ok(seen > 0, 'no scripts/ path found in any shared doc: the scan is broken');
  assert.deepEqual(unknown, [], 'a shared doc names a scripts/ file the manifest does not ship (write a placeholder as <name>.mjs)');
});
