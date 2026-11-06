// The contract every vendored file here keeps. agent-tooling is not run from this repository:
// its files are COPIED into consumer repositories by scripts/agent-tooling-sync.mjs and run
// there, from the consumer's working tree. Three properties make that copy safe, and each is
// the kind of thing that regresses one convenient import at a time:
//
//  1. The manifest is the whole set. A file under a vendored root that no manifest entry
//     lists is never shipped; a listed file that does not exist makes every sync fail.
//  2. Dependency-free. A vendored .mjs imports only node: builtins and other vendored files,
//     because a consumer may have no package.json (a Unity project) and a worktree carries
//     only its own files.
//  3. Neutral. This repository is public and serves several products, so the shared copies
//     carry no consumer's name, people or hostname. Consumer values come from
//     agent-tooling.json; consumer-only advice lives in consumer-owned overlay files.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROOTS, parseManifest, selectFiles } from '../../scripts/agent-tooling-sync.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const manifest = parseManifest(JSON.parse(readFileSync(path.join(REPO, 'manifest.json'), 'utf8')));
const listed = selectFiles(manifest, ['all']);
const listedSet = new Set(listed);

/** Files under the vendored roots that are this repository's own, never shipped. */
const REPO_OWN = new Set(['scripts/CICD-CONFIG-REF']);

function walk(rel) {
  const abs = path.join(REPO, ...rel.split('/'));
  let entries;
  try {
    entries = readdirSync(abs);
  } catch {
    return [];
  }
  return entries.flatMap((name) => {
    const child = `${rel}/${name}`;
    return statSync(path.join(abs, name)).isDirectory() ? walk(child) : [child];
  });
}

export function importsOf(source) {
  const specs = [];
  for (const m of source.matchAll(/^\s*import\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/^\s*export\s+(?:type\s+)?(?:\*(?:\s+as\s+\w+)?|\{[^}]*\})\s+from\s+['"]([^'"]+)['"]/gm)) specs.push(m[1]);
  for (const m of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  for (const m of source.matchAll(/\brequire\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1]);
  return specs;
}

// Case-insensitive: a consumer's name in any spelling, its people, its hostnames. Naming them
// here is deliberate and the one place they appear: this file is never vendored, and a
// denylist has to spell what it denies.
export const NON_NEUTRAL = /\bDnD\b|\bDND_|\bPROMPTCI_|promptci-cloud|\baftermath\b|tooling-oddities|\bdave\b|\bzach\b|vtt\.seriousgeese\.dev|stagevtt/i;

test('every manifest path exists, and every file under a vendored root is listed', () => {
  const onDisk = ROOTS.flatMap((root) => walk(root)).filter((f) => !REPO_OWN.has(f)).sort();
  assert.deepEqual(listed, onDisk);
});

test('import extraction sees every form a module can use (so an empty result below means something)', () => {
  const forms = [
    "import a from 'pkg-a';",
    "import {\n  b,\n} from 'pkg-b';",
    "import 'pkg-c';",
    "export * from 'pkg-d';",
    "export { f } from 'pkg-f';",
    "const g = await import('pkg-g');",
    "const h = require('pkg-h');",
  ].join('\n');
  assert.deepEqual(importsOf(forms).sort(), ['pkg-a', 'pkg-b', 'pkg-c', 'pkg-d', 'pkg-f', 'pkg-g', 'pkg-h']);
});

test('every vendored .mjs imports only node: builtins and other vendored files', () => {
  const bad = [];
  for (const file of listed.filter((f) => f.endsWith('.mjs'))) {
    for (const spec of importsOf(readFileSync(path.join(REPO, file), 'utf8'))) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) {
        bad.push(`${file} -> ${spec} (a package)`);
        continue;
      }
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
      if (!listedSet.has(target)) bad.push(`${file} -> ${spec} (not a vendored file)`);
    }
  }
  assert.deepEqual(bad, []);
});

