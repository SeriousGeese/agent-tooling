#!/usr/bin/env node
// Tooling-friction filing CLI: one bead per friction entry, so the active log is a
// `bd` query instead of a hand-appended file.
//
//   node scripts/oddity.mjs new "<title>" [--repo <name>] [--priority P3] [--body-file <md>] [--dry-run]
//   node scripts/oddity.mjs recur <archive-entry-N> "<title>" [--repo <name>] [--body-file <md>] [--dry-run]
//   node scripts/oddity.mjs list [--repo <name>] [--json]
//   node scripts/oddity.mjs next-number
//
// One store for every repo on the machine: run it from any repo as
// `node "$AGENT_TOOLING_CHECKOUT/scripts/oddity.mjs" …`. The entry is a bead in the store
// repo's database, labelled `repo:<origin basename>` (repo:app, repo:tools); outside a store
// checkout every bd call is `bd -C <store checkout>`, found from $AGENT_TOOLING_CHECKOUT or a
// sibling directory named by the repo's beadPrefix.
//
// Why a script, and why beads: the log used to be a plain file outside any repo -
// unversioned, single-machine, and appended to by every concurrent session. Its
// archive now lives in the repo (ARCHIVE_REL, docs/agents/tooling-oddities-archive.md by default) and the
// ACTIVE entries are beads labelled `tooling-oddity` (LABEL): `bd dolt` syncs them across
// people and machines, `bd ready` surfaces them, close-beads archives them when the
// fixing PR merges, and a recurrence is a `relates-to` edge rather than a grep.
//
// `--body-file` takes the entry text from a file written with the Write tool (never
// a heredoc, the Bash tool truncates large commands).
// Without it the bead gets the template with placeholders; fill it in afterwards
// with `bd update <id> --body-file <md>`.
//
// bd sync is clobber-safe and bare: pull → create → push. Every bd call is
// time-capped so a lock wait fails LOUDLY instead of hanging.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tryLoadConfig } from './agent-tooling-config.mjs';
import { resolveActor } from './hygiene-bd-lib.mjs';
import {
  ARCHIVE_REL,
  LABEL,
  SELF_CHECK_FILES,
  SKIP_STALE_ENV,
  UPSTREAM_REL,
  VERIFY_EXIT,
  archivedBeadIds,
  bdDirArgs,
  buildCreateArgs,
  buildListArgs,
  classifySelfVersion,
  formatUnarchivedLines,
  unarchivedClosed,
  normalizeRepoName,
  repoNameFromRemoteUrl,
  resolveStoreCheckout,
  entryTemplate,
  findArchiveEntry,
  formatVerifyLine,
  ghChildEnv,
  nextArchiveNumber,
  parseArgs,
  recurrencePreamble,
  renderUpstream,
  repairMsysMangledTitle,
  staleCliMessage,
  updateRegistry,
  upstreamKey,
  worstVerifyExit,
} from './oddity-lib.mjs';

const BD_TIMEOUT_MS = 120_000;

// The store repo's bead prefix (what its beads are called) names the sibling checkout directory
// and the dry-run id; this file's own config is the store's when it runs from the store.
// Loaded from the root of THIS checkout (the store when the CLI runs from it), never from the
// caller's cwd: the cross-repo case runs this file from the store while standing in another repo.
const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE_PREFIX = tryLoadConfig({ root: SCRIPT_ROOT }).config.beadPrefix;
const BEAD_PREFIX = STORE_PREFIX ?? 'bd';
const SIBLING_NAME = STORE_PREFIX;

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function repoRoot() {
  return git(['rev-parse', '--show-toplevel']) || process.cwd();
}


/**
 * The first CLI file whose on-disk content is an OLDER committed version than the
 * local `origin/main` ref knows, or null when every file is current, locally
 * modified (development), or unjudgeable (fail open); see classifySelfVersion.
 * `git hash-object` applies the checkout's attribute filters, so a
 * CRLF working copy still hashes to the committed LF blob.
 */
