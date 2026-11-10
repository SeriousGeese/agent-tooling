#!/usr/bin/env node
// Deterministic enforcement of the two deferred-bead rules of the repo's epic and bead hygiene
// guidance. The planning logic is pure and lives in
// scripts/epic-hygiene-lib.mjs; this file is the only part that touches bd.
//
//   node scripts/epic-hygiene.mjs audit                 # whole tracker, read-only
//   node scripts/epic-hygiene.mjs epic bd-xxxx         # plan one epic's close
//   node scripts/epic-hygiene.mjs epic bd-xxxx --apply # ...and execute it
//   node scripts/epic-hygiene.mjs sweep --apply         # fix every violation
//
// Read-only by default on every mode: nothing mutates without --apply.
//
// SAFETY, bd's "last touched issue" fallback:
// `bd update`/`bd close` with no ID operate on the last touched issue, which is
// NOT scoped to this session, a concurrent agent's bd call can become "last
// touched" between two of ours. Every mutating call below therefore refuses an
// empty/placeholder ID rather than letting it through.

import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bdCli, bdCloseAsAssignee, siblingScript, spawnWithShellFallback } from './hygiene-bd-lib.mjs';
import {
  ACTION_KINDS,
  DEFAULT_DEFER_MONTHS,
  NEW_EPIC_PREFIX,
  describeNonEpicParent,
  filterActionKinds,
  planEpicEviction,
  planFullSweep,
  resolveText,
  sweepActions,
} from './epic-hygiene-lib.mjs';


// The verified sync CLI when the beads set is installed beside this file, a bare push otherwise.
const PUSH_HINT = existsSync(siblingScript('bd-dolt-sync.mjs')) ? 'node scripts/bd-dolt-sync.mjs push' : 'bd dolt push';

function usage(code = 0) {
  process.stdout.write(`Usage: node scripts/epic-hygiene.mjs <audit|epic <id>|sweep> [options]

Modes
  audit                Report every violation of both rules. Read-only. Default.
  epic <id>            Plan the eviction of <id>'s deferred children so it can close clean.
  sweep                Plan fixes for every violation tracker-wide.

Options
  --apply              Execute the plan. Without it, everything is a dry run.
  --defer-months <n>   Runway for a deferred bead that has no date (default ${DEFAULT_DEFER_MONTHS}).
  --split-standalone   Move every deferred child out individually, creating no
                       follow-ups epic. For beads that share a parent but nothing else.
  --only <kinds>       sweep only: apply just these action kinds (comma-separated; one of
                       ${ACTION_KINDS.join(', ')}).
                       \`--only surface-expired\` is what the nightly hygiene cron runs.
  --json               Emit the plan as JSON instead of a report.
  -h, --help           This text.
`);
  process.exit(code);
}

function bd(args, { capture = true } = {}) {
  // Honour $BD_CLI via bdCli() (one lookup, not a second reimplementation) so a Windows
  // box (where `bd` can be an extensionless shim that CreateProcess cannot start directly)
  // can point at the real binary and avoid the shell entirely. Without this the sanctioned `node scripts/epic-hygiene.mjs audit` died on an
  // unhandled ENOENT in loadRows() on the primary dev machine.
  const cli = bdCli();
  const r = spawnWithShellFallback(cli, args, {
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    // Matches what execFileSync used to throw: a genuine non-zero bd exit still propagates as
    // an exception, since none of the callers below catch it locally.
    const err = new Error(
      `Command failed: ${cli} ${args.join(' ')}${r.stderr ? `\n${r.stderr}` : ''}`,
    );
    err.status = r.status;
    err.stdout = r.stdout;
    err.stderr = r.stderr;
    throw err;
  }
  return r.stdout;
}

/** Guard against bd's last-touched fallback, never let a blank ID reach a mutation. */
function requireId(id, action) {
  if (typeof id !== 'string' || id.trim() === '' || id.startsWith(NEW_EPIC_PREFIX)) {
    throw new Error(`refusing to run ${action} with an unresolved id (${JSON.stringify(id)})`);
  }
  return id;
}

function loadRows() {
  // Bare `bd export` goes to stdout. Do NOT reach for `-o -`: bd treats that as a
  // literal filename and silently writes a file called `-`, leaving stdout empty -
  // which this planner would otherwise read as a perfectly clean tracker.
  const out = bd(['export']);
  const rows = out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r && r.id);
  if (rows.length === 0) {
    throw new Error('bd export returned no issues — refusing to report a clean tracker on an empty read');
  }
  return rows;
}

