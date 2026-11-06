#!/usr/bin/env node
// Bead chains: find blocker chains that can land together.
//
//   node scripts/bead-chains.mjs [--json] [--all] [--limit N] [--exclude-label a b] [--actor id] [--repo-label repo:x]
//
// A chain is a root bead with no open blocker whose completion unblocks one or more beads,
// which unblock others. With the merge queue, a whole chain usually fits in ONE PR: nothing
// about a `blocks` edge needs a merge in between. What does need one is a BREAK, a bead that
// cannot ride along with the ones before it:
//
//   human     labelled human-required: a person has to do it
//   ask:<who> carries an ask-* label: parked on a named human's decision
//   deferred  status deferred: needs an explicit reason to undefer
//   claimed   held by an actor other than --actor
//   other-repo the work lives in another repository: a `repo:*` label other than this
//              repository's (--repo-label, or AGENT_TOOLING_REPO_LABEL; with neither set the
//              label is not consulted), or "separate repo" in the title
//   waits:<id> blocked by an open bead outside this chain
//
// The chain's "one PR" set is every bead reachable from the root without crossing a break,
// whose open blockers are all in that set. Everything else in the chain is listed with the
// reason it is not in the first PR. Time gaps the tracker cannot see (a prod deploy between
// steps, an expand/contract migration, a watch window) are the caller's judgement: the
// bead-chains skill says how to check for them.
//
// Read-only. Edges come from `bd list --format dot`, the one bd output that carries the
// dependency TYPE, so parent-child and related links are never mistaken for blockers.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { bd, bdJson } from './lib/bd-cli.mjs';
import { parseFlags } from './lib/parse-flags.mjs';

const NON_CLOSED = 'open,in_progress,blocked,deferred';

/** `"A" -> "B" [label="blocks", ...]` means A depends on B. */
export function parseDotEdges(dot) {
  const edges = [];
  const re = /"([^"]+)"\s*->\s*"([^"]+)"\s*\[label="([^"]+)"/g;
  for (const m of String(dot ?? '').matchAll(re)) edges.push({ from: m[1], to: m[2], type: m[3] });
  return edges;
}

/** Why `bead` cannot ride in the same PR as the beads before it, or null. */
export function breakReason(bead, { actor = '', repoLabel = '' } = {}) {
  const labels = bead.labels ?? [];
  if (labels.includes('human-required')) return 'human';
  const ask = labels.find((l) => l.startsWith('ask-'));
  if (ask) return `ask:${ask.slice(4)}`;
  if (bead.status === 'deferred') return 'deferred';
  if (bead.assignee && bead.assignee !== actor) return `claimed:${bead.assignee}`;
  const repo = labels.find((l) => l.startsWith('repo:'));
  if ((repoLabel && repo && repo !== repoLabel) || /\bseparate repo\b/i.test(bead.title ?? '')) return 'other-repo';
  return null;
}

/**
 * Build every chain from non-closed beads and their typed edges.
 * Returns chains sorted best first: most beads in one PR, then depth, then priority.
 */
export function buildChains(beads, edges, { actor = '', excludeLabels = [], repoLabel = '' } = {}) {
  const byId = new Map(beads.map((b) => [b.id, b]));
  const blocks = new Map(); // blocker -> beads it blocks
  const blockers = new Map(); // bead -> its open blockers
  const parent = new Map();
  for (const { from, to, type } of edges) {
    if (!byId.has(from) || !byId.has(to)) continue; // a closed end is not a live edge
    if (type === 'parent-child') {
      parent.set(from, to);
      continue;
    }
    if (type !== 'blocks') continue;
    // An epic is a container, not a step: an edge to or from one is grouping, not order.
    if (byId.get(from).issue_type === 'epic' || byId.get(to).issue_type === 'epic') continue;
    push(blocks, to, from);
    push(blockers, from, to);
  }

  const excluded = (id) => (byId.get(id).labels ?? []).some((l) => excludeLabels.includes(l));
  const roots = [...blocks.keys()].filter((id) => !(blockers.get(id) ?? []).length && !excluded(id));

  const chains = roots.map((root) => {
    const members = closure(root, blocks);
    const order = topoOrder(members, blockers);
    const depthOf = longestDepths(order, blockers, members);
    const onePr = new Set();
    const later = [];
    for (const id of order) {
      const own = breakReason(byId.get(id), { actor, repoLabel });
      const open = blockers.get(id) ?? [];
      const outside = open.find((b) => !members.has(b));
      const waiting = open.find((b) => members.has(b) && !onePr.has(b));
      const reason = own ?? (outside ? `waits:${outside}` : waiting ? `after:${waiting}` : null);
      if (reason) later.push({ id, reason });
      else onePr.add(id);
    }
    const ordered = order.filter((id) => onePr.has(id));
    return {
      root,
      epic: parent.get(root) ?? null,
      depth: Math.max(...order.map((id) => depthOf.get(id))),
      size: members.size,
      onePr: ordered.map((id) => ({ id, level: depthOf.get(id) })),
      later,
      bestPriority: Math.min(...ordered.map((id) => byId.get(id).priority ?? 4), 9),
    };
  });

  chains.sort(
    (a, b) => b.onePr.length - a.onePr.length || b.depth - a.depth || a.bestPriority - b.bestPriority,
  );
  return chains;
}