function selfStaleFile() {
  for (const rel of SELF_CHECK_FILES) {
    const file = path.join(SCRIPT_ROOT, rel);
    if (!existsSync(file)) return null;
    const diskHash = git(['hash-object', file], SCRIPT_ROOT);
    const tipHash = git(['rev-parse', `origin/main:${rel}`], SCRIPT_ROOT);
    if (!diskHash || !tipHash || diskHash === tipHash) continue;
    const commits = git(['rev-list', '--max-count=50', 'origin/main', '--', rel], SCRIPT_ROOT)
      .split('\n')
      .filter(Boolean);
    const historicalHashes = commits.map((c) => git(['rev-parse', `${c}:${rel}`], SCRIPT_ROOT)).filter(Boolean);
    if (classifySelfVersion({ diskHash, tipHash, historicalHashes }) === 'stale') return rel;
  }
  return null;
}

/** A store checkout or worktree: it carries the beads config and the oddity archive. */
function isStoreCheckout(dir) {
  return Boolean(dir) && existsSync(path.join(dir, '.beads')) && existsSync(path.join(dir, ARCHIVE_REL));
}

/**
 * The caller's repo name for the `repo:` label: origin's basename; a store checkout
 * with no origin (a test fixture, a fresh clone) is its beadPrefix, lower-cased. Anything else must say.
 */
function defaultRepoName(callerRoot, store) {
  const fromRemote = repoNameFromRemoteUrl(git(['remote', 'get-url', 'origin'], callerRoot));
  if (fromRemote) return fromRemote;
  const prefix = tryLoadConfig({ root: store.root }).config.beadPrefix;
  if (store.mode === 'local' && prefix) return prefix.toLowerCase();
  throw new Error(`cannot tell which repo ${callerRoot} is (no usable origin remote) — pass --repo <name>`);
}

// ODDITY_BD_STUB is the test seam: a node script standing in for bd, so the
// cross-repo tests can file and list without a real Dolt database. A .cmd shim on
// PATH would not work, spawnSync without a shell does not resolve one on Windows.
const BD_STUB = process.env.ODDITY_BD_STUB;

function bd(args, { dryRun = false, capture = true } = {}) {
  if (dryRun) {
    process.stdout.write(`[dry-run] bd ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}\n`);
    return { status: 0, stdout: '' };
  }
  const [bin, argv] = BD_STUB ? [process.execPath, [BD_STUB, ...args]] : ['bd', args];
  const r = spawnSync(bin, argv, { encoding: 'utf8', timeout: BD_TIMEOUT_MS, stdio: ['ignore', capture ? 'pipe' : 'inherit', 'pipe'] });
  if (r.error) throw new Error(`bd ${args[0]} failed to start: ${r.error.message}`);
  return r;
}

function usage(code = 1) {
  process.stderr.write(
    [
      'usage:',
      '  node scripts/oddity.mjs new "<title>" [--repo <name>] [--priority P3] [--body-file <md>] [--dry-run]',
      '  node scripts/oddity.mjs recur <archive-entry-N> "<title>" [--repo <name>] [--body-file <md>] [--dry-run]',
      '  node scripts/oddity.mjs list [--repo <name>] [--json]',
      '  node scripts/oddity.mjs unarchived [--repo <name>] [--json]',
      '  node scripts/oddity.mjs next-number',
      '  node scripts/oddity.mjs upstream [--write] [--json] [--states-file <json>]',
      '  node scripts/oddity.mjs verify <issue> [extra probe args...]',
      '  node scripts/oddity.mjs verify --all',
      '',
      `An entry is a bead labelled \`${LABEL}\` plus \`repo:<name>\` (default: the origin remote basename);`,
      '`unarchived` lists entries a PR already CLOSED (via its Fixes: line) that the archive does not mention —',
      'the sweep archives those with the short block in step 0c of its skill; `list` never shows them.',
      `the archive is ${ARCHIVE_REL}. From another repo: node "$AGENT_TOOLING_CHECKOUT/scripts/oddity.mjs" …`,
      '— point $AGENT_TOOLING_CHECKOUT at a CURRENT worktree, not the primary checkout: the CLI refuses to run a copy of',
      'itself that is an older committed version than origin/main.',
      `\`upstream\` asks GitHub for the state of every issue in ${UPSTREAM_REL} and`,
      'names the workaround to retire when one has closed; --write refreshes lastChecked/lastKnownState.',
      '`verify` runs one registry entry\'s verify script (its `verify.script`, conventionally scripts/oddity-verify/<issue>.mjs; or every entry with --all) and',
      'prints a one-line verdict: RETIRABLE (exit 0), STILL-REPRODUCES (1), a usage/script error (2), or',
      'NEEDS-MANUAL (3) when the entry needs a further agent or human step. --all exits with the worst verdict.',
      'The repo\'s oddity docs say what qualifies and how the weekly sweep consumes these.',
    ].join('\n') + '\n',
  );
  process.exit(code);
}

