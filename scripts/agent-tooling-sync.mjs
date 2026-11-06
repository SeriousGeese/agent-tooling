// Vendor SeriousGeese/agent-tooling into a consumer repository, pinned by SHA, in place.
//
//   node scripts/agent-tooling-sync.mjs --into <repo> --ref <40-hex sha> [--set asks,worktree] [--env-prefix ACME_]
//   node scripts/agent-tooling-sync.mjs --into <repo> --check
//
// The agent-hooks twin of this file is SeriousGeese/CICD agent-hooks/sync.mjs, which vendors
// Claude Code hooks into one flat directory. This one vendors process scripts, skills and
// docs, so its files land at their own paths (`scripts/claim.sh`, `.agents/skills/<x>/SKILL.md`,
// `docs/agents/shared/<x>.md`): the consumer path IS the path in this repository.
//
// What it does:
//   - reads manifest.json at --ref and selects the `base` files (always: this script, the
//     config loader, the node:test runner) plus the files of the named sets (`--set`,
//     comma-separated; `all` is every set; default: the sets recorded by the last sync, else
//     none), then reads every one of them;
//   - rewrites the neutral prefix (AGENT_TOOLING plus an underscore) to the consumer's prefix (--env-prefix,
//     else `envPrefix` from the consumer's agent-tooling.json, else the prefix the last sync
//     recorded, else unchanged), so a consumer
//     keeps the hatch names its docs teach (`ACME_ALLOW_CLAIM_STEAL`);
//   - REFUSES, before writing anything, a selected path that the consumer's
//     scripts/hooks/CICD-HOOKS-SHA records: a path has exactly one owner, and the hooks belong
//     to SeriousGeese/CICD;
//   - REFUSES, before writing anything, to replace an existing file agent-tooling did not
//     write: a target must be absent, already the new bytes, or still exactly what the recorded
//     ref wrote under the recorded prefix. A consumer file at a manifest path, or a vendored
//     file edited in place, is listed and the whole sync stops, unless --adopt says this sync
//     may take such files over (a consumer moving its own scripts into agent-tooling does);
//   - checks and reads everything first (a symlinked or otherwise non-regular target is
//     refused), then mutates in a fixed order: each file is written through a temp file
//     renamed over its path (a hard link is replaced, never written through), then
//     the record, then the stale deletes, so a failure never leaves a half-synced tree behind a
//     record that claims otherwise;
//   - writes each file at its path under <repo> with LF endings, deletes files an earlier sync
//     vendored that the selection no longer lists (a file the manifest dropped, or, only with
//     --drop, a de-selected set: sets are not cumulative), and records ref, prefix, sets and files in
//     scripts/AGENT-TOOLING-SHA (--sha-file to move it);
//   - `--check` re-derives every recorded file from the recorded ref, prefix and sets and
//     exits 1 naming each one that was edited, deleted or is missing.
//
// Source: raw.githubusercontent.com (this repository is public, so no token is needed), or
// `--from <local agent-tooling checkout>` to read the ref with `git show` (offline, and tests).
//
// Dependency-free, and imports no sibling: a first adoption fetches this one file alone.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = 'SeriousGeese/agent-tooling';
export const DEFAULT_SHA_FILE = 'scripts/AGENT-TOOLING-SHA';
export const DEFAULT_CICD_SHA_FILE = 'scripts/hooks/CICD-HOOKS-SHA';
export const CONFIG_FILE = 'agent-tooling.json';
export const ALL_SET = 'all';
/** Top-level directories a vendored path may live under. */
export const ROOTS = Object.freeze(['scripts', '.agents', 'docs', 'templates']);
// Assembled, never one literal: this file is vendored through transform(), and a literal
// here would be rewritten in the consumer's copy, which could then no longer re-derive the
// source text it checks against.
export const NEUTRAL_PREFIX = ['AGENT', 'TOOLING', ''].join('_');
const NEUTRAL_PREFIX_RE = new RegExp(String.raw`\b${NEUTRAL_PREFIX}`, 'g');
/** The most a single vendored file may weigh, from git or from the network. */
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

