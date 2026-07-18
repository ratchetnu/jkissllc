// ── Status vocabulary — one source of truth ──────────────────────────────────
//
// The app had three parallel status systems: <StatusBadge>'s five tones, the
// operations route/claim maps in app/admin/operations/ui.tsx (hardcoded hexes),
// and portal helpers. This module is the reconciliation layer:
//
//   • `StatusTone` (in tokens.ts) is the canonical six-tone palette.
//   • `routeTone` / `claimTone` map the operational status keys onto a tone, so
//     any screen can render `<StatusBadge tone={routeTone(r.status)}>` and match.
//   • `EXTERNAL_STATUS` is the small, calm vocabulary shown to customers/owners —
//     technical states collapse into: Ready / Updating / Complete / Needs
//     attention / Unavailable (the sprint's STATUS LANGUAGE).
//
// The operations ui.tsx chips keep their exact colors for now (live screens); new
// code should prefer <StatusBadge> + these mappers so everything converges here.

import type { StatusTone } from './tokens'

// Operational route statuses (mirrors RouteStatus in operations/ui.tsx).
const ROUTE_TONE: Record<string, StatusTone> = {
  draft: 'neutral',
  assigned: 'info',
  text_sent: 'warn',
  no_response: 'warn',
  confirmed: 'good',
  completed: 'good',
  declined: 'bad',
  no_show: 'bad',
  cancelled: 'neutral',
}
export const routeTone = (s: string): StatusTone => ROUTE_TONE[s] ?? 'neutral'

// Operational claim statuses (mirrors ClaimStatus in operations/ui.tsx).
const CLAIM_TONE: Record<string, StatusTone> = {
  new: 'info',
  under_review: 'warn',
  waiting_customer: 'warn',
  disputed: 'bad',
  approved: 'accent',
  deduction_active: 'info',
  paid: 'good',
  closed: 'neutral',
  waived: 'neutral',
}
export const claimTone = (s: string): StatusTone => CLAIM_TONE[s] ?? 'neutral'

// ── External status language (calm, small vocabulary) ────────────────────────
export type ExternalStatus = 'ready' | 'updating' | 'complete' | 'attention' | 'unavailable'

export const EXTERNAL_STATUS: Record<ExternalStatus, { label: string; tone: StatusTone }> = {
  ready: { label: 'Ready', tone: 'info' },
  updating: { label: 'Updating', tone: 'warn' },
  complete: { label: 'Complete', tone: 'good' },
  attention: { label: 'Needs attention', tone: 'bad' },
  unavailable: { label: 'Unavailable', tone: 'neutral' },
}