/**
 * Live issue states from GitHub, keyed `repo#issue`. Missing keys mean gh failed
 * for that issue (offline, rate limit, bad token), reported as UNKNOWN, never as
 * OPEN, so a dead gh cannot quietly keep a workaround alive.
 * GITHUB_TOKEN is dropped from the child env but GH_TOKEN is kept, see ghChildEnv.
 */
function fetchIssueStates(entries) {
  const env = ghChildEnv(process.env);
  const states = new Map();
  // ODDITY_GH_STUB is the test seam, like ODDITY_BD_STUB: a node script standing in
  // for gh, so a test can see exactly which token variables reach the child.
  const GH_STUB = process.env.ODDITY_GH_STUB;
  for (const e of entries) {
    const ghArgs = ['issue', 'view', String(e.issue), '--repo', e.repo, '--json', 'state,stateReason,closedAt,updatedAt'];
    const [bin, argv] = GH_STUB ? [process.execPath, [GH_STUB, ...ghArgs]] : ['gh', ghArgs];
    const r = spawnSync(bin, argv, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.status !== 0) continue;
    try {
      const parsed = JSON.parse(r.stdout);
      if (parsed && typeof parsed.state === 'string') states.set(upstreamKey(e), parsed);
    } catch {
      /* unreadable → UNKNOWN */
    }
  }
  return states;
}

/**
 * Run one registry entry's verify script: `node <root>/<entry.verify.script> ...extraArgs`.
 * Extra args are forwarded byte-for-byte, a verify script's own argv is the probe
 * (a doubled-backslash string, `--receive <payload>`, …), so this deliberately
 * bypasses the CLI's own flag parser rather than trying to validate probe content
 * it has no business inspecting.
 */
function runVerifyScript({ root, entry, extraArgs }) {
  const scriptPath = path.join(root, entry.verify.script);
  if (!existsSync(scriptPath)) {
    return { exitCode: VERIFY_EXIT.USAGE_ERROR, output: `verify script not found: ${scriptPath}` };
  }
  const r = spawnSync(process.execPath, [scriptPath, ...extraArgs], { cwd: root, encoding: 'utf8', timeout: 30_000 });
  if (r.error) {
    return { exitCode: VERIFY_EXIT.USAGE_ERROR, output: `failed to run verify script: ${r.error.message}` };
  }
  const output = [r.stdout, r.stderr].filter((s) => s && s.trim()).join('\n').trim();
  const exitCode = typeof r.status === 'number' ? r.status : VERIFY_EXIT.USAGE_ERROR;
  return { exitCode, output };
}

/**
 * `verify <issue> [extra probe args...]` / `verify --all`. Handled separately from
 * the rest of the CLI's `parseArgs` because a probe's own arguments (`--receive
 * <10 KB payload>`, a doubled-backslash string) are not this CLI's flags and must
 * reach the entry's script untouched, not be rejected as "unknown flag".
 */
