// ── Time-punch corrections API ───────────────────────────────────────────────
//
// GET  ?punchId=route:{token}:{staffId}   → the append-only history for one punch
// POST { punchId, correctedClockIn, correctedClockOut?, correctionReason, note?,
//        expectedVersion? }               → append one correction
//
// Authorization is NOT UI-hiding: both verbs are gated server-side on the existing
// `time:manage` permission (admin + manager), and every key read or written flows
// through the redis chokepoint inside `withTenantRoute`, so a punch belonging to
// another tenant is not addressable — its keys resolve into that tenant's namespace
// and simply do not exist here.
//
// Writes serialize on the shared kv-lock primitive (unique token, compare-and-delete
// release) keyed per PUNCH, so two operators correcting the same punch cannot
// interleave, while unrelated punches never block each other.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { withLock } from '../../../lib/kv-lock'
import { auditAdmin } from '../../../lib/audit'
import { listRoutes } from '../../../lib/routes'
import { listBookings, effectiveServiceDate, type Booking } from '../../../lib/bookings'
import { isEnabled } from '../../../lib/platform/flags'
import {
  parsePunchId, validateCorrection, appendCorrection, listCorrections, effectivePunch,
  attachAuditEventId, LOCK_KEY, type TimeCorrection, type WorkType,
} from '../../../lib/time-corrections'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type PunchTarget = {
  workType: WorkType
  jobToken: string
  jobNumber: string
  staffId: string
  staffName: string
  serviceDate: string
  original: { clockInAt: number | null; clockOutAt: number | null }
}

/**
 * Resolve a punch identity to its live assignee. Returns null when the job or the
 * crew member does not exist IN THIS TENANT — which is also how a cross-tenant id
 * fails, because the lookups are already tenant-scoped.
 */
async function resolvePunch(pid: string): Promise<PunchTarget | null> {
  const parsed = parsePunchId(pid)
  if (!parsed) return null
  const { workType, jobToken, staffId } = parsed

  if (workType === 'route') {
    const routes = await listRoutes(1000)
    const r = routes.find(x => x.token === jobToken)
    const a = r?.assignees?.find(x => x.staffId === staffId)
    if (!r || !a) return null
    return {
      workType, jobToken, jobNumber: r.routeNumber, staffId, staffName: a.name,
      serviceDate: r.routeDate,
      original: { clockInAt: a.clockInAt ?? null, clockOutAt: a.clockOutAt ?? null },
    }
  }

  if (!isEnabled('BOOKING_ASSIGNMENT_ENABLED')) return null
  const bookings: Booking[] = await listBookings(1000)
  const b = bookings.find(x => x.token === jobToken)
  const a = b?.assignees?.find(x => x.staffId === staffId)
  if (!b || !a) return null
  return {
    workType, jobToken, jobNumber: b.bookingNumber, staffId, staffName: a.name,
    serviceDate: effectiveServiceDate(b) ?? '',
    original: { clockInAt: a.clockInAt ?? null, clockOutAt: a.clockOutAt ?? null },
  }
}

