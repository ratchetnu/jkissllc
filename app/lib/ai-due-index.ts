import { redis } from './redis'
import { isEnabled } from './platform/flags'
import type { AiJob, Booking } from './bookings' // type-only → no runtime cycle with bookings.ts

// ─────────────────────────────────────────────────────────────────────────────
// Due-job index (OPERION AI latency Phase 2). A ZSET `ai:due` of durable AI jobs
// keyed by booking token, scored by the epoch-ms time each job becomes DUE — so the
// cron worker can read the handful of due jobs by score (ZRANGEBYSCORE -inf now)
// instead of loading every booking and filtering. This replaces an O(n) full-table
// scan with an O(due) index read.
//
// INERT BY DEFAULT + additive. The full scan in runDueAiJobs stays AUTHORITATIVE:
//   • both flags off  → no index writes/reads at all (byte-identical to today);
//   • DARK_LAUNCH on  → the index is maintained + compared against the scan every
//     tick (parity proof), but the scan result is still what runs;
//   • DUE_INDEX on    → the read source flips to the index (each token is still
//     re-verified against isDue as defense-in-depth), scan kept as the fallback.
//
// The score mirrors isDue exactly:
//   queued / retrying → nextRetryAt        (due when nextRetryAt ≤ now)
//   processing        → lastAttemptAt+lease (due when it becomes STALE = crashed)
//   terminal/none/archived/test → removed  (never due)
// ─────────────────────────────────────────────────────────────────────────────

// WAVE 5 (tenant-isolation audit), defect TEN-2. This was `ai:due` — and `ai:` is a
// PLATFORM-GLOBAL prefix (keys.ts PLATFORM_GLOBAL_PREFIXES), so the chokepoint left
// it un-namespaced. That put TENANT-OWNED state (booking tokens + each job's due
// time) in ONE physical ZSET shared by every tenant: a cross-tenant existence/timing
// leak via ZCARD/ZRANGEBYSCORE, a shared mutable structure any tenant's
// maintainDueIndex could ZREM from, and per-tick work for tokens the current tenant
// can never resolve. Unlike `ai:log`/`ai:call` — whose global placement is deliberate
// and documented, with read filtering in scopeAiRecords — nothing here was scoped.
// `aidue:` is NOT on the allowlist, so the index is now tenant-namespaced like every
// other tenant-owned family. Safe to rename: both flags default off (the index is
// unwritten today), it is a cache of derivable truth, the full scan stays
// authoritative, and rebuildDueIndex repopulates it.
export const DUE_KEY = 'aidue:index'

// The FINAL-analysis lane gets its OWN ZSET, and that separation is load-bearing
// rather than tidiness. Both indexes are keyed by booking token, and one booking can
// hold an initial job and a final job AT THE SAME TIME with different due times. A
// single ZSET could store only one score per token, so the two lanes would overwrite
// each other's entries — whichever job was saved last would silently strand the
// other. Two keys, one architecture: same scoring rules, same chokepoint, same
// backfill, same failure semantics.
export const FINAL_DUE_KEY = 'aidue:final'

/** The two due lanes. Everything below is parameterized by this rather than copied. */
export type DueLane = 'initial' | 'final'
export const DUE_LANES: DueLane[] = ['initial', 'final']
export const laneKey = (lane: DueLane): string => (lane === 'final' ? FINAL_DUE_KEY : DUE_KEY)

const DEFAULT_LEASE_MS = 5 * 60_000

/** The stale-processing lease (must match book-now-ai.processingLeaseMs — both read
 *  the same env var so the index score and isStaleProcessing agree). */
