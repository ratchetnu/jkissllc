import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { getAlert, saveAlert, applyAlertTransition, type AlertTransition } from '../../../../lib/estimation/shadow-alert-store'
import { getShadowJob } from '../../../../lib/estimation/shadow-store'
import { policyById } from '../../../../lib/estimation/shadow-alert-policies'
import { recordPlatformAudit, listPlatformAuditForRef, isShadowAlertAuditAction } from '../../../../lib/platform/updates/audit'
import type { V2ShadowJob } from '../../../../lib/estimation/shadow-types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const MAX_RELATED = 25

/** The evaluations an alert points at, trimmed to what the detail view actually shows.
 *  Raw model output is deliberately NOT included — the drill-down page owns that. */
type RelatedEvaluation = {
  bookingId: string
  bookingNumber?: string
  status: string
  model?: string
  promptVersion?: number
  completedAt?: number
  latencyMs?: number
  traceId?: string
  classification?: string
  outcome?: string
  shadowManualReview?: boolean
  authoritativeDecision?: string
  quoteDeltaUsd?: number
}

const toRelated = (j: V2ShadowJob): RelatedEvaluation => ({
  bookingId: j.bookingId,
  bookingNumber: j.bookingNumber,
  status: j.status,
  model: j.model,
  promptVersion: j.promptVersion,
  completedAt: j.completedAt,
  latencyMs: j.latencyMs,
  traceId: j.traceId,
  classification: j.classification,
  outcome: j.comparison?.outcome,
  shadowManualReview: j.comparison?.shadowManualReview,
  authoritativeDecision: j.comparison?.authoritativeDecision,
  quoteDeltaUsd: j.comparison?.quoteDeltaUsd,
})

// GET /api/admin/shadow-alerts/[id] — one alert with everything needed to judge it:
// the policy that fired, the evaluations behind it, the readiness snapshot at detection,
// and the full owner audit timeline. Platform-owner only + SHADOW_ALERTING_ENABLED.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ALERTING_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })

  const { id } = await params
  const alert = await getAlert(id)
  if (!alert) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Related evaluations are read live rather than copied onto the alert, so the detail view
  // reflects the owner's LATEST classification of each booking, not a stale snapshot.
  const related: RelatedEvaluation[] = []
  for (const bookingId of alert.relatedBookingIds.slice(0, MAX_RELATED)) {
    try {
      const j = await getShadowJob(bookingId)
      if (j) related.push(toRelated(j))
    } catch { /* a missing evaluation must not break the alert view */ }
  }

  const audit = await listPlatformAuditForRef({ alertId: alert.id }, 100)
  return NextResponse.json({ enabled: true, alert, policy: policyById(alert.policyId), related, audit })
})

// POST — owner action on an alert (audited): acknowledge / resolve / mute / unmute / note /
// mark_read. Owner-only + flag-gated. The decision is made by the PURE applyAlertTransition;
// this route only authorizes, persists, and attributes it.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ id: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ALERTING_ENABLED')) return NextResponse.json({ error: 'alerting disabled' }, { status: 403 })

  const { id } = await params
  const alert = await getAlert(id)
  if (!alert) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = parseTransition(body)
  if (!action) return NextResponse.json({ error: 'invalid action' }, { status: 400 })

  const actor = (await getPrincipal(req))?.sub || 'owner'
  const result = applyAlertTransition(alert, action, actor, Date.now())
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })

  await saveAlert(result.alert)
  // Attribute it BEFORE returning: an owner silencing a CRITICAL safety alert must be
  // explainable months later. recordPlatformAudit is fail-soft, so a Redis blip degrades
  // the trail rather than the action.
  await recordPlatformAudit({
    actor,
    actorType: 'owner',
    source: 'shadow-alerts',
    action: isShadowAlertAuditAction(result.auditAction) ? result.auditAction : 'status.manual_correction',
    alertId: result.alert.id,
    priorStatus: result.priorStatus,
    newStatus: result.newStatus,
    summary: result.summary,
    meta: {
      policyType: result.alert.policyType,
      severity: result.alert.severity,
      scope: result.alert.scopeKey,
      ...(action.type === 'mute' ? { mutedUntil: result.alert.mutedUntil } : {}),
      ...(action.type === 'resolve' ? { resolvedReason: result.alert.resolvedReason } : {}),
    },
  })
  return NextResponse.json({ ok: true, alert: result.alert })
})

const DAY = 24 * 60 * 60 * 1000
const MUTE_PRESETS: Record<string, number> = { '1h': 60 * 60 * 1000, '24h': DAY, '7d': 7 * DAY, '30d': 30 * DAY }

function parseTransition(body: unknown): AlertTransition | null {
  const b = (body ?? {}) as Record<string, unknown>
  switch (b.action) {
    case 'acknowledge': return { type: 'acknowledge' }
    case 'mark_read':   return { type: 'mark_read' }
    case 'unmute':      return { type: 'unmute' }
    case 'resolve':     return { type: 'resolve', reason: typeof b.reason === 'string' ? b.reason : undefined }
    case 'note':        return typeof b.note === 'string' ? { type: 'note', note: b.note } : null
    case 'mute': {
      // Presets only — a free-form duration is how a "temporary" mute becomes permanent.
      const d = typeof b.duration === 'string' ? MUTE_PRESETS[b.duration] : undefined
      return d ? { type: 'mute', durationMs: d } : null
    }
    default: return null
  }
}
