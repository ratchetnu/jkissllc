// ─────────────────────────────────────────────────────────────────────────────
// The claim → analyse → persist → publish protocol for the interactive photo
// estimate, as ONE executable function.
//
// WHY IT IS NOT INLINE IN THE ROUTE. The ordering here is the correctness: which
// step happens before which, and which step is allowed to touch the shared marker.
// Inlined in a Next handler — behind a tenancy wrapper, BotID and a rate limiter —
// none of that can be driven by a test, so the only available guard was grepping the
// route's source. Source text cannot distinguish "saves the draft before publishing"
// from "publishes before saving"; both contain the same two calls. Extracting the
// protocol makes the ORDER itself testable, which is the property that was broken.
//
// The route keeps every policy decision (auth, validation, telemetry, HTTP shape).
// This module owns exactly one thing: who may spend money, and in what order the
// shared state may be moved.
// ─────────────────────────────────────────────────────────────────────────────

import type { StoredAiEstimate } from './estimate-store'
import type { InteractiveDegradeReason } from './interactive-policy'
import {
  claimAnalysis, completeAnalysis, releaseAnalysis, discardStaleDone,
} from './quote-analysis-idempotency'

/** What the route must do next. Every branch is terminal and named. */
export type AnalysisLifecycleOutcome =
  /** A finished draft already answers this exact question — serve it, charge nothing. */
  | { kind: 'reused'; analysisId: string; stored: StoredAiEstimate }
  /** Someone else owns the question. No provider call was made. */
  | { kind: 'pending'; analysisId: string }
  /** We owned it (or ran fail-open) and analysed. */
  | {
    kind: 'analyzed'
    stored: StoredAiEstimate
    analyzedOk: boolean
    degraded?: InteractiveDegradeReason
    /** False when the draft could not be persisted — then nothing was published. */
    draftSaved: boolean
    /** True only when a reusable `done` marker was actually published. */
    published: boolean
    /** False when the store was unreachable: we ran fail-open and own nothing. */
    ownedClaim: boolean
  }

export type AnalysisRun = {
  stored: StoredAiEstimate
  analyzedOk: boolean
  degraded?: InteractiveDegradeReason
}

export type AnalysisLifecycleDeps = {
  claim?: typeof claimAnalysis
  complete?: typeof completeAnalysis
  release?: typeof releaseAnalysis
  discardStale?: typeof discardStaleDone
  /** Read a persisted draft. Must resolve null (never throw) when absent. */
  loadDraft: (analysisId: string) => Promise<StoredAiEstimate | null>
  /** Persist the draft. Throwing means "not saved" — nothing is published. */
  saveDraft: (stored: StoredAiEstimate) => Promise<void>
  /** The paid provider work. Called AT MOST ONCE, and only when we may spend. */
  analyze: () => Promise<AnalysisRun>
}

export async function runAnalysisLifecycle(
  input: { fingerprint: string; analysisId: string },
  deps: AnalysisLifecycleDeps,
): Promise<AnalysisLifecycleOutcome> {
  const claim = deps.claim ?? claimAnalysis
  const complete = deps.complete ?? completeAnalysis
  const release = deps.release ?? releaseAnalysis
  const discardStale = deps.discardStale ?? discardStaleDone
  const { fingerprint: fp, analysisId } = input

  let state = await claim(fp, analysisId)

  if (state.state === 'done') {
    const prior = await deps.loadDraft(state.analysisId).catch(() => null)
    if (prior) return { kind: 'reused', analysisId: state.analysisId, stored: prior }

    // The marker promised a draft that is gone — expired, evicted, or never written
    // because a previous request died between analysing and saving. Retire THAT EXACT
    // marker (compare-and-delete, so a newer healthy `done` is untouched) and compete
    // again. Falling through without re-claiming is what would let the repair path
    // start an unowned paid call.
    await discardStale(fp, state.analysisId)
    state = await claim(fp, analysisId)

    if (state.state === 'done') {
      // Someone repaired it first. Serve theirs if it is real; otherwise report
      // pending rather than loop — one repair round, then hand off.
      const repaired = await deps.loadDraft(state.analysisId).catch(() => null)
      return repaired
        ? { kind: 'reused', analysisId: state.analysisId, stored: repaired }
        : { kind: 'pending', analysisId: state.analysisId }
    }
    if (state.state === 'pending') return { kind: 'pending', analysisId: state.analysisId }
  } else if (state.state === 'pending') {
    return { kind: 'pending', analysisId: state.analysisId }
  }

  // Only `acquired` means we own the question. `unavailable` means the store failed
  // and we proceed fail-open: we may call the provider, but we hold nothing, so we
  // must never publish or delete a marker on the strength of it.
  const ownedClaim = state.state === 'acquired'

  const run = await deps.analyze()

  // ── Persist BEFORE publishing ──────────────────────────────────────────────
  // `done:{id}` asserts that a reusable draft EXISTS. Publishing first opened a real
  // window in which a duplicate read `done`, fetched the draft and found nothing.
  let draftSaved = false
  try {
    await deps.saveDraft(run.stored)
    draftSaved = true
  } catch { /* reported below; a failed save simply never advertises itself */ }

  let published = false
  if (ownedClaim) {
    if (run.analyzedOk && draftSaved) {
      published = await complete(fp, analysisId)
    } else {
      // A failed read, or a read whose draft never landed, releases the claim so the
      // customer's own retry may proceed. Caching either would be a lie that lasts
      // 24 hours.
      await release(fp, analysisId)
    }
  }

  return { kind: 'analyzed', stored: run.stored, analyzedOk: run.analyzedOk, degraded: run.degraded, draftSaved, published, ownedClaim }
}
