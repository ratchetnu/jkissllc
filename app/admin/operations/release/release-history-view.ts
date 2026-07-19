// ── Release History — pure view helpers (Increment 3B.6) ─────────────────────
//
// Presentation-only mapping for the Release History UI. No React, no fetch, no domain logic —
// keeps the history/details components thin and the mapping testable.

import type { Tone } from '../../../components/ui'
import type { ReleaseHistoryStatus, ReleaseKind } from '../../../lib/platform/release/release-history'

export function releaseStatusTone(status: ReleaseHistoryStatus): Tone {
  switch (status) {
    case 'published': return 'good'
    case 'rolled_back': return 'warn'
    case 'publish_failed': case 'rollback_failed': return 'bad'
    case 'publishing': case 'verifying': case 'rolling_back': return 'info'
    default: return 'neutral'
  }
}

export function releaseStatusLabel(status: ReleaseHistoryStatus): string {
  switch (status) {
    case 'published': return 'Published'
    case 'publishing': return 'Publishing'
    case 'verifying': return 'Verifying'
    case 'publish_failed': return 'Publish failed'
    case 'rolling_back': return 'Rolling back'
    case 'rolled_back': return 'Rolled back'
    case 'rollback_failed': return 'Rollback failed'
    default: return status
  }
}

export function releaseKindLabel(kind: ReleaseKind): string {
  return kind === 'rollback' ? 'Rollback' : 'Publish'
}

/** Compact absolute-ish "time ago" for the history list (deterministic on `now`). */
export function historyTimeAgo(at: number | undefined, now: number): string {
  if (!at) return 'Unavailable'
  const m = Math.floor((now - at) / 60000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

/** The set of statuses offered in the history status filter. */
export const RELEASE_STATUS_FILTER_OPTIONS: { value: ReleaseHistoryStatus; label: string }[] = [
  { value: 'published', label: 'Published' },
  { value: 'publish_failed', label: 'Publish failed' },
  { value: 'rolled_back', label: 'Rolled back' },
  { value: 'rollback_failed', label: 'Rollback failed' },
]