const USAGE =
  'usage: node agent-tooling-sync.mjs --into <repo> --ref <40-hex sha> [--set <name>[,<name>]] [--drop] [--adopt] [--env-prefix PREFIX_] [--sha-file scripts/AGENT-TOOLING-SHA] [--cicd-sha-file scripts/hooks/CICD-HOOKS-SHA] [--from <agent-tooling checkout>]\n' +
  '       node agent-tooling-sync.mjs --into <repo> --check [--sha-file ...] [--from <agent-tooling checkout>]\n' +
  '  --adopt  this sync may replace existing files agent-tooling did not write (each is named on stderr)\n';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, adopt?: boolean, shaFile: string, cicdShaFile: string, from?: string, check: boolean }} */
  const out = { shaFile: DEFAULT_SHA_FILE, cicdShaFile: DEFAULT_CICD_SHA_FILE, check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} needs a value`);
      return v;
    };
    if (a === '--into') out.into = next();
    else if (a === '--ref') out.ref = next();
    else if (a === '--env-prefix') out.envPrefix = next();
    else if (a === '--set') out.sets = [...(out.sets ?? []), ...parseSetList(next())];
    else if (a === '--sha-file') out.shaFile = next();
    else if (a === '--cicd-sha-file') out.cicdShaFile = next();
    else if (a === '--from') out.from = next();
    else if (a === '--check') out.check = true;
    else if (a === '--drop') out.drop = true;
    else if (a === '--adopt') out.adopt = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/** `asks, worktree` -> ['asks', 'worktree']; `none` -> [] (base files only). */
export function parseSetList(text) {
  const names = String(text)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (names.length === 0) throw new Error('--set needs at least one set name (or "none")');
  if (names.includes('none')) {
    if (names.length > 1) throw new Error(`"none" cannot be combined with other sets: ${names.join(',')}`);
    return [];
  }
  return names;
}

/** A full commit SHA. A branch or tag is a mutable pointer and is refused. */
export function isPinnedRef(ref) {
  return /^[0-9a-f]{40}$/.test(String(ref));
}

/** An env-var prefix: upper-case identifier ending in `_`. */
export function isEnvPrefix(prefix) {
  return /^[A-Z][A-Z0-9_]*_$/.test(String(prefix));
}

/**
 * A vendorable path: posix, relative, under one of ROOTS, no `.`/`..` segments, no
 * backslashes. `.agents/skills/x/SKILL.md` passes; `../x`, `/abs`, `src/x` do not.
 */
export function isSafePath(p) {
  // A string, never anything that merely stringifies to one (['scripts/x'] does).
  if (typeof p !== 'string') return false;
  const s = p;
  if (!s || s.includes('\\') || s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false;
  const segs = s.split('/');
  if (!ROOTS.includes(segs[0]) || segs.length < 2) return false;
  // Windows aliases a trailing dot away and reserves device names (with any extension), so
  // either would write somewhere other than the path the manifest names, or fail.
  return segs.every(
    (seg) =>
      seg !== '.' &&
      seg !== '..' &&
      /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/.test(seg) &&
      !seg.endsWith('.') &&
      !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(seg),
  );
}

/** The exact bytes a consumer should have for one vendored file. */
export function transform(text, envPrefix) {
  const lf = text.replace(/\r\n/g, '\n');
  // A function replacer: a string one would read `$&`, `$'` and friends as patterns.
  return envPrefix === NEUTRAL_PREFIX ? lf : lf.replace(NEUTRAL_PREFIX_RE, () => envPrefix);
}

/** @param {{ ref: string, envPrefix: string, sets: string[], files: string[] }} rec */
export function formatShaFile(rec) {
  return [
    `# Vendored from ${REPO} by agent-tooling-sync.mjs. Do not edit these files here:`,
    '# change them in agent-tooling, then re-run sync with the new ref. `--check` fails on drift.',
    `ref: ${rec.ref}`,
    `env-prefix: ${rec.envPrefix}`,
    `sets: ${rec.sets.length ? rec.sets.join(',') : 'none'}`,
    'files:',
    ...rec.files.map((f) => `  ${f}`),
    '',
  ].join('\n');
}

/** @param {string} text */
export function parseShaFile(text) {
  const ref = /^ref:\s*(\S+)\s*$/m.exec(text)?.[1];
  const envPrefix = /^env-prefix:\s*(\S+)\s*$/m.exec(text)?.[1];
  const setsLine = /^sets:\s*(\S+)\s*$/m.exec(text)?.[1];
  const block = /^files:\s*\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  const files = block
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!ref || !envPrefix || !setsLine) throw new Error('AGENT-TOOLING-SHA is missing its ref, env-prefix or sets line');
  if (!isPinnedRef(ref)) throw new Error(`AGENT-TOOLING-SHA records a ref that is not a full 40-hex commit SHA: ${ref}`);
  // The recorded prefix is rewritten into files and compared against them: a hand edit must
  // not smuggle in anything but a plain PREFIX_.
  if (!isEnvPrefix(envPrefix)) throw new Error(`AGENT-TOOLING-SHA records an env-prefix that is not PREFIX_ (upper-case, ending in _): ${envPrefix}`);
  return { ref, envPrefix, sets: parseSetList(setsLine), files };
}

