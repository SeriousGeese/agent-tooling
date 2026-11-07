#!/usr/bin/env node
// Hermetic `gh` stub for the agent-ritual conformance smoke.
//
// A consumer's merge-time script (one that closes beads from a merged PR's body) reads the
// PR's state/title/body/base via `gh pr view <n> --repo <r> --json <field> --jq .<field>`.
// This stub answers those reads from the environment so a consumer-owned overlay test can
// exercise that script without a network call or a live PR:
//   RITUAL_PR_STATE  (default "MERGED")
//   RITUAL_PR_TITLE
//   RITUAL_PR_BODY
//   RITUAL_PR_BASE   (default "main": real gh always answers baseRefName, and a script that
//                     fails CLOSED on an empty base needs a value)
//   RITUAL_PR_HEAD   (default "": the head BRANCH name. Empty by default so a case says
//                     nothing about a branch-name detector unless it opts in.)
// Any other invocation prints nothing and exits 0.
//
// CommonJS on purpose, see bd-stub.cjs for why (extensionless entry point).
'use strict';

const args = process.argv.slice(2);

if (args[0] === 'pr' && args[1] === 'view') {
  const jsonAt = args.indexOf('--json');
  const field = jsonAt !== -1 ? args[jsonAt + 1] : '';
  if (field === 'state') process.stdout.write(process.env.RITUAL_PR_STATE || 'MERGED');
  else if (field === 'title') process.stdout.write(process.env.RITUAL_PR_TITLE || '');
  else if (field === 'body') process.stdout.write(process.env.RITUAL_PR_BODY || '');
  else if (field === 'baseRefName') process.stdout.write(process.env.RITUAL_PR_BASE || 'main');
  else if (field === 'headRefName') process.stdout.write(process.env.RITUAL_PR_HEAD || '');
  process.exit(0);
}

process.exit(0);
