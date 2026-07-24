// ── Analytics date-range parsing ─────────────────────────────────────────────
// One place for the "?days=N" window every analytics route accepts, so bounds and
// fallback behavior are consistent and a malformed/oversized value fails safely to
// the default rather than loading an unbounded dataset.

export function parseDays(raw: string | null | undefined, dflt = 30, max = 180): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return dflt
  return Math.min(max, Math.max(1, Math.floor(n)))
}

// Central-time-anchored window start for `days` back from `now` (ms). Kept simple:
// the day counters/ledgers analytics reads are day-granular, so a plain N×86.4M
// window matches how the data is bucketed.
export function windowStartMs(days: number, now = Date.now()): number {
  return now - days * 86_400_000
}
