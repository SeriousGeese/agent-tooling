// GitHub rate-limit recognition and back-off for the local polling tools.
//
// WHY. Every session on the shared account spends ONE secondary (burst/concurrency) limit, and a
// 403 "API rate limit exceeded" arrives while `gh api rate_limit` still shows the core quota nearly
// full (2026-10-30: 4987/5000 left, a polling script stalled 45+ minutes). A poller
// that treats that 403 as a failure dies; one that retries at once makes the limit last longer for
// every session. The answer is to recognise it and sleep longer, doubling up to a cap.
// Rule: one request per poll tick, ticks 5+ minutes apart.
//
// A bash caller may carry a copy of RATE_LIMIT_RE as a grep -E pattern: keep the two in step.

/** gh's wording for the primary and secondary limits, REST (403/429) and GraphQL (RATE_LIMITED). */
export const RATE_LIMIT_RE = /rate limit|RATE_LIMITED|abuse detection|HTTP 429/i;

/** True when gh's stderr (or an error message carrying it) names a rate limit. */
export function isRateLimited(text) {
  return RATE_LIMIT_RE.test(String(text ?? ''));
}

/**
 * Milliseconds to sleep after the `hits`-th consecutive rate-limited poll (1-based): the poll
 * interval, floored at `floorMs`, doubled per hit and capped at `capMs`. Pure.
 */
export function backoffMs(hits, pollMs, { floorMs = backoffFloorMs(), capMs = 30 * 60 * 1000 } = {}) {
  const base = Math.max(pollMs, floorMs);
  return Math.min(base * 2 ** Math.max(0, hits - 1) * 2, capMs);
}

/** The back-off floor: 60s, or AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS (tests set 0). */
export function backoffFloorMs(env = process.env) {
  const s = Number(env.AGENT_TOOLING_GH_BACKOFF_FLOOR_SECONDS ?? 60);
  return Number.isFinite(s) && s >= 0 ? s * 1000 : 60_000;
}