function runVerifyCommand(args) {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) usage(args.length === 0 ? 1 : 0);

  const callerRoot = repoRoot();
  const store = resolveStoreCheckout({ callerRoot, env: process.env, isStoreCheckout, siblingName: SIBLING_NAME });
  if (store.error) {
    process.stderr.write(`${store.error}\n`);
    return 1;
  }
  const root = store.root;
  const regPath = path.join(root, UPSTREAM_REL);
  if (!existsSync(regPath)) {
    process.stderr.write(`upstream registry not found at ${regPath}\n`);
    return 1;
  }
  const registry = JSON.parse(readFileSync(regPath, 'utf8'));

  const allIdx = args.indexOf('--all');
  if (allIdx !== -1) {
    const rest = [...args.slice(0, allIdx), ...args.slice(allIdx + 1)];
    if (rest.length) {
      process.stderr.write('verify --all takes no issue number and no extra args\n');
      return VERIFY_EXIT.USAGE_ERROR;
    }
    const exitCodes = [];
    for (const entry of registry.entries) {
      const result = runVerifyScript({ root, entry, extraArgs: [] });
      process.stdout.write(`${formatVerifyLine(entry, result.exitCode)}\n`);
      exitCodes.push(result.exitCode);
    }
    return worstVerifyExit(exitCodes);
  }

  const n = Number(args[0]);
  if (!Number.isInteger(n) || n < 1) usage();
  const entry = registry.entries.find((e) => e.issue === n);
  if (!entry) {
    process.stderr.write(`no upstream registry entry for issue ${n} in ${UPSTREAM_REL}\n`);
    return VERIFY_EXIT.USAGE_ERROR;
  }
  if (!entry.verify) {
    process.stderr.write(`registry entry ${upstreamKey(entry)} has no verify block\n`);
    return VERIFY_EXIT.USAGE_ERROR;
  }
  const result = runVerifyScript({ root, entry, extraArgs: args.slice(1) });
  process.stdout.write(`${formatVerifyLine(entry, result.exitCode)}\n`);
  if (result.output) process.stdout.write(`${result.output}\n`);
  return result.exitCode;
}

