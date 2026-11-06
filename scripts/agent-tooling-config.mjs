// The one reader of a consumer's `agent-tooling.json`: the per-repository settings that the
// shared guards here, and the scripts in SeriousGeese/agent-tooling, need in order to say
// the consumer's own names (its claim helper, its worktree scripts, its hatch prefix) without
// a consumer's name ever appearing in the shared copy.
//
//   import { loadConfig } from './agent-tooling-config.mjs';
//   const cfg = loadConfig();                 // from the repo that holds this file
//   const cfg = loadConfig({ root: '/repo' }); // from an explicit root
//
// Where it looks: `<root>/agent-tooling.json`. Without `root`, the root is found by walking
// up from `from` (default: the directory holding this file, which sync vendors into the
// consumer's tree) to the first directory holding agent-tooling.json or a `.git` entry. A
// git worktree has a `.git` FILE at its root, so a hook running in a linked worktree reads
// that worktree's config, never the primary checkout's.
//
// A missing file is not an error: every key falls back to a neutral default, so a guard
// works in a repository that never wrote one. An unknown key IS an error, and so is a value
// of the wrong shape, because a typo in a config key otherwise reads as "use the default"
// and the guard silently says the wrong thing. `tryLoadConfig()` is the fail-open form for
// a hook that must never be the reason a tool call or a session start fails.
//
// Dependency-free on purpose (node: builtins only). SeriousGeese/agent-tooling vendors this
// same file from CICD at a pinned ref, so both homes read the config one way.
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CONFIG_FILE = 'agent-tooling.json';

// Assembled, never one literal: sync rewrites the neutral prefix to the consumer's on the
// way in, and the DEFAULT must stay neutral in every copy (a consumer that set envPrefix
// gets its own value from its config, not from this constant).
const NEUTRAL_PREFIX = ['AGENT', 'HOOKS', ''].join('_');

const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn', 'bun'];
const WORKTREE_SCRIPT_KEYS = ['new', 'await', 'install', 'rm', 'stale'];

/**
 * The neutral defaults. The script paths are where SeriousGeese/agent-tooling installs its
 * scripts, so a consumer that adopts both homes at their default paths needs no config.
 */
export const DEFAULTS = Object.freeze({
  envPrefix: NEUTRAL_PREFIX,
  beadPrefix: null,
  packageManager: 'npm',
  worktreeRoot: '..',
  worktreeNamePattern: '<repo>-<slug>',
  gateWrappers: Object.freeze(['gate.sh']),
  people: Object.freeze([]),
  claimHelper: 'scripts/claim.sh',
  emDashPaths: Object.freeze([]),
  worktreeScripts: Object.freeze({
    new: 'bash scripts/worktree-new.sh <slug> <branch>',
    await: 'bash scripts/worktree-new.sh --await <path>',
    install: 'bash scripts/worktree-new.sh --install <path>',
    rm: 'bash scripts/worktree-rm.sh <path>',
    stale: 'bash scripts/worktree-rm.sh --stale',
  }),
  staleHookFiles: Object.freeze(['.claude/settings.json', 'scripts/hooks']),
});

/** Keys that document the file and are otherwise ignored. */
const COMMENT_KEYS = new Set(['$comment', '$schema']);

export class AgentToolingConfigError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'AgentToolingConfigError';
  }
}

const isString = (v) => typeof v === 'string' && v.length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every(isString);

/** A repo-relative path: no absolute path, no `..` segment, forward slashes. */
function isRelPath(v) {
  if (!isString(v) || v.includes('\\') || path.posix.isAbsolute(v) || /^[A-Za-z]:/.test(v)) return false;
  return !v.split('/').includes('..');
}

/** One validator per key: returns an error string, or '' when the value is fine. */
const VALIDATORS = {
  envPrefix: (v) => (typeof v === 'string' && /^[A-Z][A-Z0-9_]*_$/.test(v) ? '' : 'must look like PREFIX_ (upper-case, ending in _)'),
  beadPrefix: (v) => (v === null || (typeof v === 'string' && /^[A-Za-z][A-Za-z0-9]*$/.test(v)) ? '' : 'must be null or an alphanumeric id prefix such as "bd"'),
  packageManager: (v) => (PACKAGE_MANAGERS.includes(v) ? '' : `must be one of ${PACKAGE_MANAGERS.join(', ')}`),
  worktreeRoot: (v) => (isString(v) ? '' : 'must be a non-empty path string'),
  worktreeNamePattern: (v) => (isString(v) && v.includes('<slug>') ? '' : 'must be a string containing <slug>'),
  gateWrappers: (v) => (isStringArray(v) && v.every((n) => !/[\\/]/.test(n)) ? '' : 'must be an array of script basenames (no directories)'),
  people: (v) => (isStringArray(v) && v.every((p) => /^[a-z][a-z0-9-]*$/.test(p)) ? '' : 'must be an array of lower-case handles'),
  claimHelper: (v) => (isRelPath(v) ? '' : 'must be a repo-relative path'),
  emDashPaths: (v) => (Array.isArray(v) && v.every(isRelPath) ? '' : 'must be an array of repo-relative path prefixes'),
  worktreeScripts: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return `must be an object with keys ${WORKTREE_SCRIPT_KEYS.join(', ')}`;
    const unknown = Object.keys(v).filter((k) => !WORKTREE_SCRIPT_KEYS.includes(k));
    if (unknown.length) return `has unknown key(s) ${unknown.join(', ')} (known: ${WORKTREE_SCRIPT_KEYS.join(', ')})`;
    const bad = Object.entries(v).filter(([, cmd]) => !isString(cmd)).map(([k]) => k);
    return bad.length ? `entries must be non-empty command strings: ${bad.join(', ')}` : '';
  },
  staleHookFiles: (v) => (Array.isArray(v) && v.every(isRelPath) ? '' : 'must be an array of repo-relative paths'),
};

