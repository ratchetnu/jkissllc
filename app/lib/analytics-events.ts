import { redis } from './redis'

// ─────────────────────────────────────────────────────────────────────────────
// Lightweight, durable funnel-event counters for the AI quote flow (Phase 12/13).
// Saved server-side in Redis (never browser state): one INCR counter per UTC day
// per event (`funnel:{YYYY-MM-DD}:{event}`), TTL'd so old days expire. Cheap to
// write, cheap to roll up for the dashboard. Uses only the common Redis commands
// available in both repos (incr/get/pexpire). Detailed per-call AI metrics
// (model/cost/latency/confidence/outcome) already live in the AI audit log
// (app/lib/ai/telemetry.ts) — this is the stage funnel that log doesn't model.
// ─────────────────────────────────────────────────────────────────────────────

export type FunnelEvent =
  | 'quote_analyze_started'
  | 'ai_analysis_completed'
  | 'ai_analysis_failed'
  | 'instant_quote_displayed'
  | 'estimate_range_displayed'
  | 'manual_review_required'
  | 'quote_request_persisted'
  // ── Guided customer inventory-confirmation flow (Phase 2, Part 17) ──
  | 'confirmation_started'
  | 'confirmation_item_corrected'
  | 'confirmation_conflict_detected'
  | 'confirmation_attested'
  | 'confirmation_submitted'
  | 'final_analysis_started'
  | 'final_analysis_completed'
  | 'final_routed_owner_approval'
  | 'final_routed_manual_review'
  | 'confirmation_resumed'

export const FUNNEL_EVENTS: FunnelEvent[] = [
  'quote_analyze_started', 'ai_analysis_completed', 'ai_analysis_failed',
  'instant_quote_displayed', 'estimate_range_displayed', 'manual_review_required',
  'quote_request_persisted',
  'confirmation_started', 'confirmation_item_corrected', 'confirmation_conflict_detected',
  'confirmation_attested', 'confirmation_submitted', 'final_analysis_started',
  'final_analysis_completed', 'final_routed_owner_approval', 'final_routed_manual_review',
  'confirmation_resumed',
]

const RETENTION_MS = 200 * 24 * 60 * 60 * 1000
const key = (iso: string, name: string) => `funnel:${iso.slice(0, 10)}:${name}`

// Fire-and-forget; analytics must never break the request path.
export async function recordFunnelEvent(name: FunnelEvent, nowIso: string): Promise<void> {
  try {
    const k = key(nowIso, name)
    const n = await redis.incr(k)
    if (n === 1) await redis.pexpire(k, RETENTION_MS)
  } catch { /* best-effort */ }
}

// Roll up the last N days into { event: total } and a per-day series.
export async function getFunnel(days = 30, nowMs = Date.now()): Promise<{
  totals: Record<string, number>
  byDay: Array<{ day: string; counts: Record<string, number> }>
}> {
  const totals: Record<string, number> = {}
  const byDay: Array<{ day: string; counts: Record<string, number> }> = []
  for (let i = days - 1; i >= 0; i--) {
    const iso = new Date(nowMs - i * 86_400_000).toISOString().slice(0, 10)
    const counts: Record<string, number> = {}
    await Promise.all(FUNNEL_EVENTS.map(async (ev) => {
      let raw: string | null = null
      try { raw = await redis.get(`funnel:${iso}:${ev}`) } catch { raw = null }
      const v = raw ? parseInt(raw, 10) || 0 : 0
      if (v) { counts[ev] = v; totals[ev] = (totals[ev] ?? 0) + v }
    }))
    byDay.push({ day: iso, counts })
  }
  return { totals, byDay }
}
