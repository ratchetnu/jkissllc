// ─────────────────────────────────────────────────────────────────────────────
// Second-opinion AI reviewer (the "monitor agent"). An independent vision pass
// (ops.junkAnalysisReview) that audits the primary estimator's output against the
// same photos and returns a verdict: accept / range / review, plus its own
// truck-fill read. Runs verify-before-commit — only when we're about to hand out
// an INSTANT quote — so the extra call buys accuracy exactly where it matters.
// Fail-soft: if the reviewer errors, we keep the primary analysis unchanged.
// The reviewer never sets a price.
// ─────────────────────────────────────────────────────────────────────────────

import type { ModelMessage } from 'ai'
import { runAiTask } from './service'
import { resolveAiPhotoUrls } from './photo-optimize'
import { imageOptimizationEnabled } from './image-optimize-config'
import type { JunkPhotoAnalysis } from './analysis-schema'

export type CriticRecommend = 'accept' | 'range' | 'review'
export type CriticVerdict = {
  agrees: boolean
  recommend: CriticRecommend
  adjustedTruckLoadFraction?: number
  confidence: number
  concerns: string[]
  model?: string
  callId?: string
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))
const clamp01 = (v: unknown) => { const n = Number(v); return Number.isFinite(n) ? clamp(n, 0, 1) : 0 }

// Whether the reviewer should run — gated so it only spends a call when the first
// pass is about to auto-quote. Off via env AI_JUNK_CRITIC=off.
export function criticEnabled(): boolean {
  return process.env.AI_JUNK_CRITIC !== 'off'
}

// How the reviewer inspects the estimate:
//  • 'vision' — the original behaviour: attach the photos and cross-check the read
//    against the pixels (catches a mis-read; costs a full second vision call +
//    image re-download).
//  • 'json'   — inspect the STRUCTURED analysis numbers only, no images: a cheap
//    internal-consistency + plausibility sanity check (no second vision pass, no
//    Blob re-download, far fewer input tokens). The reconciliation downstream is
//    identical — the verdict shape is the same either way.
// The caller (photo-estimate) picks the mode by confidence: JSON for confident
// instant quotes, vision for the borderline ones where a pixel mis-read is plausible.
export type CriticMode = 'vision' | 'json'

// The borderline band just ABOVE the instant-quote confidence thresholds
// (overall ≥ 0.70, volume ≥ 0.60 in quote-decision). Inside this band a pixel
// mis-read is most plausible, so a full vision re-check earns its cost; above it a
// confident instant quote gets the cheap JSON sanity check instead.
export const CRITIC_VISION_OVERALL_MAX = 0.80
export const CRITIC_VISION_VOLUME_MAX = 0.70

/**
 * Decide how the critic inspects an about-to-auto-quote estimate. Pure + testable.
 *  • jsonEnabled=false → always 'vision' (byte-identical to the original behaviour).
 *  • jsonEnabled=true  → 'vision' only for borderline-confidence reads (where a
 *    mis-read could flip the quote), else the cheap 'json' pass — no second vision
 *    call, no image re-download.
 */
export function criticModeFor(confidence: { overall: number; volume: number }, jsonEnabled: boolean): CriticMode {
  if (!jsonEnabled) return 'vision'
  const borderline = confidence.overall < CRITIC_VISION_OVERALL_MAX || confidence.volume < CRITIC_VISION_VOLUME_MAX
  return borderline ? 'vision' : 'json'
}

