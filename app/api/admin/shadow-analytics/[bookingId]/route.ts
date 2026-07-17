import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../../lib/platform/tenancy/with-tenant-route'
import { requirePlatformOwner, getPrincipal } from '../../_lib/session'
import { isEnabled } from '../../../../lib/platform/flags'
import { getShadowJob, saveShadowJob } from '../../../../lib/estimation/shadow-store'
import { getBookingByToken } from '../../../../lib/bookings'
import { applyShadowAction, isClassification, type ShadowAction } from '../../../../lib/estimation/shadow-classification'
import { recordPlatformAudit, listPlatformAuditForRef } from '../../../../lib/platform/updates/audit'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

// One evaluation, for the owner workspace drill-down. Platform-owner only +
// SHADOW_ANALYTICS_ENABLED. Reuses the persisted V2ShadowJob (full V1↔V2 comparison, raw+
// normalized output, telemetry, versions, trace) + the booking's photos + the audit trail.
export const GET = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ enabled: false }, { status: 200 })
  const { bookingId } = await params
  const job = await getShadowJob(bookingId)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Photos come from the booking (never duplicated onto the shadow job).
  let photos: string[] = []
  try {
    const b = await getBookingByToken(bookingId)
    const raw = (b as unknown as { invoicePhotos?: Array<{ url?: string } | string> } | null)?.invoicePhotos ?? []
    photos = raw.map((p) => (typeof p === 'string' ? p : p?.url)).filter((u): u is string => typeof u === 'string')
  } catch { /* booking may be gone — job still viewable */ }

  const audit = await listPlatformAuditForRef({ jobId: job.shadowJobId }, 100)
  return NextResponse.json({ enabled: true, job, photos, audit })
})

// Owner action (audited): classify / assign / note / clear. Owner-only + flag-gated.
export const POST = withTenantRoute(async (req: NextRequest, { params }: { params: Promise<{ bookingId: string }> }) => {
  const who = await requirePlatformOwner(req)
  if (who instanceof NextResponse) return who
  if (!isEnabled('SHADOW_ANALYTICS_ENABLED')) return NextResponse.json({ error: 'analytics disabled' }, { status: 403 })
  const { bookingId } = await params
  const job = await getShadowJob(bookingId)
  if (!job) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = parseAction(body)
  if (!action) return NextResponse.json({ error: 'invalid action' }, { status: 400 })
  const actor = (await getPrincipal(req))?.sub || 'owner'
  const now = Date.now()

  const result = applyShadowAction(job, action, actor, now)
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 })
  await saveShadowJob(result.job)
  await recordPlatformAudit({
    actor, actorType: 'owner', source: 'shadow-workspace', action: result.auditAction as never,
    jobId: job.shadowJobId, businessId: undefined, updateKey: undefined,
    priorStatus: result.priorStatus, newStatus: result.newStatus, summary: result.summary, traceId: job.traceId,
  })
  return NextResponse.json({ ok: true, job: result.job })
})

function parseAction(body: unknown): ShadowAction | null {
  const b = (body ?? {}) as Record<string, unknown>
  const type = b.action
  if (type === 'classify' && isClassification(b.classification)) return { type: 'classify', classification: b.classification }
  if (type === 'clear_classification') return { type: 'clear_classification' }
  if (type === 'assign' && typeof b.assignee === 'string') return { type: 'assign', assignee: b.assignee }
  if (type === 'note' && typeof b.note === 'string') return { type: 'note', note: b.note }
  return null
}
