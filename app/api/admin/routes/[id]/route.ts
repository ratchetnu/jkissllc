import { NextRequest, NextResponse } from 'next/server'
import { requireSession } from '../../_lib/session'
import {
  getRouteByToken, saveRoute, deleteRoute, setStatus, pushAudit,
  confirmVerbally, undoVerbalConfirm,
  ROUTE_STATUS_LABEL, type RouteStatus,
} from '../../../../lib/routes'
import { addCrew, removeCrew, sendAssignmentText } from '../../../../lib/route-notify'
import { listStaff } from '../../../../lib/staff'
import {
  parseMoneyCents, snapshotManualPrice, snapshotCrewPay, clearCrewPay, computeRouteMoney,
  payExceedsPrice, fmtCents, isFrozen,
} from '../../../../lib/finance'

const S = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '')

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  const route = await getRouteByToken(id)
  if (!route) return NextResponse.json({ error: 'Route not found.' }, { status: 404 })

  const body = await req.json().catch(() => ({}))
  const action = S(body.action, 40)
  let smsWarning: string | undefined

  if (action === 'assign') {
    // Add a crew member (no text). Their pay is snapshotted from `pay` if given,
    // else from their configured rate for this business, else their default.
    const staff = (await listStaff()).find(s => s.id === S(body.staffId, 80))
    if (!staff) return NextResponse.json({ error: 'Contractor not found.' }, { status: 400 })
    let manualCents: number | null | undefined
    if (S(body.pay, 80)) {
      manualCents = parseMoneyCents(body.pay)
      if (manualCents == null) return NextResponse.json({ error: 'Pay must be a positive dollar amount.' }, { status: 400 })
    }
    addCrew(route, staff, manualCents)

    // Warn (don't block) when the crew now costs more than the route earns.
    const m = computeRouteMoney(route)
    if (payExceedsPrice(m.revenueCents, m.payoutCents) && body.acknowledgeWarning !== true) {
      return NextResponse.json({
        warning: 'pay_exceeds_price',
        message: `Crew pay (${fmtCents(m.payoutCents)}) is more than this route earns (${fmtCents(m.revenueCents ?? 0)}). Assign anyway?`,
        revenueCents: m.revenueCents, payoutCents: m.payoutCents,
      }, { status: 409 })
    }
  } else if (action === 'money') {
    // Re-price a single live route by hand. Settled routes are never re-priced.
    if (isFrozen(route)) return NextResponse.json({ error: `A ${route.status} route keeps the price it ran at.` }, { status: 409 })

    if (body.businessPrice !== undefined) {
      const cents = parseMoneyCents(body.businessPrice)
      if (cents == null) return NextResponse.json({ error: 'Route price must be a positive dollar amount.' }, { status: 400 })
      snapshotManualPrice(route, cents)
      pushAudit(route, 'admin', `Route price set to ${fmtCents(cents)}`)
    }

    if (Array.isArray(body.crewPay)) {
      for (const raw of body.crewPay as unknown[]) {
        const o = raw as Record<string, unknown>
        const sid = S(o.staffId, 80)
        const a = (route.assignees ?? []).find(x => x.staffId === sid)
        if (!a) continue
        if (o.clear === true) {
          clearCrewPay(a)
          pushAudit(route, 'admin', `${a.name}'s pay cleared`)
          continue
        }
        const cents = parseMoneyCents(o.pay)
        if (cents == null) return NextResponse.json({ error: `Pay for ${a.name} must be a positive dollar amount.` }, { status: 400 })
        snapshotCrewPay(a, undefined, route.businessName, cents)
        pushAudit(route, 'admin', `${a.name}'s pay set to ${fmtCents(cents)}`)
      }
    }

    const m = computeRouteMoney(route)
    if (payExceedsPrice(m.revenueCents, m.payoutCents) && body.acknowledgeWarning !== true) {
      return NextResponse.json({
        warning: 'pay_exceeds_price',
        message: `Crew pay (${fmtCents(m.payoutCents)}) is more than this route earns (${fmtCents(m.revenueCents ?? 0)}). Save anyway?`,
        revenueCents: m.revenueCents, payoutCents: m.payoutCents,
      }, { status: 409 })
    }
  } else if (action === 'confirm') {
    // "I talked to them and they said they're taking it." Recorded as a verbal
    // confirmation — see confirmVerbally: it never forges the disclaimer signature.
    const r = confirmVerbally(route, S(body.staffId, 80), S(body.note, 300) || undefined)
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 400 })
    if (r.already) return NextResponse.json({ ok: true, already: true, route })
  } else if (action === 'unconfirm') {
    const r = undoVerbalConfirm(route, S(body.staffId, 80))
    if (!r.ok) return NextResponse.json({ error: r.error }, { status: 409 })
    if (r.already) return NextResponse.json({ ok: true, already: true, route })
  } else if (action === 'unassign') {
    // Remove one crew member (by staffId) or the lead if none specified.
    const sid = S(body.staffId, 80) || route.assignees?.[0]?.staffId
    if (sid) removeCrew(route, sid)
  } else if (action === 'send' || action === 'resend') {
    const list = route.assignees ?? []
    if (!list.length) return NextResponse.json({ error: 'Assign a contractor first.' }, { status: 400 })
    const sid = S(body.staffId, 80)
    const targets = sid ? list.filter(a => a.staffId === sid) : list.filter(a => a.phone)
    if (!targets.length) return NextResponse.json({ error: 'No one to text.' }, { status: 400 })
    const errs: string[] = []
    for (const a of targets) { const r = await sendAssignmentText(route, a); if (!r.ok && r.error) errs.push(`${a.name}: ${r.error}`) }
    if (errs.length) smsWarning = errs.join('; ')
  } else if (action === 'status') {
    const status = S(body.status, 40) as RouteStatus
    if (!(status in ROUTE_STATUS_LABEL)) return NextResponse.json({ error: 'Invalid status.' }, { status: 400 })
    // Stamp completion metadata when an admin closes a route out by hand.
    if (status === 'completed' && !route.completedAt) {
      route.completedAt = Date.now()
      route.completedBy = 'admin'
    }
    setStatus(route, status, 'admin', S(body.note, 300) || undefined)
  } else if (action === 'update') {
    // Edit route details (kept simple — admin-trusted, audited).
    const fields: Array<[keyof typeof route, number]> = [
      ['businessName', 200], ['contactPerson', 120], ['contactPhone', 40], ['reportAddress', 300],
      ['reportTime', 60], ['routeDate', 20], ['description', 2000], ['payRate', 80],
      ['vehicle', 200], ['specialNotes', 2000],
    ]
    for (const [k, max] of fields) {
      if (body[k] !== undefined) (route as Record<string, unknown>)[k] = S(body[k], max) || undefined
    }
    pushAudit(route, 'admin', 'Route details edited')
  } else {
    return NextResponse.json({ error: 'Unknown action.' }, { status: 400 })
  }

  await saveRoute(route)
  return NextResponse.json({ ok: true, route, smsWarning })
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await requireSession(req))) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  const { id } = await params
  await deleteRoute(id)
  return NextResponse.json({ ok: true })
}