export async function reviewJunkAnalysis(input: {
  analysis: JunkPhotoAnalysis
  photoUrls: string[]
  serviceLabel?: string
  mode?: CriticMode          // defaults to 'vision' (backward-compatible)
}): Promise<CriticVerdict | null> {
  const mode: CriticMode = input.mode ?? 'vision'
  const allowed = input.photoUrls.filter(u => /^https?:\/\/\S+$/i.test(u)).slice(0, 8)
  // Review the SAME (optimized) images the primary estimator saw when optimization
  // is on; original URLs otherwise. Byte-identical to today when the flag is off.
  const { urls: photos } = await resolveAiPhotoUrls(allowed, { enabled: imageOptimizationEnabled() })
  // Vision mode needs at least one photo; JSON mode reviews the numbers alone.
  if (mode === 'vision' && photos.length === 0) return null

  // Give the reviewer a compact summary of the estimate to critique (not the whole
  // blob — the numbers that matter for a sanity check).
  const a = input.analysis
  const summary = {
    items: a.normalizedItems.map(i => ({ label: i.label, qty: i.estimatedQuantity, cuYd: i.estimatedVolumeCubicYards, heavy: i.heavy })),
    totalVolumeCuYd: a.totalEstimatedVolumeCubicYards.likely,
    truckLoadFraction: a.estimatedTruckLoadFraction.likely,
    truckLoads: a.estimatedTruckLoads.likely,
    weightLb: a.totalEstimatedWeightPounds.likely,
    conditions: a.detectedConditions,
    confidence: a.confidence.overall,
  }
  const useVision = mode === 'vision'
  const prompt = useVision
    ? `${input.serviceLabel ? `Service: ${input.serviceLabel}. ` : ''}Estimator's JSON to review:\n${JSON.stringify(summary)}\n\nReview it against these ${photos.length} photo(s). Return ONLY the verdict JSON.`
    : `${input.serviceLabel ? `Service: ${input.serviceLabel}. ` : ''}Estimator's JSON to review:\n${JSON.stringify(summary)}\n\nWithout the photos, review these numbers for INTERNAL CONSISTENCY and PLAUSIBILITY only (do the item list, volume, truck-load fraction, truck loads, and weight agree with each other and with typical junk-removal loads?). If they are self-consistent and plausible, accept; if something looks off or too uncertain, recommend a range or review. Return ONLY the verdict JSON.`
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string }> = [
    { type: 'text', text: prompt },
    ...(useVision ? photos.map(url => ({ type: 'image' as const, image: url })) : []),
  ]
  const messages: ModelMessage[] = [{ role: 'user', content }]

  const res = await runAiTask({
    taskId: 'ops.junkAnalysisReview', feature: 'ops.junkAnalysisReview',
    vars: {}, messages, maxOutputTokens: 500, temperature: 0.1,
    requestChars: useVision ? photos.join(',').length : JSON.stringify(summary).length,
    // Telemetry attribution: an independent second-opinion (fallback/backup) pass.
    // imageCount distinguishes a vision pass (>0) from the JSON-only pass (0).
    kind: 'fallback', imageCount: useVision ? photos.length : 0,
  })
  if (!res.ok) return null

  let raw: Record<string, unknown> = {}
  try { const m = res.text.match(/\{[\s\S]*\}/); if (m) raw = JSON.parse(m[0]) } catch { return null }

  const rec = String(raw.recommend ?? '').toLowerCase()
  const recommend: CriticRecommend = rec === 'accept' ? 'accept' : rec === 'review' ? 'review' : 'range'
  const fr = Number(raw.adjustedTruckLoadFraction)
  return {
    agrees: raw.agrees === true,
    recommend,
    adjustedTruckLoadFraction: Number.isFinite(fr) && fr > 0 ? clamp(fr, 0.02, 6) : undefined,
    confidence: clamp01(raw.confidence),
    concerns: Array.isArray(raw.concerns) ? raw.concerns.filter(c => typeof c === 'string').slice(0, 8).map(c => (c as string).slice(0, 240)) : [],
    model: res.model,
    callId: res.callId,
  }
}

// Reconcile the reviewer's verdict into the analysis BEFORE final pricing. We never
// blindly take the reviewer's number; we act CONSERVATIVELY:
//  • recommend 'review'  → force manual review
//  • recommend 'range'   → drop confidence below the instant threshold
//  • fractions disagree materially → widen the fill range to cover BOTH reads and
//    fall back to a range (don't auto-commit to either number)
export function reconcileWithCritic(a: JunkPhotoAnalysis, v: CriticVerdict): JunkPhotoAnalysis {
  const reasons = new Set(a.reviewReasons)
  let overall = a.confidence.overall
  let volumeConf = a.confidence.volume
  let fraction = { ...a.estimatedTruckLoadFraction }
  let reviewRequired = a.reviewRequired

  if (v.recommend === 'review') {
    reviewRequired = true
    v.concerns.forEach(c => reasons.add(`Reviewer: ${c}`))
    if (v.concerns.length === 0) reasons.add('Second-opinion reviewer flagged this estimate for manual review.')
  } else if (v.recommend === 'range') {
    overall = Math.min(overall, 0.6)
    v.concerns.forEach(c => reasons.add(`Reviewer: ${c}`))
  }

  // Materially different fill reads → widen + don't auto-commit.
  if (v.adjustedTruckLoadFraction) {
    const primary = a.estimatedTruckLoadFraction.likely
    const diff = Math.abs(v.adjustedTruckLoadFraction - primary) / Math.max(0.05, primary)
    if (diff > 0.25) {
      const lo = Math.min(primary, v.adjustedTruckLoadFraction)
      const hi = Math.max(primary, v.adjustedTruckLoadFraction)
      fraction = { minimum: lo, likely: (lo + hi) / 2, maximum: hi }
      overall = Math.min(overall, 0.6)
      volumeConf = Math.min(volumeConf, 0.55)
      reasons.add(`Estimator and reviewer disagree on size (${Math.round(primary * 100)}% vs ${Math.round(v.adjustedTruckLoadFraction * 100)}% of a truck).`)
    }
  }

  return {
    ...a,
    estimatedTruckLoadFraction: fraction,
    confidence: { ...a.confidence, overall, volume: volumeConf },
    reviewRequired,
    reviewReasons: Array.from(reasons),
  }
}