/**
 * The files the consumer's CICD-HOOKS-SHA records, as repo-relative paths. An absent file
 * means CICD owns nothing here; a present one without its `files:` block is refused, since
 * reading it as "owns nothing" would let this sync write over CICD's hooks.
 * @param {string} into
 * @param {string} cicdShaFile repo-relative
 */
export function cicdOwnedPaths(into, cicdShaFile) {
  const file = recordPath(into, cicdShaFile, '--cicd-sha-file');
  if (!existsSync(file)) return new Set();
  const text = readFileSync(file, 'utf8');
  if (!/^files:[ \t]*\r?$/m.test(text)) throw new Error(`${cicdShaFile} exists but has no "files:" block, so what CICD owns here is unknown`);
  const block = /^files:\s*\n([\s\S]*)$/m.exec(text)?.[1] ?? '';
  const dir = path.posix.dirname(cicdShaFile.split(path.sep).join('/'));
  return new Set(
    block
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((name) => path.posix.join(dir, name)),
  );
}

/** `envPrefix` from the consumer's agent-tooling.json, or undefined. Only that key is read here. */
export function configEnvPrefix(into) {
  const file = path.join(path.resolve(into), CONFIG_FILE);
  if (!existsSync(file)) return undefined;
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`${file}: not valid JSON (${/** @type {Error} */ (err).message})`, { cause: err });
  }
  return typeof raw?.envPrefix === 'string' ? raw.envPrefix : undefined;
}

/** A consumer path resolved strictly inside `into`. */
function inside(into, rel) {
  const root = path.resolve(into);
  const abs = path.resolve(root, ...rel.split('/'));
  const r = path.relative(root, abs);
  if (!r || r.startsWith('..') || path.isAbsolute(r)) throw new Error(`refusing a path outside --into: ${rel}`);
  return abs;
}

/**
 * `inside()` is lexical. A symlinked directory in the consumer's tree (`scripts -> /elsewhere`)
 * would still carry a read, write or delete out of `--into`, and so would the target itself
 * when it is a symlinked file (writeFileSync follows it). So before any of those, the target
 * when it exists (as an entry: a dangling link counts), or else its nearest existing ancestor,
 * must resolve through every link to somewhere inside the real `--into`. A link that resolves
 * nowhere is refused too: writing through it would create its target, wherever that is.
 */
function assertRealInside(into, abs, rel) {
  const root = realpathSync(path.resolve(into));
  let probe = abs;
  while (!entryExists(probe)) probe = path.dirname(probe);
  let real;
  try {
    real = realpathSync(probe);
  } catch {
    throw new Error(`refusing ${rel}: a symlink in the path resolves nowhere`);
  }
  const r = path.relative(root, real);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`refusing ${rel}: a symlink in the path leads outside --into`);
}

/** True when `p` exists as a directory entry, including a symlink whose target is missing. */
function entryExists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * A write target must be a regular file or absent, and every existing ancestor up to `--into`
 * a directory: renaming over a directory, or creating under a file, fails halfway through a
 * sync. Run after assertRealInside(), so every ancestor already resolves inside `--into`.
 */
function assertWritableTarget(into, abs, rel) {
  const root = path.resolve(into);
  for (let dir = path.dirname(abs); dir.length > root.length && dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (!entryExists(dir)) continue;
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) throw new Error(`refusing ${rel}: ${path.relative(root, dir).split(path.sep).join('/')} exists and is not a directory`);
  }
  if (entryExists(abs) && !lstatSync(abs).isFile()) throw new Error(`refusing ${rel}: it exists and is not a regular file`);
}

/**
 * Write `content` at `abs` through a temp file in the same directory renamed over it. The
 * rename replaces the directory entry, so a hard link at `abs` is replaced, never written
 * through, and a reader never sees half a file. (A symlinked or otherwise non-regular target
 * never gets here: assertWritableTarget refuses it up front.) The containment check is re-run
 * immediately before the mkdir, the temp write and the rename, so a directory swapped for a
 * link after the up-front checks is still refused. An existing file's mode is kept (an
 * executable script stays executable).
 */
