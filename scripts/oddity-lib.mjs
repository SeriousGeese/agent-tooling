// Pure helpers behind scripts/oddity.mjs, the tooling-friction filing CLI.
// Nothing here touches the process, the filesystem or `bd`; scripts/oddity.node-test.mjs
// tests these directly and drives the CLI only in --dry-run mode (or against a stub bd).
import path from 'node:path';
import { beadIdPattern, tryLoadConfig } from './agent-tooling-config.mjs';
import { DISTINCT_ACTOR_RE } from './hygiene-bd-lib.mjs';

/** The default label every oddity bead carries. agent-tooling.json has no key for it. */
export const ODDITY_LABEL_DEFAULT = 'tooling-oddity';
/** Label every oddity bead carries; `bd list -l <label>` IS the active log. Env AGENT_TOOLING_ODDITY_LABEL overrides it. */
export const LABEL = process.env.AGENT_TOOLING_ODDITY_LABEL || ODDITY_LABEL_DEFAULT;
/** Added on top of LABEL for a recurrence of an archived entry. */
export const RECURRENCE_LABEL = 'recurrence';
/** The archive lives in the repo, at this path (env AGENT_TOOLING_ODDITY_ARCHIVE overrides it). */
export const ARCHIVE_REL = process.env.AGENT_TOOLING_ODDITY_ARCHIVE || 'docs/agents/tooling-oddities-archive.md';

const HEADER_RE = /^## (\d+)\.\s+(.*)$/;
// Bead ids as the repo's beadPrefix spells them (any prefix when it set none).
const BEAD_ID_SOURCE = beadIdPattern(tryLoadConfig().config).source;
const BEAD_ID_RE = new RegExp(BEAD_ID_SOURCE, 'g');

/** Next free archive entry number: entry numbers continue the sequence and are never reused. */
export function nextArchiveNumber(archiveText) {
  let max = 0;
  for (const line of String(archiveText).split('\n')) {
    const m = HEADER_RE.exec(line);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * The archive entry numbered `n`: its title, its body (up to the next `## ` header
 * or a top-level `# ` section), and every bead id mentioned in it, first-seen order.
 */
export function findArchiveEntry(archiveText, n) {
  const lines = String(archiveText).split('\n');
  const start = lines.findIndex((l) => {
    const m = HEADER_RE.exec(l);
    return m && Number(m[1]) === Number(n);
  });
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## \d+\.\s/.test(lines[i]) || /^# /.test(lines[i])) {
      end = i;
      break;
    }
  }
  const body = lines.slice(start + 1, end).join('\n');
  const title = HEADER_RE.exec(lines[start])[2].trim();
  // The entry's OWN bead is the one named as `bead <id>` in its header bullets
  // (`**Repo:** <name> (bead <id>)`); ids deeper in the body are often the sweep
  // bead that archived it or a related fix, so they come after.
  const own = new RegExp(String.raw`\bbeads?\s+(${BEAD_ID_SOURCE})`, 'i').exec(lines.slice(start, Math.min(end, start + 8)).join('\n'));
  const beadIds = [...new Set([...(own ? [own[1]] : []), ...(body.match(BEAD_ID_RE) ?? [])])];
  return { number: Number(n), title, body, beadIds };
}

/** The entry template, as the description of a fresh oddity bead. */
export function entryTemplate({ title, repo = '<repo>', date = today() } = {}) {
  return [
    `# ${title}`,
    '',
    `- **Date:** ${date}`,
    `- **Repo:** ${repo}`,
    '- **Symptom:** <what you saw — the exact error text or the misleading output, and what it made you believe>',
    '- **Root cause:** <established or suspected — say which. Name the layer: harness / MSYS-Windows / repo script / hook / CI / docs>',
    '- **What was patched in the moment:** <the workaround, or "nothing">',
    '- **Suggested systemic fix:** <the class-level fix — a guard, a doc rule, a script change — not the workaround again>',
    '- **Effort guess:** <S / M / L>',
    '',
    'Filed with `node scripts/oddity.mjs`. The weekly sweep (the oddity sweep skill)',
    'verifies it against origin/main, fixes or beads out the systemic fix, and archives it with a Resolution',
    `block in ${ARCHIVE_REL}.`,
  ].join('\n');
}

