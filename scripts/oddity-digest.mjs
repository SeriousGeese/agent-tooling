#!/usr/bin/env node
// Body renderer for the scheduled upstream-check workflow: the
// every-3-days upstream-workaround check plus the open tooling-oddity digest, refreshed
// into ONE tracking issue. The workflow stays thin (gather JSON, call this, post it);
// everything that decides what the issue SAYS lives here, where node:test can reach it.
//
//   node scripts/oddity-digest.mjs --registry docs/agents/oddity-upstream.json \
//     [--upstream-json <file>]              output of `node scripts/oddity.mjs upstream --json`
//     [--oddities-json <file>]              output of `bd list -l tooling-oddity --flat -n 0 --json`
//     [--closed-json <file>]                the same listing with `--status closed`; with --archive,
//     [--archive <file>]                    counts closed entries the archive does not mention
//     [--oddities-unavailable "<reason>"]   say WHY there is no digest instead of faking one
//     [--oddities-note "<text>"]            a caveat printed under the count (e.g. the pull failed)
//     [--inbox-dir docs/agents/oddity-inbox] entries a cloud session parked for the desktop sweep
//     [--known-repos a,b,c]                 repos always listed, even at zero (env AGENT_TOOLING_ODDITY_REPOS)
//     [--run-url <url>] [--today YYYY-MM-DD]
//
// It REPORTS; it never retires anything. A closed upstream issue is a RETIRE line that
// names the desktop-session command, because every verify recipe in the registry tests
// harness behaviour a GitHub runner cannot observe (scripts/oddity-lib.mjs, VERIFY_EXIT).
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { REPO_LABEL_PREFIX, archivedBeadIds, today as todayIso, unarchivedClosed, upstreamKey } from './oddity-lib.mjs';

/** Title of the one tracking issue; the workflow looks it up by this exact string. */
export const TRACKING_ISSUE_TITLE = 'Tooling oddities: upstream workarounds and open entries';

/** A comma-separated list as an array of trimmed, non-empty names. */
export const parseRepoList = (text) => String(text ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

/**
 * Repos the digest always lists, even at zero, so "no entries" is visibly a count and not an
 * omission. The consumer's repo names come from env AGENT_TOOLING_ODDITY_REPOS or --known-repos;
 * none by default, so only repos that have an entry are listed.
 */
export const KNOWN_REPOS = parseRepoList(process.env.AGENT_TOOLING_ODDITY_REPOS);

/** The weekly sweep stamps lastChecked; past this many days it has probably lapsed. */
export const SWEEP_LAPSE_DAYS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from an ISO date (YYYY-MM-DD…) to `today`; null when either is unreadable. */
export function daysSince(date, today) {
  const a = Date.parse(String(date ?? '').slice(0, 10));
  const b = Date.parse(String(today ?? '').slice(0, 10));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / DAY_MS);
}

/**
 * The staleness line: days since the registry was last stamped by `upstream --write`.
 * lastChecked only moves when a sweep runs that AND commits it, so this is really
 * "days since the last sweep checked upstream" — the cron does not stamp it (it has no
 * business committing to main), which is exactly why the number is worth printing.
 */
export function stalenessLine(registry, today) {
  const dates = (registry?.entries ?? []).map((e) => e.lastChecked).filter(Boolean).sort();
  if (!dates.length) return '**Registry staleness:** no entry carries a `lastChecked` date.';
  const newest = dates[dates.length - 1];
  const oldest = dates[0];
  const days = daysSince(newest, today);
  const spread = oldest === newest ? '' : ` (oldest entry: ${oldest}, ${daysSince(oldest, today)} days)`;
  const lapsed =
    days !== null && days > SWEEP_LAPSE_DAYS
      ? ` **The weekly sweep appears to have lapsed** — more than ${SWEEP_LAPSE_DAYS} days since \`upstream --write\` was committed.`
      : '';
  return `**Registry staleness:** ${days ?? '?'} day(s) since the registry's lastChecked (${newest})${spread}.${lapsed}`;
}

/** Upstream section lines + counts. `upstream` is the parsed `upstream --json` payload, or null when the check did not run. */
export function renderUpstreamSection(registry, upstream) {
  const lines = ['## Upstream workarounds', ''];
  const entries = registry?.entries ?? [];
  if (!upstream) {
    lines.push(
      '_The upstream check did not run or its output was unreadable — no issue state below is current. See the run log._',
      '',
    );
    for (const e of entries) lines.push(`- ? \`${upstreamKey(e)}\` — ${e.title} (last known ${e.lastKnownState ?? '?'} on ${e.lastChecked ?? '?'})`);
    return { lines, retire: 0, unknown: entries.length, open: 0 };
  }
  const states = upstream.states ?? {};
  let retire = 0;
  let unknown = 0;
  let open = 0;
  for (const e of entries) {
    const key = upstreamKey(e);
    const s = states[key];
    if (!s || typeof s.state !== 'string') {
      unknown++;
      lines.push(`- ? **UNKNOWN** \`${key}\` — ${e.title}. gh could not read it; last known ${e.lastKnownState ?? '?'} on ${e.lastChecked ?? '?'}. Never treated as open or closed.`);
    } else if (s.state === 'CLOSED') {
      retire++;
      const when = s.closedAt ? ` ${String(s.closedAt).slice(0, 10)}` : '';
      lines.push(
        `- **RETIRE** \`${key}\` — ${e.title}. Closed upstream (${s.stateReason ?? 'closed'}${when}) — run \`node scripts/oddity.mjs verify ${e.issue}\` in a desktop session.`,
      );
    } else {
      open++;
      lines.push(`- open \`${key}\` — ${e.title}; workaround stays.`);
    }
  }
  lines.push(
    '',
    retire
      ? `${retire} workaround(s) closed upstream. This cron does NOT retire them: \`verify\` needs a live Claude Code desktop session, and the weekly sweep (\`/oddities-sweep\`) removes the workaround only on a RETIRABLE verdict.`
      : 'Nothing closed upstream.',
  );
  return { lines, retire, unknown, open };
}