function writeFileAtomic(into, abs, rel, content) {
  assertRealInside(into, abs, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${randomBytes(6).toString('hex')}.agent-tooling-sync.tmp`);
  let mode;
  try {
    const st = lstatSync(abs);
    if (st.isFile()) mode = st.mode & 0o777;
  } catch {
    mode = undefined;
  }
  try {
    assertRealInside(into, tmp, rel);
    // `wx`: never open an entry that is already there (a planted link at the temp name).
    writeFileSync(tmp, content, { flag: 'wx' });
    if (mode !== undefined) chmodSync(tmp, mode);
    assertRealInside(into, abs, rel);
    renameSync(tmp, abs);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * The absolute path of a record file the caller named (--sha-file, --cicd-sha-file): a safe
 * repository-relative path, inside `--into` lexically and through every link.
 */
function recordPath(into, rel, flag) {
  if (!isSafePath(rel)) throw new Error(`${flag} must be a repository-relative path under ${ROOTS.join(', ')}: ${rel}`);
  const abs = inside(into, rel);
  assertRealInside(into, abs, rel);
  return abs;
}

/** Lower-cased, so a case-insensitive filesystem cannot give one path two owners. */
const ownedKey = (p) => p.toLowerCase();

/**
 * Read `<rel>` at `ref`.
 * @param {string} ref
 * @param {string} rel
 * @param {string | undefined} from
 */
async function readAtRef(ref, rel, from) {
  if (from) {
    // A pinned SHA must mean the same bytes everywhere: refs/replace in the --from checkout
    // could otherwise substitute any object, and an fsmonitor hook would run its code.
    try {
      return execFileSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', '-C', from, 'show', `${ref}:${rel}`], {
        encoding: 'utf8',
        maxBuffer: MAX_FILE_BYTES,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MSYS_NO_PATHCONV: '1', GIT_NO_REPLACE_OBJECTS: '1' },
      });
    } catch (err) {
      // One line, so a reason quoted inside a refusal or a note stays readable.
      const e = /** @type {Error & { stderr?: string }} */ (err);
      const why = String(e.stderr ?? '').trim().split('\n').pop() || e.message.split('\n')[0];
      throw new Error(`git show ${ref}:${rel} in ${from} failed: ${why}`, { cause: err });
    }
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${rel}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  const tooBig = () => new Error(`GET ${url}: response is over ${MAX_FILE_BYTES} bytes`);
  if (Number(res.headers.get('content-length')) > MAX_FILE_BYTES) {
    await res.body?.cancel();
    throw tooBig();
  }
  const chunks = [];
  let size = 0;
  if (res.body) {
    for await (const chunk of res.body) {
      size += chunk.byteLength;
      if (size > MAX_FILE_BYTES) throw tooBig();
      chunks.push(chunk);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Refuses a path list that one filesystem could not hold as listed: two paths equal but for
 * case (one file on Windows and macOS, so a sync would write it twice and a case-only rename
 * would delete it), or a path that is a directory of another listed path.
 * @param {Iterable<string>} paths
 * @param {string} where
 */
function assertDistinctPaths(paths, where) {
  /** @type {Map<string, string>} */
  const byKey = new Map();
  for (const p of paths) {
    const prior = byKey.get(ownedKey(p));
    if (prior !== undefined && prior !== p) throw new Error(`${where} lists two paths that differ only in case: ${prior}, ${p}`);
    byKey.set(ownedKey(p), p);
  }
  for (const p of byKey.values()) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const dir = byKey.get(ownedKey(segs.slice(0, i).join('/')));
      if (dir !== undefined) throw new Error(`${where} lists ${dir} as a file and as a directory of ${p}`);
    }
  }
}

/**
 * A parsed, validated manifest.
 * @param {unknown} json
 * @param {string} [where]
 * @returns {{ base: string[], sets: Record<string, string[]> }}
 */
export function parseManifest(json, where = 'manifest.json') {
  const m = /** @type {{ base?: unknown, sets?: unknown }} */ (json ?? {});
  if (!Array.isArray(m.base) || m.base.length === 0) throw new Error(`${where} "base" must list the files every consumer gets`);
  if (!m.sets || typeof m.sets !== 'object' || Array.isArray(m.sets)) throw new Error(`${where} "sets" must be an object`);
  const check = (f) => {
    if (!isSafePath(f)) throw new Error(`${where} lists an unsafe path: ${f}`);
  };
  m.base.forEach(check);
  /** @type {Record<string, string[]>} */
  const sets = {};
  for (const [name, files] of Object.entries(m.sets)) {
    if (name === ALL_SET || name === 'none') throw new Error(`${where} must not define "${name}": it is reserved`);
    if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${where} has an invalid set name: ${name}`);
    if (!Array.isArray(files)) throw new Error(`${where} set "${name}" must be an array`);
    files.forEach(check);
    sets[name] = [...files];
  }
  assertDistinctPaths([...m.base, ...Object.values(sets).flat()], where);
  return { base: [...m.base], sets };
}

