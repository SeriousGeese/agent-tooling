#!/usr/bin/env node
// A stand-in for `gh`, for scripts/oddity.node-test.mjs only (wired through the CLI's
// ODDITY_GH_STUB seam). It answers `gh issue view <n> --repo <r> --json …` and records
// which token variables reached it, so a test can prove the CLI keeps GH_TOKEN (how the
// every-3-days cron authenticates on a runner) while still dropping
// GITHUB_TOKEN (the Windows invalid-token rule).
//
//   ODDITY_GH_STUB_LOG    file each call appends one JSON line to: { args, GH_TOKEN, hasGithubToken }
//   ODDITY_GH_STUB_STATE  the state to report (default OPEN); CLOSED adds stateReason/closedAt
//
// With no GH_TOKEN in its env it exits 4 like an unauthenticated gh, so a CLI that
// dropped both variables would read every entry as UNKNOWN.
import { appendFileSync } from 'node:fs';

const args = process.argv.slice(2);
const log = process.env.ODDITY_GH_STUB_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ args, GH_TOKEN: process.env.GH_TOKEN ?? null, hasGithubToken: 'GITHUB_TOKEN' in process.env })}\n`,
  );
}

if (!process.env.GH_TOKEN) {
  process.stderr.write('gh stub: not authenticated (no GH_TOKEN)\n');
  process.exit(4);
}
if (args[0] !== 'issue' || args[1] !== 'view') {
  process.stderr.write(`gh stub: unsupported call ${args.join(' ')}\n`);
  process.exit(1);
}

const state = process.env.ODDITY_GH_STUB_STATE || 'OPEN';
const payload =
  state === 'CLOSED'
    ? { state, stateReason: 'COMPLETED', closedAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z' }
    : { state, updatedAt: '2026-09-10T00:00:00Z' };
process.stdout.write(`${JSON.stringify(payload)}\n`);