function push(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function closure(root, blocks) {
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    for (const next of blocks.get(stack.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

/** Kahn's order inside the chain; a cycle's members are appended last rather than lost. */
function topoOrder(members, blockers) {
  const indegree = new Map([...members].map((id) => [id, 0]));
  for (const id of members) {
    for (const b of blockers.get(id) ?? []) if (members.has(b)) indegree.set(id, indegree.get(id) + 1);
  }
  const ready = [...members].filter((id) => indegree.get(id) === 0).sort();
  const out = [];
  while (ready.length) {
    const id = ready.shift();
    out.push(id);
    for (const other of [...members].sort()) {
      if (!(blockers.get(other) ?? []).includes(id)) continue;
      indegree.set(other, indegree.get(other) - 1);
      if (indegree.get(other) === 0) ready.push(other);
    }
  }
  for (const id of members) if (!out.includes(id)) out.push(id);
  return out;
}

function longestDepths(order, blockers, members) {
  const depth = new Map();
  for (const id of order) {
    const within = (blockers.get(id) ?? []).filter((b) => members.has(b) && depth.has(b));
    depth.set(id, within.length ? Math.max(...within.map((b) => depth.get(b))) + 1 : 0);
  }
  return depth;
}

export function formatChains(chains, byId, { limit = 10 } = {}) {
  const line = (id) => {
    const b = byId.get(id);
    return `${id} [P${b.priority} ${b.issue_type}${b.status === 'open' ? '' : ` ${b.status}`}] ${b.title}`;
  };
  const out = [];
  chains.slice(0, limit).forEach((c, i) => {
    const epic = c.epic ? ` · epic ${c.epic}: ${byId.get(c.epic)?.title ?? ''}` : '';
    out.push(`${i + 1}. ${c.root}: ${c.onePr.length} of ${c.size} in one PR, depth ${c.depth}${epic}`);
    for (const { id, level } of c.onePr) out.push(`     ${'  '.repeat(level)}${line(id)}`);
    if (c.later.length) {
      out.push('   not in that PR:');
      for (const { id, reason } of c.later) out.push(`     ${line(id)}  <- ${reason}`);
    }
    out.push('');
  });
  return out.join('\n');
}

const USAGE = `Usage: node scripts/bead-chains.mjs [--json] [--all] [--limit N] [--exclude-label <l>...] [--actor <id>] [--repo-label <repo:x>]
  --all            include chains with fewer than 2 beads in their first PR
  --limit N        chains to print (default 10; --json prints all)
  --exclude-label  drop chains whose ROOT carries any of these labels
  --actor <id>     claims held by this actor are not a break (default: none)
  --repo-label     this repository's repo:* label; a bead with any other repo:* label is a break
                   (default: $AGENT_TOOLING_REPO_LABEL, else repo labels are ignored)`;

function main(argv) {
  const { flags } = parseFlags(argv, {
    flags: {
      json: { type: 'boolean' },
      all: { type: 'boolean' },
      limit: {},
      'exclude-label': { type: 'array' },
      actor: {},
      'repo-label': {},
      help: { type: 'boolean', aliases: ['-h'] },
    },
  });
  if (flags.help) {
    console.log(USAGE);
    return 0;
  }
  const beads = bdJson(['list', '-s', NON_CLOSED, '-n', '0', '--flat', '--json']);
  const edges = parseDotEdges(bd(['list', '-s', NON_CLOSED, '-n', '0', '--format', 'dot']));
  const byId = new Map(beads.map((b) => [b.id, b]));
  const chains = buildChains(beads, edges, {
    actor: flags.actor ?? '',
    repoLabel: flags['repo-label'] ?? process.env.AGENT_TOOLING_REPO_LABEL ?? '',
    excludeLabels: flags['exclude-label'] ?? [],
  }).filter((c) => flags.all || c.onePr.length >= 2);
  if (flags.json) {
    console.log(JSON.stringify(chains, null, 2));
    return 0;
  }
  if (!chains.length) {
    console.log('No chain has two or more beads that can land together.');
    return 0;
  }
  console.log(formatChains(chains, byId, { limit: Number(flags.limit ?? 10) }));
  return 0;
}

function isMain() {
  try {
    return process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) process.exitCode = main(process.argv.slice(2));