/** Description prefix for a recurrence, above the template. */
export function recurrencePreamble(entry) {
  const beads = entry.beadIds.length ? ` (${entry.beadIds.join(', ')})` : '';
  return [
    `**RECURRENCE of archived entry ${entry.number}: ${entry.title}**${beads}`,
    '',
    'The archived resolution was supposed to cover this. State what it failed to cover — a recurrence is',
    'higher-priority evidence than a new oddity, which is why this bead is P2 and carries the `recurrence` label.',
    '',
  ].join('\n');
}

/**
 * argv for `bd create`. Priority defaults to P3, P2 for a recurrence. `--silent`
 * so the id is the whole stdout. `actor` is passed as bd's global `--actor` only
 * when it is a per-session id (`DISTINCT_ACTOR_RE`); a shared team name is left to bd's
 * own default rather than written explicitly. `repo` adds the `repo:<name>` origin
 * label; `bdDir` prefixes `-C <dir>` when the beads database is another checkout.
 */
export function buildCreateArgs({ title, description, priority, recurrence = false, deps = [], actor = '', repo = '', bdDir = '' }) {
  const labels = [LABEL, ...(repo ? [repoLabel(repo)] : []), ...(recurrence ? [RECURRENCE_LABEL] : [])].join(',');
  const args = bdDirArgs(bdDir);
  if (actor && DISTINCT_ACTOR_RE.test(actor)) args.push('--actor', actor);
  args.push('create', title, '--type', 'bug', '-p', priority ?? (recurrence ? 'P2' : 'P3'), '--labels', labels);
  if (deps.length) args.push('--deps', deps.join(','));
  args.push('--description', description, '--silent');
  return args;
}

/**
 * argv for `bd list` over the active log, optionally narrowed to one origin repo.
 * `status` widens it past bd's default (open), `closed` is what `unarchived` needs.
 */
export function buildListArgs({ repo = '', json = false, bdDir = '', status = '' } = {}) {
  const args = [...bdDirArgs(bdDir), 'list', '-l', LABEL];
  if (repo) args.push('-l', repoLabel(repo));
  if (status) args.push('--status', status);
  args.push('--flat', '-n', '0');
  if (json) args.push('--json');
  return args;
}

// ── Closed by a PR, never archived ───────────────────────────────
// close-beads closes an oddity bead the moment its fixing PR merges, which is the
// intended path, but only the weekly sweep writes the archive, and the sweep's
// input (`list`) is bd's default listing: OPEN beads. So an entry fixed between two
// sweeps left the sweep's input before the sweep ever saw it, and its Resolution
// block was never written, so the archive silently fell behind. The archive is what the docs cite and what a
// recurrence is checked against, so this is the loop silently losing its output.
// `unarchived` is the query that makes the backlog visible: closed entries whose id
// the archive does not mention.

/** Every bead id the archive text mentions anywhere (headers, bodies, Resolution blocks). */
export function archivedBeadIds(archiveText) {
  return new Set(String(archiveText ?? '').match(BEAD_ID_RE) ?? []);
}

/** The PR number a close-beads close reason names (`Auto-closed: merged via PR #<n> (…)`), or null. */
export function closingPrNumber(row) {
  const m = /\bPR #(\d+)/.exec(String(row?.close_reason ?? row?.closeReason ?? ''));
  return m ? Number(m[1]) : null;
}

/**
 * Closed oddity rows the archive does not mention, oldest closed first. Each row is
 * annotated with `pr` (from its close reason) so the sweep's short archive block can
 * name what fixed it without a second lookup.
 * @param {object[]} rows  `bd list -l tooling-oddity --status closed --json`
 * @param {Set<string>} archivedIds  from archivedBeadIds()
 */
