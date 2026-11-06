#!/usr/bin/env node
/**
 * pr-metadata.mjs: the `metadata` job of a pull-request workflow.
 *
 *   node scripts/pr-metadata.mjs --body-file <path> --head-ref <branch> [--author <login>]
 *                                [--base <ref>] [--head <ref>] [--migrations-dir <dir>] [--json]
 *
 * Cheap checks on the PR itself, each a reason that fails the job. None touches the bead store:
 * the pipeline does not prove a bead exists on the hot path (that is the batch close's job after
 * the merge); it checks that what the body SAYS is well-formed.
 *
 *   anchor     A bead-derived branch (one ending in a bead id) names that id on an anchor line
 *              (`Fixes:`, `Closes:`, `Resolves:`, `Bead:`) or says `Part of <id>` in prose. Any
 *              anchor line present must carry well-formed ids, or the word `none`; the template's
 *              unfilled `Fixes: <prefix>-` placeholder is a failure, not a pass. The bead id shape
 *              is `<beadPrefix>-<id>[.n...]` from agent-tooling.json, or any prefix when none is set.
 *   template   The body carries the pull_request_template.md sections (`## Summary`,
 *              `## Verification`). Bot authors (dependabot, github-actions) are exempt: their bodies
 *              are generated.
 *   size       The body is under BODY_LIMIT bytes: GitHub refuses 65,536 and a squash commit
 *              message may be the body.
 *   migrations Only with --migrations-dir <dir> (a repository whose migrations are numbered
 *              <dir>/NNNN_*.sql): a migration number this PR adds (base tip to head) is not already
 *              taken on the base branch. The same number twice is the collision that only shows up
 *              at deploy time as `no such column`.
 *
 * Exit 0 when every check passes, 1 with the reasons listed, 2 on a usage error.
 */
import { spawnSync } from 'node:child_process';
import fs, { realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beadIdPattern, tryLoadConfig } from './agent-tooling-config.mjs';
import { parseFlags } from './lib/parse-flags.mjs';

export const BODY_LIMIT = 60_000;
export const ANCHOR_LINE = /^\s*(fixes|closes|resolves|bead)\s*:/i;
export const REQUIRED_SECTIONS = ['## Summary', '## Verification'];
export const BOT_AUTHORS = ['dependabot[bot]', 'github-actions[bot]', 'github-actions'];

class UsageError extends Error {}

/**
 * The consumer's config (bead prefix null: any prefix), fail-open: a broken agent-tooling.json
 * falls back to the defaults, which loosens the check, so say so as a GitHub warning annotation.
 */
export function loadBeadConfig({ root, stderr = process.stderr } = {}) {
  const { config, error } = tryLoadConfig(root ? { root } : {});
  if (error) stderr.write(`::warning title=PR metadata::agent-tooling.json is unusable, so the bead prefix checks run with defaults: ${String(error).replace(/\s+/g, ' ')}\n`);
  return config;
}

let cachedConfig = null;
function defaultConfig() {
  cachedConfig ??= loadBeadConfig();
  return cachedConfig;
}

/**
 * The id patterns for a config (`{ beadPrefix }`; default: the repository's config): a global
 * one for scanning text, an exact one for one token, and the example shape for messages.
 */
export function beadPatterns(cfg = defaultConfig()) {
  const source = beadIdPattern(cfg).source;
  return {
    scan: new RegExp(source, 'g'),
    exact: new RegExp(`^${source}$`),
    placeholder: /^[A-Za-z][A-Za-z0-9]*-x+$/i,
    example: `${cfg.beadPrefix ?? 'bd'}-xxxxx`,
    prefixSource: cfg.beadPrefix ? cfg.beadPrefix.replace(/[^A-Za-z0-9]/g, '') : '[A-Za-z][A-Za-z0-9]*',
  };
}

const lines = body => String(body ?? '').replace(/\r\n/g, '\n').split('\n');

/**
 * The bead ids on anchor lines, with `(epic ...)` parentheticals removed so an epic named in
 * passing is not an anchor, and markdown emphasis/code characters stripped so an id written as
 * `_id_`, `**id**` or a backticked id is still found.
 */
