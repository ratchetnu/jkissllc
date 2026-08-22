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
// reshaping it, which is exactly what its comments forbid. We DO reuse the shared
// primitives it is built on — kv-lock's `compareAndSet` and `releaseIfOwned`, both
// single Lua round-trips — so there is no third grade of state transition here.
//
// ── THE STATE MACHINE ───────────────────────────────────────────────────────
//
//   (absent) ──SET NX──▶ pending:{id} ──CAS(pending:{id} → done:{id}, 24h)──▶ done:{id}
//                              │
//                              └──CAD(pending:{id})──▶ (absent)     [failed / skipped]
//
//   done:{id} ──CAD(done:{id})──▶ (absent)                          [draft missing]
//
// EVERY transition is conditional on the EXACT value this caller wrote. That is the
// whole point: an expired or superseded request must never complete or release a
// NEWER request's claim. An unconditional SET or DEL cannot express that — it would
// let request A, long since lapsed, publish a `done` pointing at ITS analysis id
// while B is mid-flight, or delete B's claim outright.
//
// ORDERING. `done` is a promise that a reusable draft EXISTS, so it is published
// only AFTER the draft is persisted — never before. Publishing first opens a window
// where a duplicate reads `done:{id}`, fetches the draft, finds nothing, and holds a
// pointer to something that was never written.
//
// A FAILED analysis clears the marker rather than recording `done`. A failure must
// never be cached: the customer's retry is the recovery path, and pinning the
// failure for 24h would convert one bad minute into a bad day.
//
// The fingerprint is derived from the photo URL set + service, all of which are
// opaque Blob UUIDs and enum values — no customer identity, no PII, no readable URL
// in the key — and the key is tenant-scoped by the redis chokepoint (`qa:` is not on
// the platform allowlist).
// ─────────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto'
import { redis } from '../redis'
import { compareAndSet, releaseIfOwned } from '../kv-lock'

/** In flight long enough to outlive the route's own 60s ceiling, then self-heal. */
export const ANALYSIS_PENDING_TTL_MS = 90_000
/** Matches the draft estimate's own 24h TTL — a stale pointer must never outlive it. */
export const ANALYSIS_DONE_TTL_MS = 24 * 60 * 60_000

export type AnalysisClaim =
  /** WE won the claim and own `pending:{analysisId}`. Only this state may call the provider. */
  | { state: 'acquired' }
  /** Someone else is mid-analysis on this exact question. */
  | { state: 'pending'; analysisId: string }
  /** A completed draft answers this exact question. */
  | { state: 'done'; analysisId: string }
  /**
   * The STORE failed. We proceed fail-open — a Redis blip must not cost a quote —
   * but we own NOTHING, so we must never later complete or release a claim.
   *
   * This state exists precisely because conflating it with `acquired` is how a store
   * failure masquerades as ownership: the caller would go on to publish a `done`
   * marker it has no right to publish.
   */
  | { state: 'unavailable' }

const key = (fp: string) => `qa:idem:${fp}`
const pendingValue = (analysisId: string) => `pending:${analysisId}`
const doneValue = (analysisId: string) => `done:${analysisId}`

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
  // the same digest. Written as an escape rather than a literal byte: a literal NUL
  // makes git classify the file as binary, which silently costs the module its
  // diffs and its reviewability.
  const material = `${input.service}\u0000${input.debris ?? ''}\u0000${photos}`
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 32)
}

/** Parse a stored marker. Anything unrecognised is treated as absent, never as state. */
function parse(raw: string | null): { state: 'pending' | 'done'; analysisId: string } | null {
  if (!raw) return null
  const i = raw.indexOf(':')
  if (i < 0) return null
  const state = raw.slice(0, i)
  const analysisId = raw.slice(i + 1)
  if (!analysisId) return null
  if (state === 'pending' || state === 'done') return { state, analysisId }
  return null
}

/**
 * Claim this question for `analysisId`, or report who already holds it.
 *
 * Winning the SET NX is what grants the right to spend money on the provider. A
 * caller that does not win must not call the model — it either serves the finished
 * draft (`done`) or tells the customer the answer is already coming (`pending`).
 *
 * Fail-open on a store error, but as `unavailable` rather than `acquired`: the
 * request still proceeds (a Redis blip must not refuse a customer a quote — a rare
 * duplicate costs cents, a refused quote costs the job) while being explicit that no
 * ownership was obtained, so nothing later tries to complete or release a claim it
 * never held.
 */
export async function claimAnalysis(fp: string, analysisId: string): Promise<AnalysisClaim> {
  try {
    if (await redis.setNxPx(key(fp), pendingValue(analysisId), ANALYSIS_PENDING_TTL_MS)) {
      return { state: 'acquired' }
    }
    const held = parse(await redis.get(key(fp)))
    if (!held) {
      // It expired or was rolled back between the SET NX and the read — retake it
      // rather than turn the customer away over a race we can simply win.
      if (await redis.setNxPx(key(fp), pendingValue(analysisId), ANALYSIS_PENDING_TTL_MS)) {
        return { state: 'acquired' }
      }
      const after = parse(await redis.get(key(fp)))
      if (!after) return { state: 'unavailable' }
      return after.state === 'pending'
        ? { state: 'pending', analysisId: after.analysisId }
        : { state: 'done', analysisId: after.analysisId }
    }
    return held.state === 'pending'
      ? { state: 'pending', analysisId: held.analysisId }
      : { state: 'done', analysisId: held.analysisId }
  } catch {
    return { state: 'unavailable' }
  }
}

/**
 * Publish the reusable `done` marker — but ONLY while we still own `pending:{id}`.
 *
 * Compare-and-set in a single Lua round-trip, applying the 24h TTL in the SAME
 * atomic step. An unconditional SET followed by a separate EXPIRE would be two
 * failure modes wearing one name: it could overwrite a newer request's claim, and it
 * could leave a `done` marker carrying the 90s pending TTL (or none at all) if the
 * process died between the two calls.
 *
 * Returns false when we no longer own the claim — lapsed, or taken over — which the
 * caller must read as "someone else owns this question now", never as an error.
 */
export async function completeAnalysis(fp: string, analysisId: string): Promise<boolean> {
  return compareAndSet(key(fp), pendingValue(analysisId), doneValue(analysisId), ANALYSIS_DONE_TTL_MS)
}

/**
 * Release our own in-flight claim after a FAILED or SKIPPED analysis.
 *
 * Compare-and-DELETE against this caller's exact `pending:{id}`. An unconditional
 * DEL is the classic lock bug the kv-lock header documents: our slow request
 * finishes after its 90s TTL lapsed, a second request claims the key, and our DEL
 * removes THEIR claim — so a third request starts yet another paid analysis. Not
 * reachable here.
 */
export async function releaseAnalysis(fp: string, analysisId: string): Promise<boolean> {
  return releaseIfOwned(key(fp), pendingValue(analysisId))
}

/**
 * Remove a `done` marker whose draft is gone or unreadable.
 *
 * Compare-and-delete against that EXACT `done:{id}`, so a marker republished by a
 * newer, healthy analysis in the meantime is never destroyed. Used only on the
 * repair path, where a duplicate found `done` but the draft behind it had expired,
 * been evicted, or never been written.
 */
export async function discardStaleDone(fp: string, analysisId: string): Promise<boolean> {
  return releaseIfOwned(key(fp), doneValue(analysisId))
}