function applyAction(action, resolved) {
  switch (action.kind) {
    case 'create-epic': {
      const args = ['create', action.title, '--type', 'epic', '-d', action.description];
      if (action.parent) args.push('--parent', action.parent);
      if (action.deferUntil) args.push('--defer', action.deferUntil);
      const out = bd(args);
      const id = out.match(/Created issue:\s*(\S+)/)?.[1];
      if (!id) throw new Error(`could not parse new epic id from bd output:\n${out}`);
      // --defer alone leaves status `open` with a Deferred: line; the repo
      // convention is hard `status: deferred` (beads-hygiene Phase 2). An epic
      // that inherits a waking child stays open on purpose.
      if (action.status === 'deferred') bd(['update', id, '--status', 'deferred']);
      resolved.set(action.key, id);
      return `created epic ${id} [${action.status}] (${action.title})`;
    }
    case 'reparent': {
      const id = requireId(action.id, 'reparent');
      const parent = action.newParent?.startsWith(NEW_EPIC_PREFIX)
        ? resolved.get(action.newParent)
        : action.newParent;
      if (action.newParent?.startsWith(NEW_EPIC_PREFIX) && !parent) {
        throw new Error(`unresolved new-epic key ${action.newParent} for ${id}`);
      }
      // Empty string is bd's documented "remove parent", top-level is a real target.
      bd(['update', id, '--parent', parent ?? '']);
      return `reparented ${id} -> ${parent ?? '(top level)'}`;
    }
    case 'set-defer': {
      const id = requireId(action.id, 'set-defer');
      bd(['update', id, '--defer', action.deferUntil]);
      return `set defer date on ${id} -> ${action.deferUntil}`;
    }
    case 'surface-expired': {
      const id = requireId(action.id, 'surface-expired');
      bd(['update', id, '--status', 'open']);
      return `surfaced ${id} (defer date ${action.deferUntil} has passed)`;
    }
    case 'defer-epic': {
      // An epic that is already a bucket, deferred in place instead of re-bucketed.
      // Same two-step as create-epic: --defer sets the date but leaves status open
      // with a Deferred: line, so a follow-up --status makes it hard-deferred (the
      // repo convention, beads-hygiene Phase 2).
      const id = requireId(action.id, 'defer-epic');
      bd(['update', id, '--defer', action.deferUntil]);
      bd(['update', id, '--status', 'deferred']);
      return `deferred bucket epic ${id} -> ${action.deferUntil}`;
    }
    case 'relate': {
      // Bidirectional, non-blocking. Links the new epic to the origin it was
      // split out of, so the provenance survives outside the description prose.
      const from = action.id.startsWith(NEW_EPIC_PREFIX) ? resolved.get(action.id) : action.id;
      if (!from) throw new Error(`unresolved new-epic key ${action.id} for relate`);
      const to = requireId(action.to, 'relate');
      bd(['dep', 'relate', from, to]);
      return `related ${from} <-> ${to}`;
    }
    case 'note': {
      const id = requireId(action.id, 'note');
      bd(['note', id, resolveText(action.text, resolved)]);
      return `noted on ${id}`;
    }
    case 'close-epic': {
      const id = requireId(action.id, 'close-epic');
      // A claimed epic refuses the shared actor's close under bd 1.3.
      bdCloseAsAssignee(bd, id, resolveText(action.reason, resolved));
      return `closed epic ${id}`;
    }
    default:
      throw new Error(`unknown action kind: ${action.kind}`);
  }
}

function runActions(actions, apply) {
  if (!apply) {
    for (const a of actions) process.stdout.write(`  would ${describe(a)}\n`);
    process.stdout.write(`\n${actions.length} action(s) planned. Re-run with --apply to execute.\n`);
    return;
  }
  const resolved = new Map();
  for (const a of actions) process.stdout.write(`  ${applyAction(a, resolved)}\n`);
  process.stdout.write(`\n${actions.length} action(s) applied. Now run: ${PUSH_HINT}\n`);
}

function describe(a) {
  switch (a.kind) {
    case 'create-epic': return `create ${a.status} epic "${a.title}" (defer ${a.deferUntil ?? 'none'}, parent ${a.parent ?? 'top level'})`;
    case 'reparent': return `reparent ${a.id} -> ${a.newParent ?? '(top level)'}`;
    case 'set-defer': return `set defer date on ${a.id} -> ${a.deferUntil}`;
    case 'surface-expired': return `surface ${a.id} to open (defer date ${a.deferUntil} passed)`;
    case 'defer-epic': return `defer bucket epic ${a.id} -> ${a.deferUntil} (already a bucket, not re-bucketed)`;
    case 'relate': return `relate ${a.id} <-> ${a.to}`;
    case 'note': return `append note to ${a.id}`;
    case 'close-epic': return `close epic ${a.id}`;
    default: return JSON.stringify(a);
  }
}