/** Open (non-closed) oddity rows grouped by `repo:<name>` label; unlabelled rows under `(no repo label)`. */
export const NO_REPO_LABEL = '(no repo label)';

export function groupByRepo(rows, knownRepos = KNOWN_REPOS) {
  const groups = new Map(knownRepos.map((r) => [r, []]));
  for (const row of Array.isArray(rows) ? rows : []) {
    if (String(row?.status ?? '').toLowerCase() === 'closed') continue;
    const repos = (row.labels ?? []).filter((l) => String(l).startsWith(REPO_LABEL_PREFIX)).map((l) => String(l).slice(REPO_LABEL_PREFIX.length));
    const keys = repos.length ? repos : [NO_REPO_LABEL];
    for (const k of keys) {
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
  }
  return groups;
}

export function renderDigestSection({ oddities, unavailable, note = '', today, knownRepos = KNOWN_REPOS }) {
  const lines = ['## Open tooling-oddity entries', ''];
  if (!Array.isArray(oddities)) {
    lines.push(`_Digest skipped: ${unavailable || 'no bead listing was produced'}. Not reconstructed from older data — run \`node scripts/oddity.mjs list\` in a desktop session._`);
    return { lines, total: null };
  }
  const groups = groupByRepo(oddities, knownRepos);
  const total = new Set([...groups.values()].flat().map((r) => r.id)).size;
  lines.push(`${total} open entr${total === 1 ? 'y' : 'ies'}. Recurrences first within each repo.`, '');
  if (note) lines.push(`_${note}_`, '');
  for (const [repo, rows] of groups) {
    lines.push(`### ${repo === NO_REPO_LABEL ? repo : `repo:${repo}`} — ${rows.length}`);
    if (!rows.length) {
      lines.push('', '_none_', '');
      continue;
    }
    lines.push('');
    const sorted = [...rows].sort((a, b) => {
      const ra = (a.labels ?? []).includes('recurrence') ? 0 : 1;
      const rb = (b.labels ?? []).includes('recurrence') ? 0 : 1;
      return ra - rb || (a.priority ?? 9) - (b.priority ?? 9) || String(a.created_at ?? '').localeCompare(String(b.created_at ?? ''));
    });
    for (const r of sorted) {
      const age = daysSince(r.created_at, today);
      const tags = [
        `P${r.priority ?? '?'}`,
        r.status ?? '?',
        ...((r.labels ?? []).includes('recurrence') ? ['RECURRENCE'] : []),
        ...(age !== null ? [`${age}d old`] : []),
      ].join(', ');
      lines.push(`- \`${r.id}\` ${r.title} (${tags})`);
    }
    lines.push('');
  }
  return { lines, total };
}

/** Files a cloud session parked for the desktop sweep (the oddity docs, "Filing from a cloud session"). */
export function listInbox(dir) {
  if (!dir || !existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.toLowerCase() !== 'readme.md')
    .sort();
}

export function renderInboxSection(files, inboxRel) {
  if (!files.length) return [];
  return [
    '## Parked by cloud sessions, not yet filed',
    '',
    `${files.length} entr${files.length === 1 ? 'y' : 'ies'} in \`${inboxRel}\` waiting for a desktop session to file with \`node scripts/oddity.mjs new --body-file\`:`,
    '',
    ...files.map((f) => `- \`${f}\``),
    '',
  ];
}

/**
 * Closed entries the archive does not mention. close-beads closes an entry
 * the moment its PR merges; only the sweep archives it, and the sweep's `list` input
 * is open beads — so between sweeps this backlog is invisible everywhere but here.
 * `closed` null = the listing was not produced; `archiveText` null = no archive given.
 */
export function renderUnarchivedSection({ closed, archiveText, today }) {
  if (!Array.isArray(closed) || archiveText === null || archiveText === undefined) return { lines: [], count: null };
  const entries = unarchivedClosed(closed, archivedBeadIds(archiveText));
  const lines = ['## Closed by a PR, not yet archived', ''];
  if (!entries.length) {
    lines.push('_none — every closed entry has an archive block._', '');
    return { lines, count: 0 };
  }
  const oldest = String(entries[0].closed_at ?? entries[0].closedAt ?? '').slice(0, 10);
  const age = daysSince(oldest, today);
  lines.push(
    `${entries.length} closed entr${entries.length === 1 ? 'y' : 'ies'} with no Resolution block in the archive (oldest closed ${oldest || '?'}${age !== null ? `, ${age}d ago` : ''}). ` +
      'The sweep archives these with the short block in its step 0c — `node scripts/oddity.mjs unarchived` lists them.',
    '',
  );
  for (const r of entries.slice(0, 15)) lines.push(`- \`${r.id}\` ${r.title ?? ''}${r.pr ? ` (PR #${r.pr})` : ''}`);
  if (entries.length > 15) lines.push(`- … and ${entries.length - 15} more`);
  lines.push('');
  return { lines, count: entries.length };
}

export function renderDigest({ registry, upstream, oddities, closed = null, archiveText = null, unavailable, note = '', inboxFiles = [], inboxRel = 'docs/agents/oddity-inbox', runUrl = '', today = todayIso(), knownRepos = KNOWN_REPOS }) {
  const up = renderUpstreamSection(registry, upstream);
  const dg = renderDigestSection({ oddities, unavailable, note, today, knownRepos });
  const un = renderUnarchivedSection({ closed, archiveText, today });
  const summary = [
    `retire ${up.retire}`,
    `unknown ${up.unknown}`,
    `open upstream ${up.open}`,
    `open entries ${dg.total ?? 'n/a (digest skipped)'}`,
    ...(un.count !== null ? [`unarchived ${un.count}`] : []),
    ...(inboxFiles.length ? [`parked ${inboxFiles.length}`] : []),
  ].join(' · ');
  const body = [
    `Tooling friction check for **${today}** — ${summary}`,
    ...(runUrl ? ['', runUrl] : []),
    '',
    stalenessLine(registry, today),
    '',
    ...up.lines,
    '',
    ...dg.lines,
    ...un.lines,
    ...renderInboxSection(inboxFiles, inboxRel),
    // The blank line is load-bearing: text directly above `---` renders as a setext heading.
    '',
    '---',
    'Posted every 3 days by a scheduled workflow. It reports only; the weekly sweep acts. See the repo\'s oddity docs.',
  ];
  return { body: `${body.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`, counts: { retire: up.retire, unknown: up.unknown, open: up.open, total: dg.total, unarchived: un.count, parked: inboxFiles.length } };
}

function parseCli(argv) {
  const valued = new Set(['registry', 'upstream-json', 'oddities-json', 'closed-json', 'archive', 'oddities-unavailable', 'oddities-note', 'inbox-dir', 'known-repos', 'run-url', 'today']);
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const name = a.startsWith('--') ? a.slice(2) : '';
    if (!valued.has(name)) throw new Error(`unknown argument ${a} (known: ${[...valued].map((f) => `--${f}`).join(', ')})`);
    const v = argv[++i];
    if (v === undefined) throw new Error(`--${name} needs a value`);
    flags[name] = v;
  }
  return flags;
}

/** Read a JSON file, or null when it is missing, empty or unparseable — the renderer says so instead of crashing the report. */
function readJsonOrNull(p) {
  if (!p || !existsSync(p)) return null;
  try {
    const text = readFileSync(p, 'utf8').trim();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function main(argv) {
  const flags = parseCli(argv);
  if (!flags.registry) throw new Error('--registry <path to the upstream registry json> is required');
  const registry = JSON.parse(readFileSync(flags.registry, 'utf8'));
  const upstream = readJsonOrNull(flags['upstream-json']);
  let oddities = null;
  let unavailable = flags['oddities-unavailable'] ?? '';
  if (flags['oddities-json']) {
    oddities = readJsonOrNull(flags['oddities-json']);
    if (!Array.isArray(oddities)) {
      oddities = null;
      unavailable ||= `the bead listing at ${flags['oddities-json']} was missing or not a JSON array`;
    }
  }
  // The closed listing and the archive travel together: without both, the unarchived
  // section is omitted rather than rendered as a misleading zero.
  const closed = flags['closed-json'] ? readJsonOrNull(flags['closed-json']) : null;
  const archiveText = flags.archive && existsSync(flags.archive) ? readFileSync(flags.archive, 'utf8') : null;
  const inboxDir = flags['inbox-dir'];
  const { body } = renderDigest({
    registry,
    upstream,
    oddities,
    closed: Array.isArray(closed) ? closed : null,
    archiveText,
    unavailable,
    note: flags['oddities-note'] ?? '',
    inboxFiles: listInbox(inboxDir),
    knownRepos: flags['known-repos'] === undefined ? KNOWN_REPOS : parseRepoList(flags['known-repos']),
    inboxRel: inboxDir ? inboxDir.replace(/\\/g, '/') : undefined,
    runUrl: flags['run-url'] ?? '',
    today: flags.today ?? todayIso(),
  });
  process.stdout.write(body);
  return 0;
}

if (isEntryPoint()) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err?.message ?? err}\n`);
    process.exit(2);
  }
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
