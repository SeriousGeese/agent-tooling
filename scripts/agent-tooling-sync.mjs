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
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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

const USAGE =
  'usage: node agent-tooling-sync.mjs --into <repo> --ref <40-hex sha> [--set <name>[,<name>]] [--drop] [--env-prefix PREFIX_] [--sha-file scripts/AGENT-TOOLING-SHA] [--cicd-sha-file scripts/hooks/CICD-HOOKS-SHA] [--from <agent-tooling checkout>]\n' +
  '       node agent-tooling-sync.mjs --into <repo> --check [--sha-file ...] [--from <agent-tooling checkout>]\n';

/** @param {string[]} argv */
export function parseArgs(argv) {
  /** @type {{ into?: string, ref?: string, envPrefix?: string, sets?: string[], drop?: boolean, shaFile: string, cicdShaFile: string, from?: string, check: boolean }} */
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
  const s = String(p);
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
  return envPrefix === NEUTRAL_PREFIX ? lf : lf.replace(NEUTRAL_PREFIX_RE, envPrefix);
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
  return { ref, envPrefix, sets: parseSetList(setsLine), files };
}

/**
 * The files the consumer's CICD-HOOKS-SHA records, as repo-relative paths. An absent file
 * means CICD owns nothing here.
 * @param {string} into
 * @param {string} cicdShaFile repo-relative
 */
export function cicdOwnedPaths(into, cicdShaFile) {
  const file = path.join(path.resolve(into), cicdShaFile);
  if (!existsSync(file)) return new Set();
  const text = readFileSync(file, 'utf8');
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
 * would still carry a write out of `--into`, so before writing, the nearest existing ancestor
 * of the target must resolve, through every link, to somewhere inside the real `--into`.
 */
function assertRealInside(into, abs, rel) {
  const root = realpathSync(path.resolve(into));
  let probe = path.dirname(abs);
  while (!existsSync(probe)) probe = path.dirname(probe);
  const r = path.relative(root, realpathSync(probe));
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`refusing ${rel}: a symlink in the path leads outside --into`);
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
    return execFileSync('git', ['-C', from, 'show', `${ref}:${rel}`], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
  }
  const url = `https://raw.githubusercontent.com/${REPO}/${ref}/${rel}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
  return res.text();
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
    const lists = name === ALL_SET ? Object.values(manifest.sets) : [manifest.sets[name]];
    if (!lists[0] && name !== ALL_SET) {
      throw new Error(`unknown set "${name}" (known: ${[...Object.keys(manifest.sets), ALL_SET].join(', ')})`);
    }
    for (const list of lists) for (const f of list ?? []) picked.add(f);
  }
  return [...picked].sort();
}

async function manifestAt(ref, from) {
  return parseManifest(JSON.parse(await readAtRef(ref, 'manifest.json', from)), `manifest.json at ${ref}`);
}

/**
 * @param {{ into: string, ref: string, envPrefix?: string, sets?: string[], drop?: boolean, shaFile?: string, cicdShaFile?: string, from?: string }} opts
 * @returns {Promise<string[]>} the files written
 */
export async function sync(opts) {
  if (!isPinnedRef(opts.ref)) throw new Error(`ref must be a full 40-hex commit SHA (a branch or tag can move): ${opts.ref}`);
  const shaRel = opts.shaFile ?? DEFAULT_SHA_FILE;
  const shaPath = inside(opts.into, shaRel);
  const previous = existsSync(shaPath) ? parseShaFile(readFileSync(shaPath, 'utf8')) : null;
  // The recorded prefix comes before the neutral one, so a consumer that once passed
  // --env-prefix and has no agent-tooling.json keeps its hatch names on a plain re-sync.
  const envPrefix = opts.envPrefix ?? configEnvPrefix(opts.into) ?? previous?.envPrefix ?? NEUTRAL_PREFIX;
  if (!isEnvPrefix(envPrefix)) throw new Error(`env prefix must look like PREFIX_ (upper-case, ending in _): ${envPrefix}`);

  const manifest = await manifestAt(opts.ref, opts.from);
  const sets = opts.sets ?? previous?.sets ?? [];
  const files = selectFiles(manifest, sets);
  // A file the manifest still ships but the new selection leaves out may still be wired up
  // (a package.json script, a settings.json hook, a skill link). Sets are not cumulative, so
  // naming fewer is the easy mistake: refuse unless the caller says --drop.
  if (!opts.drop && previous) {
    const shipped = new Set(selectFiles(manifest, ['all']));
    const dropped = previous.files.filter((f) => !files.includes(f) && shipped.has(f));
    if (dropped.length > 0) {
      throw new Error(
        `set(s) ${sets.join(',') || 'none'} would stop vendoring ${dropped.length} file(s) the last sync (sets ${previous.sets.join(',') || 'none'}) wrote: ${dropped.join(', ')}. ` +
          'Remove what still uses them, then re-run with --drop, or name every set you still want.',
      );
    }
  }

  const cicd = new Set([...cicdOwnedPaths(opts.into, opts.cicdShaFile ?? DEFAULT_CICD_SHA_FILE)].map(ownedKey));
  const clash = files.filter((f) => cicd.has(ownedKey(f)));
  if (clash.length) {
    throw new Error(
      `refusing to write ${clash.length} path(s) that ${opts.cicdShaFile ?? DEFAULT_CICD_SHA_FILE} records as vendored from SeriousGeese/CICD ` +
        `(a path has exactly one owner): ${clash.join(', ')}`,
    );
  }

  const contents = await Promise.all(files.map(async (f) => transform(await readAtRef(opts.ref, f, opts.from), envPrefix)));
  const targets = files.map((f) => inside(opts.into, f));
  targets.forEach((abs, i) => assertRealInside(opts.into, abs, files[i]));
  // A stale file is deleted only when the manifest at the recorded ref shipped it: the
  // record's own file list is plain text a hand edit could point at a consumer's file.
  const stale = (previous?.files ?? []).filter((f) => !files.includes(f) && isSafePath(f) && !cicd.has(ownedKey(f)));
  let shippedBefore = new Set();
  if (stale.length) {
    try {
      shippedBefore = new Set(selectFiles(await manifestAt(previous.ref, opts.from), [ALL_SET]));
    } catch (err) {
      process.stderr.write(`agent-tooling-sync: not deleting ${stale.length} stale file(s): cannot read manifest.json at ${previous.ref} (${/** @type {Error} */ (err).message})\n`);
    }
  }
  targets.forEach((abs, i) => {
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, contents[i]);
  });
  for (const f of stale) {
    if (shippedBefore.has(f)) rmSync(inside(opts.into, f), { force: true });
  }
  mkdirSync(path.dirname(shaPath), { recursive: true });
  writeFileSync(shaPath, formatShaFile({ ref: opts.ref, envPrefix, sets, files }));
  return files;
}

/**
 * @param {{ into: string, shaFile?: string, cicdShaFile?: string, from?: string }} opts
 * @returns {Promise<string[]>} one line per problem; empty when the vendored copy is exact
 */
export async function check(opts) {
  const shaRel = opts.shaFile ?? DEFAULT_SHA_FILE;
  const shaPath = inside(opts.into, shaRel);
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
    if (!existsSync(local)) {
      problems.push(`${f}: missing`);
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
