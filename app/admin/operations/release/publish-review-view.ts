// ── Publish Review UI — pure view helpers (Increment 3B.2C) ──────────────────
//
// Pure presentation logic for the READ-ONLY Publish Review interface. No React, no
// fetch, no domain mutation. Keeps the drawer thin and the logic testable.

import type { PublishReview } from '../../../lib/platform/release/publish-review'
import type { RiskLevel } from '../../../components/ui/deliberate-action-logic'
import type { Tone } from '../../../components/ui'

/** The secondary "Review release" entry appears when a verified candidate is ready to
 *  review (the resolver's publish gate). It is read-only — visibility ≠ approval. */
export function showReviewRelease(action: string): boolean {
  return action === 'publish'
}

/** Display an optional value, or the literal "Unavailable" — never invent a value. */
export const orUnavailable = (v: string | number | undefined | null): string =>
  v === undefined || v === null || v === '' ? 'Unavailable' : String(v)

export function verificationAgeLabel(ms: number | undefined): string {
  if (ms == null) return 'Unavailable'
  const m = Math.floor(ms / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export type ReviewBanner = { level: RiskLevel; title: string; detail?: string }

/** The single overall risk/status banner for the review. Deliberately never uses
 *  "approved"/"published" language — this is a review, nothing is published. */
export function overallReviewBanner(review: PublishReview, warnings: string[]): ReviewBanner {
  if (review.business.testOnly) {
    return { level: 'warning', title: 'Test-only business', detail: 'Refused for production promotion by default — review only.' }
  }
  const e = review.eligibility
  if (!e.eligible) {
    const top = e.blockingReasons?.[0]?.message
    return { level: 'warning', title: 'Not eligible to publish', detail: `${e.failed} check(s) blocking${top ? ` — ${top}` : ''}. Review only — nothing ships from here.` }
  }
  const missing = warnings.length > 0 || !review.version.candidate || !review.rollback.ready
  if (e.warnings > 0 || missing) {
    return { level: 'warning', title: 'Eligible with warnings', detail: missing ? 'Some review data is unavailable (see below).' : `${e.warnings} warning(s). Review only.` }
  }
  return { level: 'success', title: 'Eligible for review', detail: 'All checks passed. This is a review only — nothing ships from here.' }
}

// ── Dashboard derivations (pure — power the compact summary UI) ───────────────

/** Map the design-system RiskLevel to a status Tone (for badges / metric cards). */
export function riskToTone(level: RiskLevel): Tone {
  return level === 'success' ? 'good' : level === 'warning' ? 'warn' : level === 'destructive' ? 'bad' : 'info'
}

/** A short status pill for the overall eligibility state. */
export function eligibilityPill(review: PublishReview): { tone: Tone; label: string } {
  const e = review.eligibility
  if (e.failed > 0) return { tone: 'bad', label: `${e.failed} blocking` }
  if (e.warnings > 0) return { tone: 'warn', label: `${e.warnings} warning${e.warnings === 1 ? '' : 's'}` }
  return e.eligible ? { tone: 'good', label: 'Eligible' } : { tone: 'neutral', label: 'Not eligible' }
}

/** Preview verification state as a single label + tone. */
export function previewPill(review: PublishReview): { tone: Tone; label: string } {
  const p = review.preview
  if (p.verified) return { tone: 'good', label: 'Verified' }
  if (p.deploymentId) return { tone: 'info', label: p.readyState ?? 'Building' }
  return { tone: 'neutral', label: 'Unavailable' }
}

/** Rollback readiness as a single label + tone. */
export function rollbackPill(review: PublishReview): { tone: Tone; label: string } {
  const r = review.rollback
  if (!r.ready) return { tone: 'warn', label: 'Not ready' }
  return r.metadataComplete === false ? { tone: 'info', label: 'Partial' } : { tone: 'good', label: 'Ready' }
}

/** High-risk file count when known (verified evidence), else null (Unavailable). */
export function highRiskCount(review: PublishReview): number | null {
  const fc = review.filesChanged
  if (fc.highRiskDetails) return fc.highRiskDetails.length
  if (fc.highRiskFiles == null) return null
  return fc.highRiskFiles ? 1 : 0
}

export type SummaryMetric = { key: string; label: string; value: string; tone: Tone; hint?: string }

/** The six compact summary cards. Every value degrades to "Unavailable" — never invented. */
export function summaryMetrics(review: PublishReview, warnings: string[]): SummaryMetric[] {
  const fc = review.filesChanged
  const e = review.eligibility
  const hr = highRiskCount(review)
  const info = groupedWarnings(review, warnings).informational.length
  const prev = previewPill(review)
  const roll = rollbackPill(review)
  const filesValue = fc.available === false ? 'Unavailable' : fc.identical ? '0' : orUnavailable(fc.fileCount)
  return [
    { key: 'files', label: 'Files changed', value: filesValue, tone: 'neutral', hint: fc.available === false ? 'read at execution' : fc.identical ? 'no changes' : `+${fc.additions ?? 0} / −${fc.deletions ?? 0}` },
    { key: 'highRisk', label: 'High-risk files', value: hr == null ? 'Unavailable' : String(hr), tone: hr && hr > 0 ? 'bad' : 'good' },
    { key: 'warnings', label: 'Warnings', value: String(info), tone: info > 0 ? 'warn' : 'good' },
    { key: 'blocking', label: 'Blocking issues', value: String(e.failed), tone: e.failed > 0 ? 'bad' : 'good' },
    { key: 'preview', label: 'Preview', value: prev.label, tone: prev.tone },
    { key: 'rollback', label: 'Rollback', value: roll.label, tone: roll.tone },
  ]
}

export type WarningGroups = { blocking: { code: string; message: string }[]; informational: string[] }

/** Separate hard blockers (eligibility) from informational provider/data warnings, and
 *  de-duplicate the informational list (identical messages collapse to one). */
export function groupedWarnings(review: PublishReview, warnings: string[]): WarningGroups {
  return { blocking: review.eligibility.blockingReasons ?? [], informational: [...new Set(warnings)] }
}

/** How many list items to show before an accessible "show more" disclosure. */
export const FILE_PREVIEW_LIMIT = 8

/** Split a changed-file list into a shown head + hidden tail count (never a giant list). */
export function splitFileList(paths: string[] | undefined, limit = FILE_PREVIEW_LIMIT): { shown: string[]; remaining: number } {
  const list = paths ?? []
  return { shown: list.slice(0, limit), remaining: Math.max(0, list.length - limit) }
}