export function unarchivedClosed(rows, archivedIds) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => String(r?.status ?? '').toLowerCase() === 'closed' && !archivedIds.has(String(r.id)))
    .map((r) => ({ ...r, pr: closingPrNumber(r) }))
    .sort((a, b) => String(a.closed_at ?? a.closedAt ?? '').localeCompare(String(b.closed_at ?? b.closedAt ?? '')));
}

/** One line per unarchived entry, the shape the sweep reads. */
export function formatUnarchivedLines(entries) {
  return entries.map((r) => {
    const closed = String(r.closed_at ?? r.closedAt ?? '').slice(0, 10) || '?';
    const repo = (r.labels ?? []).find((l) => String(l).startsWith(REPO_LABEL_PREFIX)) ?? '(no repo label)';
    return `${r.id}  closed ${closed}  ${r.pr ? `PR #${r.pr}` : 'no PR named'}  [${repo}]  ${r.title ?? ''}`;
  });
}

// ── One friction store for every repo on the box ───────────────
// Every entry, from every repo, is a bead in the STORE repo's beads database, under the store's
// one id prefix; the ORIGIN repo is a `repo:<name>` label. Never a second prefix (bd calls a
// multi-prefix database corrupt and BEAD_ID_RE above matches one prefix), never
// `bd repo add` (that hydrates a separate planning DB). A caller in another repo
// reaches the DB with `bd -C <store checkout>`, so the CLI stays in the store.

/** Prefix of the origin-repo label: `repo:app`, `repo:tools`. */
export const REPO_LABEL_PREFIX = 'repo:';

const REPO_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

/** A repo name as it appears in the label: lowercased, trimmed; throws on anything label-unsafe. */
export function normalizeRepoName(name) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!REPO_NAME_RE.test(n)) throw new Error(`--repo "${name}" is not a usable repo name (want letters, digits, . _ -; e.g. app, my-tools)`);
  return n;
}

export function repoLabel(name) {
  return `${REPO_LABEL_PREFIX}${normalizeRepoName(name)}`;
}

/**
 * The repo name from a `git remote get-url origin` value: its basename, `.git`
 * stripped, lowercased. Handles https, scp-style ssh and local paths. '' when
 * nothing usable is left.
 */
export function repoNameFromRemoteUrl(url) {
  const trimmed = String(url ?? '').trim().replace(/[\\/]+$/, '');
  const base = trimmed.split(/[\\/:]/).pop() ?? '';
  const name = base.replace(/\.git$/i, '').toLowerCase();
  return REPO_NAME_RE.test(name) ? name : '';
}

/** `['-C', dir]` when bd must run against another checkout, `[]` otherwise. */
export function bdDirArgs(bdDir) {
  return bdDir ? ['-C', bdDir] : [];
}

/** Git Bash can hand a POSIX drive path (`/c/git/store`) through the environment; bd and Node want `C:/git/store`. */
export function normalizeDrivePath(p, platform = process.platform) {
  const s = String(p ?? '').trim();
  if (platform !== 'win32') return s;
  const m = /^\/([a-zA-Z])(\/.*)?$/.exec(s);
  return m ? `${m[1].toUpperCase()}:${m[2] ?? '/'}` : s;
}

export const CHECKOUT_ENV = 'AGENT_TOOLING_CHECKOUT';

/**
 * Where the friction store lives for this invocation.
 *
 *   local  , the caller's repo root IS a store checkout or worktree: behave exactly as
 *             before this change (no `-C`; archive and registry under that root).
 *   env    , $AGENT_TOOLING_CHECKOUT names a store checkout; every bd call runs `bd -C` there.
 *   sibling, no $AGENT_TOOLING_CHECKOUT, but `<caller root>/../<siblingName>` is one (siblingName is the repo's beadPrefix).
 *
 * A set-but-wrong $AGENT_TOOLING_CHECKOUT is an error even when a sibling would resolve: an
 * explicit setting that silently loses to a guess is how an entry lands in the wrong
 * database. Returns `{ root, bdDir, mode }` or `{ error }`; `isStoreCheckout` is
 * injected so this stays pure. A null `siblingName` turns sibling discovery off.
 */
