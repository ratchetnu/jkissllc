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

export const DUE_KEY = 'ai:due'
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
export async function maintainDueIndex(b: Pick<Booking, 'token' | 'archived' | 'isTest' | 'aiJob'>): Promise<void> {
  if (!dueIndexMaintained()) return
  try {
    const score = bookingDueScore(b)
    if (score == null) await redis.zrem(DUE_KEY, b.token)
    else await redis.zadd(DUE_KEY, score, b.token)
  } catch { /* index is a cache of derivable truth — the scan stays authoritative */ }
}

/** Backfill (additive) the index from a set of bookings — populate entries for jobs
 *  enqueued before the feature was on, so the dark-launch parity check turns clean
 *  BEFORE flipping the read source. Idempotent; terminal/ineligible jobs are removed.
 *  Caller supplies the bookings (avoids a bookings.ts import cycle). Fail-soft. */
export async function rebuildDueIndex(bookings: Pick<Booking, 'token' | 'archived' | 'isTest' | 'aiJob'>[]): Promise<{ added: number; removed: number }> {
  let added = 0, removed = 0
  for (const b of bookings) {
    try {
      const score = bookingDueScore(b)
      if (score == null) { await redis.zrem(DUE_KEY, b.token); removed++ }
      else { await redis.zadd(DUE_KEY, score, b.token); added++ }
    } catch { /* fail-soft — the scan stays authoritative */ }
  }
  return { added, removed }
}

/** Read due tokens (score ≤ at) from the index, bounded. Fail-soft → []. */
export async function dueTokensFromIndex(at: number, limit: number): Promise<string[]> {
  try {
    return await redis.zrangebyscore(DUE_KEY, '-inf', String(at), 0, limit)
  } catch {
    return []
  }
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
