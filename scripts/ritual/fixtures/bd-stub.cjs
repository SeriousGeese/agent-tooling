#!/usr/bin/env node
// Hermetic `bd` stub for the agent-ritual conformance smoke.
//
// NOT a real beads client. It manages a tiny JSON "database" at $RITUAL_BD_DB so the smoke
// can drive scripts/claim.sh (and its claim-age check) end to end WITHOUT ever touching the
// shared tracker remote or the real .beads workspace. That is the hard hermeticity
// constraint: a scratch bead pushed to the shared remote pollutes every session.
//
// CommonJS on purpose: the smoke copies this file to an extensionless `bd` on a temp PATH
// dir, and an extensionless entry point is treated as CommonJS by Node, so `require` runs
// regardless of module-detection heuristics.
//
// Handles exactly the bd surface claim.sh uses:
//   bd dolt pull|push                  -> no-op, exit 0 (claim.sh routes its sync through
//                                         bd-dolt-sync.mjs, which shells out to these)
//   bd show <id> --json                -> print [issue] (or [] when unknown)
//   bd show <id>                       -> print a one-line header (a consumer's close script
//                                         may read only the first line + "CLOSED")
//   bd update <id> --claim [--actor X] -> assignee := X or $BEADS_ACTOR,
//                                         status := in_progress, started_at := now
//   bd update <id> -a <v> | --assignee <v> | --status <v>
//   bd close <id> --reason <r>         -> status := closed, but REFUSES (exit 1) while the
//                                         issue still has a non-closed child, mirroring bd's
//                                         real parent guard that a closing script has to
//                                         order around
// Anything else exits 0 so an incidental bd call can never break a script.
'use strict';
// process.getBuiltinModule rather than require(): the file runs as CommonJS (see above), and a
// consumer's lint config may ban require().
const fs = process.getBuiltinModule('node:fs');

const DB_PATH = process.env.RITUAL_BD_DB || '';

function load() {
  if (!DB_PATH) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}
function save(db) {
  if (DB_PATH) fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2));
}
function out(s) {
  process.stdout.write(s);
}

const args = process.argv.slice(2);
const [cmd] = args;

// RITUAL_BD_LOG: append each call's argv, one line per call, so a test can prove THIS stub (and
// not a real bd found elsewhere on PATH) was the one that ran.
if (process.env.RITUAL_BD_LOG) fs.appendFileSync(process.env.RITUAL_BD_LOG, `${args.join(' ')}\n`);

if (cmd === 'dolt' && (args[1] === 'pull' || args[1] === 'push')) {
  // The sync path we deliberately neutralise: report success, touch no remote.
  process.exit(0);
}

if (cmd === 'show') {
  const id = args[1];
  const db = load();
  const issue = db[id] || null;
  if (args.includes('--json')) {
    out(JSON.stringify(issue ? [issue] : []));
    process.exit(0);
  }
  // Non-JSON header: a closing script may read `bd show <id> | head -1` and only check
  // whether that line contains "CLOSED".
  if (issue) out(`${id}  [${issue.status || 'open'}]  ${issue.title || ''}\n`);
  process.exit(0);
}

if (cmd === 'close') {
  const id = args[1];
  const db = load();
  const issue = db[id];
  if (!issue) {
    process.stderr.write(`issue not found: ${id}\n`);
    process.exit(1);
  }
  // Mirror bd's real refusal: an issue with a non-closed child cannot close. A closing
  // script has to ORDER around this rather than override it, since an epic whose other
  // children are genuinely open must still fail loudly.
  const openChildren = Object.values(db).filter(
    (i) => i.id !== id && i.id.startsWith(`${id}.`) && i.status !== 'closed',
  );
  if (openChildren.length > 0) {
    process.stderr.write(
      `cannot close epic ${id}: ${openChildren.length} open child issue(s); ` +
        'close children first or use --force to override\n',
    );
    process.exit(1);
  }
  issue.status = 'closed';
  db[id] = issue;
  save(db);
  out(`Closed ${id}\n`);
  process.exit(0);
}

if (cmd === 'update') {
  const id = args[1];
  const db = load();
  const issue = db[id] || { id, title: `stub ${id}`, status: 'open', assignee: null, started_at: null };
  const rest = args.slice(2);

  if (rest.includes('--claim')) {
    const ai = rest.indexOf('--actor');
    const actor = ai !== -1 ? rest[ai + 1] : process.env.BEADS_ACTOR || '';
    issue.assignee = actor;
    issue.status = 'in_progress';
    issue.started_at = new Date().toISOString();
    out(`claimed ${id} as ${actor}\n`);
  }
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '-a' || rest[i] === '--assignee') issue.assignee = rest[i + 1] ?? '';
    if (rest[i] === '--status') issue.status = rest[i + 1] ?? issue.status;
  }

  db[id] = issue;
  save(db);
  process.exit(0);
}

process.exit(0);
