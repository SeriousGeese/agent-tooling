// scripts/agent-tooling-config.mjs (and its suite) are NOT authored here. They are copied
// verbatim from SeriousGeese/CICD agent-hooks/ at the commit recorded in
// scripts/CICD-CONFIG-REF, so that both homes read a consumer's agent-tooling.json through one
// loader. This fails when the copy drifts from that commit: change the loader in CICD, then
// copy it here and move the ref, never edit it in place.
//
// It reads CICD from raw.githubusercontent.com (CICD is public), or from a local checkout
// when CICD_CHECKOUT is set (offline). A network failure is a FAILURE, not a skip: a check
// that passes by not running is worse than no check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ref = readFileSync(path.join(REPO, 'scripts', 'CICD-CONFIG-REF'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .find((l) => l && !l.startsWith('#'));
const FILES = ['agent-tooling-config.mjs', 'agent-tooling-config.node-test.mjs'];

async function cicdAt(name) {
  if (process.env.CICD_CHECKOUT) {
    return execFileSync('git', ['-C', process.env.CICD_CHECKOUT, 'show', `${ref}:agent-hooks/${name}`], {
      encoding: 'utf8',
      env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    });
  }
  const url = `https://raw.githubusercontent.com/SeriousGeese/CICD/${ref}/agent-hooks/${name}`;
  const res = await fetch(url);
  assert.ok(res.ok, `GET ${url} -> HTTP ${res.status}`);
  return res.text();
}

test('scripts/CICD-CONFIG-REF holds one full commit SHA', () => {
  assert.match(String(ref), /^[0-9a-f]{40}$/);
});

for (const name of FILES) {
  test(`scripts/${name} is byte-identical (modulo CRLF) to CICD agent-hooks/${name} at the recorded ref`, async () => {
    const want = (await cicdAt(name)).replace(/\r\n/g, '\n');
    const have = readFileSync(path.join(REPO, 'scripts', name), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(have === want, `scripts/${name} differs from CICD@${String(ref).slice(0, 12)}: re-copy it from CICD, never edit it here`);
  });
}