export function resolveStoreCheckout({ callerRoot, env = {}, isStoreCheckout, siblingName = null, platform = process.platform }) {
  if (isStoreCheckout(callerRoot)) return { root: callerRoot, bdDir: '', mode: 'local' };
  const explicit = normalizeDrivePath(env[CHECKOUT_ENV], platform);
  if (explicit) {
    if (isStoreCheckout(explicit)) return { root: explicit, bdDir: explicit, mode: 'env' };
    return { error: storeCheckoutError({ callerRoot, explicit }) };
  }
  const sibling = siblingName ? path.join(path.dirname(callerRoot), siblingName) : '';
  if (sibling && path.resolve(sibling) !== path.resolve(callerRoot) && isStoreCheckout(sibling)) return { root: sibling, bdDir: sibling, mode: 'sibling' };
  return { error: storeCheckoutError({ callerRoot, sibling }) };
}

function storeCheckoutError({ callerRoot, explicit, sibling }) {
  return [
    explicit
      ? `${CHECKOUT_ENV}=${explicit} is not a store checkout (no .beads/ and ${ARCHIVE_REL} there).`
      : `cannot find the store checkout that holds the friction log: ${callerRoot} is not one, ${CHECKOUT_ENV} is unset, and there is ${sibling ? `no sibling ${sibling}` : 'no sibling name to look for (agent-tooling.json sets no beadPrefix)'}.`,
    'Every repo on this machine files friction into one beads database. Point this machine at a checkout that holds it:',
    `  export ${CHECKOUT_ENV}=<path to the store checkout>        # Git Bash; PowerShell: $env:${CHECKOUT_ENV} = '<path to the store checkout>'`,
  ].join('\n');
}

// ── Self-staleness ────────────────────────────────────────────────
//
// The cross-repo recipe resolves the CLI in a sibling store checkout, usually the PRIMARY
// checkout, which nothing keeps current (one sat many commits behind with an oddity.mjs
// that predated `--repo`: `list` exited 1 with no output and `new` silently dropped
// the repo: label). Any worktree behind main has the same problem. A stale CLI cannot
// know it is stale unless taught, so the CLI classifies its OWN files against the
// local `origin/main` ref and REFUSES loudly when it is an older committed version.
// The ref is shared repo-wide (linked worktrees share the primary's .git), and every
// session's worktree-new/refresh fetches it, so on this fleet it tracks GitHub closely
// without the CLI paying a network round-trip per invocation.

/** The files whose behavior IS the CLI. A change to any of them is a behavior change. */
export const SELF_CHECK_FILES = ['scripts/oddity.mjs', 'scripts/oddity-lib.mjs', 'scripts/hygiene-bd-lib.mjs'];

export const SKIP_STALE_ENV = 'AGENT_TOOLING_ODDITY_SKIP_STALE_CHECK';

/**
 * Verdict for one running CLI file:
 *   current , disk blob equals origin/main's: identical content, identical behavior.
 *   stale   , disk blob equals an OLDER committed version on origin/main's history:
 *              refuse, this is the silently-misbehaving case.
 *   modified, matches neither: an in-development or locally edited copy. Allowed -
 *              refusing here would block working on the CLI itself.
 *   unknown , git could not answer (no repo, no origin/main ref): fail OPEN, a
 *              copy outside a checkout must still work.
 */
export function classifySelfVersion({ diskHash, tipHash, historicalHashes = [] }) {
  if (!diskHash || !tipHash) return 'unknown';
  if (diskHash === tipHash) return 'current';
  if (historicalHashes.includes(diskHash)) return 'stale';
  return 'modified';
}