export const KNOWN_KEYS = Object.freeze(Object.keys(DEFAULTS));

/**
 * Validate a parsed config object and merge it over the defaults. `worktreeScripts` merges
 * per key, so a consumer may override one command and keep the rest.
 * @param {unknown} raw
 * @param {string} [source] a name for error messages
 */
export function resolveConfig(raw, source = CONFIG_FILE) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new AgentToolingConfigError(`${source} must hold a JSON object`);
  }
  const problems = [];
  for (const [key, value] of Object.entries(raw)) {
    if (COMMENT_KEYS.has(key)) continue;
    const validate = VALIDATORS[key];
    if (!validate) {
      problems.push(`unknown key "${key}" (known: ${KNOWN_KEYS.join(', ')})`);
      continue;
    }
    const why = validate(value);
    if (why) problems.push(`"${key}" ${why}`);
  }
  if (problems.length) throw new AgentToolingConfigError(`${source}: ${problems.join('; ')}`);

  const out = {};
  for (const key of KNOWN_KEYS) {
    if (key === 'worktreeScripts') out[key] = Object.freeze({ ...DEFAULTS.worktreeScripts, ...(raw.worktreeScripts ?? {}) });
    else if (Object.hasOwn(raw, key)) out[key] = Array.isArray(raw[key]) ? Object.freeze([...raw[key]]) : raw[key];
    else out[key] = DEFAULTS[key];
  }
  return Object.freeze(out);
}

function hasEntry(dir, name) {
  try {
    statSync(path.join(dir, name));
    return true;
  } catch {
    return false;
  }
}

/**
 * The nearest directory at or above `from` holding agent-tooling.json or a `.git` entry,
 * or `from` itself when neither is found.
 * @param {string} from
 */
export function findRoot(from) {
  let dir = path.resolve(from);
  for (;;) {
    if (hasEntry(dir, CONFIG_FILE) || hasEntry(dir, '.git')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(from);
    dir = parent;
  }
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * @param {{ root?: string, from?: string }} [opts]
 * @returns {Readonly<typeof DEFAULTS> & { root: string, found: boolean }}
 */
export function loadConfig(opts = {}) {
  const root = opts.root ? path.resolve(opts.root) : findRoot(opts.from ?? HERE);
  const file = path.join(root, CONFIG_FILE);
  if (!existsSync(file)) return Object.freeze({ ...DEFAULTS, root, found: false });
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (err) {
    throw new AgentToolingConfigError(`${file}: not valid JSON (${err.message})`, { cause: err });
  }
  return Object.freeze({ ...resolveConfig(raw, file), root, found: true });
}

/**
 * The fail-open form: never throws. On a broken config it returns the defaults and the
 * reason in `error`, so a hook can say so on stderr and carry on.
 * @param {{ root?: string, from?: string }} [opts]
 */
export function tryLoadConfig(opts = {}) {
  try {
    return { config: loadConfig(opts), error: null };
  } catch (err) {
    const root = opts.root ? path.resolve(opts.root) : findRoot(opts.from ?? HERE);
    return { config: Object.freeze({ ...DEFAULTS, root, found: false }), error: err.message };
  }
}

/**
 * Fill `<name>` placeholders in a configured command template, e.g.
 * `fillTemplate(cfg.worktreeScripts.await, { path: top })`. Unknown placeholders stay as
 * written, so a refusal message can still show `<branch>` for the agent to fill in.
 * @param {string} template
 * @param {Record<string, string>} values
 */
export function fillTemplate(template, values = {}) {
  return template.replace(/<([a-z]+)>/g, (whole, name) => (Object.hasOwn(values, name) ? values[name] : whole));
}

/**
 * The worktree directory name for a slug, from `worktreeNamePattern`. `<repo>` is the
 * basename of the config root unless given.
 * @param {{ worktreeNamePattern: string, root?: string }} cfg
 * @param {string} slug
 * @param {string} [repo]
 */
export function worktreeName(cfg, slug, repo) {
  return fillTemplate(cfg.worktreeNamePattern, { slug, repo: repo ?? path.basename(cfg.root ?? '') });
}

/**
 * A bead id regex for `beadPrefix` (`<prefix>-<id>[.n...]`), or one accepting any prefix when
 * the consumer set none.
 * @param {{ beadPrefix: string | null }} cfg
 */
export function beadIdPattern(cfg) {
  const prefix = cfg.beadPrefix ? cfg.beadPrefix.replace(/[^A-Za-z0-9]/g, '') : '[A-Za-z][A-Za-z0-9]*';
  return new RegExp(`\\b${prefix}-[a-z0-9]+(?:\\.[0-9]+)*\\b`);
}