export function anchoredBeadIds(body, cfg) {
  const { scan } = beadPatterns(cfg);
  return lines(body).filter(line => ANCHOR_LINE.test(line))
    .flatMap(line => line.replace(/\([Ee]pic[^)]*\)/g, '').replace(/[`*_]/g, '').match(scan) || []);
}

/**
 * The bead id a branch ENDS in, or null. With no configured prefix a branch carries no id: any
 * `word-word` ending would read as one (`feat/fix-login`), so the branch check is off.
 */
export function branchBeadId(headRef, cfg = defaultConfig()) {
  if (!cfg.beadPrefix) return null;
  const { prefixSource } = beadPatterns(cfg);
  return new RegExp(`(?:^|[/_-])(${prefixSource}-[a-z0-9]+(?:\\.[0-9]+)*)$`).exec(String(headRef ?? ''))?.[1] ?? null;
}

/** The problems with the body's anchor lines, as reasons. */
export function anchorProblems(body, headRef, cfg) {
  const patterns = beadPatterns(cfg);
  const problems = [];
  const anchors = lines(body).filter(line => ANCHOR_LINE.test(line));
  const ids = anchoredBeadIds(body, cfg);
  for (const line of anchors) {
    const value = line.replace(ANCHOR_LINE, '').trim();
    if (/^none\b/i.test(value)) continue;
    const tokens = value.replace(/\([Ee]pic[^)]*\)/g, '').split(/[\s,]+/).map(token => token.replace(/^[`*_]+|[`*_.]+$/g, '')).filter(Boolean);
    if (tokens.length === 0) { problems.push(`The anchor line "${line.trim()}" names no bead id (the template placeholder is not filled in). Write the ids, or "Fixes: none".`); continue; }
    const bad = tokens.filter(token => !patterns.exact.test(token) || patterns.placeholder.test(token));
    if (bad.length > 0) problems.push(`The anchor line "${line.trim()}" carries ${bad.map(token => JSON.stringify(token)).join(', ')}, not a bead id of the form ${patterns.example} or ${patterns.example}.N.`);
  }
  const branchId = branchBeadId(headRef, cfg);
  if (branchId && !ids.includes(branchId)) {
    const partOf = new RegExp(`part\\s+of\\s+[\`*_]*${branchId.replace(/\./g, '[.]')}([^a-z0-9.]|[.]([^0-9]|$)|$)`, 'i');
    if (!lines(body).some(line => partOf.test(line))) {
      problems.push(`The branch ends in ${branchId} but no anchor line (Fixes:, Closes:, Resolves:, Bead:) names it and nothing says "Part of ${branchId}".`);
    }
  }
  return problems;
}

export function templateProblems(body, author) {
  if (BOT_AUTHORS.includes(String(author ?? ''))) return [];
  const text = String(body ?? '');
  return REQUIRED_SECTIONS.filter(section => !new RegExp(`^\\s*${section.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'im').test(text))
    .map(section => `The body has no "${section}" section; .github/pull_request_template.md has one. Keep the template's headings.`);
}

export function sizeProblems(body) {
  const bytes = Buffer.byteLength(String(body ?? ''), 'utf8');
  return bytes > BODY_LIMIT ? [`The body is ${bytes} bytes; the limit is ${BODY_LIMIT} (it may become the squash commit message).`] : [];
}

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Migration numbers the PR adds (`addedPaths`) that the base branch (`basePaths`, a list of paths)
 * already holds. `dir` is the migrations directory, files named `<dir>/NNNN_*.sql`.
 */
export function migrationCollisions(addedPaths, basePaths, dir) {
  const clean = String(dir ?? '').replace(/\/+$/, '');
  if (!clean) return [];
  const sql = new RegExp(`^${escapeRe(clean)}/(\\d{4})_[^/]+\\.sql$`);
  const taken = new Map();
  for (const file of basePaths) {
    const m = sql.exec(file);
    if (m) taken.set(m[1], file);
  }
  const problems = [];
  for (const file of addedPaths) {
    const m = sql.exec(file);
    if (m && taken.has(m[1])) {
      problems.push(`Migration ${file} takes number ${m[1]}, which the base branch already holds as ${taken.get(m[1])}. ` +
        'Keep BOTH: regenerate yours at the next free number.');
    }
  }
  return problems;
}

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return r.stdout;
}

/**
 * Migration paths present at the head and absent at the base TIP, and the base tip's file list.
 * A two-dot diff of two commits, on purpose: a workflow may fetch both at depth 1, so there is no
 * merge base to ask for, and "added relative to the base tip" is the collision question anyway: a
 * number the base took after the branch point shows up.
 */
export function migrationsFromGit({ cwd, base, head, dir }) {
  const baseSha = git(['rev-parse', '--verify', `${base}^{commit}`], cwd).trim();
  const headSha = git(['rev-parse', '--verify', `${head}^{commit}`], cwd).trim();
  const added = git(['diff', '--name-only', '--diff-filter=A', baseSha, headSha, '--', dir], cwd).split('\n').filter(Boolean);
  const basePaths = git(['ls-tree', '-r', '--name-only', baseSha, '--', dir], cwd).split('\n').filter(Boolean);
  return { added, basePaths };
}

export function checkMetadata({ body, headRef, author, added = [], basePaths = [], migrationsDir = null, config }) {
  const problems = {
    anchor: anchorProblems(body, headRef, config),
    template: templateProblems(body, author),
    size: sizeProblems(body),
    migrations: migrationCollisions(added, basePaths, migrationsDir),
  };
  const all = Object.values(problems).flat();
  return { ok: all.length === 0, problems, all };
}

const USAGE = `usage:
  node scripts/pr-metadata.mjs --body-file <path> --head-ref <branch> [--author <login>] [--base <ref>] [--head <ref>] [--migrations-dir <dir>] [--json]`;

export async function main(argv, { cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr, config } = {}) {
  try {
    const { flags } = parseFlags(argv, {
      ErrorClass: UsageError,
      flags: { 'body-file': {}, 'head-ref': {}, author: {}, base: {}, head: {}, 'migrations-dir': {}, json: { type: 'boolean' }, help: { type: 'boolean', aliases: ['-h'] } },
    });
    if (flags.help) { stdout.write(`${USAGE}\n`); return 0; }
    if (!flags['body-file'] || !flags['head-ref']) throw new UsageError('--body-file and --head-ref are required');
    const body = fs.readFileSync(path.resolve(cwd, flags['body-file']), 'utf8');
    const migrationsDir = flags['migrations-dir'] ?? null;
    let gitFacts = { added: [], basePaths: [] };
    let gitError = null;
    if (migrationsDir) {
      try {
        gitFacts = migrationsFromGit({ cwd, base: flags.base ?? 'origin/main', head: flags.head ?? 'HEAD', dir: migrationsDir });
      } catch (error) {
        gitError = String(error?.message ?? error);
      }
    }
    const result = checkMetadata({ body, headRef: flags['head-ref'], author: flags.author, migrationsDir, config, ...gitFacts });
    // A collision check that could not run is a failure, never a silent pass: the whole point of the
    // check is the case that every local gate misses.
    if (gitError) { result.ok = false; result.all.push(`The migration-number check could not read git: ${gitError}`); }
    if (flags.json) stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      for (const problem of result.all) stdout.write(`::error title=PR metadata::${problem}\n`);
      stdout.write(result.ok ? 'pr-metadata: ok\n' : `pr-metadata: ${result.all.length} problem(s)\n`);
    }
    return result.ok ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) { stderr.write(`pr-metadata: ${error.message}\n\n${USAGE}\n`); return 2; }
    stderr.write(`pr-metadata: ${error.stack ?? error}\n`);
    return 1;
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch { return false; }
}

if (isEntryPoint()) {
  main(process.argv.slice(2)).then(code => { process.exitCode = code; });
}