/**
 * The sorted, de-duplicated base files plus the files of the named sets.
 * @param {{ base: string[], sets: Record<string, string[]> }} manifest
 * @param {string[]} names
 */
export function selectFiles(manifest, names) {
  const picked = new Set(manifest.base);
  for (const name of names) {
    // Own properties only: `constructor` or `toString` is an unknown set, not a crash.
    if (name !== ALL_SET && !Object.hasOwn(manifest.sets, name)) {
      throw new Error(`unknown set "${name}" (known: ${[...Object.keys(manifest.sets), ALL_SET].join(', ')})`);
    }
    const lists = name === ALL_SET ? Object.values(manifest.sets) : [manifest.sets[name]];
    for (const list of lists) for (const f of list ?? []) picked.add(f);
  }
  const files = [...picked].sort();
  assertDistinctPaths(files, 'the selected files');
  return files;
}

async function manifestAt(ref, from) {
  return parseManifest(JSON.parse(await readAtRef(ref, 'manifest.json', from)), `manifest.json at ${ref}`);
}

/**
 * @param {{ into: string, ref: string, envPrefix?: string, sets?: string[], drop?: boolean, adopt?: boolean, shaFile?: string, cicdShaFile?: string, from?: string }} opts
 *   `adopt`: this sync may replace existing files agent-tooling did not write (each one is
 *   named on stderr). Without it such a file stops the whole sync before anything is written.
 * @returns {Promise<string[]>} the files written
 */
