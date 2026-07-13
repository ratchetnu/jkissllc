// ─────────────────────────────────────────────────────────────────────────────
// Deterministic consistency monitor for a JunkPhotoAnalysis (the always-on QA
// layer). Zero AI cost, fully auditable: it cross-checks the vision model's OWN
// numbers for internal consistency and penalizes confidence / forces review when
// they don't line up. A single model pass can be confidently self-contradictory
// (e.g. "0.3 truck load" but items summing to 15 cu yd); this catches that before
// the deterministic pricing engine trusts the read.
//
// It never invents a price and never edits the numbers silently — it produces a
// report (concerns + confidence penalty + forceReview) that the analyze route
// applies transparently and stores alongside the estimate.
// ─────────────────────────────────────────────────────────────────────────────

import type { JunkPhotoAnalysis } from './analysis-schema'

const TRUCK_CUBIC_YARDS = 44   // 24 ft box truck ≈ 1,200 cu ft ≈ 44 cu yd

export type MonitorSeverity = 'info' | 'warn' | 'block'
export type MonitorConcern = { code: string; message: string; severity: MonitorSeverity }
export type MonitorReport = {
  concerns: MonitorConcern[]
  confidencePenalty: number   // 0..0.5 subtracted from confidence.overall
  forceReview: boolean        // any 'block' concern
}

const ratio = (a: number, b: number) => (b <= 0 ? (a <= 0 ? 1 : Infinity) : a / b)

export function monitorAnalysis(a: JunkPhotoAnalysis): MonitorReport {
  const concerns: MonitorConcern[] = []
  let penalty = 0
  const add = (code: string, message: string, severity: MonitorSeverity, pen = 0) => {
    concerns.push({ code, message, severity }); penalty += pen
  }

  const itemsVolume = a.normalizedItems.reduce((s, i) => s + i.estimatedVolumeCubicYards * i.estimatedQuantity, 0)
  const totalVolume = a.totalEstimatedVolumeCubicYards.likely
  const fraction = a.estimatedTruckLoadFraction.likely
  const loads = a.estimatedTruckLoads.likely
  const weight = a.totalEstimatedWeightPounds.likely

  // 1) Item volumes should roughly sum to the reported total volume.
  if (a.normalizedItems.length > 0 && totalVolume > 0) {
    const r = ratio(itemsVolume, totalVolume)
    if (r > 2.2 || r < 0.45) {
      add('volume_sum_mismatch', `Item volumes (${itemsVolume.toFixed(1)} cu yd) disagree with the reported total (${totalVolume.toFixed(1)} cu yd).`, 'warn', 0.12)
    }
  }

  // 2) Truck fraction should track total volume ÷ truck capacity.
  if (totalVolume > 0) {
    const impliedFraction = totalVolume / TRUCK_CUBIC_YARDS
    const r = ratio(fraction, impliedFraction)
    if (r > 2.5 || r < 0.4) {
      add('fraction_volume_mismatch', `Truck fill ${Math.round(fraction * 100)}% doesn't match the volume read (~${Math.round(impliedFraction * 100)}%).`, 'warn', 0.15)
    }
  }

  // 3) Loads should be ceil(fraction) within tolerance.
  const expectedLoads = Math.max(1, Math.ceil(fraction - 1e-9))
  if (Math.abs(loads - expectedLoads) >= 1) {
    add('loads_fraction_mismatch', `Truck loads (${loads}) don't match the fill fraction (~${expectedLoads}).`, 'warn', 0.08)
  }

  // 4) Weight density plausibility (lb per cu yd). Typical mixed junk ~150–400;
  // dense debris higher. Flag physically implausible densities.
  if (totalVolume > 0.5 && weight > 0) {
    const density = weight / totalVolume
    if (density > 900 && !a.detectedConditions.concreteOrSoilPossible) {
      add('weight_dense_unflagged', `Very high density (${Math.round(density)} lb/cu yd) but no dense-debris flag — possible weight risk.`, 'block')
    } else if (density > 1500) {
      add('weight_implausible', `Implausible density (${Math.round(density)} lb/cu yd).`, 'warn', 0.1)
    } else if (density < 20) {
      add('weight_too_low', `Weight looks too low for the volume (${Math.round(density)} lb/cu yd).`, 'warn', 0.08)
    }
  }

  // 5) Confidence justified by the evidence.
  const usableItems = a.normalizedItems.filter(i => i.confidence >= 0.4).length
  if (a.confidence.overall > 0.75 && usableItems === 0 && a.normalizedItems.length > 0) {
    add('overconfident', 'High overall confidence but no individual item is confidently identified.', 'warn', 0.15)
  }
  const limitedPhotos = a.photoObservations.filter(p => p.imageQuality === 'limited' || p.imageQuality === 'unusable').length
  if (a.confidence.overall > 0.7 && limitedPhotos >= a.photoObservations.length && a.photoObservations.length > 0) {
    add('confidence_vs_quality', 'High confidence despite limited/unusable photo quality.', 'warn', 0.12)
  }

  // 6) Single photo → hidden-volume risk on anything but a tiny load.
  if (a.photoObservations.length <= 1 && fraction > 0.3) {
    add('single_photo_hidden_volume', 'Only one photo for a non-trivial load — back/side volume is unverified.', 'info', 0.05)
  }

  return { concerns, confidencePenalty: Math.min(0.5, penalty), forceReview: concerns.some(c => c.severity === 'block') }
}

// Apply the monitor to the analysis: lower overall confidence and, on a block,
// force review — transparently appending the reasons. Returns a NEW analysis.
export function applyMonitor(a: JunkPhotoAnalysis, report: MonitorReport): JunkPhotoAnalysis {
  if (report.concerns.length === 0) return a
  const overall = Math.max(0, a.confidence.overall - report.confidencePenalty)
  const extraReasons = report.concerns.filter(c => c.severity !== 'info').map(c => `Consistency check: ${c.message}`)
  return {
    ...a,
    confidence: { ...a.confidence, overall },
    reviewRequired: a.reviewRequired || report.forceReview,
    reviewReasons: Array.from(new Set([...a.reviewReasons, ...(report.forceReview ? extraReasons : [])])),
    warnings: Array.from(new Set([...a.warnings, ...report.concerns.filter(c => c.severity === 'warn').map(c => c.message)])),
  }
}