function main(argv) {
  // Before anything else, including --dry-run and list: a stale CLI answers every
  // command with stale behavior, and the whole defect class is that it does so
  // silently.
  if (process.env[SKIP_STALE_ENV] !== '1') {
    const staleRel = selfStaleFile();
    if (staleRel) {
      process.stderr.write(staleCliMessage({ scriptRoot: SCRIPT_ROOT, rel: staleRel }));
      return 1;
    }
  }

  if (argv[0] === 'verify') return runVerifyCommand(argv.slice(1));

  const { cmd, positionals, flags } = parseArgs(argv);
  if (!cmd || flags.help || flags.h) usage(cmd ? 0 : 1);
  if (!['new', 'recur', 'list', 'unarchived', 'next-number', 'upstream'].includes(cmd)) usage();

  // Every repo on the box files into ONE store: the store repo's beads database.
  // Inside a store checkout nothing changes; elsewhere bd runs as `bd -C <store>` and the
  // archive and upstream registry resolve under that checkout.
  const callerRoot = repoRoot();
  const store = resolveStoreCheckout({ callerRoot, env: process.env, isStoreCheckout, siblingName: SIBLING_NAME });
  if (store.error) {
    process.stderr.write(`${store.error}\n`);
    return 1;
  }
  const root = store.root;
  const bdDir = store.bdDir;
  const archivePath = path.join(root, ARCHIVE_REL);
  const dryRun = flags['dry-run'] === true;

  if (cmd === 'next-number') {
    process.stdout.write(`${nextArchiveNumber(existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : '')}\n`);
    return 0;
  }

  if (cmd === 'list') {
    const r = bd(buildListArgs({ repo: flags.repo, json: flags.json, bdDir }), { capture: false });
    return r.status ?? 0;
  }

  if (cmd === 'unarchived') {
    // Closed by a PR's Fixes: line, never given an archive entry. `list`
    // is bd's default listing, open beads, so these had already left the sweep's
    // input; this is the query that brings them back.
    const r = bd(buildListArgs({ repo: flags.repo, json: true, bdDir, status: 'closed' }));
    if (r.status !== 0) {
      process.stderr.write(`bd list failed: ${(r.stderr || '').trim()}\n`);
      return r.status ?? 1;
    }
    let rows;
    try {
      rows = JSON.parse(r.stdout || '[]');
    } catch {
      process.stderr.write('bd list --json did not return JSON\n');
      return 1;
    }
    const archived = archivedBeadIds(existsSync(archivePath) ? readFileSync(archivePath, 'utf8') : '', { beadPrefix: STORE_PREFIX });
    const entries = unarchivedClosed(rows, archived);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify(entries, null, 2)}\n`);
    } else if (!entries.length) {
      process.stdout.write('nothing closed and unarchived — every closed entry is in the archive\n');
    } else {
      process.stdout.write(
        `${entries.length} closed entr${entries.length === 1 ? 'y' : 'ies'} with no archive block (oldest first). ` +
          'Archive each with the SHORT block in step 0c of the oddity sweep skill:\n' +
          `${formatUnarchivedLines(entries).join('\n')}\n`,
      );
    }
    return 0;
  }

  if (cmd === 'upstream') {
    const regPath = path.join(root, UPSTREAM_REL);
    if (!existsSync(regPath)) {
      process.stderr.write(`upstream registry not found at ${regPath}\n`);
      return 1;
    }
    const registry = JSON.parse(readFileSync(regPath, 'utf8'));
    // --states-file is the test seam: a JSON object of `repo#issue` → gh's --json
    // payload, so the rendering and the --write path run without network or gh.
    const states = flags['states-file']
      ? new Map(Object.entries(JSON.parse(readFileSync(path.resolve(flags['states-file']), 'utf8'))))
      : fetchIssueStates(registry.entries);
    const result = renderUpstream(registry, states);
    if (flags.json) {
      process.stdout.write(`${JSON.stringify({ retire: result.retire.map(upstreamKey), unknown: result.unknown.map(upstreamKey), states: Object.fromEntries(states) }, null, 2)}\n`);
    } else {
      process.stdout.write(`${result.lines.join('\n')}\n`);
    }
    if (flags.write) {
      writeFileSync(regPath, `${JSON.stringify(updateRegistry(registry, states), null, 2)}\n`);
      process.stdout.write(`updated lastChecked/lastKnownState in ${UPSTREAM_REL} for ${states.size} of ${registry.entries.length} entries\n`);
    }
    // A closed upstream issue is an action item; exit 2 so a scripted caller notices.
    return result.retire.length ? 2 : 0;
  }

  let recurrence = null;
  if (cmd === 'recur') {
    const n = Number(positionals.shift());
    if (!Number.isInteger(n) || n < 1) usage();
    if (!existsSync(archivePath)) {
      process.stderr.write(`archive not found at ${archivePath}\n`);
      return 1;
    }
    recurrence = findArchiveEntry(readFileSync(archivePath, 'utf8'), n, { beadPrefix: STORE_PREFIX });
    if (!recurrence) {
      process.stderr.write(`no archive entry numbered ${n} in ${ARCHIVE_REL}\n`);
      return 1;
    }
  }

  const given = positionals.join(' ').trim();
  if (!given) usage();

  // A title that merely BEGINS with `/` is rewritten by MSYS before this process sees a
  // single byte of it, and nothing else in the pipeline will ever notice.
  // Repaired here rather than rejected, the original is unambiguous, but never
  // quietly: the whole defect was a success message over a corrupted title.
  const repair = repairMsysMangledTitle(given);
  const rawTitle = repair.title;
  if (repair.repaired) {
    process.stderr.write(
      [
        '',
        '!! ================================================================== !!',
        '!! MSYS PATH MANGLING DETECTED AND REPAIRED — READ THIS    !!',
        '!! ================================================================== !!',
        `!!   received: ${repair.original}`,
        `!!   filing as: ${rawTitle}`,
        '!! Git Bash rewrote your title because it begins with "/". Quoting does',
        '!! not prevent it and there is no error — an unrepaired title reaches the',
        '!! active log, bd list and the weekly sweep corrupted, forever.',
        '!! Next time: MSYS_NO_PATHCONV=1 node scripts/oddity.mjs new "/…"',
        '!! CHECK THE FILED TITLE BELOW before you move on.',
        '!! ================================================================== !!',
        '',
      ].join('\n') + '\n',
    );
  }

  const title = recurrence ? `RECURRENCE of archived entry ${recurrence.number}: ${rawTitle}` : rawTitle;

  const repo = normalizeRepoName(flags.repo ?? defaultRepoName(callerRoot, store));

  let body;
  if (flags['body-file']) {
    const p = path.resolve(flags['body-file']);
    if (!existsSync(p)) {
      process.stderr.write(`--body-file not found: ${p}\n`);
      return 1;
    }
    body = readFileSync(p, 'utf8');
  } else {
    body = entryTemplate({ title: rawTitle, repo });
  }
  const description = recurrence ? recurrencePreamble(recurrence) + body : body;

  const deps = recurrence && recurrence.beadIds.length ? [`relates-to:${recurrence.beadIds[0]}`] : [];
  // resolveActor keys only on env (BEADS_ACTOR, CLAUDE_CODE_SESSION_ID) and git
  // user.name, none of which is repo-specific, so it gives the same -bot-<8> id from
  // any repo; with no session id it is a bare name and buildCreateArgs leaves the
  // actor to bd's own default.
  const actor = resolveActor();
  const createArgs = buildCreateArgs({ title, description, priority: flags.priority, recurrence: Boolean(recurrence), deps, actor, repo, bdDir });

  // Clobber-safe sync around the one mutation. Pull failure is a warning (offline
  // filing must still work); push failure is loud, because a bead that exists only
  // locally is exactly the "nothing re-surfaces it" failure this tool exists to end.
  const pull = bd([...bdDirArgs(bdDir), 'dolt', 'pull'], { dryRun });
  if (pull.status !== 0) process.stderr.write(`warning: bd dolt pull failed (${(pull.stderr || '').trim()}); creating locally\n`);

  const created = bd(createArgs, { dryRun });
  if (created.status !== 0) {
    process.stderr.write(`bd create failed: ${(created.stderr || '').trim()}\n`);
    return created.status ?? 1;
  }
  // `.pop()` is safe here, and that was checked rather than assumed (does it survive a
  // validation warning?): under `--silent`, bd writes the id and nothing else to stdout,
  // and a `missing required sections` warning goes to stderr where it belongs. Without `--silent`
  // stdout ends with a "💡 Tip:" line, which `.pop()` would happily return instead, so
  // this line and `buildCreateArgs`' `--silent` are a pair. Do not separate them.
  const id = dryRun ? `${BEAD_PREFIX}-dryrun` : (created.stdout || '').trim().split('\n').pop();

  const push = bd([...bdDirArgs(bdDir), 'dolt', 'push'], { dryRun });
  if (push.status !== 0) {
    process.stderr.write(`bd dolt push FAILED after creating ${id}: ${(push.stderr || '').trim()}\nRun: ${bdDir ? `bd -C "${bdDir}" dolt pull && bd -C "${bdDir}" dolt push` : 'bd dolt pull && bd dolt push'}\n`);
    return push.status ?? 1;
  }

  process.stdout.write(
    [
      `${id}`,
      `filed as ${id} (${recurrence ? 'RECURRENCE, P2' : createArgs[createArgs.indexOf('-p') + 1]}, labels ${createArgs[createArgs.indexOf('--labels') + 1]})` +
        (deps.length ? `, ${deps[0]}` : ''),
      flags['body-file']
        ? 'Description taken from --body-file.'
        : `Template placeholders are in the description — fill them in: bd update ${id} --body-file <md>`,
      `It is now in the active log: node ${bdDir ? `"${path.join(root, 'scripts', 'oddity.mjs')}"` : 'scripts/oddity.mjs'} list --repo ${repo}`,
    ].join('\n') + '\n',
  );
  return 0;
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(1);
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