/** The refusal text: what happened, the remedy, and the escape hatch, never silent. */
export function staleCliMessage({ scriptRoot, rel }) {
  return [
    `!! STALE oddity CLI: ${path.join(scriptRoot, rel)} is an OLDER committed version than origin/main.`,
    '!! Nothing keeps a sibling/primary checkout (or an old worktree) current, and a stale CLI misbehaves',
    '!! silently — an older one exited 1 with no output on `list` and dropped the repo: label on `new`.',
    'Run the CLI from a checkout that is on current origin/main instead:',
    `  ${CHECKOUT_ENV}=<current store worktree> node "<current store worktree>/scripts/oddity.mjs" ...`,
    `or bring this checkout forward first (only if you own it): git -C "${scriptRoot}" pull origin main`,
    `Escape hatch (this run only): ${SKIP_STALE_ENV}=1`,
  ].join('\n') + '\n';
}

const VALUED_FLAGS = new Set(['repo', 'priority', 'body-file', 'states-file']);
const BOOLEAN_FLAGS = new Set(['dry-run', 'json', 'help', 'write']);

/**
 * Minimal argv parser: `cmd positionals… --flag value --bool`. Unknown flags and
 * short flags throw rather than being swallowed into the title, `new -p P2 "t"`
 * must not file a P3 bead titled `-p P2 t`.
 */
export function parseArgs(argv) {
  const out = { cmd: argv[0] ?? '', positionals: [], flags: {} };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h') {
      out.flags.help = true;
    } else if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      if (BOOLEAN_FLAGS.has(name)) {
        out.flags[name] = true;
      } else if (VALUED_FLAGS.has(name)) {
        const value = eq === -1 ? argv[++i] : a.slice(eq + 1);
        if (value === undefined) throw new Error(`--${name} needs a value`);
        out.flags[name] = value;
      } else {
        throw new Error(`unknown flag ${a} (known: ${[...VALUED_FLAGS, ...BOOLEAN_FLAGS].map((f) => `--${f}`).join(', ')})`);
      }
    } else if (a.startsWith('-') && a.length > 1) {
      throw new Error(`unknown flag ${a} — this CLI takes long flags only (--priority P2, not -p P2)`);
    } else {
      out.positionals.push(a);
    }
  }
  return out;
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── MSYS-mangled titles ──────────────────────────────────────────
// A quoted argument that merely BEGINS with `/` is rewritten by MSYS argv path
// conversion, and quoting does not protect it:
//
//   node scripts/oddity.mjs new "/beadsBulk has no peer ping before the gate, …"
//   → filed as        "C:/Program Files/Git/beadsBulk has no peer ping before the gate, …"
//
// No error, no warning; the CLI reports success and the corrupted title is what the
// active log, `bd list` and the weekly sweep show from then on. Every earlier
// instance of this class was a path-shaped argument, where an agent is at
// least thinking about paths, here it is prose, so nothing cues the check, and the
// damage lands in shared durable state. A repo with slash commands steers straight into
// it: a bead ABOUT one (`/bead`, `/asks`) naturally opens with its name. Reproduced independently with
// `bd create "/conditions/ renders SRD prose publicly…"`.

/**
 * The mangle's fingerprint: an absolute Windows path whose last directory component is
 * the Git installation root (`C:/Program Files/Git`, `C:/Program Files (x86)/Git`,
 * `D:/Tools/Git`), immediately followed by more text. MSYS substitutes exactly that root
 * for the leading `/`, so the original is recoverable by putting the slash back.
 */
const MSYS_MANGLED_TITLE_RE = /^[A-Za-z]:[\\/](?:[^\\/]+[\\/])*Git[\\/](?=\S)/;

/**
 * Undo the mangle when a title carries its fingerprint.
 *
 * Returns `{ title, repaired, original }`. Repair rather than rejection, because the
 * original is unambiguous, a leading `/` is the only thing that produces this, and a
 * rejection makes the filer retype prose they already wrote. The caller MUST still say
 * so loudly: a silent repair is the same failure mode as the silent corruption, one
 * layer along. A title that legitimately begins with the Git install root does not
 * exist; that is why this can be a one-line check at the only moment anyone is looking.
 */
