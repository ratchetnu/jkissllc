// ─────────────────────────────────────────────────────────────────────────────
// Benchmark pacing — respect the application's real rate limit instead of
// hammering through it.
//
// /api/quote/analyze allows 10 requests per 10 minutes per IP. The first real
// Preview run ignored that: 10 jobs succeeded, then 17 were rejected with 429 in
// ~110ms each. Those fast rejections then polluted the latency percentiles,
// making the analyzer look faster the more often it was refused service.
//
// This module is the fix, and it keeps two clocks strictly apart:
//   • WAIT time — time spent respecting the limit. Never latency.
//   • INFERENCE time — time the model actually took. The only thing measured.
//
// PURE + INJECTABLE — no sleeping, no wall clock of its own. The caller supplies
// `now` and performs the wait, so the whole policy is unit-testable in
// microseconds instead of ten-minute windows.
// ─────────────────────────────────────────────────────────────────────────────

/** The shipped limit on POST /api/quote/analyze — see the route's rateLimit call. */
export const ANALYZE_LIMIT = { requests: 10, windowMs: 10 * 60_000 } as const

export type RateLimitPolicy = { requests: number; windowMs: number }

export type PacerDecision =
  | { action: 'go' }
  /** Wait this long before the next request. Recorded as wait, never as latency. */
  | { action: 'wait'; ms: number; reason: 'window_full' | 'retry_after' }

export type Pacer = {
  /** Should the next request go now, or wait? Call immediately before sending. */
  next(now: number): PacerDecision
  /** Record that a request was actually sent at `now`. */
  record(now: number): void
  /** Honour a server 429: block until `until`, regardless of the local window. */
  penalize(until: number): void
  /** Total milliseconds spent waiting so far — reported separately from latency. */
  waitedMs(): number
  /** Add to the wait total after the caller has actually slept. */
  addWait(ms: number): void
  /** Requests sent inside the current window. */
  usedInWindow(now: number): number
}

export function createPacer(
  policy: RateLimitPolicy = ANALYZE_LIMIT,
  opts: { safetyMarginMs?: number } = {},
): Pacer {
  // A small margin so a request never lands on the exact boundary the server is
  // measuring against — clock skew between us and the limiter is real.
  const margin = opts.safetyMarginMs ?? 1_000
  const sent: number[] = []
  let penaltyUntil = 0
  let waited = 0

  const prune = (now: number) => {
    const cutoff = now - policy.windowMs
    while (sent.length > 0 && sent[0] <= cutoff) sent.shift()
  }

  return {
    next(now: number): PacerDecision {
      if (penaltyUntil > now) {
        return { action: 'wait', ms: penaltyUntil - now, reason: 'retry_after' }
      }
      prune(now)
      if (sent.length < policy.requests) return { action: 'go' }
      // The window is full: wait until the oldest request ages out of it.
      const freeAt = sent[0] + policy.windowMs + margin
      return { action: 'wait', ms: Math.max(0, freeAt - now), reason: 'window_full' }
    },
    record(now: number) { prune(now); sent.push(now) },
    penalize(until: number) { penaltyUntil = Math.max(penaltyUntil, until) },
    waitedMs: () => waited,
    addWait(ms: number) { waited += Math.max(0, ms) },
    usedInWindow(now: number) { prune(now); return sent.length },
  }
}

/**
 * Parse a `Retry-After` header. Supports both forms in the spec: delta-seconds
 * and an HTTP date. Returns milliseconds to wait, or null when absent/unparseable
 * so the caller can fall back to its own backoff rather than waiting forever.
 */
export function parseRetryAfter(header: string | null | undefined, now: number): number | null {
  if (!header) return null
  const trimmed = header.trim()
  if (/^\d+$/.test(trimmed)) return Math.max(0, Number(trimmed) * 1000)
  const at = Date.parse(trimmed)
  return Number.isFinite(at) ? Math.max(0, at - now) : null
}

/** Exponential backoff for a 429 with no usable Retry-After. Capped. */
export function fallbackBackoffMs(attempt: number, capMs = 5 * 60_000): number {
  return Math.min(capMs, 30_000 * Math.pow(2, Math.max(0, attempt - 1)))
}
