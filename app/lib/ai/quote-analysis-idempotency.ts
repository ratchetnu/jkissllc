// ─────────────────────────────────────────────────────────────────────────────
// Idempotency for the interactive photo analysis (POST /api/quote/analyze).
//
// WHAT IT PROTECTS. A vision analysis is a PAID provider call. The route's own
// contract already advertised an `idempotencyKey`, but nothing server-side ever
// read it, so the only dedupe was `ai/pre-analysis`'s in-memory, per-controller
// fingerprint map. That guard is real but narrow: it lives in one browser tab and
// dies with it. A refresh, a second tab, the back button, or an impatient second
// click all sail straight past it and buy another analysis of the SAME photos.
//
// WHY NOT booking-idempotency. That module solves a harder problem — a booking must
// exist exactly once, and its claim/CAS/lease design is load-bearing and explicitly
// fenced off in AGENTS.md. Nothing here needs uniqueness of a persisted record; we
// need "don't pay twice for the same question". Reusing that machinery would mean
// reshaping it, which is exactly what its comments forbid.
//
// THE STATES.
//   (absent)          → nobody has asked this question; caller runs the analysis
//   pending:{id}      → an analysis is in flight; caller must NOT start a second
//   done:{id}         → a completed draft estimate answers this exact question
//
// A FAILED analysis clears the marker rather than recording `done`. A failure must
// never be cached: the customer's retry is the recovery path, and pinning the
// failure for 24h would convert one bad minute into a bad day.
//
// The fingerprint is derived from the photo URL set + service, all of which are
// opaque Blob UUIDs and enum values — no customer identity, no PII, and the key is
// tenant-scoped by the redis chokepoint (`qa:` is not on the platform allowlist).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto'
import { redis } from '../redis'

/** In flight long enough to outlive the route's own 60s ceiling, then self-heal. */
export const ANALYSIS_PENDING_TTL_MS = 90_000
/** Matches the draft estimate's own 24h TTL — a stale pointer must never outlive it. */
export const ANALYSIS_DONE_TTL_MS = 24 * 60 * 60_000

export type AnalysisClaim =
  | { state: 'free' }
  | { state: 'pending'; analysisId: string }
  | { state: 'done'; analysisId: string }

const key = (fp: string) => `qa:idem:${fp}`

/**
 * A stable fingerprint of the QUESTION being asked of the model.
 *
 * Photo order must not matter — the same set dragged in a different order is the
 * same question and must not be paid for twice — so the URLs are sorted. Service
 * and debris are included because they change the prompt, and therefore the answer.
 */
export function analysisFingerprint(input: {
  photoUrls: string[]
  service: string
  debris?: string
}): string {
  const photos = [...input.photoUrls].sort().join('\n')
  // NUL separates the fields because it cannot occur in a URL, a service enum or a
  // debris string — so no set of values can be rearranged into a different set with
  // the same digest. Written as an escape rather than a literal byte: a
  // literal NUL makes git classify the file as binary, which silently costs the
  // module its diffs and its reviewability.
  const material = `${input.service}\u0000${input.debris ?? ''}\u0000${photos}`
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)
}

function parse(raw: string | null): AnalysisClaim {
  if (!raw) return { state: 'free' }
  const i = raw.indexOf(':')
  if (i < 0) return { state: 'free' }
  const state = raw.slice(0, i)
  const analysisId = raw.slice(i + 1)
  if (!analysisId) return { state: 'free' }
  if (state === 'pending') return { state: 'pending', analysisId }
  if (state === 'done') return { state: 'done', analysisId }
  return { state: 'free' }
}

/**
 * Claim this question for `analysisId`, or report who already holds it.
 *
 * Winning the SET NX is what grants the right to spend money on the provider. A
 * caller that does not win must not call the model — it either serves the finished
 * draft (`done`) or tells the customer the answer is already coming (`pending`).
 *
 * Fail-OPEN on a store error: a Redis blip must not block a customer from getting a
 * quote. The cost of a rare duplicate analysis is a few cents; the cost of a refused
 * quote is the job.
 */
export async function claimAnalysis(fp: string, analysisId: string): Promise<AnalysisClaim> {
  try {
    const won = await redis.setNxPx(key(fp), `pending:${analysisId}`, ANALYSIS_PENDING_TTL_MS)
    if (won) return { state: 'free' }
    const held = parse(await redis.get(key(fp)))
    // Expired between the SET NX and the GET — try once more rather than send the
    // customer away over a race we can simply retake.
    if (held.state === 'free') {
      const retook = await redis.setNxPx(key(fp), `pending:${analysisId}`, ANALYSIS_PENDING_TTL_MS)
      return retook ? { state: 'free' } : parse(await redis.get(key(fp)))
    }
    return held
  } catch {
    return { state: 'free' }
  }
}

/** Record that this question now has a completed, reusable draft estimate. */
export async function completeAnalysis(fp: string, analysisId: string): Promise<void> {
  try {
    // Overwrites our own `pending:` marker — set, then re-arm the longer TTL.
    await redis.set(key(fp), `done:${analysisId}`)
    await redis.expire(key(fp), Math.floor(ANALYSIS_DONE_TTL_MS / 1000))
  } catch { /* telemetry-only: a lost pointer costs one repeat analysis, never a quote */ }
}

/**
 * Release the claim after a FAILED analysis so the customer's retry can proceed.
 * Never records `done` — see the header note on why a failure must not be cached.
 */
export async function releaseAnalysis(fp: string): Promise<void> {
  try { await redis.del(key(fp)) } catch { /* the 90s TTL is the backstop */ }
}