export function dueLeaseMs(env: Record<string, string | undefined> = process.env): number {
  const raw = Number(env.AI_PROCESSING_LEASE_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_LEASE_MS
}

/** The epoch-ms at which a job becomes due, or null if it can never be due
 *  (terminal state). Pure + exported so the index/scan agreement is unit-tested. */
export function dueScore(j: Pick<AiJob, 'status' | 'nextRetryAt' | 'lastAttemptAt'>, leaseMs: number): number | null {
  if (j.status === 'queued' || j.status === 'retrying') return j.nextRetryAt ?? 0
  if (j.status === 'processing') return (j.lastAttemptAt ?? 0) + leaseMs
  return null // completed | failed | manual_review → not due
}

/** The due-score for a whole booking, honouring the same eligibility guards as isDue
 *  (archived / test / no-job are never due). Pure. */
export function bookingDueScore(b: Pick<Booking, 'archived' | 'isTest' | 'aiJob'>, leaseMs = dueLeaseMs()): number | null {
  if (b.archived || b.isTest || !b.aiJob) return null
  return dueScore(b.aiJob, leaseMs)
}

/** The due-score for a booking's FINAL job. Mirrors `isFinalDue` exactly, including
 *  its extra guards: a final job is not due without a live confirmation, and an
 *  invalidated confirmation retires the entry. Pure, so index/scan agreement is
 *  unit-tested rather than assumed. */
export function finalBookingDueScore(
  b: Pick<Booking, 'archived' | 'isTest' | 'finalAiJob' | 'confirmation'>,
  leaseMs = dueLeaseMs(),
): number | null {
  if (b.archived || b.isTest || !b.finalAiJob) return null
  if (!b.confirmation || b.confirmation.invalidatedAt) return null
  return dueScore(b.finalAiJob, leaseMs)
}

/** One booking's score for either lane. */
export function laneDueScore(
  lane: DueLane,
  b: Pick<Booking, 'archived' | 'isTest' | 'aiJob' | 'finalAiJob' | 'confirmation'>,
  leaseMs = dueLeaseMs(),
): number | null {
  return lane === 'final' ? finalBookingDueScore(b, leaseMs) : bookingDueScore(b, leaseMs)
}

/** Whether the index is being written (either dark-launch parity or a live read). */
export function dueIndexMaintained(env: Record<string, string | undefined> = process.env): boolean {
  return isEnabled('OPERION_DUE_INDEX', env) || isEnabled('OPERION_DUE_INDEX_DARK_LAUNCH', env)
}
/** Whether the cron worker should READ due jobs from the index (vs. the scan). */
export function dueIndexReadEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return isEnabled('OPERION_DUE_INDEX', env)
}

/** Keep the index in lockstep with a booking's AI-job state. Called from saveBooking
 *  (the single write chokepoint) so every transition is captured in one place.
 *  No-op + fail-soft when the feature is off. */
export async function maintainDueIndex(
  b: Pick<Booking, 'token' | 'archived' | 'isTest' | 'aiJob' | 'finalAiJob' | 'confirmation'>,
): Promise<void> {
  if (!dueIndexMaintained()) return
  // BOTH lanes, every save. Idempotent by construction: ZADD overwrites the score
  // for an existing member and ZREM on an absent member is a no-op, so a duplicate
  // request, a retry, a photo replacement, a provider failure, a confirmation, a
  // cancellation and a completion all converge on the same end state no matter how
  // many times they run or in what order they interleave.
  for (const lane of DUE_LANES) {
    try {
      const score = laneDueScore(lane, b)
      if (score == null) await redis.zrem(laneKey(lane), b.token)
      else await redis.zadd(laneKey(lane), score, b.token)
    } catch { /* index is a cache of derivable truth — the scan stays authoritative */ }
  }
}

/** Backfill (additive) the index from a set of bookings — populate entries for jobs
 *  enqueued before the feature was on, so the dark-launch parity check turns clean
 *  BEFORE flipping the read source. Idempotent; terminal/ineligible jobs are removed.
 *  Caller supplies the bookings (avoids a bookings.ts import cycle). Fail-soft. */