export function repairMsysMangledTitle(rawTitle) {
  const title = String(rawTitle ?? '');
  const m = MSYS_MANGLED_TITLE_RE.exec(title);
  if (!m) return { title, repaired: false, original: title };
  return { title: `/${title.slice(m[0].length)}`, repaired: true, original: title };
}

// ── Upstream registry ────────────────────────────────────────────────────────
// Workarounds that exist only because of an upstream (Claude Code) defect, keyed
// to the issue that would make them unnecessary. The sweep checks the issue state
// each week and retires the workaround once it closes AND the verify recipe
// passes, an unretired workaround is a guard that blocks legitimate commands
// for a bug that no longer exists.

export const UPSTREAM_REL = process.env.AGENT_TOOLING_ODDITY_UPSTREAM || 'docs/agents/tooling-oddities-upstream.json';

export const upstreamKey = (e) => `${e.repo}#${e.issue}`;

/**
 * The environment `upstream` hands to gh. GITHUB_TOKEN is dropped: on the Windows dev
 * box an invalid (even empty) one overrides gh's own stored credential and breaks
 * every call (a known Windows gh pitfall). GH_TOKEN is KEPT, and that is
 * load-bearing for the every-3-days cron: a GitHub Actions runner has no
 * stored gh login, so the workflow passes its token as GH_TOKEN, which gh reads first.
 * Deleting both would leave the runner unauthenticated and every state UNKNOWN.
 */
export function ghChildEnv(env) {
  const out = { ...env };
  delete out.GITHUB_TOKEN;
  return out;
}

// ── `oddity.mjs verify`, a runnable verdict instead of prose ──
// `verifyBeforeRetiring` above is English a human reads and acts on; the four
// current entries all test HARNESS behaviour (the Bash tool's `\\` collapse, its
// >8 KB command truncation, `preview_start` cwd resolution, harness-worktree
// CRLF) that is observable only from inside a live Claude Code desktop session -
// never from a GitHub runner, never reliably from a cloud session. So a cron
// cannot answer "retirable yes/no" on its own; what it CAN do is turn "read this
// paragraph and judge" into a command with an exit code, so a sweep runs
// `node scripts/oddity.mjs verify <issue>` and reads a verdict line instead.
// Each registry entry's own `verify.script` is what actually runs; the code below
// is command-agnostic plumbing shared by every verdict.

/**
 * Exit codes a verify script (scripts/oddity-verify/<issue>.mjs) and the
 * `oddity.mjs verify` CLI both use. 0 is the only "safe to retire" answer;
 * everything else means the workaround stays. NEEDS_MANUAL is not a failure -
 * some of these recipes genuinely cannot be judged by one process alone (a
 * fan-out subagent check, a cross-session durable record that does not exist
 * yet), it just means a human or a further agent step must supply the missing
 * fact before a verdict is possible.
 *
 * Note: Node's own default exit code for an uncaught exception is 1, the same
 * number this scheme gives STILL_REPRODUCES, so a verify script that crashes is
 * not always distinguishable from one that deliberately reported the bug as
 * still present. That is an accepted tradeoff, not a bug: what a caller (and the
 * sweep) must never do is treat ANY exit code but 0 as safe to retire, and a
 * crash can never produce 0 by accident.
 */
export const VERIFY_EXIT = Object.freeze({
  RETIRABLE: 0,
  STILL_REPRODUCES: 1,
  USAGE_ERROR: 2,
  NEEDS_MANUAL: 3,
});

const VERDICT_NAME = Object.freeze({
  [VERIFY_EXIT.RETIRABLE]: 'RETIRABLE',
  [VERIFY_EXIT.STILL_REPRODUCES]: 'STILL-REPRODUCES',
  [VERIFY_EXIT.NEEDS_MANUAL]: 'NEEDS-MANUAL',
});

const VERDICT_SYMBOL = Object.freeze({
  [VERIFY_EXIT.RETIRABLE]: '✓',
  [VERIFY_EXIT.STILL_REPRODUCES]: '✗',
  [VERIFY_EXIT.NEEDS_MANUAL]: '○',
});

