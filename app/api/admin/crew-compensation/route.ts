// ── Assignment compensation API ──────────────────────────────────────────────
//
// GET  ?assignmentId=route:{token}:{staffId} → current snapshot + full history +
//                                              the effective/legacy resolution
// POST { assignmentId, compensationMode, hourlyRateCents | flatRoutePayCents,
//        compensationSource?, reason?, note?, expectedVersion? }
//                                            → append a new immutable snapshot
//
// Scope: this configures THIS crew member's assignment on THIS job and service date
// only. It deliberately offers no way to rewrite a crew default or a business rule
// as a side effect — those are separate, explicit actions elsewhere, so an operator
// fixing one route can never silently change what everyone earns everywhere.
//
// Gated on `pay:configure` (admin) — the permission that already means "set rates".
// Managers hold `pay:adjust:submit` (submit for approval), not `pay:configure`, so
// they cannot change money here; that split is pre-existing and preserved.
import { NextRequest, NextResponse } from 'next/server'
import { withTenantRoute } from '../../../lib/platform/tenancy/with-tenant-route'
import { requirePermission } from '../_lib/session'
import { withLock } from '../../../lib/kv-lock'
import { auditAdmin } from '../../../lib/audit'
import { listRoutes } from '../../../lib/routes'
import { listBookings, effectiveServiceDate, type Booking } from '../../../lib/bookings'
import { isEnabled } from '../../../lib/platform/flags'
import { parsePunchId } from '../../../lib/time-corrections'
import {
  validateCompensation, appendSnapshot, listSnapshots, currentSnapshot, resolveCompensation,
  attachCompAuditEventId, COMP_LOCK_KEY, type CompensationSnapshot,
} from '../../../lib/crew-compensation'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Target = {
  workType: 'route' | 'booking'
  jobToken: string
  jobNumber: string
  staffId: string
  staffName: string
  serviceDate: string
  legacy: { payCents?: number; paySource?: string }
  jobCompleted: boolean
}

async function resolveAssignment(aid: string): Promise<Target | null> {
  const parsed = parsePunchId(aid)          // same `{type}:{job}:{staff}` shape
  if (!parsed) return null
  const { workType, jobToken, staffId } = parsed

  if (workType === 'route') {
    const r = (await listRoutes(1000)).find(x => x.token === jobToken)
    const a = r?.assignees?.find(x => x.staffId === staffId)
    if (!r || !a) return null
    return {
      workType, jobToken, jobNumber: r.routeNumber, staffId, staffName: a.name, serviceDate: r.routeDate,
      legacy: { payCents: a.payCents, paySource: a.paySource },
      jobCompleted: r.status === 'completed',
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
    legacy: { payCents: a.payCents, paySource: a.paySource },
    jobCompleted: b.status === 'completed' || b.status === 'partially_completed',
  }
}

export const GET = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'pay:view:all')
  if (who instanceof NextResponse) return who

  const aid = new URL(req.url).searchParams.get('assignmentId') || ''
  if (!parsePunchId(aid)) return NextResponse.json({ ok: false, error: 'A valid assignmentId is required.' }, { status: 400 })
  const target = await resolveAssignment(aid)
  if (!target) return NextResponse.json({ ok: false, error: 'Assignment not found.' }, { status: 404 })

  const history = await listSnapshots(aid)
  const current = currentSnapshot(history)
  const resolved = resolveCompensation(current, target.legacy, {
    staffId: target.staffId, workType: target.workType, jobToken: target.jobToken, serviceDate: target.serviceDate,
  })

  return NextResponse.json({
    ok: true,
    assignmentId: aid,
    assignment: {
      staffId: target.staffId, staffName: target.staffName, workType: target.workType,
      jobNumber: target.jobNumber, serviceDate: target.serviceDate, jobCompleted: target.jobCompleted,
    },
    effective: resolved.ok
      ? { mode: resolved.snapshot.compensationMode, hourlyRateCents: resolved.snapshot.hourlyRateCents, flatRoutePayCents: resolved.snapshot.flatRoutePayCents, source: resolved.snapshot.compensationSource }
      : null,
    gap: resolved.ok ? null : resolved.gap,
    version: current?.snapshotVersion ?? 0,
    history,
  })
})

