// Build a git fixture once per test file, then hand each test its own COPY.
//
// The heaviest scripts/ harnesses built the same throwaway repo (a bare origin, a clone, one pushed
// commit) from scratch in every test: seven or more `git` processes before the test did anything.
// On Windows a process costs 6 to 8 times what it costs on Linux, more under load, so that setup
// was a large share of verify-local's scripted:scripts step. A copy is plain file I/O in this
// process: no spawns.
//
// A copy must be indistinguishable from a fresh build. Git records ABSOLUTE paths in a few text
// files (a clone's remote url, a linked worktree's `gitdir` pointers, FETCH_HEAD), so copyTemplate
// rewrites every spelling of the template's root to the copy's root in every text file outside
// objects/. The index holds no paths, only stat data, and git re-reads a stat-changed file's content
// before calling it modified, so a copied worktree is exactly as clean as the template's.

import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const templates = new Map();

/** The template `build(root)` makes under `key`, built on first use in a fresh empty directory. */
function template(key, build) {
  let t = templates.get(key);
  if (!t) {
    const root = fs.mkdtempSync(path.join(tmpdir(), `agent-fixture-tpl-${key}-`));
    build(root);
    t = { root };
    templates.set(key, t);
  }
  return t;
}

/** The spellings of `p` git or a shell may have written into a text file. */
function spellingsOf(p) {
  const fwd = p.replace(/\\/g, '/');
  const m = /^([A-Za-z]):\/(.*)$/.exec(fwd);
  return [
    p,
    fwd,
    p.replace(/\\/g, '\\\\'), // git config's escaped form of a backslashed path
    m ? `/${m[1].toLowerCase()}/${m[2]}` : fwd, // the MSYS mount form
  ];
}

/**
 * [old, new] pairs: every spelling of `from` (and of its realpath, which git may have resolved it
 * to) against the same spelling of `to` (and of its realpath). Longest first, so a spelling is never
 * partly replaced by a shorter one it contains.
 */
function replacements(from, to) {
  const pairs = new Map();
  for (const [a, b] of [[from, to], [fs.realpathSync(from), fs.realpathSync(to)]]) {
    const olds = spellingsOf(a);
    const news = spellingsOf(b);
    olds.forEach((o, i) => { if (!pairs.has(o)) pairs.set(o, news[i]); });
  }
  return [...pairs].sort((x, y) => y[0].length - x[0].length);
}

// Opened 'r+' and truncated, never recreated: Git for Windows marks a linked worktree's `.git` file
// HIDDEN, and Windows refuses to create-over (writeFileSync's 'w') a hidden file with EPERM.
function writeInPlace(file, text) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, text, 0, 'utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function rewritePaths(dir, pairs, re = new RegExp(pairs.map(([o]) => o.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g'), map = new Map(pairs)) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Object storage is content-addressed and never holds a path.
      if (entry.name === 'objects') continue;
      rewritePaths(full, pairs, re, map);
      continue;
    }
    if (!entry.isFile() || entry.name === 'index') continue;
    const buf = fs.readFileSync(full);
    if (buf.length > 1 << 20 || buf.includes(0)) continue;
    const text = buf.toString('utf8');
    // One pass, longest spelling first (alternation order), so a rewritten path is never rewritten again.
    const next = text.replace(re, (m) => map.get(m));
    if (next !== text) writeInPlace(full, next);
  }
}

/**
 * A fresh directory (under tmpdir(), named `<prefix>XXXXXX`) holding a copy of the template `key`,
 * with every absolute path that pointed into the template now pointing into the copy. Returns the
 * copy's root.
 */
export function copyTemplate(key, build, prefix) {
  const t = template(key, build);
  const root = fs.mkdtempSync(path.join(tmpdir(), prefix));
  fs.cpSync(t.root, root, { recursive: true });
  rewritePaths(root, replacements(t.root, root));
  return root;
}

/** Remove every template this process built. Call it from the test file's `after`. */
export function disposeTemplates(remove = (dir) => fs.rmSync(dir, { recursive: true, force: true })) {
  for (const { root } of templates.values()) remove(root);
  templates.clear();
}
