// ── Publish Review UI — pure view helpers (Increment 3B.2C) ──────────────────
//
// Pure presentation logic for the READ-ONLY Publish Review interface. No React, no
// fetch, no domain mutation. Keeps the drawer thin and the logic testable.

import type { PublishReview } from '../../../lib/platform/release/publish-review'
import type { RiskLevel } from '../../../components/ui/deliberate-action-logic'

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