export const POST = withTenantRoute(async (req: NextRequest) => {
  const who = await requirePermission(req, 'pay:configure')
  if (who instanceof NextResponse) return who

  const body = await req.json().catch(() => ({}))
  const aid = String(body?.assignmentId ?? '')
  if (!parsePunchId(aid)) return NextResponse.json({ ok: false, error: 'A valid assignmentId is required.' }, { status: 400 })
  const target = await resolveAssignment(aid)
  if (!target) return NextResponse.json({ ok: false, error: 'Assignment not found.' }, { status: 404 })

  const expectedVersion = body?.expectedVersion === undefined ? undefined : Number(body.expectedVersion)
  if (expectedVersion !== undefined && !Number.isInteger(expectedVersion)) {
    return NextResponse.json({ ok: false, error: 'expectedVersion must be an integer.' }, { status: 400 })
  }

  type Outcome =
    | { kind: 'created'; snapshot: CompensationSnapshot; prior: CompensationSnapshot | null }
    | { kind: 'stale'; currentVersion: number }
    | { kind: 'invalid'; errors: { field: string; message: string }[] }
    | { kind: 'reason_required' }
    | { kind: 'busy' }

  const outcome = await withLock<Outcome>(COMP_LOCK_KEY(aid), async () => {
    const history = await listSnapshots(aid)
    const prior = currentSnapshot(history)

    const validated = validateCompensation({
      compensationMode: body?.compensationMode,
      hourlyRateCents: body?.hourlyRateCents,
      flatRoutePayCents: body?.flatRoutePayCents,
      compensationSource: body?.compensationSource,
      reason: body?.reason,
      note: body?.note,
    })
    if (!validated.ok) return { kind: 'invalid' as const, errors: validated.errors }

    // Re-pricing settled work is allowed but never silent: it must carry a reason.
    if (target.jobCompleted && !validated.value.reason) return { kind: 'reason_required' as const }

    const appended = await appendSnapshot({
      staffId: target.staffId, workType: target.workType, jobToken: target.jobToken,
      jobNumber: target.jobNumber, serviceDate: target.serviceDate,
      value: validated.value, actor: { sub: who.sub, role: who.role }, now: Date.now(), expectedVersion,
    })
    if (!appended.ok) return { kind: 'stale' as const, currentVersion: appended.currentVersion }
    return { kind: 'created' as const, snapshot: appended.snapshot, prior }
  }, {
    ttlMs: 15_000, attempts: 30, backoffMs: 100,
    onBusy: () => ({ kind: 'busy' as const }),
    onStoreError: 'busy',
  })

  switch (outcome.kind) {
    case 'busy':
      return NextResponse.json({ ok: false, reason: 'assignment_busy', error: 'This assignment is being updated right now. Try again in a moment.' }, { status: 423 })
    case 'stale':
      return NextResponse.json({
        ok: false, reason: 'stale_version', currentVersion: outcome.currentVersion,
        error: 'This assignment\'s pay was changed by someone else. Reload before changing it again.',
      }, { status: 409 })
    case 'invalid':
      return NextResponse.json({ ok: false, reason: 'invalid', errors: outcome.errors, error: outcome.errors[0].message }, { status: 400 })
    case 'reason_required':
      return NextResponse.json({
        ok: false, reason: 'reason_required',
        error: 'This job is already completed — a reason is required to change its pay.',
      }, { status: 400 })
    case 'created': {
      const s = outcome.snapshot
      const prior = outcome.prior
      const ev = await auditAdmin(who, 'crew.compensation.set', {
        entity: 'crew_assignment', entityId: aid,
        summary: `Set ${s.compensationMode === 'hourly' ? 'hourly' : 'flat route'} pay for ${target.staffName} on ${target.jobNumber} (${target.serviceDate})`,
        meta: {
          assignmentId: aid, staffId: s.staffId, workType: s.workType, jobToken: s.jobToken,
          jobNumber: s.jobNumber, serviceDate: s.serviceDate,
          previousMode: prior?.compensationMode ?? null,
          newMode: s.compensationMode,
          previousAmountCents: prior ? (prior.hourlyRateCents ?? prior.flatRoutePayCents ?? null) : null,
          newAmountCents: s.hourlyRateCents ?? s.flatRoutePayCents ?? null,
          compensationSource: s.compensationSource,
          afterCompletion: target.jobCompleted,
          reason: s.reason ?? null,
          snapshotVersion: s.snapshotVersion,
        },
      })
      await attachCompAuditEventId(s.compensationSnapshotId, ev.id)
      return NextResponse.json({
        ok: true,
        snapshot: { ...s, auditEventId: ev.id },
        version: s.snapshotVersion,
        // The caller decides how loudly to warn; we only state the fact.
        afterCompletion: target.jobCompleted,
      })
    }
  }
})