export async function rebuildDueIndex(
  bookings: Pick<Booking, 'token' | 'archived' | 'isTest' | 'aiJob' | 'finalAiJob' | 'confirmation'>[],
): Promise<{ added: number; removed: number; byLane: Record<DueLane, { added: number; removed: number }>; failed: number }> {
  const byLane: Record<DueLane, { added: number; removed: number }> = {
    initial: { added: 0, removed: 0 }, final: { added: 0, removed: 0 },
  }
  let failed = 0
  for (const b of bookings) {
    for (const lane of DUE_LANES) {
      try {
        const score = laneDueScore(lane, b)
        if (score == null) { await redis.zrem(laneKey(lane), b.token); byLane[lane].removed++ }
        else { await redis.zadd(laneKey(lane), score, b.token); byLane[lane].added++ }
      } catch {
        // Counted, never swallowed silently: a backfill that could not write is a
        // backfill that is not finished, and the caller must be able to see that.
        failed++
      }
    }
  }
  return {
    added: byLane.initial.added + byLane.final.added,
    removed: byLane.initial.removed + byLane.final.removed,
    byLane, failed,
  }
}

/**
 * Read due tokens for a lane, bounded.
 *
 * The result is EXPLICIT — `{ ok: false }` on failure, never an empty array. An
 * unreadable index and an index with nothing due are completely different facts:
 * the first must stop the tick and retry, the second means there is no work. The
 * previous fail-soft `→ []` made them indistinguishable, so a Redis outage would
 * have read as "all caught up" and quietly stranded every queued job.
 */
export type DueRead = { ok: true; tokens: string[] } | { ok: false; error: string }

export async function readDueTokens(lane: DueLane, at: number, limit: number): Promise<DueRead> {
  try {
    const tokens = await redis.zrangebyscore(laneKey(lane), '-inf', String(at), 0, limit)
    return { ok: true, tokens }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'index_read_failed' }
  }
}

/** Retire index entries that are no longer due — a token the index offered but whose
 *  booking re-verification rejected. Keeps the index from accumulating tombstones
 *  after terminal transitions that a fail-soft maintain call missed. Fail-soft: a
 *  repair that cannot run is reported by the caller, never fatal to the tick. */
export async function retireDueEntries(lane: DueLane, tokens: string[]): Promise<number> {
  let retired = 0
  for (const t of tokens) {
    try { await redis.zrem(laneKey(lane), t); retired++ } catch { /* reported by caller */ }
  }
  return retired
}

/** Back-compat fail-soft read, used ONLY by the dark-launch parity comparison where
 *  an unreadable index genuinely is benign (it changes nothing that runs). */
export async function dueTokensFromIndex(at: number, limit: number): Promise<string[]> {
  const r = await readDueTokens('initial', at, limit)
  return r.ok ? r.tokens : []
}

// ── Parity (dark-launch proof the index === the scan) ─────────────────────────
export type DueParity = { scan: number; index: number; missingFromIndex: string[]; extraInIndex: string[]; match: boolean }

/** Compare the authoritative scan's due tokens with the index's. Pure. `missingFrom
 *  Index` = due per the scan but absent from the index (the dangerous direction — a
 *  job the index would strand); `extraInIndex` = in the index but not currently due
 *  per the scan (usually benign staleness). */
export function compareDue(scanTokens: string[], indexTokens: string[]): DueParity {
  const scan = new Set(scanTokens)
  const index = new Set(indexTokens)
  const missingFromIndex = scanTokens.filter(t => !index.has(t))
  const extraInIndex = indexTokens.filter(t => !scan.has(t))
  return { scan: scan.size, index: index.size, missingFromIndex, extraInIndex, match: missingFromIndex.length === 0 && extraInIndex.length === 0 }
}

// ── Indexed selection (the path that replaces the full scan) ─────────────────

/** What one indexed selection actually did. Returned to the cron so a run can be
 *  read afterwards without guessing: how much work the index offered, how much
 *  survived re-verification, what was retired, and — the one that matters for the
 *  request-exhaustion defect — whether a full scan happened. */