test('every set is closed: a file it ships imports only base files and files in that set', () => {
  const bad = [];
  for (const [name, files] of Object.entries(manifest.sets)) {
    const inSet = new Set([...manifest.base, ...files]);
    for (const file of files.filter((f) => f.endsWith('.mjs'))) {
      for (const spec of importsOf(readFileSync(path.join(REPO, file), 'utf8'))) {
        if (!spec.startsWith('.')) continue;
        const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
        if (!inSet.has(target)) bad.push(`set ${name}: ${file} -> ${target}`);
      }
    }
  }
  assert.deepEqual(bad, []);
});

test('no vendored file names a consumer, its people or its hostnames', () => {
  const hits = [];
  for (const file of listed) {
    readFileSync(path.join(REPO, file), 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (NON_NEUTRAL.test(line)) hits.push(`${file}:${i + 1}: ${line.trim().slice(0, 160)}`);
      });
  }
  assert.deepEqual(hits, []);
});

test('the neutral-text pattern catches what it is meant to (so a clean result means something)', () => {
  for (const s of ['see DnD-abc12', 'DND_ALLOW_X', 'ask Zach', 'dave said', 'https://vtt.seriousgeese.dev', 'tooling-oddities entry 1', 'the Aftermath repo']) {
    assert.match(s, NON_NEUTRAL, s);
  }
  for (const s of ['AGENT_TOOLING_ALLOW_X', 'bd-abc12', 'scripts/claim.sh']) assert.doesNotMatch(s, NON_NEUTRAL, s);
});

// 4. Exit without truncating. On Linux, stdout and stderr to a pipe are asynchronous in Node,
//    so process.exit() can end the process with a report still queued while the status stays
//    0. A vendored script sets process.exitCode and lets Node drain; a hard exit that is truly
//    needed flushes first, `process.stdout.write('', () => process.exit(code))`, which this
//    does not match. Consumers can carry the same guardrail over their whole tree, so a
//    vendored offender would fail there.
export const BANNED_EXIT_SHAPES = [
  { name: 'process.exit(<call>)', re: /process\.exit\(\s*(?:await\s+)?[A-Za-z_$][\w$.]*\(/ },
  { name: '(code) => process.exit(code)', re: /\(\s*([A-Za-z_$][\w$]*)\s*\)\s*=>\s*process\.exit\(\s*\1\s*\)/ },
  { name: 'code => process.exit(code)', re: /(?<![\w$)])([A-Za-z_$][\w$]*)\s*=>\s*process\.exit\(\s*\1\s*\)/ },
];

const stripJsComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');
const exitHits = (src) => BANNED_EXIT_SHAPES.filter((s) => s.re.test(stripJsComments(src))).map((s) => s.name);

test('the exit-shape scan sees each banned form and passes the flushing hard exit', () => {
  assert.deepEqual(exitHits('process.exit(main());'), ['process.exit(<call>)']);
  assert.deepEqual(exitHits('process.exit(await run(argv));'), ['process.exit(<call>)']);
  assert.deepEqual(exitHits('main().then((code) => process.exit(code));'), ['(code) => process.exit(code)']);
  assert.deepEqual(exitHits('main().then(c => process.exit(c));'), ['code => process.exit(code)']);
  assert.deepEqual(exitHits("process.stdout.write('', () => process.exit(code));"), []);
  assert.deepEqual(exitHits('process.exit(1); process.exitCode = code;'), []);
  assert.deepEqual(exitHits('// process.exit(main())'), [], 'comment-blind');
});

test('no vendored script exits with process.exit(<call>) or a forwarding arrow', () => {
  const offenders = [];
  for (const file of listed.filter((f) => /\.(mjs|cjs|js)$/.test(f) && !/\.(node-)?test\.mjs$/.test(f))) {
    for (const name of exitHits(readFileSync(path.join(REPO, file), 'utf8'))) offenders.push(`${file}: ${name}`);
  }
  assert.deepEqual(offenders, [], 'set process.exitCode instead, so piped stdout is never truncated');
});