export async function sync(opts) {
  if (!isPinnedRef(opts.ref)) throw new Error(`ref must be a full 40-hex commit SHA (a branch or tag can move): ${opts.ref}`);
  const shaRel = opts.shaFile ?? DEFAULT_SHA_FILE;
  const cicdRel = opts.cicdShaFile ?? DEFAULT_CICD_SHA_FILE;
  const shaPath = recordPath(opts.into, shaRel, '--sha-file');
  // Writing this record over CICD's would erase what CICD owns here.
  if (ownedKey(shaRel) === ownedKey(cicdRel)) throw new Error(`--sha-file and --cicd-sha-file name the same file: ${shaRel}`);
  const previous = existsSync(shaPath) ? parseShaFile(readFileSync(shaPath, 'utf8')) : null;
  // The recorded prefix comes before the neutral one, so a consumer that once passed
  // --env-prefix and has no agent-tooling.json keeps its hatch names on a plain re-sync.
  const envPrefix = opts.envPrefix ?? configEnvPrefix(opts.into) ?? previous?.envPrefix ?? NEUTRAL_PREFIX;
  if (!isEnvPrefix(envPrefix)) throw new Error(`env prefix must look like PREFIX_ (upper-case, ending in _): ${envPrefix}`);

  const manifest = await manifestAt(opts.ref, opts.from);
  const sets = opts.sets ?? previous?.sets ?? [];
  const files = selectFiles(manifest, sets);
  const selected = new Set(files.map(ownedKey));
  // A vendored file at a record's path would be overwritten by the record (or would overwrite
  // CICD's): one path, one owner, and the records are nobody's vendored file.
  const recordKeys = new Set([ownedKey(shaRel), ownedKey(cicdRel)]);
  const onRecord = files.filter((f) => recordKeys.has(ownedKey(f)));
  if (onRecord.length) {
    throw new Error(`refusing a selection that vendors a record file (--sha-file ${shaRel}, --cicd-sha-file ${cicdRel}): ${onRecord.join(', ')}`);
  }
  // A file the manifest still ships but the new selection leaves out may still be wired up
  // (a package.json script, a settings.json hook, a skill link). Sets are not cumulative, so
  // naming fewer is the easy mistake: refuse unless the caller says --drop.
  if (!opts.drop && previous) {
    const shipped = new Set(selectFiles(manifest, ['all']));
    const dropped = previous.files.filter((f) => !selected.has(ownedKey(f)) && shipped.has(f));
    if (dropped.length > 0) {
      throw new Error(
        `set(s) ${sets.join(',') || 'none'} would stop vendoring ${dropped.length} file(s) the last sync (sets ${previous.sets.join(',') || 'none'}) wrote: ${dropped.join(', ')}. ` +
          'Remove what still uses them, then re-run with --drop, or name every set you still want.',
      );
    }
  }

  const cicd = new Set([...cicdOwnedPaths(opts.into, cicdRel)].map(ownedKey));
  const clash = files.filter((f) => cicd.has(ownedKey(f)));
  if (clash.length) {
    throw new Error(`refusing to write ${clash.length} path(s) that ${cicdRel} records as vendored from SeriousGeese/CICD (a path has exactly one owner): ${clash.join(', ')}`);
  }

  // Every read and every check happens before the first mutation, so a refusal or a failed
  // fetch leaves the tree exactly as it was.
  const contents = await Promise.all(files.map(async (f) => transform(await readAtRef(opts.ref, f, opts.from), envPrefix)));
  const targets = files.map((f) => inside(opts.into, f));
  targets.forEach((abs, i) => {
    assertRealInside(opts.into, abs, files[i]);
    assertWritableTarget(opts.into, abs, files[i]);
  });
  assertWritableTarget(opts.into, shaPath, shaRel);

  /** @type {Promise<{ shipped: Set<string>, error?: undefined } | { error: Error }> | undefined} */
  let before;
  // The manifest at the recorded ref, read once and only when something needs it.
  const shippedBefore = () =>
    (before ??= manifestAt(/** @type {{ ref: string }} */ (previous).ref, opts.from)
      .then((m) => ({ shipped: new Set(selectFiles(m, [ALL_SET])) }))
      .catch((error) => ({ error })));
  /**
   * The bytes the recorded ref wrote at `f` under the recorded prefix, or why that is unknown.
   * The record's file list alone is plain text a hand edit could point anywhere, so the old
   * manifest must have shipped the path too.
   * @returns {Promise<{ text: string } | { text?: undefined, why: string }>}
   */
  const wroteBefore = async (f) => {
    const rec = /** @type {{ ref: string, envPrefix: string }} */ (previous);
    const b = await shippedBefore();
    if (b.error) return { why: `cannot read manifest.json at ${rec.ref} (${b.error.message})` };
    if (!b.shipped.has(f)) return { why: `manifest.json at ${rec.ref.slice(0, 12)} did not ship it` };
    try {
      return { text: transform(await readAtRef(rec.ref, f, opts.from), rec.envPrefix) };
    } catch (err) {
      return { why: `cannot read it at ${rec.ref} (${/** @type {Error} */ (err).message})` };
    }
  };

  // Ownership: a target that exists must be the new bytes already, or still exactly what the
  // recorded ref wrote. Anything else is the consumer's (its own file at a path the manifest
  // now claims, or a vendored file edited in place) and is replaced only with --adopt.
  const recorded = new Map((previous?.files ?? []).filter(isSafePath).map((f) => [ownedKey(f), f]));
  /** @type {{ f: string, why: string }[]} */
  const foreign = [];
  /** @type {{ f: string, have: string, was: string }[]} */
  const differing = [];
  for (let i = 0; i < files.length; i++) {
    if (!entryExists(targets[i])) continue;
    const have = readFileSync(targets[i], 'utf8').replace(/\r\n/g, '\n');
    if (have === contents[i]) continue;
    const was = recorded.get(ownedKey(files[i]));
    if (!previous || was === undefined) foreign.push({ f: files[i], why: `no ${shaRel} records agent-tooling writing it` });
    else differing.push({ f: files[i], have, was });
  }
  // The old-ref reads run together; wroteBefore() turns each failure into a per-path reason.
  const wroteDiffering = await Promise.all(differing.map(({ was }) => wroteBefore(was)));
  differing.forEach(({ f, have }, i) => {
    const wrote = wroteDiffering[i];
    if (wrote.text === undefined) foreign.push({ f, why: `${wrote.why}, so it cannot be confirmed unchanged` });
    else if (have !== wrote.text) foreign.push({ f, why: `edited since ${REPO}@${previous?.ref.slice(0, 12)} wrote it` });
  });
  foreign.sort((a, b) => (a.f < b.f ? -1 : a.f > b.f ? 1 : 0));
  if (foreign.length && !opts.adopt) {
    throw new Error(
      `refusing to replace ${foreign.length} existing file(s) agent-tooling did not write; nothing was written: ` +
        `${foreign.map(({ f, why }) => `${f} (${why})`).join(', ')}. ` +
        'If this sync should take them over (the consumer moved its own copy into agent-tooling), re-run with --adopt; ' +
        'if a vendored file was edited in place, move the change into agent-tooling first.',
    );
  }

  // The record and the old manifest only say a path WAS vendored; the consumer may have taken
  // it over since (a hand edit, a file of its own at a name the manifest later claimed). So a
  // stale file is deleted only when its bytes are still exactly what the recorded ref wrote,
  // under the recorded prefix. Anything else is kept, and the sync says so. A path still
  // selected under another case is the same file on a case-insensitive filesystem: not stale.
  const stale = (previous?.files ?? []).filter(
    (f) => isSafePath(f) && !selected.has(ownedKey(f)) && !cicd.has(ownedKey(f)) && !recordKeys.has(ownedKey(f)),
  );
  /** @type {string[]} */
  const notes = [];
  /** @type {{ f: string, abs: string, wrote: string }[]} */
  const deletions = [];
  if (stale.length) {
    const b = await shippedBefore();
    if (b.error) {
      notes.push(`not deleting ${stale.length} stale file(s): cannot read manifest.json at ${previous?.ref} (${b.error.message})`);
    } else {
      // One outcome per stale path, the old-ref reads run together, then notes and deletions
      // are collected in path order.
      /** @type {{ keep?: string, deletion?: { f: string, abs: string, wrote: string } }[]} */
      const outcomes = await Promise.all(
        stale.map(async (f) => {
          if (!b.shipped.has(f)) return {};
          const abs = inside(opts.into, f);
          try {
            assertRealInside(opts.into, abs, f);
          } catch (err) {
            return { keep: /** @type {Error} */ (err).message };
          }
          if (!entryExists(abs)) return {};
          if (!lstatSync(abs).isFile()) return { keep: 'it is not a regular file' };
          const wrote = await wroteBefore(f);
          if (wrote.text === undefined) return { keep: `${wrote.why}, so it cannot be confirmed unchanged` };
          if (readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') !== wrote.text) {
            return { keep: `it differs from what ${REPO}@${previous?.ref.slice(0, 12)} wrote, so it is treated as the consumer's; delete it by hand if it is not` };
          }
          return { deletion: { f, abs, wrote: wrote.text } };
        }),
      );
      outcomes.forEach(({ keep, deletion }, i) => {
        if (keep) notes.push(`not deleting stale ${stale[i]}: ${keep}`);
        if (deletion) deletions.push(deletion);
      });
    }
  }

  // Mutate, in order: the files, then the record, then the stale deletes. A stale delete that
  // fails keeps its file and says so; it never throws past a record that is already written.
  const say = (line) => process.stderr.write(`agent-tooling-sync: ${line}\n`);
  for (const { f } of foreign) say(`adopting ${f}: replacing a file agent-tooling did not write`);
  targets.forEach((abs, i) => writeFileAtomic(opts.into, abs, files[i], contents[i]));
  writeFileAtomic(opts.into, shaPath, shaRel, formatShaFile({ ref: opts.ref, envPrefix, sets, files }));
  notes.forEach(say);
  for (const { f, abs, wrote } of deletions) {
    try {
      assertRealInside(opts.into, abs, f);
      if (!entryExists(abs)) continue;
      if (!lstatSync(abs).isFile() || readFileSync(abs, 'utf8').replace(/\r\n/g, '\n') !== wrote) {
        say(`not deleting stale ${f}: it changed while this sync ran`);
        continue;
      }
      rmSync(abs);
    } catch (err) {
      say(`not deleting stale ${f}: ${/** @type {Error} */ (err).message}`);
    }
  }
  return files;
}