function main(argv) {
  const args = [...argv];
  if (args.includes('-h') || args.includes('--help')) usage(0);

  const apply = args.includes('--apply');
  const asJson = args.includes('--json');
  const splitStandalone = args.includes('--split-standalone');
  const mi = args.indexOf('--defer-months');
  const defaultMonths = mi >= 0 ? Number(args[mi + 1]) : DEFAULT_DEFER_MONTHS;
  if (!Number.isFinite(defaultMonths) || defaultMonths < 0) {
    process.stderr.write('--defer-months must be a non-negative number\n');
    process.exit(2);
  }

  const oi = args.indexOf('--only');
  const onlyKinds = oi >= 0 ? String(args[oi + 1] ?? '').split(',').map((k) => k.trim()).filter(Boolean) : null;
  if (oi >= 0 && !onlyKinds.length) {
    process.stderr.write('--only needs a comma-separated list of action kinds\n');
    process.exit(2);
  }

  const positional = args.filter((a) => !a.startsWith('--') && a !== String(defaultMonths) && a !== (oi >= 0 ? args[oi + 1] : undefined));
  const mode = positional[0] ?? 'audit';
  if (onlyKinds && mode !== 'sweep') {
    process.stderr.write('--only applies to sweep mode only\n');
    process.exit(2);
  }
  const now = new Date();
  const rows = loadRows();

  if (mode === 'epic') {
    const epicId = positional[1];
    if (!epicId) { process.stderr.write('epic mode needs an epic id\n'); process.exit(2); }
    const plan = planEpicEviction(epicId, rows, now, { defaultMonths, splitStandalone });
    if (asJson) { process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`); return; }

    // Not an epic: this tool never plans its close or moves its children. Report and stop.
    if (plan.parentNotEpic) {
      const { text, exitCode } = describeNonEpicParent(epicId, plan);
      process.stdout.write(text);
      // Exit 1 when real work remains, as the hygiene guidance says `epic <id>` does.
      if (exitCode !== 0) process.exit(exitCode);
      return;
    }

    // The toggle-cleanup holder parks cleanup beads until sign-off; it is never closed or emptied here.
    if (plan.toggleCleanupHolder) {
      process.stdout.write(
        `${epicId} is the toggle-cleanup holder epic: it parks ${plan.deferred.length} cleanup bead(s) ` +
        `until sign-off, so this tool plans nothing for it.\n`,
      );
      return;
    }

    if (plan.blockedBy.length) {
      process.stdout.write(
        `${epicId} CANNOT close — ${plan.blockedBy.length} non-deferred child(ren) still live:\n` +
        plan.blockedBy.map((c) => `  ${c.id} [${c.status}] ${c.title}`).join('\n') + '\n',
      );
      process.exit(1);
    }
    if (!plan.actions.length) {
      process.stdout.write(`${epicId} has no deferred children — it can close clean as-is.\n`);
      return;
    }
    process.stdout.write(`${epicId}: evicting ${plan.deferred.length} deferred child(ren)\n`);
    runActions(plan.actions, apply);
    return;
  }

  if (mode !== 'audit' && mode !== 'sweep') usage(2);

  const sweep = planFullSweep(rows, now, { defaultMonths, splitStandalone });
  if (asJson) { process.stdout.write(`${JSON.stringify(sweep, null, 2)}\n`); return; }

  process.stdout.write('== Rule 1: closed parents still holding deferred children ==\n');
  if (!sweep.evictions.length) process.stdout.write('  (none)\n');
  for (const e of sweep.evictions) {
    process.stdout.write(`  ${e.epicId} -> ${e.deferred.length} deferred: ${e.deferred.map((c) => c.id).join(', ')}\n`);
  }

  process.stdout.write('\n== Rule 1b: OPEN epics with no live work left, still holding deferred children ==\n');
  if (!sweep.staleOpen.length) process.stdout.write('  (none)\n');
  for (const e of sweep.staleOpen) {
    process.stdout.write(`  ${e.epicId} -> ${e.deferred.length} deferred: ${e.deferred.map((c) => c.id).join(', ')}\n`);
  }

  process.stdout.write('\n== Informational: OPEN non-epic parents holding deferred children (no action; their own work decides their close) ==\n');
  if (!sweep.nonEpicParents.length) process.stdout.write('  (none)\n');
  for (const p of sweep.nonEpicParents) {
    process.stdout.write(`  ${p.parentId} [${p.type ?? 'unknown type'}] -> ${p.deferred.length} deferred: ${p.deferred.join(', ')}\n`);
  }

  process.stdout.write('\n== Rule 2a: deferred beads with NO defer date (parked forever) ==\n');
  process.stdout.write(sweep.dateless.length ? `  ${sweep.dateless.length} bead(s)\n` : '  (none)\n');

  process.stdout.write('\n== Rule 2b: deferred beads whose date has PASSED (never resurfaced) ==\n');
  if (!sweep.expired.length) process.stdout.write('  (none)\n');
  for (const x of sweep.expired) process.stdout.write(`  ${x.id} due ${x.deferUntil} — ${x.title}\n`);

  let actions = sweepActions(sweep);
  if (onlyKinds) {
    try {
      actions = filterActionKinds(actions, onlyKinds);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    process.stdout.write(`\n(--only ${onlyKinds.join(',')}: ${actions.length} of ${sweepActions(sweep).length} planned action(s) kept)\n`);
  }
  if (!actions.length) { process.stdout.write('\nTracker is clean.\n'); return; }
  if (mode === 'audit') {
    process.stdout.write(`\n${actions.length} action(s) would fix this. Run \`sweep --apply\` to execute.\n`);
    return;
  }
  process.stdout.write('\n== Plan ==\n');
  runActions(actions, apply);
}

function isEntryPoint() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) main(process.argv.slice(2));
