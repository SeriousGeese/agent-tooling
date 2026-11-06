#!/usr/bin/env node
// A stand-in for `bd`, for scripts/oddity.node-test.mjs only (wired through the CLI's
// ODDITY_BD_STUB seam). It keeps a tiny JSON "database" at $ODDITY_STUB_DB so the
// cross-repo test can file entries from three different repos and then list them
// back — without a Dolt database, a network, or a single real bead.
//
// It understands exactly what scripts/oddity.mjs sends: the global `-C <dir>` and
// `--actor <id>`, `dolt pull|push`, `create <title> … --labels a,b --silent`, and
// `list -l <label>… --flat -n 0 [--json]` (every -l must match, as bd's does).
// Every call is appended to the database's `calls` array, `-C` included, so the
// test can assert which checkout each call was aimed at.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

const dbPath = process.env.ODDITY_STUB_DB;
if (!dbPath) {
  process.stderr.write('oddity-bd-stub: ODDITY_STUB_DB is not set\n');
  process.exit(2);
}
const db = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, 'utf8')) : { next: 1, beads: [], calls: [] };

const argv = process.argv.slice(2);
let dir = null;
while (argv[0] === '-C' || argv[0] === '--actor') {
  const [flag, value] = argv.splice(0, 2);
  if (flag === '-C') dir = value;
}
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
};

db.calls.push({ dir, cmd: argv[0], sub: argv[0] === 'dolt' ? argv[1] : undefined });
let status = 0;

if (argv[0] === 'dolt') {
  // pull / push: nothing to sync
} else if (argv[0] === 'create') {
  const id = `bd-stub${db.next++}`;
  db.beads.push({ id, title: argv[1], labels: String(valueOf('--labels') ?? '').split(',').filter(Boolean), status: 'open' });
  process.stdout.write(`${id}\n`);
} else if (argv[0] === 'list') {
  const want = argv.flatMap((a, i) => (a === '-l' ? [argv[i + 1]] : []));
  // bd's default listing is OPEN beads; `--status closed` is what `unarchived` sends.
  const status = valueOf('--status') ?? 'open';
  const hits = db.beads.filter((b) => want.every((l) => b.labels.includes(l)) && (b.status ?? 'open') === status);
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(hits)}\n` : hits.map((b) => `${b.id} [${b.labels.join(', ')}] ${b.title}\n`).join(''));
} else {
  process.stderr.write(`oddity-bd-stub: unsupported bd ${argv[0]}\n`);
  status = 2;
}

writeFileSync(dbPath, JSON.stringify(db, null, 2));
process.exit(status);