export type DueSelection<T> = {
  ok: boolean
  lane: DueLane
  /** Tokens the index offered (score ≤ now). */
  selectedFromIndex: number
  /** Of those, the ones re-verification agreed are genuinely due. */
  due: T[]
  /** Offered but not actually due → removed from the index. */
  staleRetired: number
  /** Index entries pointing at a booking that no longer loads → removed. */
  missingRetired: number
  indexReadFailed: boolean
  error?: string
  /** ZRANGEBYSCORE + one GET per offered token + one ZREM per retirement. */
  estimatedRedisRequests: number
  fullScanPerformed: false
}

/**
 * Select due work for one lane from the index — and NEVER fall back to a scan.
 *
 * When the index read fails this returns `ok: false` with an empty `due` list. The
 * caller must surface that and let the next tick retry. Falling back to
 * `listBookings(500)` here would defeat the entire point: the fallback is exactly
 * the O(n) scan that exhausted the Redis request quota, so a flaky index would
 * silently restore the failure mode this change exists to remove.
 *
 * `load` and `isDueNow` are injected so this stays free of a bookings.ts cycle and
 * is directly testable with fakes.
 */
export async function selectDueFromIndex<T>(
  lane: DueLane,
  at: number,
  limit: number,
  load: (token: string) => Promise<T | null>,
  isDueNow: (b: T) => boolean,
): Promise<DueSelection<T>> {
  const read = await readDueTokens(lane, at, limit)
  if (!read.ok) {
    return {
      ok: false, lane, selectedFromIndex: 0, due: [], staleRetired: 0, missingRetired: 0,
      indexReadFailed: true, error: read.error,
      estimatedRedisRequests: 1, fullScanPerformed: false,
    }
  }

  const due: T[] = []
  const stale: string[] = []
  const missing: string[] = []
  for (const token of read.tokens) {
    const b = await load(token)
    // Re-verification is defense in depth: the index is a cache of derivable truth,
    // so the booking record — not the score — decides whether work runs.
    if (!b) { missing.push(token); continue }
    if (isDueNow(b)) due.push(b)
    else stale.push(token)
  }

  const staleRetired = stale.length ? await retireDueEntries(lane, stale) : 0
  const missingRetired = missing.length ? await retireDueEntries(lane, missing) : 0

  return {
    ok: true, lane,
    selectedFromIndex: read.tokens.length,
    due, staleRetired, missingRetired,
    indexReadFailed: false,
    estimatedRedisRequests: 1 + read.tokens.length + staleRetired + missingRetired,
    fullScanPerformed: false,
  }
}

/** What a cron run reports about how it found its work. The `fullScanPerformed`
 *  field is the one this whole change exists to be able to answer honestly. */
export type DueRunTelemetry = {
  lane: DueLane | 'both'
  source: 'index' | 'scan'
  selectedFromIndex: number
  dueProcessed: number
  staleRetired: number
  missingRetired: number
  indexReadFailed: boolean
  estimatedRedisRequests: number
  fullScanPerformed: boolean
  error?: string
}

/** Telemetry for an indexed selection. `null` means the scan path ran. */
export function dueTelemetry<T>(sel: DueSelection<T> | null, dueProcessed = 0, scanned = 0): DueRunTelemetry {
  if (!sel) {
    return {
      lane: 'both', source: 'scan',
      selectedFromIndex: 0, dueProcessed, staleRetired: 0, missingRetired: 0,
      indexReadFailed: false,
      // 1 ZRANGE + one GET per booking — the cost this change removes.
      estimatedRedisRequests: scanned > 0 ? 1 + scanned : 0,
      fullScanPerformed: true,
    }
  }
  return {
    lane: sel.lane, source: 'index',
    selectedFromIndex: sel.selectedFromIndex,
    dueProcessed,
    staleRetired: sel.staleRetired,
    missingRetired: sel.missingRetired,
    indexReadFailed: sel.indexReadFailed,
    estimatedRedisRequests: sel.estimatedRedisRequests,
    fullScanPerformed: false,
    error: sel.error,
  }
}
