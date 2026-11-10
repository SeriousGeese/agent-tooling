// Load-tolerant wall-clock budgets for the node-tests that spawn real bash, git and dev servers.
//
// A fixed timeout is a statement about an idle machine. On a Windows box running several agent
// sessions, a Git Bash spawn alone can take tens of seconds, so a 60 s `spawnSync` budget fails
// with ETIMEDOUT on a test that passes alone in a few seconds. The budget is scaled instead of
// the failure being retried or skipped.
//
// Scale, in order of precedence:
//   1. AGENT_TOOLING_NODE_TEST_TIMEOUT_SCALE (a consumer's prefixed spelling is rewritten by sync),
//      a positive number, e.g. 3 triples every budget.
//   2. CI (CI=true): 1. CI stays strict; a timeout there is a real hang.
//   3. Anywhere else on win32: 3. Process spawn is the slow part there.
//   4. Everything else: 1.

/** @param {NodeJS.ProcessEnv} [env] @param {string} [platform] */
export function timeoutScale(env = process.env, platform = process.platform) {
  const raw = env.AGENT_TOOLING_NODE_TEST_TIMEOUT_SCALE;
  if (raw !== undefined && raw !== '') {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ci = env.CI;
  if (ci && ci !== '0' && ci.toLowerCase() !== 'false') return 1;
  return platform === 'win32' ? 3 : 1;
}

/** @param {number} ms */
export function scaledMs(ms, env = process.env, platform = process.platform) {
  return Math.round(ms * timeoutScale(env, platform));
}