/**
 * @param {{ into: string, shaFile?: string, cicdShaFile?: string, from?: string }} opts
 * @returns {Promise<string[]>} one line per problem; empty when the vendored copy is exact
 */
export async function check(opts) {
  const shaRel = opts.shaFile ?? DEFAULT_SHA_FILE;
  const shaPath = recordPath(opts.into, shaRel, '--sha-file');
  if (!existsSync(shaPath)) return [`${shaRel} is missing: nothing records what was vendored`];
  const rec = parseShaFile(readFileSync(shaPath, 'utf8'));
  const manifest = await manifestAt(rec.ref, opts.from);
  let wanted;
  try {
    wanted = selectFiles(manifest, rec.sets);
  } catch (err) {
    return [`${shaRel} records ${/** @type {Error} */ (err).message} at ${rec.ref}`];
  }
  const problems = [];
  const cicd = new Set([...cicdOwnedPaths(opts.into, opts.cicdShaFile ?? DEFAULT_CICD_SHA_FILE)].map(ownedKey));
  const both = wanted.filter((f) => cicd.has(ownedKey(f)));
  if (both.length) problems.push(`${both.join(', ')}: recorded by both ${shaRel} and ${opts.cicdShaFile ?? DEFAULT_CICD_SHA_FILE} (a path has one owner)`);
  if ([...rec.files].sort().join('\n') !== wanted.join('\n')) {
    problems.push(`${shaRel} file list does not match set(s) ${rec.sets.join(',') || 'none'} in manifest.json at ${rec.ref}: re-run sync`);
  }
  for (const f of wanted) {
    const local = inside(opts.into, f);
    try {
      assertRealInside(opts.into, local, f);
    } catch (err) {
      problems.push(`${f}: ${/** @type {Error} */ (err).message}`);
      continue;
    }
    if (!existsSync(local)) {
      problems.push(`${f}: missing`);
      continue;
    }
    // Something that is not a regular file (a directory, a symlink) where a vendored file belongs
    // is drift to report; reading it would throw (EISDIR) and take the whole --check down.
    if (!lstatSync(local).isFile()) {
      problems.push(`${f}: exists and is not a regular file`);
      continue;
    }
    const want = transform(await readAtRef(rec.ref, f, opts.from), rec.envPrefix);
    const have = readFileSync(local, 'utf8').replace(/\r\n/g, '\n');
    if (have !== want) problems.push(`${f}: differs from ${REPO}@${rec.ref.slice(0, 12)}`);
  }
  return problems;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`agent-tooling-sync: ${/** @type {Error} */ (err).message}\n${USAGE}`);
    return 2;
  }
  if (!opts.into) {
    process.stderr.write(USAGE);
    return 2;
  }
  if (opts.check) {
    const problems = await check({ into: opts.into, shaFile: opts.shaFile, cicdShaFile: opts.cicdShaFile, from: opts.from });
    if (problems.length === 0) {
      process.stdout.write('[agent-tooling-drift] vendored agent-tooling files match their recorded ref.\n');
      return 0;
    }
    process.stdout.write(
      `[agent-tooling-drift] ${problems.length} problem(s): vendored files are edited in SeriousGeese/agent-tooling, never in place:\n` +
        problems.map((p) => `[agent-tooling-drift]   ${p}\n`).join(''),
    );
    return 1;
  }
  if (!isPinnedRef(opts.ref)) {
    process.stderr.write(`agent-tooling-sync: --ref must be a full 40-hex commit SHA (a branch or tag can move): ${opts.ref}\n`);
    return 2;
  }
  if (opts.envPrefix !== undefined && !isEnvPrefix(opts.envPrefix)) {
    process.stderr.write(`agent-tooling-sync: --env-prefix must look like PREFIX_ (upper-case, ending in _): ${opts.envPrefix}\n`);
    return 2;
  }
  const files = await sync({ ...opts, ref: /** @type {string} */ (opts.ref) });
  process.stdout.write(`synced ${files.length} files from ${REPO}@${opts.ref} into ${opts.into}\n`);
  return 0;
}

/**
 * True when this module is the process entry point. Compared through realpath on both sides:
 * node resolves import.meta.url through symlinks and junctions but leaves argv[1] as typed, so
 * a plain comparison skipped main() for a linked checkout and `--check` exited 0 having checked
 * nothing. The same idiom as SeriousGeese/CICD agent-hooks, and one consumers' entry-guard
 * guardrails already recognise.
 */
function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // process.exitCode, never process.exit(code): a hard exit can drop the tail of a report
  // still queued on a piped stdout while the status stays 0.
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      process.stderr.write(`agent-tooling-sync: ${err?.message ?? err}\n`);
      process.exitCode = 2;
    },
  );
}