/** Any exit code the runner did not expect (a crash, a wrong invocation, an unknown script) reads as an error, never as quietly retirable. */
export function verdictNameForExit(exitCode) {
  return VERDICT_NAME[exitCode] ?? 'ERROR (script did not produce a known verdict)';
}

export function verdictSymbolForExit(exitCode) {
  return VERDICT_SYMBOL[exitCode] ?? '!';
}

/** The one-line verdict `oddity.mjs verify` prints per entry, no prose to interpret. */
export function formatVerifyLine(entry, exitCode) {
  return `${verdictSymbolForExit(exitCode)} ${verdictNameForExit(exitCode)}  ${upstreamKey(entry)} — ${entry.title}`;
}

// Worseness ranking for combining verdicts under `--all`: a single STILL-REPRODUCES
// means the overall answer is "no, do not retire anything", which must outrank a
// pile of NEEDS-MANUALs; a script that errored is worse than one that merely
// could not reach an automatic verdict, because an error means the check itself
// is broken, not just inconclusive.
const VERDICT_RANK = Object.freeze({
  [VERIFY_EXIT.STILL_REPRODUCES]: 3,
  [VERIFY_EXIT.NEEDS_MANUAL]: 1,
  [VERIFY_EXIT.RETIRABLE]: 0,
});
const ERROR_RANK = 2;

/** The exit code `verify --all` reports: the worst of every entry's own exit code. Empty input is itself a usage error. */
export function worstVerifyExit(exitCodes) {
  if (!exitCodes.length) return VERIFY_EXIT.USAGE_ERROR;
  const rankOf = (c) => VERDICT_RANK[c] ?? ERROR_RANK;
  return exitCodes.reduce((worst, c) => (rankOf(c) > rankOf(worst) ? c : worst));
}

/**
 * @param {{entries: object[]}} registry
 * @param {Map<string, {state: string, stateReason?: string, closedAt?: string, updatedAt?: string}>} states
 * @returns {{ lines: string[], retire: object[], unknown: object[] }}
 */
export function renderUpstream(registry, states) {
  const lines = [];
  const retire = [];
  const unknown = [];
  for (const e of registry.entries) {
    const key = upstreamKey(e);
    const s = states.get(key);
    const wk = [...(e.workaround?.hooks ?? []), ...(e.workaround?.settings ?? []), ...(e.workaround?.docs ?? [])];
    if (!s) {
      unknown.push(e);
      lines.push(`? UNKNOWN ${key} — state could not be read; last known ${e.lastKnownState ?? '?'} on ${e.lastChecked ?? '?'}. ${e.title}`);
      continue;
    }
    if (s.state === 'CLOSED') {
      retire.push(e);
      lines.push(
        `✓ CLOSED  ${key} (${s.stateReason ?? 'closed'}${s.closedAt ? ` ${s.closedAt.slice(0, 10)}` : ''}) — ${e.title}`,
        `    RETIRE the workaround after verifying on the current Claude Code version:`,
        `      ${e.verifyBeforeRetiring}`,
        `    workaround: ${wk.join('; ') || '(none listed)'}`,
        ...(e.verify ? [`    verify: node scripts/oddity.mjs verify ${e.issue} (desktop session)`] : []),
      );
    } else {
      lines.push(`○ OPEN    ${key}${s.updatedAt ? ` (updated ${s.updatedAt.slice(0, 10)})` : ''} — ${e.title}; workaround stays`);
    }
  }
  lines.push(
    retire.length
      ? `${retire.length} workaround(s) to retire: ${retire.map(upstreamKey).join(', ')}`
      : 'nothing to retire this week',
  );
  return { lines, retire, unknown };
}

/** The registry with lastChecked / lastKnownState refreshed for every entry whose state was read. */
export function updateRegistry(registry, states, day = today()) {
  return {
    ...registry,
    entries: registry.entries.map((e) => {
      const s = states.get(upstreamKey(e));
      return s ? { ...e, lastChecked: day, lastKnownState: s.state } : e;
    }),
  };
}