const shape = (c: TimeCorrection) => c   // full record — this surface is admin/manager only

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'time:manage')
  if (who instanceof NextResponse) return who

  const pid = new URL(req.url).searchParams.get('punchId') || ''
  if (!parsePunchId(pid)) {
    return NextResponse.json({ ok: false, error: 'A valid punchId is required.' }, { status: 400 })
  }
  const target = await resolvePunch(pid)
  if (!target) return NextResponse.json({ ok: false, error: 'Punch not found.' }, { status: 404 })

  const corrections = await listCorrections(pid)
  const eff = effectivePunch(target.original, corrections)
  return NextResponse.json({
    ok: true,
    punchId: pid,
    punch: {
      staffId: target.staffId, staffName: target.staffName, workType: target.workType,
      jobNumber: target.jobNumber, serviceDate: target.serviceDate,
      originalClockIn: target.original.clockInAt, originalClockOut: target.original.clockOutAt,
      effectiveClockIn: eff.clockInAt, effectiveClockOut: eff.clockOutAt,
      corrected: eff.corrected,
    },
    // The optimistic token the editor must echo back — 0 when never corrected.
    version: corrections.filter(c => c.status === 'active').sort((a, b) => b.version - a.version)[0]?.version ?? 0,
    corrections: corrections.map(shape),
  })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'time:manage')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const pid = String(body?.punchId ?? '')
  if (!parsePunchId(pid)) {
    return NextResponse.json({ ok: false, error: 'A valid punchId is required.' }, { status: 400 })
  }
  const target = await resolvePunch(pid)
  if (!target) return NextResponse.json({ ok: false, error: 'Punch not found.' }, { status: 404 })

  const expectedVersion = body?.expectedVersion === undefined ? undefined : Number(body.expectedVersion)
  if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
    return NextResponse.json({ ok: false, error: 'expectedVersion must be an integer.' }, { status: 400 })
  }

  type Outcome =
    | { kind: 'created'; correction: TimeCorrection; previous: ReturnType<typeof effectivePunch> }
    | { kind: 'stale'; currentVersion: number }
    | { kind: 'invalid'; errors: { field: string; message: string }[] }
    | { kind: 'busy' }

  const outcome = await withLock<Outcome>(LOCK_KEY(pid), async () => {
    // Re-read INSIDE the lock: the effective punch a competing operator may have
    // just changed is what this correction must be validated against.
    const existing = await listCorrections(pid)
    const current = effectivePunch(target.original, existing)

    const validated = validateCorrection({
      correctedClockIn: body?.correctedClockIn,
      correctedClockOut: body?.correctedClockOut,
      correctionReason: body?.correctionReason,
      correctionNote: body?.correctionNote,
    }, { effectiveClockIn: current.clockInAt, effectiveClockOut: current.clockOutAt })
    if (!validated.ok) return { kind: 'invalid' as const, errors: validated.errors }

    const appended = await appendCorrection({
      punchId: pid,
      staffId: target.staffId,
      workType: target.workType,
      jobToken: target.jobToken,
      jobNumber: target.jobNumber,
      serviceDate: target.serviceDate,
      original: target.original,
      value: validated.value,
      actor: { sub: who.sub, role: who.role },
      now: Date.now(),
      expectedVersion,
    })
    if (!appended.ok) return { kind: 'stale' as const, currentVersion: appended.currentVersion }
    return { kind: 'created' as const, correction: appended.correction, previous: current }
  }, {
    ttlMs: 15_000,
    attempts: 30,
    backoffMs: 100,
    // A second identical click waits out the winner and then fails the
    // unchanged-correction rule, so it can never create a duplicate record.
    onBusy: () => ({ kind: 'busy' as const }),
    onStoreError: 'busy',
  })

  switch (outcome.kind) {
    case 'busy':
      return NextResponse.json({
        ok: false, reason: 'punch_busy',
        error: 'This punch is being corrected right now. Try again in a moment.',
      }, { status: 423 })
    case 'stale':
      return NextResponse.json({
        ok: false, reason: 'stale_version', currentVersion: outcome.currentVersion,
        error: 'This punch was corrected by someone else. Reload to see the current time before correcting it.',
      }, { status: 409 })
    case 'invalid':
      return NextResponse.json({ ok: false, reason: 'invalid', errors: outcome.errors, error: outcome.errors[0].message }, { status: 400 })
    case 'created': {
      const c = outcome.correction
      // Post-commit, fail-open, and only on a real change. A superseding correction
      // records BOTH events so the prior record's fate is auditable on its own.
      if (c.supersedesCorrectionId) {
        await auditAdmin(who, 'time.correction.superseded', {
          entity: 'time_punch', entityId: c.punchId,
          summary: `Superseded correction ${c.supersedesCorrectionId} on ${target.jobNumber} (${target.staffName})`,
          meta: { correctionId: c.supersedesCorrectionId, punchId: c.punchId, supersededBy: c.correctionId },
        })
      }
      const ev = await auditAdmin(who, 'time.correction.created', {
        entity: 'time_punch', entityId: c.punchId,
        summary: `Corrected time on ${target.jobNumber} for ${target.staffName} (${target.serviceDate})`,
        meta: {
          correctionId: c.correctionId, punchId: c.punchId, staffId: c.staffId,
          workType: c.workType, jobToken: c.jobToken, jobNumber: c.jobNumber, serviceDate: c.serviceDate,
          previousEffectiveClockIn: c.previousEffectiveClockIn, previousEffectiveClockOut: c.previousEffectiveClockOut,
          correctedClockIn: c.correctedClockIn, correctedClockOut: c.correctedClockOut,
          reason: c.correctionReason, version: c.version,
        },
      })
      await attachAuditEventId(c.correctionId, ev.id)
      return NextResponse.json({ ok: true, correction: { ...c, auditEventId: ev.id }, version: c.version })
    }
  }
})
